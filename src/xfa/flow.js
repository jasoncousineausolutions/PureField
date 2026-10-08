/**
 * Purefield / xfa / flow.js
 *
 * Layout: instance tree → placed boxes on pages, in top-left page points
 * (spec §2 Coordinates, §3 Container flow). Y is not flipped here.
 *
 * Two passes:
 *
 *   1. size   bottom-up/top-down sizing in each container's local frame.
 *             Every participating node gets lw, lh (outer box) and lx, ly
 *             (offset of its outer box inside its parent's outer box).
 *             Leaves also get `parts` (caption and value rectangles).
 *   2. paginate  walks the root's flow into the pageSet's content areas,
 *             splitting flowed subforms (tb, table, lr-tb rows) between
 *             areas and pages; position subforms and leaves move whole.
 *
 * Presence and relevance are applied first: hidden and inactive nodes take
 * no space; invisible and non-print (relevant) nodes take space but are not
 * painted.
 * x and y are used only inside position layouts (pdf.js: flowed layouts
 * ignore them).
 */

import { XfaLog } from './log.js';
import { isPrintRelevant } from './model.js';
import { resolveFont, textWidth, wrapText, lineHeightOf, setEmbedResolver, naturalLineHeight } from './text.js';
import { layoutRich, richHeight, plainParas } from './rich.js';

const EPS = 0.01;
const NO_LIMITS = Object.freeze({ minW: 0, minH: 0, maxW: null, maxH: null });
const ZERO = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const DEFAULT_PAGE = { width: 612, height: 792, contentAreas: [{ x: 18, y: 18, w: 576, h: 756 }] };

/**
 * @param {object} root - instance root from bindData()
 * @param {{ log?: XfaLog }} [opts]
 * @returns {{ pages: Page[], byId: Map<string, object>, log: XfaLog }}
 *
 * @typedef {{ width: number, height: number, pageArea: object|null, items: Item[] }} Page
 * @typedef {{ node: object, x: number, y: number, w: number, h: number,
 *             paint: boolean, fragment?: boolean }} Item
 */
export function layoutForm(root, { log = new XfaLog(), fonts = null, pageValues = null, display = null } = {}) {
  // fonts: parsed embedded faces { regular, bold }; inherited via the root font
  // pageValues(page, count): the values page-dependent boilerplate scripts
  // give their fields on a page (Map node → raw); display: a value's text
  const ctx = { log, baseFont: fonts ? { ttf: fonts } : null, pageValues, display };
  const pageAreas = listPageAreas(root.pageSets ?? []);
  const firstArea = (pageAreas[0]?.contentAreas[0]) ?? DEFAULT_PAGE.contentAreas[0];
  const byId = indexIds(root, pageAreas);
  ctx.byId = byId;

  // floating fields measure as what they will show; page numbers have the
  // page count's digits, so a layout reaching ten pages is redone with two
  const run = digits => {
    setEmbedResolver(id => {
      const f = byId.get(id);
      if (!f) return '';
      if (f.pageRole) return '0'.repeat(digits);
      return String(f.display ?? f.raw ?? '');
    });
    try {
      sizeNode(root, firstArea.w, true, ctx.baseFont, ctx);
      return paginate(root, pageAreas, ctx);
    } finally {
      setEmbedResolver(null);
    }
  };
  let pages = run(1);
  if (pages.length >= 10) pages = run(String(pages.length).length);
  return { pages, byId, log };
}

// id → instance node, hidden ones included (floating fields usually are)
function indexIds(root, pageAreas) {
  const byId = new Map();
  const walk = n => {
    if (n.id && !byId.has(n.id)) byId.set(n.id, n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  for (const pa of pageAreas) pa.children.forEach(walk);
  return byId;
}

// ---------------------------------------------------------------------------
// Participation
// ---------------------------------------------------------------------------

export function participates(n) {
  return n.presence !== 'hidden' && n.presence !== 'inactive';
}

// Flow children: participating, with subformSets dissolved into their parent
function flowChildren(n) {
  const out = [];
  for (const c of n.children ?? []) {
    if (!participates(c)) continue;
    if (c.type === 'subformSet') out.push(...flowChildren(c));
    else out.push(c);
  }
  if (n.bookendLeader || n.bookendTrailer) bookends(n, out);
  return out;
}

// A <bookend>: the child its leader names comes first in the container's
// flow, the one its trailer names last ("#id", or a name; the last part of a
// SOM path). A name that is not one of the container's children is ignored.
function bookends(n, out) {
  const find = ref => {
    const r = String(ref).trim();
    const id = r.startsWith('#') ? r.slice(1) : null;
    const name = r.split('.').pop().replace(/\[\d+\]$/, '');
    return out.find(c => (id ? c.id === id : c.name === name)) ?? null;
  };
  const lead = n.bookendLeader ? find(n.bookendLeader) : null;
  const trail = n.bookendTrailer ? find(n.bookendTrailer) : null;
  if (lead) { out.splice(out.indexOf(lead), 1); out.unshift(lead); }
  if (trail && trail !== lead) { out.splice(out.indexOf(trail), 1); out.push(trail); }
}

function dim(v, ref) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return ref === null || ref === undefined || !Number.isFinite(ref) ? null : v.percent / 100 * ref;
  return v;
}

function clamp(v, min, max) {
  let r = v;
  if (max !== null && max !== undefined && typeof max === 'number' && max > 0) r = Math.min(r, max);
  if (typeof min === 'number') r = Math.max(r, min);
  return r;
}

// ---------------------------------------------------------------------------
// Pass 1: size
// ---------------------------------------------------------------------------

/**
 * @param {object} n
 * @param {number} availW   - width offered by the parent (content width)
 * @param {boolean} fill    - an omitted w takes availW (tb children; fields keep their natural width)
 * @param {object|null} parentFont - resolved font of the parent
 * @param {object} ctx
 * @param {number} [forceW] - width imposed by a table column
 */
function sizeNode(n, availW, fill, parentFont, ctx, forceW) {
  n.font_ = resolveFont(n.font, parentFont, ctx.log);
  // minW/minH/maxW/maxH bind fields and draws in every layout (pdf.js
  // Field/Draw layout; Attestation's minH="26mm" multi-line fields in an
  // lr-tb subform print 26mm tall) but not subforms: their content decides
  // (Acrobat prints: Conflict-of-interest's minH="178mm" tb section and
  // imm1294e's minH="23.8mm" positioned education row print at content height)
  const leaf = n.type === 'field' || n.type === 'draw';
  n.lim_ = leaf ? { minW: n.minW, minH: n.minH, maxW: n.maxW, maxH: n.maxH } : NO_LIMITS;
  // relevant: Acrobat lays the form out once for screen and print, so an
  // object excluded from print keeps its space and is just not printed
  n.paint = n.presence !== 'invisible' && isPrintRelevant(n.relevant);

  if (n.type === 'field' || n.type === 'draw') sizeLeaf(n, availW, fill, ctx, forceW);
  else sizeContainer(n, availW, fill, ctx, forceW);
  // an invisible container hides everything inside it
  if (!n.paint) unpaint(n);
}

function unpaint(n) {
  for (const c of n.children ?? []) { c.paint = false; unpaint(c); }
}

function sizeContainer(n, availW, fill, ctx, forceW) {
  const m = n.margin ?? ZERO;
  const declaredW = forceW ?? dim(n.w, availW);
  // a table whose column widths are all given is as wide as its columns,
  // not its parent (ro-pos-cce-application's 102mm + 30mm co-financing
  // table is boxed at 132mm in Reader)
  const columnsFixed = n.layout === 'table' && n.columnWidths?.length > 0 && n.columnWidths.every(w => w >= 0);
  const outerW = declaredW ?? (fill && !columnsFixed && Number.isFinite(availW) ? availW : null);
  const contentW = (outerW ?? availW) - m.left - m.right;
  const kids = flowChildren(n);
  const layout = n.layout ?? 'position';

  let natW = 0;
  let natH = 0;

  if (layout === 'position') {
    for (const c of kids) {
      sizeNode(c, contentW, false, n.font_, ctx);
      const x = dim(c.x, contentW) ?? 0;
      const y = dim(c.y, null) ?? 0;
      const [dx, dy] = anchorOffset(c.anchorType, c.lw, c.lh);
      c.lx = m.left + x + dx;
      c.ly = m.top + y + dy;
      // rotate turns the box counterclockwise about its anchor point (spec §2)
      c.anchorDx = dx;
      c.anchorDy = dy;
      const [, , x1, y1] = rotatedExtent(c, dx, dy);
      natW = Math.max(natW, x + x1);
      natH = Math.max(natH, y + y1);
    }
    // a hidden field with a declared h still stretches its positioned
    // container by that box: it is not laid out, so a growable one adds
    // nothing, nor does a hidden draw (on-1965e's hidden 5.08mm frmInt
    // field makes the header 3pt taller in Reader; on-fw1015e's hidden
    // minH field and hmrc-c1800-chief's hidden help lines do not)
    if (dim(n.h, null) === null) {
      for (const c of n.children ?? []) {
        if (c.presence !== 'hidden' || c.type !== 'field') continue;
        const h = dim(c.h, null);
        if (h === null || c.rotate || (c.anchorType ?? 'topLeft') !== 'topLeft') continue;
        natH = Math.max(natH, (dim(c.y, null) ?? 0) + h);
      }
    }
  } else if (layout === 'tb') {
    let cursor = 0;
    for (const c of kids) {
      sizeNode(c, contentW, true, n.font_, ctx);
      c.lx = m.left;
      c.ly = m.top + cursor;
      cursor += c.lh;
      natW = Math.max(natW, c.lw);
    }
    natH = cursor;
  } else if (layout === 'lr-tb' || layout === 'rl-tb') {
    ({ natW, natH } = sizeLrTb(n, kids, contentW, m, layout === 'rl-tb', ctx));
  } else if (layout === 'table') {
    ({ natW, natH } = sizeTable(n, kids, contentW, m, ctx));
  } else if (layout === 'row' || layout === 'rl-row') {
    // A row outside a table: cells side by side at natural width
    let x = 0;
    for (const c of kids) {
      sizeNode(c, contentW, false, n.font_, ctx);
      c.lx = m.left + x;
      c.ly = m.top;
      x += c.lw;
      natH = Math.max(natH, c.lh);
    }
    for (const c of kids) c.lh = Math.max(c.lh, natH);
    natW = x;
  }

  n.lw = outerW ?? clamp(natW + m.left + m.right, n.lim_.minW, n.lim_.maxW);
  n.lh = dim(n.h, null) ?? clamp(natH + m.top + m.bottom, n.lim_.minH, n.lim_.maxH);
}

function sizeLrTb(n, kids, contentW, m, rightToLeft, ctx) {
  const rows = [];
  let row = null;
  let x = 0;
  for (const c of kids) {
    sizeNode(c, contentW, false, n.font_, ctx);
    if (!row || (x > 0 && x + c.lw > contentW + EPS)) {
      row = { y: 0, h: 0, w: 0, items: [] };
      rows.push(row);
      x = 0;
    }
    c.lx = x; // provisional, fixed below
    row.items.push(c);
    x += c.lw;
    row.w = x;
    row.h = Math.max(row.h, c.lh);
  }
  let y = 0;
  let natW = 0;
  for (const r of rows) {
    r.y = m.top + y;
    for (const c of r.items) {
      c.lx = rightToLeft ? m.left + contentW - c.lx - c.lw : m.left + c.lx;
      c.ly = r.y;
    }
    y += r.h;
    natW = Math.max(natW, r.w);
  }
  n.rows_ = rows;
  return { natW: Number.isFinite(contentW) ? Math.min(natW, contentW) || natW : natW, natH: y };
}

function sizeTable(n, kids, contentW, m, ctx) {
  const widths = (n.columnWidths ?? []).slice();
  const rowsInfo = [];

  // Pass A: natural sizes, column assignment
  for (const k of kids) {
    if (k.layout !== 'row' && k.layout !== 'rl-row') { rowsInfo.push({ node: k, cells: null }); continue; }
    const cells = [];
    let col = 0;
    for (const c of flowChildren(k)) {
      sizeNode(c, contentW, false, k.font_ ?? n.font_, ctx);
      const span = c.colSpan === -1 ? Infinity : Math.max(1, c.colSpan ?? 1);
      cells.push({ node: c, col, span });
      if (span === Infinity) break; // consumes the rest of the row; later siblings dropped
      col += span;
    }
    k.font_ = resolveFont(k.font, n.font_, ctx.log);
    rowsInfo.push({ node: k, cells });
  }
  const nCols = Math.max(widths.length, ...rowsInfo.flatMap(r => (r.cells ?? []).map(c => c.col + (Number.isFinite(c.span) ? c.span : 1))), 0);
  for (let j = 0; j < nCols; j++) {
    if (widths[j] === undefined || widths[j] === -1) {
      let w = -1;
      for (const r of rowsInfo) for (const c of r.cells ?? []) {
        if (c.col === j && c.span === 1) w = Math.max(w, c.node.lw);
      }
      widths[j] = w;
    }
  }
  // Columns whose every cell spans: split what is left
  const unknown = widths.filter(w => w < 0).length;
  if (unknown) {
    const known = widths.filter(w => w >= 0).reduce((a, b) => a + b, 0);
    const share = Number.isFinite(contentW) ? Math.max(0, contentW - known) / unknown : 0;
    for (let j = 0; j < nCols; j++) if (widths[j] < 0) widths[j] = share;
    ctx.log.once('warn', 'XFA_TABLE_SPAN_COLUMN', n.som, `${n.som}: column with only spanning cells; split remaining width`);
  }
  const tableW = widths.reduce((a, b) => a + b, 0);

  // Pass B: cells at column width, rows stretched to the tallest cell
  let cursor = 0;
  for (const r of rowsInfo) {
    const k = r.node;
    if (!r.cells) {
      sizeNode(k, contentW, true, n.font_, ctx);
    } else {
      const rm = k.margin ?? ZERO;
      let x = rm.left;
      let h = 0;
      for (const c of r.cells) {
        const last = Number.isFinite(c.span) ? c.col + c.span : nCols;
        const cw = widths.slice(c.col, last).reduce((a, b) => a + b, 0);
        sizeNode(c.node, cw, true, k.font_, ctx, cw);
        c.node.lx = x;
        c.node.ly = rm.top;
        x += cw;
        h = Math.max(h, c.node.lh);
      }
      for (const c of r.cells) stretchH(c.node, h);
      // cells dropped by a colSpan of -1 do not participate
      k.cells_ = r.cells.map(c => c.node);
      k.lw = Math.max(dim(k.w, contentW) ?? 0, tableW + rm.left + rm.right);
      k.lh = dim(k.h, null) ?? h + rm.top + rm.bottom; // rows sit in a table: no min/max
      k.paint = k.presence !== 'invisible' && isPrintRelevant(k.relevant);
      if (!k.paint) unpaint(k);
    }
    k.lx = m.left;
    k.ly = m.top + cursor;
    cursor += k.lh;
  }
  return { natW: tableW, natH: cursor };
}

// Bounding box, relative to the anchor point, of a box drawn at (dx, dy)
// from the anchor and turned counterclockwise about it (Y down)
function rotatedExtent(n, dx, dy) {
  const a = (n.rotate ?? 0) * Math.PI / 180;
  const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  const pts = [[dx, dy], [dx + n.lw, dy], [dx, dy + n.lh], [dx + n.lw, dy + n.lh]]
    .map(([x, y]) => [x * c + y * s, -x * s + y * c]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function anchorOffset(anchor, w, h) {
  const a = anchor ?? 'topLeft';
  const dx = a.endsWith('Right') ? -w : a.endsWith('Center') ? -w / 2 : 0;
  const dy = a.startsWith('bottom') ? -h : a.startsWith('middle') ? -h / 2 : 0;
  return [dx, dy];
}

// ---------------------------------------------------------------------------
// Leaves: field and draw
// ---------------------------------------------------------------------------

/** Text a leaf shows, before picture formatting (display wins when present). */
export function leafText(n) {
  if (n.type === 'draw') {
    const v = n.value;
    // a draw with no value is empty text (it still holds a line)
    if (!v) return '';
    return v.kind === 'text' || v.kind === 'rich' ? v.text ?? '' : null;
  }
  const kind = n.ui?.kind;
  if (kind === 'checkButton' || kind === 'imageEdit' || kind === 'button') return null;
  const s = n.display ?? n.raw ?? '';
  if (kind === 'passwordEdit') return (n.ui.passwordChar ?? '*').repeat([...(n.raw ?? '')].length);
  return s;
}

function isMultiLine(n) {
  if (n.type === 'draw') return true;
  return n.ui?.kind === 'textEdit' && n.ui.multiLine === true;
}

function captionOf(n) {
  const c = n.caption;
  if (!c || c.presence === 'hidden' || c.presence === 'inactive') return null;
  const text = c.value && (c.value.kind === 'text' || c.value.kind === 'rich') ? c.value.text ?? '' : '';
  if (!text) return null;
  return c;
}

function sizeLeaf(n, availW, fill, ctx, forceW) {
  const m = n.margin ?? ZERO;
  const font = n.font_;
  const lineH = lineHeightOf(font, n.para);
  const cap = captionOf(n);
  const capFont = cap ? resolveFont(cap.font, font, ctx.log) : null;
  const capM = cap?.margin ?? ZERO;
  const capText = cap ? (cap.value.text ?? '') : '';
  const capLineH = cap ? lineHeightOf(capFont, cap.para) : 0;
  const placement = cap ? (cap.placement === 'inline' ? 'left' : cap.placement) : null;
  const horizontalCap = placement === 'left' || placement === 'right';

  const uiM = n.ui?.margin ?? ZERO;
  const text = leafText(n);
  const kind = n.type === 'field' ? n.ui?.kind : null;
  const vk = n.value?.kind;
  // Styled runs: draw rich text and rich captions (spec §4 rich text)
  // plain text with tabs is set as rich text, so its tabs reach the stops
  const tabbed = text?.includes('\t') && kind !== 'passwordEdit' && !(n.ui?.comb > 0) && !n.pageRole ? plainParas(text) : null;
  const valueRich = n.type === 'draw'
    ? (vk === 'rich' && n.value.paras?.length ? n.value.paras : tabbed)
    : (n.richValue ?? (!n.bound && vk === 'rich' && n.value.paras?.length && n.raw === n.value.text ? n.value.paras : tabbed));
  const capRich = cap?.value?.kind === 'rich' && cap.value.paras?.length ? cap.value.paras : null;
  const richOpts = wrap => ({ wrap, log: ctx.log });

  let outerW = forceW ?? dim(n.w, availW);
  const declaredH = dim(n.h, null);

  // Natural caption reserve (spec §7): measured width + margins, or lines × height
  const capNatW = !cap ? 0 : capRich
    ? richNaturalWidth(layoutRich(capRich, capFont, cap.para, Infinity, richOpts(false)))
    : Math.max(...wrapText(capFont, capText, Infinity).map(l => textWidth(capFont, l)), 0);
  const capReserveW = cap ? (cap.reserve ?? capNatW + capM.left + capM.right
    + (capRich ? 0 : (cap.para?.marginLeft ?? 0) + (cap.para?.marginRight ?? 0))) : 0;

  // Natural value size
  let valW;
  if (kind === 'checkButton') valW = n.ui.size + uiM.left + uiM.right;
  else if (valueRich) valW = richNaturalWidth(layoutRich(valueRich, font, n.para, Infinity, richOpts(false))) + uiM.left + uiM.right;
  // the para margins narrow the lines, so the natural width holds them
  // (mn-dhs-4258a's 1pt marginLeft headings stay on one line, as in Reader)
  else if (text !== null) valW = Math.max(0, ...wrapText(font, text, Infinity).map(l => textWidth(font, l))) + uiM.left + uiM.right
    + (text === '' ? 0 : (n.para?.marginLeft ?? 0) + (n.para?.marginRight ?? 0));
  else valW = 0;

  if (outerW === null) {
    const natW = (horizontalCap ? capReserveW : 0) + valW + m.left + m.right;
    const capOnlyW = cap && !horizontalCap ? capReserveW + m.left + m.right : 0;
    // a field with no w takes its natural width even in tb (pdf.js Field
    // layout; Acrobat prints a minW button at minW); draws fill the row
    outerW = fill && Number.isFinite(availW) && n.type === 'draw'
      ? availW
      : clamp(Math.max(natW, capOnlyW), n.lim_.minW, n.lim_.maxW);
    if (Number.isFinite(availW) && outerW > availW && (vk === 'text' || vk === 'rich' || n.type === 'field')) {
      outerW = Math.max(availW, n.lim_.minW ?? 0);
    }
  }

  const contentW = Math.max(0, outerW - m.left - m.right);
  // an automatic side reserve is at most the content width: a long caption
  // wraps inside the field instead of running past it (Acrobat prints of
  // dclUnica 2025's two-line 'Salt la Capitolul II' button)
  const capW = horizontalCap && cap.reserve === null ? Math.min(capReserveW, contentW) : capReserveW;
  const valueRectW = horizontalCap ? Math.max(0, contentW - capW) : contentW;
  const textW = Math.max(0, valueRectW - uiM.left - uiM.right);

  // Lines and heights
  let lines = [];
  let richLines = null;
  let valH;
  if (kind === 'checkButton') {
    valH = n.ui.size + uiM.top + uiM.bottom;
  } else if (valueRich) {
    richLines = layoutRich(valueRich, font, n.para, textW, richOpts(isMultiLine(n)));
    valH = richHeight(richLines) + uiM.top + uiM.bottom + (n.para?.spaceAbove ?? 0) + (n.para?.spaceBelow ?? 0);
  } else if (text !== null) {
    const indent = n.para?.textIndent ?? 0;
    lines = isMultiLine(n) ? wrapText(font, text, textW - (n.para?.marginLeft ?? 0) - (n.para?.marginRight ?? 0), { textIndent: indent }) : (text === '' ? [] : [String(text).replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ')]);
    // empty text holds one line without its gap: the font size (pdf.js
    // lineNoGap; Acrobat prints of Selbstauskunft's empty separator draws and
    // Attestation's empty minH fields)
    valH = blockHeight(lines.length, font, lineH, n.para) + uiM.top + uiM.bottom;
    if (n.para) valH += (n.para.spaceAbove ?? 0) + (n.para.spaceBelow ?? 0);
  } else {
    valH = 0;
  }

  let capLines = [];
  let capRichLines = null;
  let capH = 0;
  if (cap) {
    const capTextW = Math.max(0, horizontalCap ? capW - capM.left - capM.right : contentW - capM.left - capM.right);
    let textH;
    if (capRich) {
      capRichLines = layoutRich(capRich, capFont, cap.para, capTextW, richOpts(true));
      textH = richHeight(capRichLines);
    } else {
      // the caption's para margins narrow its lines, as a value's do
      const cpm = (cap.para?.marginLeft ?? 0) + (cap.para?.marginRight ?? 0);
      capLines = wrapText(capFont, capText, capTextW - cpm, { textIndent: cap.para?.textIndent ?? 0 });
      textH = blockHeight(capLines.length, capFont, capLineH, cap.para);
    }
    capH = cap.reserve !== null && !horizontalCap ? cap.reserve : textH + capM.top + capM.bottom;
  }

  const natH = (horizontalCap ? Math.max(capH, valH) : capH + valH) + m.top + m.bottom;
  const outerH = declaredH ?? clamp(natH, n.lim_.minH, n.lim_.maxH);

  n.lw = outerW;
  n.lh = outerH;

  // Rectangles, relative to the leaf's outer box
  const content = { x: m.left, y: m.top, w: contentW, h: Math.max(0, outerH - m.top - m.bottom) };
  let caption = null;
  let value = { ...content };
  if (cap) {
    const r = horizontalCap ? capW : capH;
    if (placement === 'left') { caption = { ...content, w: r }; value = { ...content, x: content.x + r, w: content.w - r }; }
    else if (placement === 'right') { caption = { ...content, x: content.x + content.w - r, w: r }; value = { ...content, w: content.w - r }; }
    else if (placement === 'top') { caption = { ...content, h: r }; value = { ...content, y: content.y + r, h: content.h - r }; }
    else { caption = { ...content, y: content.y + content.h - r, h: r }; value = { ...content, h: content.h - r }; }
    // a button's caption is its face: without a reserve it takes the whole
    // content box (Acrobat prints centre 'Add Item' on the button)
    if (kind === 'button' && !(cap.reserve > 0)) caption = { ...content };
  }
  n.parts = {
    content,
    caption, captionPlacement: cap ? placement : null, captionFont: capFont, captionLines: capLines, captionLineH: capLineH, captionRich: capRichLines,
    value, lines, lineH, richLines,
  };
}

// A table cell grows to its row's height: a leaf's content, value and side
// captions grow with it (so vAlign works in the full cell); a bottom
// caption moves down
function stretchH(n, h) {
  const d = h - n.lh;
  n.lh = h;
  const p = n.parts;
  if (!p || d <= 0) return;
  // a caption that covers the whole content box (a button face) grows too
  const whole = p.caption && Math.abs(p.caption.h - p.content.h) < EPS;
  p.content = { ...p.content, h: p.content.h + d };
  p.value = { ...p.value, h: p.value.h + d };
  if (!p.caption) return;
  if (whole || p.captionPlacement === 'left' || p.captionPlacement === 'right') p.caption = { ...p.caption, h: p.caption.h + d };
  else if (p.captionPlacement === 'bottom') p.caption = { ...p.caption, y: p.caption.y + d };
}

// Height of n lines of text: the first takes the font size (its ascent to
// descent, without the line gap), each further line the line height (pdf.js
// TextMeasure; Acrobat prints of dclUnica's minH headings and fields). Empty
// text holds one line.
// the first line counts as the font size, or with a set line height as that
// height or the face's own line height, whichever is less (as rich text,
// rich.js); each further line as the line height
function blockHeight(n, font, lineH, para) {
  const first = para?.lineHeight > 0 ? Math.min(lineH, naturalLineHeight(font)) : font.size * font.vScale;
  return first + Math.max(0, n - 1) * lineH;
}

function richNaturalWidth(lines) {
  return Math.max(0, ...lines.map(l => l.width + l.marginLeft + l.marginRight + Math.max(0, l.indent)));
}

// ---------------------------------------------------------------------------
// Pass 2: paginate
// ---------------------------------------------------------------------------

// A paginated set's last page (or only page) takes the page area qualified
// pagePosition="last" (or "only") when its content fits that area's first
// content area: the content moves with the area's origin
function lastPageArea(pages, ctx) {
  const page = pages[pages.length - 1];
  const cur = page?.pageArea;
  if (!cur || !/Paginated$/.test(cur.relation ?? '')) return;
  const onlyOne = !pages.slice(0, -1).some(p => cur.setAreas.includes(p.pageArea));
  const want = cur.setAreas.find(pa => pa.pagePosition === (onlyOne ? 'only' : 'last'))
    ?? (onlyOne ? cur.setAreas.find(pa => pa.pagePosition === 'last') : null);
  if (!want || want === cur) return;
  if (cur.relation === 'duplexPaginated' && want.oddOrEven !== 'any' && (want.oddOrEven === 'odd') !== (pages.length % 2 === 1)) return;
  const from = page.areas?.[0], to = want.contentAreas?.[0];
  if (!from || !to) return;
  const dx = to.x - from.x, dy = to.y - from.y;
  const bottom = Math.max(0, ...page.items.map(it => it.y + it.h));
  if (bottom + dy > to.y + to.h + 0.01 || page.items.some(it => it.x + it.w + dx > to.x + to.w + 0.01)) {
    ctx.log.once('info', 'XFA_LAST_PAGE_AREA', want.name, `last page's content does not fit page area ${want.name}; kept on ${cur.name}`);
    return;
  }
  for (const it of page.items) { it.x += dx; it.y += dy; }
  const size = want.size ?? page;
  Object.assign(page, { pageArea: want, width: size.width ?? page.width, height: size.height ?? page.height });
}

function listPageAreas(pageSets) {
  const out = [];
  for (const ps of pageSets) {
    // the set's page areas and how they are chosen (paginate's qualify)
    for (const pa of ps.pageAreas) { pa.relation = ps.relation; pa.setAreas = ps.pageAreas; }
    out.push(...ps.pageAreas);
    out.push(...listPageAreas(ps.pageSets ?? []));
  }
  return out;
}

const keeps = v => v === 'contentArea' || v === 'pageArea';

function paginate(root, pageAreas, ctx) {
  const pages = [];
  const usage = new Map(); // pageArea → pages used
  const st = { page: null, pageArea: null, areaIdx: 0, area: null, cursor: 0, fresh: true, frames: [] };

  const closeFrame = f => {
    const h = st.cursor - f.y;
    if (h > EPS) {
      f.page.items.splice(f.insertAt, 0,
        { node: f.node, x: f.area.x + f.x, y: f.area.y + f.y, w: f.node.lw, h, paint: f.node.paint, fragment: true });
    }
  };
  // inner frames close first so outer fragments end up before inner ones
  const suspendFrames = () => { for (const f of [...st.frames].reverse()) closeFrame(f); };
  // a split container starts each continuation with its top margin again
  // (Acrobat prints of dclUnica: the bife section resumes 5mm down page 2).
  // On an overflow, the innermost container with an <overflow> that holds
  // the object moved on then repeats its leader (a table's header row),
  // once that has been placed in the flow; an inner one whose overflow names
  // no leader repeats nothing: ro-pos-cce-application's budget sections
  // (subform sets, inside the table) overflow to Page1 without one, and
  // Reader's continuation pages carry no copy of the table's header
  const resumeFrames = () => {
    for (const f of st.frames) {
      Object.assign(f, { page: st.page, area: st.area, y: st.cursor, insertAt: st.page.items.length });
      st.cursor += f.node.margin?.top ?? 0;
    }
    if (!st.overflowing || !st.frames.length) return;
    const ruling = rulingOverflow();
    if (!ruling?.overflowLeader) return;
    const lead = overflowNode(ruling, ruling.overflowLeader);
    if (!lead || !placed.has(lead.node) || lead.node.lh <= EPS) return;
    if (st.cursor + lead.node.lh > st.area.h + EPS) {
      ctx.log.once('info', 'XFA_OVERFLOW_LEADER', ruling.som, `${ruling.som}: overflow leader taller than the content area; left out`);
      return;
    }
    const fresh = st.fresh;
    emit(lead.node, st.area.x + hostX(ruling) + lead.dx, st.area.y + st.cursor);
    st.fresh = fresh; // the area still takes anything that does not fit elsewhere
    st.cursor += lead.node.lh;
  };

  // each instance's parent, subform sets included
  const parents = new Map();
  const link = n => { for (const c of n.children ?? []) { parents.set(c, n); link(c); } };
  link(root);

  // The container whose <overflow> governs a move to the next area: the
  // innermost one holding the object being placed (a subform set dissolved
  // into a table included), within the containers being split
  const rulingOverflow = () => {
    if (!st.frames.length) return null;
    const frameNodes = new Set(st.frames.map(f => f.node));
    for (let a = st.moving && !frameNodes.has(st.moving) ? parents.get(st.moving) : st.moving; a; a = parents.get(a)) {
      if (a.overflow) return a;
      if (a === st.frames[0].node) break;
    }
    return null;
  };
  // a frame's leader or trailer sits at the frame's x; a dissolved subform
  // set's at the x of the innermost frame it flows in
  const hostX = n => (st.frames.find(f => f.node === n) ?? st.frames.at(-1)).x;
  // whether the object being placed is (in) the container's last child: the
  // last piece of a container gets no trailer
  const inLastChild = n => {
    let c = st.moving;
    while (c && parents.get(c) !== n) c = parents.get(c);
    const kids = (n.children ?? []).filter(participates);
    return !c || c === kids[kids.length - 1];
  };
  // The overflow trailer of the ruling container: its height is kept free at
  // the bottom of each area the container continues from
  const trailerOf = () => {
    const r = rulingOverflow();
    if (!r?.overflowTrailer || inLastChild(r)) return null;
    const t = overflowNode(r, r.overflowTrailer);
    return t && t.node.lh > EPS ? { ruling: r, ...t } : null;
  };

  // nodes placed in the flow (an overflow leader repeats only once placed)
  const placed = new Set();
  // The node an overflow leader or trailer names: "#id", else the
  // container's nearest descendant with that name (the last part of a SOM
  // path), with its x offset in the container; null when nothing matches
  const resolved = new Map();
  const overflowNode = (n, ref) => {
    const key = `${n.som}|${ref}`;
    if (resolved.has(key)) return resolved.get(key);
    const r = String(ref).trim();
    const id = r.startsWith('#') ? r.slice(1) : null;
    const name = id ? null : r.split('.').pop().replace(/\[\d+\]$/, '');
    const target = id ? ctx.byId?.get(id) : null;
    let found = null;
    // breadth first: the nearest match
    let level = flowChildren(n).map(c => ({ node: c, dx: c.lx }));
    while (level.length && !found) {
      found = level.find(e => (target ? e.node === target : e.node.name === name)) ?? null;
      level = level.flatMap(e => (e.node.type === 'field' || e.node.type === 'draw' ? [] : (e.node.cells_ ?? flowChildren(e.node)).map(c => ({ node: c, dx: e.dx + c.lx }))));
    }
    if (!found) ctx.log.once('info', 'XFA_OVERFLOW_UNRESOLVED', `${n.som}|${ref}`, `${n.som}: overflow leader or trailer "${ref}" not found`);
    resolved.set(key, found);
    return found;
  };

  const pick = target => {
    if (target && typeof target === 'object') return target; // a page area itself
    if (target) {
      // "#id", "name" or a SOM path such as "ErsteSeite.DS1"; a list takes its first entry
      const first = String(target).trim().split(/\s+/)[0];
      const t = first.replace(/^#/, '');
      const last = t.split('.').pop().replace(/\[\d+\]$/, '');
      const found = pageAreas.find(pa => pa.id === t || pa.name === t)
        ?? pageAreas.find(pa => pa.name === last || pa.id === last);
      if (found) return found;
    }
    // a paginated page set picks by page position and parity
    const q = qualify();
    if (q) return q;
    if (st.pageArea) {
      const used = usage.get(st.pageArea) ?? 0;
      const max = st.pageArea.occur?.max ?? -1;
      if (max === -1 || used < max) return st.pageArea;
      const i = pageAreas.indexOf(st.pageArea);
      if (i + 1 < pageAreas.length) return pageAreas[i + 1];
      return st.pageArea;
    }
    return pageAreas[0] ?? null;
  };

  // simplexPaginated and duplexPaginated page sets (§6 pageArea
  // qualifications): the set's page area whose pagePosition fits (first for
  // the set's first page, rest after it, any always) and, duplex, whose
  // oddOrEven fits the page number; an exact fit beats any. Only sets whose
  // page areas qualify at all choose this way; last and only are settled
  // once the pages are known (lastPageArea)
  const qualifies = set => set?.some(pa => pa.pagePosition !== 'any' || pa.oddOrEven !== 'any');
  const qualify = () => {
    const cur = st.pageArea ?? pageAreas[0];
    if (!cur || !/Paginated$/.test(cur.relation ?? '') || !qualifies(cur.setAreas)) return null;
    const set = cur.setAreas;
    const first = !pages.some(p => set.includes(p.pageArea));
    const pageNo = pages.length + 1;
    const duplex = cur.relation === 'duplexPaginated';
    let best = null, bestScore = -1;
    for (const pa of set) {
      const pos = pa.pagePosition;
      if (!(pos === 'any' || (pos === 'first' && first) || (pos === 'rest' && !first))) continue;
      const odd = pa.oddOrEven;
      if (duplex && odd !== 'any' && (odd === 'odd') !== (pageNo % 2 === 1)) continue;
      const score = (pos === 'any' ? 0 : 2) + (duplex && odd !== 'any' ? 1 : 0);
      if (score > bestScore) { best = pa; bestScore = score; }
    }
    return best;
  };

  const newPage = target => {
    suspendFrames();
    const pa = pick(target);
    usage.set(pa, (usage.get(pa) ?? 0) + 1);
    const size = pa?.size ?? DEFAULT_PAGE;
    const areas = pa?.contentAreas?.length ? pa.contentAreas : DEFAULT_PAGE.contentAreas;
    st.page = { width: size.width, height: size.height, pageArea: pa, items: [], areas, used: new Set() };
    pages.push(st.page);
    st.pageArea = pa;
    st.areaIdx = 0;
    st.area = areas[0];
    st.cursor = 0;
    st.fresh = true;
    resumeFrames();
  };

  // A content area named by a break or overflow target ("#id", "name" or
  // "PageArea.name"): its index on the current page, or -1
  const areaIndex = target => {
    if (!target) return -1;
    const t = String(target).trim().split(/\s+/)[0].replace(/^#/, '');
    const last = t.split('.').pop().replace(/\[\d+\]$/, '');
    return st.page.areas.findIndex(a => a.id === t || a.id === last || (a.name && a.name === last));
  };
  const pageAreaOfArea = target => {
    const t = String(target).trim().split(/\s+/)[0].replace(/^#/, '');
    const segs = t.split('.').map(x => x.replace(/\[\d+\]$/, ''));
    const last = segs[segs.length - 1];
    const holds = pa => (pa.contentAreas ?? []).some(a => a.id === t || a.id === last || (a.name && a.name === last));
    const named = segs.length > 1 ? pageAreas.find(pa => (pa.name === segs[segs.length - 2] || pa.id === segs[segs.length - 2]) && holds(pa)) : null;
    return named ?? pageAreas.find(holds) ?? null;
  };
  const moveToArea = idx => {
    suspendFrames();
    st.areaIdx = idx;
    st.area = st.page.areas[idx];
    st.cursor = 0;
    st.fresh = true;
    resumeFrames();
  };
  // Go to a named content area: on this page while nothing has been placed
  // there yet, else on a new page (hmrc-c1800-chief fills its banner, menu
  // and main content areas in that order, by contentArea breaks)
  // startNew: a new instance of the area even when the flow is already in
  // it (itext-dataset-2page starts its second product on a new page)
  const toArea = (target, startNew = false) => {
    let idx = areaIndex(target);
    if (idx < 0) {
      // a content area of another page area ("Page3.ContentArea3"): a new
      // page of that page area (da-form-5575's instructions print on Page3,
      // without Page2's "continued" header)
      const pa = pageAreaOfArea(target);
      if (!pa) return false;
      const emptyPage = st.fresh && st.areaIdx === 0 && !st.page.used.size;
      if (emptyPage && st.pageArea !== pa) {
        usage.set(st.pageArea, (usage.get(st.pageArea) ?? 1) - 1);
        pages.pop();
      }
      if (!emptyPage || st.pageArea !== pa) newPage(pa);
      idx = areaIndex(target);
      if (idx > 0) moveToArea(idx);
      return true;
    }
    if (idx === st.areaIdx && !(startNew && st.page.used.has(idx))) return true;
    if (st.page.used.has(idx)) {
      newPage(null);
      idx = areaIndex(target);
      if (idx < 0) return true;
    }
    moveToArea(idx);
    return true;
  };

  // Overflow continues in the content area or on the page area named by the
  // innermost container being split that has an overflow target (the
  // registration form's page1 subform continues on its Page2 area, without page
  // 1's footer); without one, in the next content area, then a new page
  const nextArea = () => {
    // the trailer at the bottom of the area being left, when it still fits
    // (the rows already there stay; dclUnica's FooterRow, on-fw1015e)
    const t = trailerOf();
    if (t) {
      if (st.cursor + t.node.lh <= st.area.h + EPS) emit(t.node, st.area.x + hostX(t.ruling) + t.dx, st.area.y + st.area.h - t.node.lh);
      else ctx.log.once('info', 'XFA_OVERFLOW_TRAILER', t.ruling.som, `${t.ruling.som}: no room left for the overflow trailer; left out`);
    }
    st.overflowing = true;
    try { overflowTo(); } finally { st.overflowing = false; }
  };
  const overflowTo = () => {
    const target = [...st.frames].reverse().find(f => f.node.overflowTarget)?.node.overflowTarget ?? null;
    if (target && areaIndex(target) >= 0) {
      const idx = areaIndex(target);
      if (idx !== st.areaIdx && !st.page.used.has(idx)) { moveToArea(idx); return; }
      newPage(null);
      const again = areaIndex(target);
      if (again > 0) moveToArea(again);
      return;
    }
    let idx = st.areaIdx + 1;
    while (idx < st.page.areas.length && st.page.used.has(idx)) idx++;
    if (idx < st.page.areas.length) moveToArea(idx);
    else newPage(target);
  };

  // what is left of the area, less the trailer a continuing container keeps
  // free at its bottom
  const remaining = () => st.area.h - st.cursor - (trailerOf()?.node.lh ?? 0);
  // the bottom margins of the containers being split: each piece of one
  // ends with its bottom margin, so whatever is placed inside must leave
  // room for all of them should the area end after it (anaf-d017's C.b
  // period row, 6mm of three sections' insets short of the area's end,
  // starts page 2 in Reader)
  const openBottoms = () => st.frames.reduce((s, f) => s + (f.node.margin?.bottom ?? 0), 0);

  // rots: rotations inherited from rotated ancestors, outermost first; each
  // { angle, ox, oy } turns counterclockwise about the absolute point (ox, oy)
  const emit = (n, x, y, rots = []) => {
    const own = n.rotate
      ? [...rots, { angle: n.rotate, ox: x - (n.anchorDx ?? 0), oy: y - (n.anchorDy ?? 0) }]
      : rots;
    st.page.items.push({ node: n, x, y, w: n.lw, h: n.lh, paint: n.paint, rots: own });
    st.page.used.add(st.areaIdx);
    placed.add(n);
    const kids = n.type === 'field' || n.type === 'draw' ? [] : (n.cells_ ?? flowChildren(n));
    for (const c of kids) emit(c, x + c.lx, y + c.ly, own);
    st.fresh = false;
  };

  const applyBreaks = (list, before) => {
    for (const b of list ?? []) {
      if (b.targetType === 'pageArea') {
        const emptyPage = before && st.fresh && st.areaIdx === 0 && st.frames.every(f => f.page !== st.page || f.y === 0);
        // a fresh page that already matches the target needs no new page
        if (emptyPage && (!b.target || pick(b.target) === st.pageArea)) continue;
        // nor, without startNew, does any page of the target page area
        // (XFA 3.3 breakBefore startNew="0": ro-pos-cce-application's budget
        // table starts under the co-financing table on page 28, as in Reader,
        // where its section, with startNew="1", started that page)
        if (b.target && !b.startNew && pick(b.target) === st.pageArea) continue;
        if (emptyPage && b.target) {
          // nothing is on this page yet: give it the target page area instead
          usage.set(st.pageArea, (usage.get(st.pageArea) ?? 1) - 1);
          pages.pop();
          st.pageArea = null;
        }
        newPage(b.target);
      } else if (b.targetType === 'contentArea') {
        if (b.target && toArea(b.target, b.startNew)) continue;
        if (before && st.fresh) continue;
        nextArea();
      }
    }
  };

  // a flowed descendant (through split-able containers) with a page or
  // content area break
  const innerBreak = n => {
    if (n.innerBreak_ !== undefined) return n.innerBreak_;
    const breaks = c => [...(c.breakBefore ?? []), ...(c.breakAfter ?? [])].some(b => b.targetType === 'pageArea' || b.targetType === 'contentArea');
    n.innerBreak_ = flowChildren(n).some(c => breaks(c) || (splittable(c) && innerBreak(c)));
    return n.innerBreak_;
  };

  const splittable = n =>
    (n.type === 'subform' || n.type === 'area')
    && ['tb', 'table', 'lr-tb', 'rl-tb'].includes(n.layout)
    && dim(n.h, null) === null
    && flowChildren(n).length > 0;

  // tail: bottom margins of the enclosing containers this node ends, which
  // must fit in the same area as the node's last piece
  // keepWith: first piece of the next sibling this node is kept with
  const place = (n, x, tail = 0, keepWith = 0) => {
    st.moving = n;
    applyBreaks(n.breakBefore, true);
    const intact = n.keep?.intact === 'contentArea' || n.keep?.intact === 'pageArea';
    // keep next/previous: a node that fits but would leave its kept
    // neighbour's first piece on the next area moves on with it
    if (keepWith && !st.fresh && n.lh + tail <= remaining() + EPS
      && n.lh + keepWith > remaining() + EPS && n.lh + keepWith <= st.area.h + EPS) nextArea();

    // nothing of zero height overflows, even after content that already
    // overran the area (eu-mir-7-2-1's empty last subform makes no page);
    // a container with a break inside is flowed piece by piece even when it
    // fits, so the break happens (on-a-103e's submit section starts its own
    // page, as in Reader)
    if ((n.lh + tail <= remaining() + EPS || (n.lh <= EPS && tail <= EPS)) && !(splittable(n) && innerBreak(n))) {
      emit(n, st.area.x + x, st.area.y + st.cursor);
      st.cursor += n.lh;
    } else if (intact && n.lh <= st.area.h + EPS && !st.fresh) {
      nextArea();
      emit(n, st.area.x + x, st.area.y + st.cursor);
      st.cursor += n.lh;
    } else if (splittable(n)) {
      if (intact) ctx.log.info('XFA_KEEP_BROKEN', `${n.som}: keep intact but taller than a content area; split`);
      split(n, x, tail);
    } else if (!intact && splitText(n, x, tail)) {
      // placed in two pieces, between lines
    } else if (!intact && splitPositioned(n, x, tail)) {
      // placed in two pieces
    } else if (!intact && splitBlankRow(n, x, tail)) {
      // a table row of empty boxes, cut where the area ends
    } else {
      if (!st.fresh) nextArea();
      emit(n, st.area.x + x, st.area.y + st.cursor); // may overflow: placed anyway
      st.cursor += n.lh;
    }
    applyBreaks(n.breakAfter, false);
  };

  // a row holding one container, or one text leaf that fills it, is placed
  // like a tb child when it does not fit (it may split)
  const loneItem = row => {
    if (row.items.length !== 1) return false;
    const only = row.items[0];
    if (only.type !== 'field' && only.type !== 'draw') return true;
    return Math.abs(only.lh - row.h) < EPS && only.ly - row.y < EPS && textCut(only) !== null;
  };

  // Place a flowed container piecewise. Its own box (borders, fill) is
  // emitted as one fragment per content area it touches; open frames are
  // closed and reopened whenever the flow moves to a new area.
  const split = (n, x, tail = 0) => {
    const m = n.margin ?? ZERO;
    const end = m.bottom + tail;
    // a split never leaves only the container's top margin behind: when its
    // first piece does not fit, the whole container starts in the next area
    if (!st.fresh && leadHeight(n) > remaining() + EPS) nextArea();
    const frame = { node: n, x, page: st.page, area: st.area, y: st.cursor, insertAt: st.page.items.length };
    st.frames.push(frame);
    st.cursor += m.top;
    if (n.layout === 'lr-tb' || n.layout === 'rl-tb') {
      const rows = n.rows_ ?? [];
      // keep next/previous between rows chain: a heading row kept with a
      // text row kept with a table row moves on with both (mn-dhs-4258a's
      // Substitute caregivers section starts page 3 whole, as in Reader)
      const kept = i => i + 1 < rows.length
        && (rows[i].items.some(c => keeps(c.keep?.next)) || rows[i + 1].items.some(c => keeps(c.keep?.previous)));
      // the last row of the chain only needs its first piece to fit
      const rowLead = r => {
        const only = loneItem(r) ? r.items[0] : null;
        return only && (splittable(only) || textCut(only)) ? leadHeight(only) : r.h;
      };
      const chain = i => (!kept(i) ? 0 : kept(i + 1) ? rows[i + 1].h + chain(i + 1) : rowLead(rows[i + 1]));
      rows.forEach((row, i) => {
        const after = Math.max(i === rows.length - 1 ? end : 0, openBottoms());
        const keepWith = chain(i);
        if (keepWith && !st.fresh && row.h + after <= remaining() + EPS
          && row.h + keepWith > remaining() + EPS && row.h + keepWith <= st.area.h + EPS) nextArea();
        // a row holding one container or one text leaf that does not fit is
        // placed like a tb child (it may split)
        if (row.h + after > remaining() + EPS && loneItem(row)) {
          const only = row.items[0];
          place(only, x + only.lx, after);
          return;
        }
        if (row.h + after > remaining() + EPS && !st.fresh) nextArea();
        const top = st.cursor;
        for (const c of row.items) emit(c, st.area.x + x + c.lx, st.area.y + top + (c.ly - row.y));
        st.cursor = top + row.h;
      });
    } else {
      placeAll(flowChildren(n), x, end);
    }
    st.cursor += m.bottom;
    st.frames.pop();
    closeFrame(frame);
  };

  // A positioned container with no h that does not fit breaks at the highest
  // line no child crosses: the children above stay, the rest move up to the
  // top of the next area (Acrobat prints of dclUnica 2023, whose SECȚIUNEA
  // I.3 area breaks between its I.3.1 and I.3.2 rows; pdf.js never splits
  // a position layout)
  // The boxes a positioned container (or a table row of positioned cells)
  // is cut between, or null when it is not cut: its frames (itself, its
  // cells) and leaves (the children, offsets from its top)
  const cutParts = n => {
    const positioned = c => (c.type === 'subform' || c.type === 'area') && (c.layout ?? 'position') === 'position';
    // a fixed height holds the content together unless page breaks are
    // explicitly allowed (keep intact="none": tx-appellate-docketing's
    // 139.7mm section XII runs on to the next page in Reader)
    const breakable = c => dim(c.h, null) === null || c.keep?.intact === 'none';
    if (positioned(n) && breakable(n)) {
      return { frames: [{ node: n, x: 0, y: 0, h: n.lh }], leaves: flowChildren(n).map(c => ({ node: c, x: c.lx, y: c.ly })) };
    }
    if (n.layout === 'row' && n.cells_?.length && n.cells_.every(c => positioned(c) && breakable(c))) {
      return {
        frames: [{ node: n, x: 0, y: 0, h: n.lh }, ...n.cells_.map(c => ({ node: c, x: c.lx, y: c.ly, h: c.lh }))],
        leaves: n.cells_.flatMap(cell => flowChildren(cell).map(c => ({ node: c, x: cell.lx + c.lx, y: cell.ly + c.ly }))),
      };
    }
    return null;
  };
  const crosses = (leaves, cut) => leaves.some(l => l.y < cut - EPS && l.y + l.node.lh > cut + EPS);
  // the height of the first piece such a node can be cut into
  const firstBand = n => {
    const parts = cutParts(n);
    if (!parts) return null;
    const lines = [...new Set(parts.leaves.map(l => l.y).filter(y => y > EPS))].sort((a, b) => a - b);
    return lines.find(y => !crosses(parts.leaves, y)) ?? null;
  };

  // A growable text draw or multi-line text field that does not fit, or
  // one whose fixed height is taller than a content area, is cut between
  // lines, as Reader does: the lines that fit stay (with a top caption),
  // the rest continue in the next areas (anaf-d1000's 457mm article text
  // runs on from page to page instead of overflowing one). A top caption
  // may stay behind alone (on-a-103e's empty explanation box starts on the
  // next page under its caption on this one). textCut gives its lines, the
  // fewest the first piece holds, and the height of a box holding some.
  const textCut = n => {
    if (n.textCut_ !== undefined) return n.textCut_;
    n.textCut_ = null;
    const p = n.parts;
    if (!p || n.rotate || n.pageRole) return null;
    const fixed = dim(n.h, null) !== null;
    const textual = n.type === 'draw' ? (n.value?.kind === 'text' || n.value?.kind === 'rich')
      : n.type === 'field' && n.ui?.kind === 'textEdit' && isMultiLine(n);
    const rich = p.richLines ?? null;
    const lines = rich ?? p.lines ?? [];
    // an empty field is a blank box, cut anywhere whatever its alignment
    // (ro-pos-cce-application's 2.3.3 box, no caption and vAlign middle,
    // runs from page 13 onto page 14 in Reader)
    const empty = n.type === 'field' && !lines.length;
    if (!textual || (!empty && (n.para?.vAlign ?? 'top') !== 'top')) return null;
    if (p.caption && p.captionPlacement !== 'top') return null;
    const minLines = p.caption || empty ? 0 : 1;
    if (lines.length < 2 && !p.caption && !empty) return null;
    const height = list => (!list.length ? 0 : rich ? richHeight(list) : blockHeight(list.length, n.font_, p.lineH, n.para));
    const m = n.margin ?? ZERO;
    const uiM = n.ui?.margin ?? ZERO;
    const capH = p.value.y - m.top;
    // the box around the text: margins, caption, ui margins, para spacing
    const around = m.top + m.bottom + capH + uiM.top + uiM.bottom + (n.para?.spaceAbove ?? 0) + (n.para?.spaceBelow ?? 0);
    const box = (from, to, withCaption) => around + height(lines.slice(from, to)) - (withCaption ? 0 : capH);
    // a piece's lines are painted at the full pitch, the first included: a
    // cut is made where they fit so (anaf-d1000's article text leaves its
    // 47th line, which fits only by the first line's gap, for page 4)
    const gap = from => (!lines[from] ? 0 : rich ? lines[from].gap ?? 0 : p.lineH - blockHeight(1, n.font_, p.lineH, n.para));
    const fit = (from, to, withCaption) => box(from, to, withCaption) + (to > from ? gap(from) : 0);
    // an empty field still holds one (empty) line where its alignment puts
    // it, which a cut does not go through: middle-aligned, the first piece
    // reaches past the middle; bottom-aligned, it is not cut (Reader cuts
    // ro-pos-cce-application's 2.3.3 box with 137pt left but moves its
    // 221pt 2.3.2 context box whole with 41pt left)
    const va = n.para?.vAlign ?? 'top';
    const lead = !empty || va === 'top' ? null : va === 'middle' ? (n.lh + (p.lineH ?? n.font_?.size ?? 10)) / 2 : n.lh;
    n.textCut_ = { fixed, rich, lines, minLines, capH, m, box, fit, lead };
    return n.textCut_;
  };
  // lines from..to of a plain-text leaf keep their paragraph ends (justify)
  const sliceLines = (lines, from, to) => {
    const out = lines.slice(from, to);
    if (lines.paraEnds) out.paraEnds = new Set([...lines.paraEnds].filter(i => i >= from && i < to).map(i => i - from));
    return out;
  };
  const splitText = (n, x, tail) => {
    const c = textCut(n);
    if (!c || c.fixed && n.lh <= st.area.h + EPS) return false;
    if (c.lead !== null && remaining() - tail < c.lead - EPS) return false;
    const { lines, rich, minLines, capH, m, box, fit } = c;
    const top = n.parts.value.y;
    // how many lines from `from` fit in the room (-1: not even the fewest)
    const fitting = (from, withCaption, room) => {
      const least = withCaption ? minLines : 1;
      if (fit(from, from + least, withCaption) > room + EPS) return -1;
      let k = least;
      while (from + k < lines.length && fit(from, from + k + 1, withCaption) <= room + EPS) k++;
      return k;
    };
    let k = fitting(0, true, remaining() - tail);
    // a field box taller than its text is cut anywhere below the text: the
    // first piece fills the area, the blank rest carries on (on-a-103e's
    // empty explanation boxes run from page 4 onto page 5 in Reader)
    const blank = n.type === 'field' && k === lines.length && n.lh - box(0, k, true) > EPS;
    // all the lines fit: only a caption with nothing under it is cut off
    if (!blank && k === lines.length && (lines.length || n.lh - box(0, 0, true) <= EPS)) return false;
    if (k < 0) {
      if (st.fresh) return false;
      nextArea();
      if (n.lh + tail <= remaining() + EPS) {
        emit(n, st.area.x + x, st.area.y + st.cursor);
        st.cursor += n.lh;
        return true;
      }
      k = fitting(0, true, remaining() - tail);
      if (k < 0 || k === lines.length && lines.length) {
        emit(n, st.area.x + x, st.area.y + st.cursor); // may overflow: placed anyway
        st.cursor += n.lh;
        return true;
      }
    }
    const piece = (from, to, withCaption, h) => {
      const vy = withCaption ? top : top - capH;
      const p = n.parts;
      const parts = {
        ...p,
        content: { ...p.content, h: h - p.content.y - m.bottom },
        value: { ...p.value, y: vy, h: h - vy - m.bottom },
        caption: withCaption ? p.caption : null,
      };
      if (rich) parts.richLines = lines.slice(from, to); else parts.lines = sliceLines(lines, from, to);
      return { ...n, parts, lh: h };
    };
    // the first piece, with the caption, is never the last: a cut leaves
    // lines, or the empty value box, for the next area
    let it = piece(0, k, true, blank && k >= 0 ? Math.max(box(0, k, true), remaining() - tail) : box(0, k, true));
    emit(it, st.area.x + x, st.area.y + st.cursor);
    st.cursor += it.lh;
    let used = it.lh;
    let from = k;
    for (;;) {
      nextArea();
      k = from < lines.length ? Math.max(1, fitting(from, false, remaining() - tail)) : 0;
      const last = from + k >= lines.length;
      // the last piece keeps what is left of a minH or fixed h
      const h = box(from, from + k, false);
      it = piece(from, from + k, false, last ? Math.max(h, n.lh - used) : h);
      emit(it, st.area.x + x, st.area.y + st.cursor);
      st.cursor += it.lh;
      used += it.lh;
      from += k;
      if (last) return true;
    }
  };

  // A table row whose cells are all empty text fields that can grow is cut
  // where the area ends, as a blank field is: each cell's first piece fills
  // the room left, the rest of its height carries on at the top of the next
  // area (ro-pos-cce-application's 2.3.3 justification box, the one cell of
  // its table's second row, runs from page 13 onto page 14 in Reader)
  // its cells and the height of the smallest first piece, or null
  const blankRow = n => {
    if (n.layout !== 'row' || !n.cells_?.length) return null;
    const cuts = n.cells_.map(c => [c, c.type === 'field' ? textCut(c) : null]);
    if (!cuts.every(([c, t]) => t && !t.fixed && !t.lines.length && c.lh >= n.lh - EPS)) return null;
    return { cuts, least: Math.max(...cuts.map(([, t]) => t.lead ?? t.box(0, 0, true))) };
  };
  const splitBlankRow = (n, x, tail) => {
    const b = st.fresh ? null : blankRow(n);
    if (!b) return false;
    const { cuts, least } = b;
    const room = remaining() - tail;
    if (room <= least + EPS || room >= n.lh - EPS) return false;
    const blank = (c, t, h, first) => {
      const p = c.parts;
      const vy = first ? p.value.y : p.value.y - t.capH;
      return { ...c, lh: h, parts: { ...p, lines: [], content: { ...p.content, h: h - p.content.y - t.m.bottom },
        value: { ...p.value, y: vy, h: h - vy - t.m.bottom }, caption: first ? p.caption : null } };
    };
    const piece = (h, first) => {
      const top = st.cursor;
      st.page.items.push({ node: n, x: st.area.x + x, y: st.area.y + top, w: n.lw, h, paint: n.paint, fragment: true });
      for (const [c, t] of cuts) emit(blank(c, t, h, first), st.area.x + x + c.lx, st.area.y + top + c.ly);
      st.cursor = top + h;
    };
    piece(room, true);
    nextArea();
    piece(Math.max(n.lh - room, Math.max(...cuts.map(([, t]) => t.box(0, 0, false)))), false);
    return true;
  };

  const splitPositioned = (n, x, tail) => {
    if (st.fresh) return false;
    const parts = cutParts(n);
    if (!parts) return false;
    const { frames, leaves } = parts;
    const room = remaining() - tail;
    const over = leaves.filter(l => l.y + l.node.lh > room + EPS);
    if (!over.length || over.length === leaves.length) return false;
    const cut = Math.min(...over.map(l => l.y));
    if (cut <= EPS || crosses(leaves, cut)) return false;
    const piece = (from, to) => {
      const top = st.cursor;
      for (const f of frames) {
        const y0 = Math.max(f.y, from), y1 = Math.min(f.y + f.h, to);
        if (y1 - y0 > EPS) {
          st.page.items.push({ node: f.node, x: st.area.x + x + f.x, y: st.area.y + top + y0 - from, w: f.node.lw, h: y1 - y0, paint: f.node.paint, fragment: true });
        }
      }
      for (const l of leaves) {
        if (l.y >= from - EPS && l.y < to - EPS) emit(l.node, st.area.x + x + l.x, st.area.y + top + l.y - from);
      }
      st.cursor = top + (to - from);
    };
    piece(0, cut);
    nextArea();
    piece(cut, n.lh);
    return true;
  };

  // Children stacked in order; the last carries the closing margins
  const placeAll = (kids, x, end) => kids.forEach((c, i) => {
    const next = kids[i + 1];
    const kept = next && (keeps(c.keep?.next) || keeps(next.keep?.previous));
    place(c, x + c.lx, Math.max(i === kids.length - 1 ? end : 0, openBottoms()), kept ? leadHeight(next) : 0);
  });

  // Height of the first piece a container can be split into: its top margin
  // plus the first row (lr-tb) or the first child's first piece (tb)
  const leadHeight = n => {
    if (!splittable(n)) {
      if (n.keep?.intact === 'contentArea' || n.keep?.intact === 'pageArea') return n.lh;
      const b = blankRow(n);
      if (b) return b.least;
      const c = textCut(n);
      if (c && !c.fixed) return c.box(0, c.minLines, true);
      return firstBand(n) ?? n.lh;
    }
    const m = n.margin ?? ZERO;
    if (n.layout === 'lr-tb' || n.layout === 'rl-tb') {
      const row = n.rows_?.[0];
      if (!row) return m.top;
      const only = loneItem(row) ? row.items[0] : null;
      return m.top + (only && (splittable(only) || textCut(only)) ? leadHeight(only) : row.h);
    }
    const first = flowChildren(n)[0];
    return m.top + (first ? leadHeight(first) : 0);
  };

  newPage(null);
  if (root.layout === 'position' || !splittable(root)) {
    emit(root, st.area.x, st.area.y);
  } else {
    // The root's own box is not painted per page; flow its children
    const m = root.margin ?? ZERO;
    st.cursor += m.top;
    placeAll(flowChildren(root), 0, 0);
  }

  lastPageArea(pages, ctx);

  // pageArea boilerplate on every page, positioned from the page origin
  for (const page of pages) {
    const pa = page.pageArea;
    if (!pa) continue;
    // the values page-dependent scripts give on this page ("Page 2 / 5"):
    // the fields are sized with them, and this page's items keep a copy
    const values = ctx.pageValues?.(pages.indexOf(page) + 1, pages.length);
    const saved = new Map();
    for (const [n, raw] of values ?? []) {
      saved.set(n, [n.raw, n.display]);
      n.raw = raw;
      n.display = ctx.display ? ctx.display(n) : raw === null || raw === undefined ? '' : String(raw);
    }
    const boiler = [];
    for (const c of pa.children ?? []) {
      if (!participates(c)) continue;
      sizeNode(c, page.width, false, ctx.baseFont, ctx);
      const [dx, dy] = anchorOffset(c.anchorType, c.lw, c.lh);
      c.anchorDx = dx;
      c.anchorDy = dy;
      const save = st.page;
      st.page = { items: boiler, used: new Set() };
      emit(c, (dim(c.x, page.width) ?? 0) + dx, (dim(c.y, page.height) ?? 0) + dy);
      st.page = save;
    }
    if (saved.size) {
      for (const it of boiler) if (saved.has(it.node)) it.node = Object.assign(Object.create(Object.getPrototypeOf(it.node)), it.node);
      for (const [n, [raw, display]] of saved) { n.raw = raw; n.display = display; }
    }
    page.items = boiler.concat(page.items);
    page.pageNumber = pages.indexOf(page) + 1;
    page.pageCount = pages.length;
    delete page.areas;
  }
  return pages;
}
