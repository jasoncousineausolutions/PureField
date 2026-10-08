/**
 * Purefield / xfa / model.js
 *
 * Template packet → template model: a plain-object tree holding every
 * property the reduced spec's later stages need (docs/REDUCED_XFA_SPEC.txt):
 *
 *   binding  — bind (match/ref), occur, items save list
 *   flow     — layout, geometry, margin, columnWidths, colSpan, breaks, keep,
 *              presence, relevant, pageSet/pageArea/contentArea
 *   chrome   — border (edges, corners, fill), caption (placement, reserve),
 *              ui widget (comb, multiLine, checkButton size/mark, …)
 *   type     — font and para (own values only; inheritance is resolved later)
 *   draws    — value: text, exData, image, rectangle, line, arc
 *   pictures — ui/*\/picture and format/picture
 *
 * This is the template prototype, not the instance tree: occur is resolved
 * to numbers but nothing is repeated, and no data is read. Measurements are
 * points; an omitted measurement is null (indefinite), a percentage is
 * { percent } and resolved during layout.
 *
 * DOM use is limited to childNodes, nodeType, localName, getAttribute and
 * textContent so the same code runs in browsers and under @xmldom/xmldom.
 */

import { toPt, parseMeasurement, toQuarterTurn, mediumSize } from '../core/units.js';
import { XfaLog } from './log.js';
import { parseRich, richPlainText, parseTabStops } from './rich.js';
import { resolvePrototypes } from './proto.js';

const CONTAINERS = new Set(['subform', 'subformSet', 'area', 'exclGroup', 'field', 'draw']);

// Script-bearing or interactive-only children. They are not modelled; their
// presence is recorded where binding needs to know (calculate/initialize).
const IGNORED = new Set([
  'script', 'event', 'validate', 'assist', 'toolTip', 'speak', 'traversal',
  'traverse', 'desc', 'extras', 'setProperty', 'connect', 'variables', 'proto',
  'leader', 'trailer', 'bindItems', 'calculate',
]);

// properties an object has at most once
const SINGLE_PROPERTIES = new Set([
  'ui', 'caption', 'value', 'format', 'font', 'para', 'margin', 'border', 'bind', 'keep', 'occur',
  'overflow', 'calculate', 'validate', 'assist', 'traversal',
]);

const UI_WIDGETS = new Set([
  'textEdit', 'numericEdit', 'dateTimeEdit', 'passwordEdit', 'checkButton',
  'choiceList', 'imageEdit', 'signature', 'barcode', 'button', 'defaultUi',
]);

const VALUE_SCALARS = new Set(['integer', 'decimal', 'float', 'date', 'time', 'dateTime', 'boolean']);

/**
 * Parse the template packet into a template model.
 *
 * @param {import('./extractor.js').XfaStreams|Document} source
 * @param {{ log?: XfaLog }} [opts]
 * @returns {{ root: object, log: XfaLog }}
 * @throws if the template is missing or has no root subform (spec §1: abort)
 */
export function parseTemplateModel(source, { log } = {}) {
  log ??= source?.log ?? new XfaLog();
  const xml = typeof source?.parseXml === 'function' ? source.template : source;
  const docEl = xml?.documentElement;
  if (!docEl || xml.getElementsByTagName('parsererror').length) {
    throw new Error('XFA template packet is missing or not well-formed');
  }
  const rootEl = elementChildren(docEl).find(el => localName(el) === 'subform');
  if (!rootEl) throw new Error('XFA template has no root subform');
  // use/usehref: inherit from prototypes (Designer stylesheets) first
  resolvePrototypes(docEl, log);

  const ctx = { log };
  const root = parseContainer(rootEl, ctx, null);
  // The root subform always instantiates once
  root.occur = { min: 1, max: 1, initial: 1 };
  return { root, log };
}

// ---------------------------------------------------------------------------
// Containers: subform, subformSet, area, exclGroup, field, draw
// ---------------------------------------------------------------------------

function parseContainer(el, ctx, parentType) {
  const type = localName(el);
  const node = {
    type,
    name:     attr(el, 'name') ?? '',
    id:       attr(el, 'id'),
    presence: presenceOf(el),
    relevant: parseRelevant(attr(el, 'relevant')),
    children: [],
  };
  // open, readOnly, protected, nonInteractive: scripts read it (a form's
  // "is it blank?" check skips fields the user cannot fill)
  if (attr(el, 'access')) node.access = attr(el, 'access');

  if (attr(el, 'use') || attr(el, 'usehref')) {
    ctx.log.once('info', 'XFA_USE_SKIPPED', attr(el, 'use') || attr(el, 'usehref'),
      `Prototype reference not resolved: ${attr(el, 'use') || attr(el, 'usehref')}`);
  }

  if (type !== 'subformSet') {
    Object.assign(node, geometry(el, ctx));
  }

  if (type === 'subform' || type === 'exclGroup' || type === 'area') {
    node.layout = type === 'area' ? 'position' : layoutOf(el, ctx);
  }
  if (type === 'subform' || type === 'exclGroup') {
    node.columnWidths = parseColumnWidths(attr(el, 'columnWidths'), ctx);
  }
  if (type === 'subformSet') {
    node.relation = attr(el, 'relation') ?? 'ordered';
  }
  if (type === 'subform' || type === 'subformSet') {
    node.occur = parseOccur(child(el, 'occur'), type, parentType);
  }

  // field-only defaults
  if (type === 'field') node.ui = { kind: 'textEdit' };

  // a property given twice keeps its first occurrence, as Reader does
  // (anaf-d017's txtB carries a second, stale <value> and <font>)
  const seen = new Set();
  for (const c of elementChildren(el)) {
    const tag = localName(c);
    if (CONTAINERS.has(tag)) {
      node.children.push(parseContainer(c, ctx, type));
      continue;
    }
    if (SINGLE_PROPERTIES.has(tag)) {
      if (seen.has(tag)) {
        ctx.log.once('info', 'XFA_PROPERTY_DUPLICATE', tag, `<${tag}> given twice in one object: the first is used`);
        continue;
      }
      seen.add(tag);
    }
    switch (tag) {
      case 'pageSet':     (node.pageSets ??= []).push(parsePageSet(c, ctx)); break;
      case 'ui':          node.ui = parseUi(c, ctx); break;
      case 'caption':     node.caption = parseCaption(c, ctx); break;
      case 'value':       node.value = parseValue(c, ctx); break;
      case 'items':       (node.items ??= []).push(parseItems(c)); break;
      case 'format':      node.picture = pictureOf(c); break;
      case 'font':        node.font = parseFont(c, ctx); break;
      case 'para':        node.para = parsePara(c, ctx); break;
      case 'margin':      node.margin = parseMargin(c, ctx); break;
      case 'border':      node.border = parseBorder(c, ctx); break;
      case 'bind':        node.bind = parseBind(c); break;
      case 'keep':        node.keep = parseKeep(c); break;
      case 'breakBefore': (node.breakBefore ??= []).push(parseBreak(c)); break;
      case 'breakAfter':  (node.breakAfter ??= []).push(parseBreak(c)); break;
      case 'break':       parseLegacyBreak(c, node); break;
      // where the container continues when it overflows, and the subforms
      // repeated at the top (leader) and bottom (trailer) of each piece
      case 'overflow':
        node.overflow = true;
        node.overflowTarget = attr(c, 'target');
        node.overflowLeader = attr(c, 'leader') || null;
        node.overflowTrailer = attr(c, 'trailer') || null;
        break;
      // the subforms that open and close the container's content (once,
      // not on each page as an overflow leader and trailer are)
      case 'bookend':
        node.bookendLeader = attr(c, 'leader') || null;
        node.bookendTrailer = attr(c, 'trailer') || null;
        break;
      case 'occur':       break; // handled above
      case 'calculate': {
        (node.scripted ??= {}).calculate = true;
        notePageRole(node, c);
        const script = parseScript(child(c, 'script'));
        if (script) node.calculate = script;
        break;
      }
      case 'event': {
        if (attr(c, 'activity') === 'initialize' && child(c, 'script')) {
          (node.scripted ??= {}).initialize = true;
        }
        notePageRole(node, c);
        const script = parseScript(child(c, 'script'));
        if (script) (node.events ??= []).push({ activity: attr(c, 'activity') ?? 'click', ref: attr(c, 'ref') ?? '$', script });
        break;
      }
      case 'variables':
        // script objects (named <script>s) and named values; see script/run.js
        for (const v of elementChildren(c)) {
          const name = attr(v, 'name');
          if (!name) continue;
          if (localName(v) === 'script') {
            const script = parseScript(v);
            if (script) (node.variables ??= []).push({ name, script });
          } else if (localName(v) === 'text' || VALUE_SCALARS.has(localName(v))) {
            (node.variables ??= []).push({ name, text: v.textContent });
          } else if (localName(v) === 'manifest') {
            // a named list of SOM references (a paper forms barcode's collection)
            const refs = elementChildren(v).filter(r => localName(r) === 'ref').map(r => r.textContent.trim()).filter(Boolean);
            (node.variables ??= []).push({ name, manifest: refs });
          }
        }
        break;
      default:
        if (!IGNORED.has(tag)) {
          ctx.log.once('info', 'XFA_TEMPLATE_UNKNOWN', tag, `Unmodelled template element <${tag}>`);
        }
    }
  }

  if ((type === 'field' || type === 'exclGroup') && !node.bind) {
    node.bind = { match: 'once', ref: null };
  }
  return node;
}

// The one script idiom a flattener can honour without running scripts:
// "this.rawValue = xfa.layout.page(this)" / "xfa.layout.pageCount()".
// The page number is painted per page instead (paint.js).
function notePageRole(node, el) {
  const script = child(el, 'script');
  const code = script ? script.textContent : '';
  // the value assigned from a layout query, not any mention of one
  // (hmrc-iform's FormTitle only tests xfa.layout.sheet(this) > 0)
  if (/rawValue\s*=\s*xfa\.layout\.(page|sheet)\(\s*(this|\$)\s*\)/.test(code)) node.pageRole = 'page';
  else if (/rawValue\s*=\s*xfa\.layout\.(pageCount|sheetCount|absPageCount)\(\s*\)/.test(code)) node.pageRole = 'count';
}

// A <script>: its language (FormCalc unless contentType names JavaScript)
// and source; scripts that run only on a server or client of a kind a
// flattener is not (runAt="server") are dropped
function parseScript(el) {
  if (!el) return null;
  const text = el.textContent ?? '';
  if (!text.trim()) return null;
  if (attr(el, 'runAt') === 'server') return null;
  const lang = /javascript/i.test(attr(el, 'contentType') ?? '') ? 'javascript' : 'formcalc';
  return { lang, text };
}

function geometry(el, ctx) {
  const m = name => measure(attr(el, name), ctx);
  const colSpan = parseInt(attr(el, 'colSpan') ?? '1', 10);
  return {
    x: m('x') ?? 0,
    y: m('y') ?? 0,
    w: m('w'),
    h: m('h'),
    minW: m('minW') ?? 0,
    minH: m('minH') ?? 0,
    maxW: m('maxW'),
    maxH: m('maxH'),
    anchorType: attr(el, 'anchorType') ?? 'topLeft',
    rotate: toQuarterTurn(attr(el, 'rotate')),
    colSpan: Number.isFinite(colSpan) ? colSpan : 1,
    locale: attr(el, 'locale'),
  };
}

const LAYOUTS = new Set(['position', 'tb', 'lr-tb', 'rl-tb', 'table', 'row', 'rl-row']);

function layoutOf(el, ctx) {
  const v = attr(el, 'layout');
  if (!v) return 'position';
  if (LAYOUTS.has(v)) return v;
  ctx.log.once('warn', 'XFA_LAYOUT_UNKNOWN', v, `Unknown layout "${v}", using position`);
  return 'position';
}

function parseColumnWidths(v, ctx) {
  if (!v) return null;
  return v.trim().split(/\s+/).map(s => (s === '-1' ? -1 : toPt(s, { log: ctx.log })));
}

// Spec §5 occurrence defaults, as pdf.js implements them: omitted min is 1
// (0 for pageArea/pageSet); omitted max follows min when min is given, else
// 1 (-1 for pageArea/pageSet); max below min is raised; initial is min.
function parseOccur(el, type, parentType) {
  const isPage = type === 'pageArea' || type === 'pageSet';
  const int = v => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));
  const rawMin = el ? int(attr(el, 'min')) : null;
  const rawMax = el ? int(attr(el, 'max')) : null;
  const rawInitial = el ? int(attr(el, 'initial')) : null;

  const min = rawMin ?? (isPage ? 0 : 1);
  const initial = rawInitial ?? (parentType === null ? 1 : min);
  let max = rawMax ?? (rawMin !== null ? min : (isPage ? -1 : 1));
  if (max !== -1 && max < min) max = min;
  // Designer writes <occur min="0" initial="1"/> for optional sections; a
  // derived max of 0 would make initial meaningless, so an omitted max is
  // never below initial
  if (rawMax === null && max !== -1 && max < initial) max = initial;
  return { min, max, initial };
}

// ---------------------------------------------------------------------------
// pageSet / pageArea / contentArea
// ---------------------------------------------------------------------------

function parsePageSet(el, ctx) {
  const set = {
    type: 'pageSet',
    name: attr(el, 'name') ?? '',
    relation: attr(el, 'relation') ?? 'orderedOccurrence',
    occur: parseOccur(child(el, 'occur'), 'pageSet'),
    pageAreas: [],
    pageSets: [],
  };
  for (const c of elementChildren(el)) {
    const tag = localName(c);
    if (tag === 'pageArea') set.pageAreas.push(parsePageArea(c, ctx));
    else if (tag === 'pageSet') set.pageSets.push(parsePageSet(c, ctx));
  }
  return set;
}

function parsePageArea(el, ctx) {
  const mediumEl = child(el, 'medium');
  const medium = mediumEl ? {
    short: attr(mediumEl, 'short'),
    long: attr(mediumEl, 'long'),
    stock: attr(mediumEl, 'stock'),
    orientation: attr(mediumEl, 'orientation'),
  } : {};
  const area = {
    type: 'pageArea',
    name: attr(el, 'name') ?? '',
    id: attr(el, 'id'),
    oddOrEven: attr(el, 'oddOrEven') ?? 'any',
    pagePosition: attr(el, 'pagePosition') ?? 'any',
    initialNumber: parseInt(attr(el, 'initialNumber') ?? '1', 10),
    occur: parseOccur(child(el, 'occur'), 'pageArea'),
    size: mediumSize(medium),
    contentAreas: [],
    // Boilerplate placed on every page using this pageArea (headers, footers)
    children: [],
  };
  for (const c of elementChildren(el)) {
    const tag = localName(c);
    if (tag === 'contentArea') {
      area.contentAreas.push({
        name: attr(c, 'name') ?? '',
        id: attr(c, 'id'),
        x: measure(attr(c, 'x'), ctx) ?? 0,
        y: measure(attr(c, 'y'), ctx) ?? 0,
        w: measure(attr(c, 'w'), ctx) ?? 0,
        h: measure(attr(c, 'h'), ctx) ?? 0,
      });
    } else if (CONTAINERS.has(tag)) {
      area.children.push(parseContainer(c, ctx, 'pageArea'));
    }
  }
  return area;
}

// ---------------------------------------------------------------------------
// ui, caption, value, items, picture
// ---------------------------------------------------------------------------

function parseUi(el, ctx) {
  const widgetEl = elementChildren(el).find(c => UI_WIDGETS.has(localName(c)));
  const kind = widgetEl ? localName(widgetEl) : 'textEdit';
  const ui = { kind: kind === 'defaultUi' ? 'textEdit' : kind };

  // picture may sit on the widget or directly on ui
  ui.picture = pictureOf(widgetEl) ?? pictureOf(el);
  if (!widgetEl) return ui;

  const b = child(widgetEl, 'border');
  if (b) ui.border = parseBorder(b, ctx);
  const m = child(widgetEl, 'margin');
  if (m) ui.margin = parseMargin(m, ctx);

  switch (kind) {
    case 'textEdit': {
      const ml = attr(widgetEl, 'multiLine');
      ui.multiLine = ml === null ? null : ml === '1';
      const comb = child(widgetEl, 'comb');
      if (comb) ui.comb = parseInt(attr(comb, 'numberOfCells') ?? '0', 10) || 0;
      break;
    }
    case 'numericEdit': {
      // numericEdit takes a comb too (Acrobat draws the cells)
      const comb = child(widgetEl, 'comb');
      if (comb) ui.comb = parseInt(attr(comb, 'numberOfCells') ?? '0', 10) || 0;
      break;
    }
    case 'checkButton':
      ui.size = measure(attr(widgetEl, 'size'), ctx) ?? 10;
      ui.mark = attr(widgetEl, 'mark') ?? 'default';
      ui.shape = attr(widgetEl, 'shape') ?? 'square';
      break;
    case 'choiceList':
      ui.open = attr(widgetEl, 'open') ?? 'userControl';
      ui.textEntry = attr(widgetEl, 'textEntry') === '1';
      break;
    case 'passwordEdit':
      ui.passwordChar = attr(widgetEl, 'passwordChar') ?? '*';
      break;
    case 'imageEdit':
      ui.data = attr(widgetEl, 'data') ?? 'link';
      break;
    case 'barcode': {
      // absent attributes stay null: each symbology has its own default
      const num = name => { const v = attr(widgetEl, name); return v === null || v.trim() === '' ? null : Number(v); };
      ui.barcode = {
        type: (attr(widgetEl, 'type') ?? '').trim(),
        charEncoding: attr(widgetEl, 'charEncoding'),
        dataPrep: attr(widgetEl, 'dataPrep') ?? 'none',
        moduleWidth: measure(attr(widgetEl, 'moduleWidth'), ctx),
        moduleHeight: measure(attr(widgetEl, 'moduleHeight'), ctx),
        wideNarrowRatio: attr(widgetEl, 'wideNarrowRatio'),
        textLocation: attr(widgetEl, 'textLocation'),
        checksum: attr(widgetEl, 'checksum') ?? 'none',
        printCheckDigit: attr(widgetEl, 'printCheckDigit') === '1',
        errorCorrectionLevel: num('errorCorrectionLevel'),
        dataColumnCount: num('dataColumnCount'),
        dataRowCount: num('dataRowCount'),
        startChar: attr(widgetEl, 'startChar'),
        endChar: attr(widgetEl, 'endChar'),
        truncate: attr(widgetEl, 'truncate') === '1',
      };
      break;
    }
  }
  return ui;
}

function pictureOf(el) {
  const p = el && child(el, 'picture');
  return p ? p.textContent : null;
}

function parseCaption(el, ctx) {
  const reserve = measure(attr(el, 'reserve'), ctx);
  const caption = {
    placement: attr(el, 'placement') ?? 'left',
    // omitted, zero or negative → measure the caption (spec §7)
    reserve: typeof reserve === 'number' && reserve > 0 ? reserve : null,
    presence: presenceOf(el),
  };
  for (const c of elementChildren(el)) {
    switch (localName(c)) {
      case 'value':  caption.value = parseValue(c, ctx); break;
      case 'font':   caption.font = parseFont(c, ctx); break;
      case 'para':   caption.para = parsePara(c, ctx); break;
      case 'margin': caption.margin = parseMargin(c, ctx); break;
    }
  }
  return caption;
}

export function parseValue(el, ctx = { log: new XfaLog() }) {
  const c = elementChildren(el)[0];
  if (!c) return null;
  const tag = localName(c);

  if (tag === 'text') return { kind: 'text', text: c.textContent };
  if (VALUE_SCALARS.has(tag)) return { kind: 'text', text: c.textContent.trim(), valueType: tag };

  if (tag === 'exData') {
    const contentType = attr(c, 'contentType') ?? 'text/plain';
    if (contentType === 'text/html' || contentType === 'text/xml') {
      // Styled paragraphs for typography (DOM-free); plain text for binding defaults
      const body = elementChildren(c)[0] ?? c;
      const paras = parseRich(body);
      return { kind: 'rich', paras, text: richPlainText(paras) };
    }
    return { kind: 'text', text: c.textContent };
  }

  if (tag === 'image') {
    return {
      kind: 'image',
      href: attr(c, 'href'),
      contentType: attr(c, 'contentType') ?? 'image/png',
      aspect: attr(c, 'aspect') ?? 'fit',
      data: c.textContent.replace(/\s+/g, ''),
    };
  }

  if (tag === 'rectangle') {
    return { kind: 'rectangle', ...parseBorder(c, ctx) };
  }
  if (tag === 'line') {
    return {
      kind: 'line',
      slope: attr(c, 'slope') ?? '\\',
      hand: attr(c, 'hand') ?? 'even',
      edge: parseEdge(child(c, 'edge'), ctx),
    };
  }
  if (tag === 'arc') {
    const fillEl = child(c, 'fill');
    return {
      kind: 'arc',
      startAngle: parseFloat(attr(c, 'startAngle') ?? '0') || 0,
      sweepAngle: parseFloat(attr(c, 'sweepAngle') ?? '360') || 360,
      circular: attr(c, 'circular') === '1',
      hand: attr(c, 'hand') ?? 'even',
      edge: parseEdge(child(c, 'edge'), ctx),
      fill: fillEl ? parseFill(fillEl, ctx) : null,
    };
  }

  ctx.log.once('info', 'XFA_TEMPLATE_UNKNOWN', `value/${tag}`, `Unmodelled value <${tag}>`);
  return null;
}

// <items save="1" presence="hidden"> lists; resolution into save/display
// pairs happens in chrome (spec §7)
export function parseItems(el) {
  return {
    save: attr(el, 'save') === '1',
    presence: presenceOf(el),
    values: elementChildren(el).map(c => c.textContent),
  };
}

// ---------------------------------------------------------------------------
// font, para, margin
// ---------------------------------------------------------------------------

function parseFont(el, ctx) {
  const pct = (name, def) => {
    const v = attr(el, name);
    return v === null ? def : parseFloat(v);
  };
  const int = (name, def) => (attr(el, name) === null ? def : parseInt(attr(el, name), 10));
  const fill = child(el, 'fill');
  // A <font> element is complete: omitted attributes take the XFA defaults
  // (Courier, 10pt, normal) rather than the parent's values — pdf.js does the
  // same. Only a node with no <font> at all inherits (text.js).
  return {
    typeface: attr(el, 'typeface') ?? 'Courier',
    size: measure(attr(el, 'size'), ctx) ?? 10,
    weight: attr(el, 'weight') ?? 'normal',
    posture: attr(el, 'posture') ?? 'normal',
    // colour too: without a <fill> it is black, not the parent's colour
    // (Acrobat prints a registration form's captions black under blue field fonts;
    // pdf.js leaves the CSS colour unset, so they inherit there)
    color: fill ? parseFill(fill, ctx).color : [0, 0, 0],
    hScale: pct('fontHorizontalScale', 100),
    vScale: pct('fontVerticalScale', 100),
    baselineShift: measure(attr(el, 'baselineShift'), ctx) ?? 0,
    letterSpacing: measure(attr(el, 'letterSpacing'), ctx) ?? 0,
    underline: int('underline', 0),
    lineThrough: int('lineThrough', 0),
  };
}

function parsePara(el, ctx) {
  const m = name => measure(attr(el, name), ctx);
  return {
    hAlign: attr(el, 'hAlign'),
    vAlign: attr(el, 'vAlign'),
    lineHeight: m('lineHeight'),
    marginLeft: m('marginLeft'),
    marginRight: m('marginRight'),
    spaceAbove: m('spaceAbove'),
    spaceBelow: m('spaceBelow'),
    textIndent: m('textIndent'),
    radixOffset: m('radixOffset'),
    tabDefault: m('tabDefault'),
    tabStops: attr(el, 'tabStops') ? parseTabStops(attr(el, 'tabStops')) : null,
  };
}

function parseMargin(el, ctx) {
  const m = name => measure(attr(el, name), ctx) ?? 0;
  return { top: m('topInset'), right: m('rightInset'), bottom: m('bottomInset'), left: m('leftInset') };
}

// ---------------------------------------------------------------------------
// border / rectangle: edges, corners, fill
// ---------------------------------------------------------------------------

export function parseBorder(el, ctx = { log: new XfaLog() }) {
  const edges = [];
  const corners = [];
  let fill = null;
  for (const c of elementChildren(el)) {
    switch (localName(c)) {
      case 'edge':   edges.push(parseEdge(c, ctx)); break;
      case 'corner': corners.push(parseCorner(c, ctx)); break;
      case 'fill':   fill = parseFill(c, ctx); break;
    }
  }
  return {
    presence: presenceOf(el),
    hand: attr(el, 'hand') ?? 'even',
    // top, right, bottom, left; fewer than four broadcast the last one given
    edges: expand4(edges),
    corners: expand4(corners),
    // how many were given, so a change to edge[i] reaches the sides it covers
    edgesGiven: edges.length,
    cornersGiven: corners.length,
    fill,
  };
}

/**
 * A border with edge (or corner) i changed by patch, as a script or the
 * saved form state changes it: a part the template broadcast (the last one
 * given covers the remaining sides) changes on every side it covers.
 * @param {object} border
 * @param {'edges'|'corners'} kind
 * @param {number} i
 * @param {object} patch - e.g. { presence: 'hidden' }
 */
export function patchBorder(border, kind, i, patch) {
  const list = [...(border[kind] ?? [])];
  if (!list.length) return border;
  const given = border[kind === 'edges' ? 'edgesGiven' : 'cornersGiven'] ?? list.length;
  const last = Math.max(0, given - 1);
  for (let k = 0; k < list.length; k++) {
    if (k === i || (i >= last && k >= last)) list[k] = { ...list[k], ...patch };
  }
  return { ...border, [kind]: list };
}

function expand4(list) {
  if (list.length === 0) return [];
  const out = list.slice(0, 4);
  while (out.length < 4) out.push(out[out.length - 1]);
  return out;
}

// An edge element with no thickness is 0.5pt, no colour is black
function parseEdge(el, ctx) {
  if (!el) return { presence: 'visible', thickness: 0.5, color: [0, 0, 0], stroke: 'solid' };
  return {
    presence: presenceOf(el),
    thickness: measure(attr(el, 'thickness'), ctx) ?? 0.5,
    color: colorOf(el) ?? [0, 0, 0],
    stroke: attr(el, 'stroke') ?? 'solid',
  };
}

function parseCorner(el, ctx) {
  return {
    presence: presenceOf(el),
    thickness: measure(attr(el, 'thickness'), ctx) ?? 0.5,
    radius: measure(attr(el, 'radius'), ctx) ?? 0,
    join: attr(el, 'join') ?? 'square',
    inverted: attr(el, 'inverted') === '1',
    color: colorOf(el) ?? [0, 0, 0],
    stroke: attr(el, 'stroke') ?? 'solid',
  };
}

// Fill colour defaults to white. A linear or radial gradient runs from it
// to the gradient's own colour (black by default) in the direction its type
// names; a pattern draws lines in its colour (black by default) over the
// fill colour, and a stipple blends its colour in at its rate (spec §7).
function parseFill(el, ctx) {
  const g = elementChildren(el).find(c => ['linear', 'radial', 'pattern', 'stipple'].includes(localName(c)));
  const pattern = g ? localName(g) : 'solid';
  const fill = { presence: presenceOf(el), color: colorOf(el) ?? [255, 255, 255], pattern };
  if (pattern === 'linear' || pattern === 'radial') {
    fill.gradient = { type: attr(g, 'type') ?? (pattern === 'linear' ? 'toRight' : 'toEdge'), color: colorOf(g) ?? [0, 0, 0] };
  } else if (pattern === 'pattern') {
    fill.hatch = { type: attr(g, 'type') ?? 'crossHatch', color: colorOf(g) ?? [0, 0, 0] };
  } else if (pattern === 'stipple') {
    const rate = Number(attr(g, 'rate') ?? 50);
    fill.stipple = { rate: Number.isFinite(rate) ? Math.min(100, Math.max(0, rate)) : 50, color: colorOf(g) ?? [0, 0, 0] };
  }
  return fill;
}

function colorOf(el) {
  const c = child(el, 'color');
  if (!c) return null;
  const v = attr(c, 'value');
  if (!v) return [0, 0, 0];
  const parts = v.split(',').map(s => Math.max(0, Math.min(255, parseInt(s, 10) || 0)));
  return parts.length === 3 ? parts : [0, 0, 0];
}

// ---------------------------------------------------------------------------
// bind, keep, breaks, presence, relevant
// ---------------------------------------------------------------------------

function parseBind(el) {
  const match = attr(el, 'match') ?? 'once';
  return {
    match: ['once', 'dataRef', 'global', 'none'].includes(match) ? match : 'once',
    ref: attr(el, 'ref'),
    picture: pictureOf(el),
  };
}

function parseKeep(el) {
  return {
    intact: attr(el, 'intact') ?? 'none',
    next: attr(el, 'next') ?? 'none',
    previous: attr(el, 'previous') ?? 'none',
  };
}

function parseBreak(el) {
  return {
    targetType: attr(el, 'targetType') ?? 'auto',
    target: attr(el, 'target'),
    startNew: attr(el, 'startNew') === '1',
  };
}

// XFA 2.x <break before="pageArea" beforeTarget="#id" after=… afterTarget=…>
function parseLegacyBreak(el, node) {
  const before = attr(el, 'before');
  if (before && before !== 'auto') {
    (node.breakBefore ??= []).push({ targetType: before, target: attr(el, 'beforeTarget'), startNew: attr(el, 'startNew') === '1' });
  }
  const after = attr(el, 'after');
  if (after && after !== 'auto') {
    (node.breakAfter ??= []).push({ targetType: after, target: attr(el, 'afterTarget'), startNew: false });
  }
  for (const [a, k] of [['overflowTarget', 'overflowTarget'], ['overflowLeader', 'overflowLeader'], ['overflowTrailer', 'overflowTrailer']]) {
    if (attr(el, a)) { node[k] = attr(el, a); node.overflow = true; }
  }
}

function presenceOf(el) {
  const p = attr(el, 'presence');
  return p === 'hidden' || p === 'invisible' || p === 'inactive' ? p : 'visible';
}

/**
 * relevant="-print +screen" → [{ excluded: true, view: 'print' }, …]
 * @returns {{ excluded: boolean, view: string }[]}
 */
export function parseRelevant(v) {
  if (!v) return [];
  return v.trim().split(/\s+/).map(tok => ({
    excluded: tok[0] === '-',
    view: tok.replace(/^[+-]/, ''),
  }));
}

/**
 * Is a node relevant to the print view? A flattener is the print view
 * (spec §3): "-print" drops the node, and a list that names only other views
 * (e.g. "+screen") drops it too.
 */
export function isPrintRelevant(relevant) {
  if (!relevant?.length) return true;
  if (relevant.some(r => r.view === 'print')) {
    return !relevant.find(r => r.view === 'print').excluded;
  }
  // Only exclusions of other views (e.g. "-screen") keep it for print
  return relevant.every(r => r.excluded);
}

// ---------------------------------------------------------------------------
// DOM helpers (browser + xmldom common subset)
// ---------------------------------------------------------------------------

function measure(v, ctx) {
  if (v === null || v === undefined || v === '') return null;
  const m = parseMeasurement(v);
  if (m?.unit === '%') return { percent: m.value };
  // Malformed values (e.g. h="=0mm") resolve to 0, as pdf.js does; log once per value
  const once = { warn: (code, msg) => ctx.log.once('warn', code, v, msg) };
  return toPt(v, { log: once });
}

function attr(el, name) {
  const v = el.getAttribute(name);
  return v === '' || v === null || v === undefined ? null : v;
}

function localName(el) {
  return el.localName || String(el.tagName).split(':').pop();
}

function elementChildren(el) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}

function child(el, name) {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && localName(n) === name) return n;
  }
  return null;
}

