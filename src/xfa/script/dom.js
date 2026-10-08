/**
 * Purefield / xfa / script / dom.js
 *
 * The XFA object model that form scripts see, over the bound instance tree
 * (bind.js) and the data DOM. Both interpreters (formcalc.js, js.js) work
 * through it, so what a script can read and change is decided here:
 *
 *   form nodes  name, className, parent, index, nodes, somExpression,
 *               presence, relevant, rawValue, formattedValue, editValue,
 *               isNull, x, y, w, h, instanceManager, locale; children by
 *               name, seeing through nameless containers (as pdf.js's
 *               $getChildrenByName); "_name" is the instance manager of the
 *               children called name
 *   data nodes  name, value, isNull, className, parent, nodes; children by
 *               name, attributes included (Attestation reads
 *               $record.FrgBoutons.watermark1.presence, an attribute)
 *   xfa         form, datasets, record, host, layout, event; resolveNode(s)
 *
 * A script changes the instance tree only through presence, relevant,
 * rawValue, formattedValue (kept as the display text, format.js), item
 * lists and geometry. Anything else a script sets is logged and ignored;
 * anything it calls that has no meaning without a viewer (instance
 * changes, layout queries before layout) throws ScriptError, which ends
 * that script.
 */

import { parseRelevant, patchBorder } from '../model.js';
import { leafValue, addInstance as bindAddInstance, removeInstance as bindRemoveInstance, moveInstance as bindMoveInstance } from '../bind.js';
import { displayValue } from '../format.js';
import { formatPicture } from '../picture.js';
import { toPt } from '../../core/units.js';

/** A script that cannot run here: the runner logs it and moves on */
export class ScriptError extends Error {}

const PRESENCES = new Set(['visible', 'hidden', 'invisible', 'inactive']);
const NUMERIC = new Set(['integer', 'decimal', 'float']);
// nameless containers are transparent to name lookups
const TRANSPARENT = new Set(['subform', 'subformSet', 'area', 'exclGroup', 'pageSet']);
// Containers a name is found through: nameless ones, and areas even when
// named (dclUnica's scripts reach Cap1.G12.I12 through the area G1 that
// holds G12, and Cap2.G1.G11 by its name too)
const seeThrough = c => c.type === 'area' || (!c.name && TRANSPARENT.has(c.type));

export class XfaDom {
  /**
   * @param {object} root - instance root from bindData()
   * @param {{ record?: Element|null, dataEl?: Element|null, locales?: object,
   *   log?: import('../log.js').XfaLog, now?: Date }} [opts]
   */
  constructor(root, { record = null, dataEl = null, locales = {}, log, now, layout = null } = {}) {
    this.root = root;
    this.record = record;
    this.dataEl = dataEl ?? (record?.parentNode?.nodeType === 1 ? record.parentNode : null);
    this.locales = locales;
    this.log = log;
    this.now = now ?? new Date();
    this.parents = new Map();
    this.wrappers = new Map();
    // <variables> of each container: script objects and named values
    this.variables = new Map();
    // set by the runner: run a node's scripts for an activity (execEvent)
    this.fireEvent = null;
    this.link(root, null);
    this.formRoot = new FormRoot(this);
    this.xfa = new XfaRoot(this);
    // a previous pass's layout, for layout queries (index.js lays out twice)
    this.xfa.layout.known = layout;
  }

  addVariable(inst, name, item) {
    if (!this.variables.has(inst)) this.variables.set(inst, new Map());
    this.variables.get(inst).set(name, item);
  }

  link(n, parent) {
    this.parents.set(n, parent);
    for (const c of kidsOf(n)) this.link(c, n);
  }

  /** The wrapper for an instance node or a data DOM node */
  wrap(n) {
    if (n === null || n === undefined) return null;
    let w = this.wrappers.get(n);
    if (!w) {
      w = this.parents.has(n) ? new FormNode(this, n) : new DataNode(this, n);
      this.wrappers.set(n, w);
    }
    return w;
  }

  /** The locale a node formats with: its own, else the nearest ancestor's */
  localeOf(n) {
    for (let p = n; p; p = this.parents.get(p)) if (p.locale) return p.locale;
    return 'en_US';
  }

  /** The script-wide shortcuts: $record, $data, $form, $host, … */
  shortcut(name, current) {
    switch (name) {
      case '$': return current;
      // "this" in a SOM string: the object whose script is running
      case 'this': return this.xfa?.event?.target ?? current;
      case '$record': return this.wrap(this.record);
      case '$data': return this.wrap(this.dataEl);
      case '$form': return this.formRoot;
      case '$host': return this.xfa.host;
      case '$layout': return this.xfa.layout;
      case '$event': return this.xfa.event;
      case 'xfa': return this.xfa;
      case '!': return this.xfa.datasets;
      case '$template': case '$config': case '$connectionSet': case '$signature':
        throw new ScriptError(`${name} is not available`);
      default: return undefined;
    }
  }

  /**
   * An unqualified name, as SOM scoping finds it: among the children of
   * the current container, then of each ancestor in turn (pdf.js searchNode)
   * @returns {object[]} matches (empty when nothing is in scope)
   */
  lookup(name, current) {
    for (let scope = current; scope; scope = scope.parent) {
      const hits = scope.childrenByName(name);
      if (hits.length) return hits;
    }
    return [];
  }

  /**
   * Resolve a SOM expression string (resolveNode, resolveNodes)
   * @returns {object[]}
   */
  resolve(som, current) {
    const segs = splitSom(String(som).trim());
    if (!segs.length) return [];
    let nodes;
    const first = segs[0];
    const head = /^([^[]+)(?:\[(\*|[+-]?\d+)\])?$/.exec(first.name);
    if (!head) throw new ScriptError(`Unsupported SOM expression "${som}"`);
    // "#items", "#field": the current object's children of that class
    if (head[1][0] === '#') {
      nodes = pick(current?.childrenByClass?.(head[1].slice(1)) ?? [], head[2] ?? '*');
      return this.resolveRest(nodes, segs.slice(1), som);
    }
    const sc = this.shortcut(head[1], current);
    if (sc !== undefined) nodes = sc ? [sc] : [];
    else nodes = this.lookup(head[1], current);
    // a property object of the current node ("caption.value")
    if (!nodes.length && sc === undefined) nodes = propertyObject(current, head[1]);
    nodes = pick(nodes, head[2]);
    return this.resolveRest(nodes, segs.slice(1), som);
  }

  resolveRest(nodes, segs, som) {
    for (const seg of segs) {
      const m = /^([^[]+)(?:\[(\*|[+-]?\d+)\])?$/.exec(seg.name);
      if (!m) throw new ScriptError(`Unsupported SOM expression "${som}"`);
      const next = [];
      for (const n of nodes) {
        let kids = seg.op === '..' ? n.descendantsByName?.(m[1]) ?? []
          : seg.op === '.#' ? n.childrenByClass?.(m[1]) ?? []
          : n.childrenByName(m[1]);
        if (!kids.length && seg.op === '.') kids = propertyObject(n, m[1]);
        next.push(...pick(kids, m[2]));
        if (m[2] !== '*' && next.length) break;
      }
      nodes = next;
    }
    return nodes;
  }
}

function propertyObject(n, name) {
  const v = n?.getProperty?.(name)?.value;
  return v !== null && typeof v === 'object' && typeof v.childrenByName === 'function' ? [v] : [];
}

function pick(nodes, idx) {
  if (idx === '*') return nodes;
  const i = idx === undefined ? 0 : parseInt(idx, 10);
  return nodes[i] ? [nodes[i]] : [];
}

// "a.b[2]..c.#d" → [{op:'.', name:'a'}, {op:'.', name:'b[2]'}, {op:'..', name:'c'}, …]
function splitSom(s) {
  const out = [];
  let cur = '', op = '.', depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // "AreaLeft_A\.1": a dot that is part of the name
    if (ch === '\\' && s[i + 1] === '.') { cur += '.'; i++; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      if (cur) out.push({ op, name: cur });
      cur = '';
      if (s[i + 1] === '.') { op = '..'; i++; } else if (s[i + 1] === '#') { op = '.#'; i++; } else op = '.';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push({ op, name: cur });
  return out;
}

// Instance-tree children, page sets and page areas included. Page sets
// come after the content, so form1.Page1 is the subform Page1 rather than a
// page area of the same name (Conflict-of-interest, imm1294e)
function kidsOf(n) {
  if (n.type === 'pageSet') return [...(n.pageAreas ?? []), ...(n.pageSets ?? [])];
  return [...(n.children ?? []), ...(n.pageSets ?? [])];
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export class NodeList {
  constructor(items) { this.items = items; }
  get length() { return this.items.length; }
  item(i) { return this.items[i] ?? null; }
  getProperty(name) {
    if (name === 'length') return { value: this.items.length };
    if (name === 'className') return { value: 'nodeList' };
    return undefined;
  }
  call(name, args) {
    if (name === 'item') return this.item(Number(args[0]));
    if (name === 'append') { this.items.push(args[0]); return null; }
    if (name === 'namedItem') return this.items.find(n => n.name === String(args[0])) ?? null;
    throw new ScriptError(`nodeList.${name}() is not supported`);
  }
  childrenByName() { return []; }
}

// ---------------------------------------------------------------------------
// Form nodes
// ---------------------------------------------------------------------------

export class FormNode {
  constructor(dom, inst) {
    this.dom = dom;
    this.inst = inst;
  }

  get name() { return this.inst.name ?? ''; }
  get className() { return this.inst.type; }
  get parent() {
    const p = this.dom.parents.get(this.inst);
    return p ? this.dom.wrap(p) : (this.inst === this.dom.root ? this.dom.formRoot : null);
  }
  get children() { return kidsOf(this.inst).map(c => this.dom.wrap(c)); }

  childrenByName(name) {
    if (name === 'parent') return [];
    const out = [];
    const walk = n => {
      const v = this.dom.variables.get(n)?.get(name);
      if (v) out.push(v);
      for (const c of kidsOf(n)) {
        if (c.name === name) out.push(this.dom.wrap(c));
        else if (seeThrough(c)) walk(c);
      }
    };
    walk(this.inst);
    // _name: the instance manager of the subforms called name, which exists
    // even when there are no instances
    if (!out.length && name.startsWith('_') && name.length > 1) {
      const target = name.slice(1);
      const protos = n => (n.proto ?? n).children ?? [];
      const has = n => protos(n).some(c => (c.name === target && (c.type === 'subform' || c.type === 'subformSet'))
        || (seeThrough(c) && has(c)));
      if (has(this.inst)) return [new InstanceManager(this, target)];
    }
    return out;
  }

  childrenByClass(cls) {
    // #items: the item lists (a check box's on and off values)
    if (cls === 'items') return (this.inst.items ?? []).map(l => new ItemsNode(l));
    if (PROPERTY_OBJECTS.has(cls)) return [new PropObject(this, [cls])];
    return kidsOf(this.inst).filter(c => c.type === cls).map(c => this.dom.wrap(c));
  }

  descendantsByName(name) {
    const out = [];
    const walk = n => {
      for (const c of kidsOf(n)) {
        if (c.name === name) out.push(this.dom.wrap(c));
        walk(c);
      }
    };
    walk(this.inst);
    return out;
  }

  /** @returns {{ value: any }|undefined} undefined when not a property */
  getProperty(name) {
    const n = this.inst;
    switch (name) {
      case 'name': return { value: this.name };
      case 'className': return { value: n.type };
      case 'parent': return { value: this.parent };
      case 'index': return { value: n.index ?? 0 };
      case 'nodes': return { value: new NodeList(this.children) };
      case 'somExpression': return { value: somExpression(n) };
      case 'presence': return { value: n.presence ?? 'visible' };
      case 'relevant': return { value: (n.relevant ?? []).map(r => (r.excluded ? '-' : '') + r.view).join(' ') };
      case 'locale': return { value: this.dom.localeOf(n) };
      case 'access': return { value: n.access ?? 'open' };
      case 'mandatory': return { value: 'disabled' };
      case 'x': case 'y': case 'w': case 'h':
        return { value: n[name] === null || n[name] === undefined ? '0in' : `${n[name]}pt` };
      case 'instanceManager':
        return n.type === 'subform' || n.type === 'subformSet' ? { value: new InstanceManager(this.parent, n.name) } : undefined;
      case 'all': return { value: new NodeList(this.parent ? this.parent.childrenByName(this.name) : [this]) };
      case 'isContainer': return { value: true };
      case 'fontColor': return { value: (n.font?.color ?? [0, 0, 0]).join(',') };
      // the border's fill colour (white when there is no visible fill)
      case 'fillColor': {
        const f = n.border?.fill;
        return { value: (f && f.presence !== 'hidden' && f.presence !== 'invisible' ? f.color : [255, 255, 255]).join(',') };
      }
    }
    if (PROPERTY_OBJECTS.has(name)) return { value: new PropObject(this, [name]) };
    if (name === 'dataNode' && (n.type === 'field' || n.type === 'exclGroup')) {
      return { value: n.bind?.match === 'none' ? null : new FieldData(this.dom, n) };
    }
    if (n.type === 'field' || n.type === 'exclGroup' || n.type === 'draw') {
      switch (name) {
        case 'rawValue': return { value: this.rawValue() };
        case 'formattedValue': return { value: this.formattedValue() };
        case 'editValue': return { value: this.editValue() };
        case 'isNull': { const v = this.rawValue(); return { value: v === null || v === '' }; }
        case 'length': return n.items ? { value: this.itemPairs().length } : undefined;
        case 'selectedIndex': {
          const raw = n.raw;
          return { value: this.itemPairs().findIndex(p => p.save === raw) };
        }
      }
    }
    return undefined;
  }

  /** @returns {boolean} false when the property is not one scripts may set */
  setProperty(name, value) {
    const n = this.inst;
    switch (name) {
      case 'presence': {
        const v = String(value);
        if (!PRESENCES.has(v)) throw new ScriptError(`Invalid presence "${v}"`);
        // a table row prePrint hides keeps its height in Reader's print
        // (mn-dhs-4258a's add-row footers leave their gap under the table);
        // other containers close up (hmrc-c1800-chief's help text)
        const row = n.layout === 'row' && this.dom.parents.get(n)?.layout === 'table';
        n.presence = v === 'hidden' && row && this.dom.printing && n.presence !== 'hidden' ? 'invisible' : v;
        return true;
      }
      case 'relevant': n.relevant = parseRelevant(String(value ?? '')); return true;
      case 'fontColor': setFont(n, 'color', value); return true;
      case 'fillColor': {
        const color = parseColor(value);
        if (!color) return true;
        const b = n.border ?? { presence: 'visible', hand: 'even', edges: [], corners: [], edgesGiven: 0, cornersGiven: 0, fill: null };
        n.border = { ...b, fill: { pattern: 'solid', ...(b.fill ?? {}), presence: 'visible', color } };
        return true;
      }
      // interactive-only: nothing to print
      case 'access': n.access = String(value); return true;
      case 'mandatory': case 'validationMessage': case 'borderColor': case 'borderWidth':
      case 'toolTip': case 'speak':
        return true;
      case 'x': case 'y': case 'w': case 'h': {
        const pt = typeof value === 'number' ? value : toPt(String(value));
        if (!Number.isFinite(pt)) throw new ScriptError(`Invalid measurement "${value}"`);
        n[name] = pt;
        return true;
      }
    }
    if (n.type === 'field' || n.type === 'exclGroup' || n.type === 'draw') {
      switch (name) {
        case 'rawValue': this.assign(value); return true;
        case 'formattedValue':
          if (n.type === 'draw') { this.assign(value); return true; }
          n.raw = value === null || value === undefined ? null : String(value);
          n.scriptDisplay = n.raw ?? '';
          return true;
        case 'editValue': this.assign(value); return true;
        case 'selectedIndex': {
          const p = this.itemPairs()[Number(value)];
          this.assign(p ? p.save : null);
          return true;
        }
      }
    }
    this.dom.log?.once('info', 'XFA_SCRIPT_PROPERTY_IGNORED', name, `Scripts setting "${name}" are ignored`);
    return false;
  }

  /** The value of the node itself: field.rawValue, else null */
  scalar() {
    const t = this.inst.type;
    return t === 'field' || t === 'exclGroup' || t === 'draw' ? this.rawValue() : null;
  }

  /** Assigning to the node itself sets its value */
  assign(value) {
    const n = this.inst;
    if (n.type === 'draw') {
      n.value = { kind: 'text', text: value === null || value === undefined ? '' : toText(value) };
      return;
    }
    if (n.type !== 'field' && n.type !== 'exclGroup') throw new ScriptError(`Cannot assign a value to a ${n.type}`);
    n.raw = value === null || value === undefined ? null : toText(value);
    delete n.scriptDisplay;
    delete n.richValue;
    if (n.type === 'exclGroup') for (const c of n.children) if (c.type === 'field') c.raw = n.raw;
  }

  rawValue() {
    const n = this.inst;
    if (n.type === 'draw') return n.value?.text ?? null;
    const raw = n.raw;
    if (raw === null || raw === undefined || raw === '') return null;
    const type = n.value?.valueType ?? (n.ui?.kind === 'numericEdit' ? 'decimal' : null);
    if (NUMERIC.has(type) || (n.ui?.kind === 'checkButton' && /^-?\d+$/.test(raw))) {
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
    return raw;
  }

  formattedValue() {
    const n = this.inst;
    if (n.type === 'draw') return n.value?.text ?? '';
    if (n.scriptDisplay !== undefined) return n.scriptDisplay;
    return displayValue(n, { locales: this.dom.locales, locale: this.dom.localeOf(n), log: this.dom.log }) ?? (n.raw ?? '');
  }

  editValue() {
    const n = this.inst;
    if (n.raw === null || n.raw === undefined) return '';
    const pic = n.ui?.picture;
    if (!pic) return n.raw;
    return formatPicture(pic, n.raw, { locale: this.dom.localeOf(n), locales: this.dom.locales, kind: n.ui?.kind });
  }

  itemPairs() {
    const lists = this.inst.items ?? [];
    let save = lists.find(l => l.save);
    let disp = lists.find(l => l !== save);
    if (!save) { save = lists[0]; disp = lists[1] ?? lists[0]; }
    if (!save) return [];
    if (!disp) disp = save;
    return save.values.map((v, i) => ({ save: v, display: disp.values[i] ?? v }));
  }

  call(name, args) {
    const n = this.inst;
    switch (name) {
      case 'resolveNode': return this.dom.resolve(args[0], this)[0] ?? null;
      case 'resolveNodes': return new NodeList(this.dom.resolve(args[0], this));
      case 'getAttribute': return this.getProperty(String(args[0]))?.value ?? '';
      case 'setAttribute': this.setProperty(String(args[1]), args[0]); return null;
      case 'isPropertySpecified': return false;
      case 'getDisplayItem': return this.itemPairs()[Number(args[0])]?.display ?? null;
      case 'getSaveItem': return this.itemPairs()[Number(args[0])]?.save ?? null;
      case 'boundItem': {
        const hit = this.itemPairs().find(p => p.display === String(args[0]));
        return hit ? hit.save : String(args[0]);
      }
      case 'clearItems': n.items = []; return null;
      // the member field whose on value the group holds
      case 'selectedMember': {
        if (n.type !== 'exclGroup') throw new ScriptError('selectedMember() needs an exclusion group');
        const hit = n.children.find(c => c.type === 'field' && n.raw !== null && n.raw !== '' && (c.items?.[0]?.values?.[0] ?? '1') === n.raw);
        return hit ? this.dom.wrap(hit) : null;
      }
      // selection state of list boxes: nothing to print
      case 'setItemState': return null;
      case 'getItemState': return false;
      case 'deleteItem': {
        const i = Number(args[0]);
        n.items = (n.items ?? []).map(l => ({ ...l, values: l.values.filter((_, k) => k !== i) }));
        return null;
      }
      case 'setItems': {
        // "a,b,c" with one column (display = save) or two (display, save pairs)
        const parts = String(args[0] ?? '').split(',');
        const cols = Number(args[1] ?? 1) === 2 ? 2 : 1;
        const disp = [], save = [];
        for (let i = 0; i < parts.length; i += cols) { disp.push(parts[i]); save.push(parts[i + cols - 1] ?? parts[i]); }
        n.items = cols === 2
          ? [{ save: false, presence: 'visible', values: disp }, { save: true, presence: 'hidden', values: save }]
          : [{ save: false, presence: 'visible', values: disp }];
        return null;
      }
      case 'addItem': {
        const display = toText(args[0]);
        const save = args.length > 1 && args[1] !== undefined && args[1] !== null ? toText(args[1]) : display;
        if (!n.items?.length) n.items = [{ save: false, presence: 'visible', values: [] }];
        const lists = n.items;
        if (lists.length === 1) {
          if (save !== display) {
            // a second list now differs: split into display and save lists
            lists[0] = { ...lists[0], save: false, values: [...lists[0].values] };
            lists.push({ save: true, presence: 'hidden', values: [...lists[0].values] });
          }
        }
        const saveList = lists.find(l => l.save) ?? lists[0];
        const dispList = lists.find(l => l !== saveList) ?? saveList;
        dispList.values = [...dispList.values, display];
        if (saveList !== dispList) saveList.values = [...saveList.values, save];
        return null;
      }
      case 'execEvent': this.dom.fireEvent?.(n, String(args[0]), false); return null;
      case 'execInitialize': this.dom.fireEvent?.(n, 'initialize', true); return null;
      case 'execCalculate': this.dom.fireEvent?.(n, 'calculate', true); return null;
      case 'execValidate': case 'recalculate': case 'remerge': case 'relayout':
        return null;
      default:
        throw new ScriptError(`${n.type}.${name}() is not supported`);
    }
  }
}

function somExpression(n) {
  const parts = String(n.som ?? '').split('.').filter(Boolean).map(s => (/\[\d+\]$/.test(s) ? s : `${s}[0]`));
  return ['xfa[0]', 'form[0]', ...parts].join('.');
}

// ---------------------------------------------------------------------------
// Property objects: field.caption, .font, .value, .border, .margin, .para, …
// ---------------------------------------------------------------------------

const PROPERTY_OBJECTS = new Set([
  'caption', 'font', 'value', 'border', 'margin', 'para', 'ui', 'assist', 'validate', 'items',
  'format', 'bind', 'desc', 'extras', 'occur', 'keep', 'traversal', 'calculate', 'event', 'breakBefore',
  'breakAfter', 'overflow', 'bookend', 'variables', 'setProperty', 'bindItems', 'connect', 'pageSet',
]);

// names that are read as values, not as further objects
const LEAVES = new Set([
  'value', 'presence', 'typeface', 'size', 'weight', 'posture', 'underline', 'lineThrough',
  'placement', 'reserve', 'hAlign', 'vAlign', 'marginLeft', 'marginRight', 'spaceAbove', 'spaceBelow',
  'textIndent', 'lineHeight', 'topInset', 'bottomInset', 'leftInset', 'rightInset', 'thickness',
  'stroke', 'nullTest', 'scriptTest', 'formatTest', 'href', 'contentType', 'min', 'max', 'initial',
  'maxChars', 'numberOfCells', 'multiLine', 'hand', 'join', 'radius', 'inverted', 'cap', 'open',
  'textEntry', 'commitOn', 'mark', 'shape', 'allowNeutral', 'aspect', 'transferEncoding', 'save',
  'match', 'ref', 'intact', 'next', 'previous', 'activity', 'runAt', 'contentType', 'override',
]);

const SIDES = { topInset: 'top', rightInset: 'right', bottomInset: 'bottom', leftInset: 'left' };
const KEEPS = new Set(['intact', 'next', 'previous']);

/**
 * A property object of a form node, by path (["caption", "value", "text"]).
 * What changes print — caption text and presence, draw and default text,
 * font, margins, para alignment — reads and writes the instance node; the
 * rest reads as empty and quietly ignores writes, so the scripts that touch
 * it carry on.
 */
class PropObject {
  constructor(owner, path) {
    this.owner = owner;
    this.path = path;
    this.className = oneOfChildClass(owner.inst, path) ?? path[path.length - 1];
    this.name = '';
  }
  get parent() { return this.path.length > 1 ? new PropObject(this.owner, this.path.slice(0, -1)) : this.owner; }
  childrenByName() { return []; }
  childrenByClass(cls) { return [new PropObject(this.owner, [...this.path, cls])]; }

  getProperty(name) {
    if (name === 'className') return { value: this.className };
    if (name === 'name') return { value: '' };
    if (name === 'parent') return { value: this.parent };
    if (name === 'oneOfChild') return { value: new PropObject(this.owner, [...this.path, 'oneOfChild']) };
    if (name === 'nodes') return { value: new NodeList([]) };
    // caption.value is the caption's value object; text.value its text
    if (!LEAVES.has(name) || (name === 'value' && this.className === 'caption')) {
      return { value: new PropObject(this.owner, [...this.path, name]) };
    }
    const v = readProp(this.owner.inst, [...this.path, name]);
    return { value: v === undefined ? '' : v };
  }

  setProperty(name, value) {
    if (!writeProp(this.owner.inst, [...this.path, name], value)) {
      this.owner.dom.log?.once('info', 'XFA_SCRIPT_PROPERTY_IGNORED', [...this.path, name].join('.'),
        `Scripts setting "${[...this.path, name].join('.')}" are ignored`);
    }
    return true;
  }

  scalar() { return readProp(this.owner.inst, [...this.path, 'value']) ?? null; }
  assign(v) { this.setProperty('value', v); }

  call(name, args = []) {
    switch (name) {
      case 'isPropertySpecified': return false;
      // "#text", "text": a step into the property object
      case 'resolveNode': {
        const step = String(args[0] ?? '').replace(/^#/, '').replace(/\[\d+\]$/, '');
        return /^[A-Za-z]+$/.test(step) ? new PropObject(this.owner, [...this.path, step]) : null;
      }
      case 'resolveNodes': return new NodeList([]);
      case 'getElement': return new PropObject(this.owner, [...this.path, String(args[0] ?? '')]);
      case 'getAttribute': { const v = this.getProperty(String(args[0] ?? '')); return v && typeof v.value !== 'object' ? v.value : ''; }
      case 'setAttribute': this.setProperty(String(args[1] ?? ''), args[0]); return null;
      case 'saveXML': return '';
      case 'loadXML': case 'setElement': case 'assignNode': return null;
    }
    throw new ScriptError(`${this.className}.${name}() is not supported`);
  }
}

// ui.oneOfChild is the widget (textEdit, checkButton, …), value.oneOfChild
// the value's type (text, integer, exData, …): InputControls.create in
// hmrc-c1800-chief switches on it
function oneOfChildClass(n, path) {
  if (path[path.length - 1] !== 'oneOfChild' || path.length !== 2) return null;
  if (path[0] === 'ui') return n.ui?.kind ?? (n.type === 'field' ? 'textEdit' : null);
  if (path[0] === 'value') {
    const v = n.value;
    if (!v) return 'text';
    return v.valueType ?? (v.kind === 'rich' ? 'exData' : v.kind);
  }
  return null;
}

const UI_LEAVES = { open: 'open', multiLine: 'multiLine', numberOfCells: 'comb', mark: 'mark', shape: 'shape', textEntry: 'textEntry' };

// text a value object holds: value.text.value, value.#text, value.oneOfChild.value, value.exData.value
const TEXT_STEPS = new Set(['text', 'exData', 'oneOfChild', 'decimal', 'integer', 'float', 'date', 'time', 'dateTime', 'boolean']);
// (value.text = "x" assigns the text node itself, as Acrobat allows:
// adobe-master-pages-test numbers its rows with caption.value.text)
const isValueText = rest => (rest.length === 2 && TEXT_STEPS.has(rest[0]) && rest[1] === 'value')
  || (rest.length === 1 && TEXT_STEPS.has(rest[0]) && rest[0] !== 'oneOfChild');

function readProp(n, path) {
  const [head, ...rest] = path;
  const key = rest.join('.');
  switch (head) {
    case 'keep':
      return KEEPS.has(key) ? (n.keep?.[key] ?? 'none') : undefined;
    case 'caption': {
      const c = n.caption;
      if (key === 'presence') return c?.presence ?? 'visible';
      if (key === 'placement') return c?.placement ?? 'left';
      if (key === 'reserve') return c?.reserve === null || c?.reserve === undefined ? '-1' : `${c.reserve}pt`;
      if (rest[0] === 'value' && isValueText(rest.slice(1))) return c?.value?.text ?? '';
      if (rest[0] === 'font') return fontProp(c?.font, rest.slice(1));
      return undefined;
    }
    case 'value':
      if (isValueText(rest)) return n.type === 'draw' ? (n.value?.text ?? '') : (n.raw ?? '');
      return undefined;
    case 'ui': {
      // ui.textEdit.multiLine, ui.oneOfChild.open, ui.#choiceList.open
      const leaf = UI_LEAVES[rest[1]];
      if (rest.length !== 2 || !leaf) return undefined;
      const v = n.ui?.[leaf];
      if (typeof v === 'boolean') return v ? '1' : '0';
      return v ?? undefined;
    }
    case 'font': return fontProp(n.font, rest);
    case 'border':
      if (key === 'presence') return n.border?.presence ?? 'visible';
      if (key === 'fill.color.value') return (n.border?.fill?.color ?? [255, 255, 255]).join(',');
      return undefined;
    case 'margin':
      if (SIDES[rest[0]]) return `${n.margin?.[SIDES[rest[0]]] ?? 0}pt`;
      return undefined;
    case 'para':
      if (rest[0] === 'hAlign') return n.para?.hAlign ?? 'left';
      if (rest[0] === 'vAlign') return n.para?.vAlign ?? 'top';
      return undefined;
    case 'occur':
      if (['min', 'max', 'initial'].includes(rest[0])) return n.occur?.[rest[0]] ?? 1;
      return undefined;
  }
  return undefined;
}

function fontProp(font, rest) {
  const key = rest.join('.');
  if (key === 'fill.color.value') return (font?.color ?? [0, 0, 0]).join(',');
  if (['typeface', 'weight', 'posture'].includes(key)) return font?.[key] ?? { typeface: 'Courier', weight: 'normal', posture: 'normal' }[key];
  if (key === 'size') return `${font?.size ?? 10}pt`;
  return undefined;
}

// → true when the write changed (or may change) what prints
function writeProp(n, path, value) {
  const [head, ...rest] = path;
  const key = rest.join('.');
  const text = value === null || value === undefined ? '' : toText(value);
  switch (head) {
    // keep.intact/next/previous: hmrc-c1800-chief's prePrint scripts keep
    // each section whole, as Reader prints it
    case 'keep':
      if (!KEEPS.has(key) || !['none', 'contentArea', 'pageArea'].includes(text)) return false;
      n.keep = { intact: 'none', next: 'none', previous: 'none', ...(n.keep ?? {}), [key]: text };
      return true;
    case 'caption': {
      const c = n.caption ?? { placement: 'left', reserve: null, presence: 'visible' };
      if (key === 'presence' && PRESENCES.has(text)) { n.caption = { ...c, presence: text }; return true; }
      if (rest[0] === 'value' && isValueText(rest.slice(1))) { n.caption = { ...c, value: { kind: 'text', text } }; return true; }
      if (rest[0] === 'font') {
        const f = fontPatch(c.font, rest.slice(1), value);
        if (f) { n.caption = { ...c, font: f }; return true; }
      }
      return false;
    }
    case 'value':
      if (isValueText(rest)) {
        if (n.type === 'draw') n.value = { kind: 'text', text };
        else if (n.type === 'field' || n.type === 'exclGroup') { n.raw = value === null || value === undefined ? null : text; delete n.scriptDisplay; delete n.richValue; }
        return true;
      }
      return false;
    case 'font': {
      const f = fontPatch(n.font, rest, value);
      if (f) { n.font = f; return true; }
      return false;
    }
    case 'border': {
      if (!n.border) return false;
      if (key === 'presence' && PRESENCES.has(text)) { n.border = { ...n.border, presence: text }; return true; }
      // border.edge / border.corner (the first), presence and colour
      const part = /^(edge|corner)(?:\[(\d+)\])?\.(presence|color\.value|thickness)$/.exec(key);
      if (part) {
        const kind = part[1] === 'edge' ? 'edges' : 'corners';
        const i = Number(part[2] ?? 0);
        let patch = null;
        if (part[3] === 'presence' && PRESENCES.has(text)) patch = { presence: text };
        else if (part[3] === 'color.value') { const color = parseColor(text); if (color) patch = { color }; }
        else if (part[3] === 'thickness') { const pt = toPt(text); if (Number.isFinite(pt)) patch = { thickness: pt }; }
        if (!patch) return false;
        n.border = patchBorder(n.border, kind, i, patch);
        return true;
      }
      if (key === 'fill.presence' && PRESENCES.has(text)) {
        n.border = { ...n.border, fill: { ...(n.border.fill ?? { pattern: 'solid', color: [255, 255, 255] }), presence: text } };
        return true;
      }
      if (key === 'fill.color.value') {
        const color = parseColor(text);
        if (!color) return false;
        n.border = { ...n.border, fill: { ...(n.border.fill ?? { pattern: 'solid' }), presence: 'visible', color } };
        return true;
      }
      return false;
    }
    case 'margin':
      if (SIDES[rest[0]] && rest.length === 1) {
        const pt = toPt(text);
        if (!Number.isFinite(pt)) return false;
        n.margin = { top: 0, right: 0, bottom: 0, left: 0, ...n.margin, [SIDES[rest[0]]]: pt };
        return true;
      }
      return false;
    case 'para':
      if ((rest[0] === 'hAlign' || rest[0] === 'vAlign') && rest.length === 1) { n.para = { ...n.para, [rest[0]]: text }; return true; }
      return false;
  }
  return false;
}

function fontPatch(font, rest, value) {
  const key = rest.join('.');
  const text = value === null || value === undefined ? '' : toText(value);
  if (key === 'fill.color.value') {
    const color = parseColor(text);
    return color ? { ...font, color } : null;
  }
  if (key === 'weight' && (text === 'bold' || text === 'normal')) return { ...font, weight: text };
  if (key === 'posture' && (text === 'italic' || text === 'normal')) return { ...font, posture: text };
  if (key === 'typeface' && text) return { ...font, typeface: text };
  if (key === 'size') {
    const pt = toPt(text);
    return Number.isFinite(pt) && pt > 0 ? { ...font, size: pt } : null;
  }
  return null;
}

function parseColor(text) {
  const parts = String(text).split(',').map(x => parseInt(x, 10));
  if (parts.length !== 3 || parts.some(x => !Number.isFinite(x))) return null;
  return parts.map(x => Math.max(0, Math.min(255, x)));
}

function setFont(n, key, value) {
  if (key === 'color') {
    const color = parseColor(value);
    if (color) n.font = { ...n.font, color };
  }
}

// The instance manager of the children called `name` of a container
class InstanceManager {
  constructor(parent, name) {
    this.parentNode = parent;
    this.target = name;
    this.className = 'instanceManager';
  }
  get name() { return `_${this.target}`; }
  get dom() { return this.parentNode.dom; }
  instances() { return this.parentNode ? this.parentNode.childrenByName(this.target) : []; }
  childrenByName() { return []; }
  // the instance holding the subforms (through nameless containers and
  // areas) and their prototype
  holder() {
    const find = n => {
      const proto = ((n.proto ?? n).children ?? []).find(c => c.name === this.target && c.type === 'subform');
      if (proto) return { parent: n, proto };
      for (const c of n.children ?? []) if (seeThrough(c)) { const f = find(c); if (f) return f; }
      return null;
    };
    return this.parentNode?.inst ? find(this.parentNode.inst) : null;
  }
  occur() {
    const o = this.holder()?.proto.occur ?? this.instances()[0]?.inst?.occur;
    return { min: o?.min ?? 1, max: o?.max ?? 1 };
  }
  getProperty(name) {
    switch (name) {
      case 'count': return { value: this.instances().length };
      case 'min': return { value: this.occur().min };
      case 'max': return { value: this.occur().max };
      case 'name': return { value: this.name };
      case 'className': return { value: 'instanceManager' };
    }
    return undefined;
  }
  setProperty(name, value) {
    if (name !== 'count') throw new ScriptError(`instanceManager.${name} cannot be set`);
    this.setInstances(Number(value));
    return true;
  }
  call(name, args) {
    switch (name) {
      case 'addInstance': return this.addInstance(args[0] === undefined ? true : !!args[0]);
      case 'removeInstance': this.removeInstance(args[0] === undefined ? undefined : Number(args[0])); return null;
      case 'setInstances': this.setInstances(Number(args[0])); return null;
      case 'insertInstance': return this.addInstance(args[1] === undefined ? true : !!args[1], Number(args[0]));
      case 'moveInstance': this.moveInstance(Number(args[0]), Number(args[1])); return null;
      default: throw new ScriptError(`instanceManager.${name}() is not supported`);
    }
  }
  // Acrobat stops at occur max (-1: none) and min; it does not throw
  addInstance(merge = true, position = null) {
    const have = this.instances();
    const h = this.holder();
    if (!h) throw new ScriptError(`no subform ${this.target} to add an instance of`);
    const { max } = this.occur();
    if (max !== -1 && have.length >= max) return have[have.length - 1] ?? null;
    const ctx = this.dom.root.bindContext;
    if (!ctx) throw new ScriptError('instances cannot be added here');
    if (this.dom.inPageArea?.(h.parent)) throw new ScriptError('instances cannot be added to page-area boilerplate');
    const inst = bindAddInstance(h.parent, h.proto, ctx, merge, Number.isFinite(position) ? position : null);
    this.dom.link(inst, h.parent);
    this.dom.instanceAdded?.(inst);
    return this.dom.wrap(inst);
  }
  // moveInstance(from, to): the instance at from takes position to
  moveInstance(from, to) {
    const h = this.holder();
    const have = this.instances();
    const w = have[from];
    if (!h || !w?.inst || !Number.isFinite(to)) return;
    const parent = this.dom.parents.get(w.inst);
    if (parent) bindMoveInstance(parent, w.inst.proto, have.indexOf(w), Math.min(Math.max(0, to), have.length - 1));
  }
  removeInstance(index) {
    const have = this.instances();
    const { min } = this.occur();
    if (have.length <= Math.max(0, min)) return;
    const i = index === undefined || !Number.isFinite(index) ? have.length - 1 : index;
    const w = have[i];
    if (!w?.inst) return;
    const parent = this.dom.parents.get(w.inst);
    bindRemoveInstance(parent, w.inst, this.dom.root.bindContext ?? { bound: new Set() });
    this.dom.instanceRemoved?.(w.inst);
  }
  setInstances(n) {
    if (!Number.isFinite(n)) return;
    let guard = 1000;
    while (this.instances().length < n && guard--) {
      const before = this.instances().length;
      this.addInstance(true);
      if (this.instances().length === before) break; // at max
    }
    while (this.instances().length > n && guard--) {
      const before = this.instances().length;
      this.removeInstance();
      if (this.instances().length === before) break; // at min
    }
  }
}

// A node a script made with xfa.form.createNode: it keeps what is set on it
// and is never part of the form (scripts use it for speak text and the like)
class DetachedNode {
  constructor(className, name) { this.className = className; this.name = name; this.values = new Map(); }
  get parent() { return null; }
  childrenByName() { return []; }
  getProperty(key) {
    if (key === 'name') return { value: this.name };
    if (key === 'className') return { value: this.className };
    if (key === 'value') return { value: this.values.get('value') ?? '' };
    if (this.values.has(key)) return { value: this.values.get(key) };
    return undefined;
  }
  setProperty(key, v) { this.values.set(key, v); return true; }
  scalar() { return this.values.get('value') ?? null; }
  assign(v) { this.values.set('value', v); }
  call(name) {
    if (name === 'isPropertySpecified') return false;
    throw new ScriptError(`${this.className}.${name}() is not supported`);
  }
}

// One <items> list: its values as text nodes (CheckBox.getOffValue in
// hmrc-c1800-chief reads #items.nodes.item(1).value)
class ItemsNode {
  constructor(list) { this.list = list; this.className = 'items'; this.name = ''; }
  get parent() { return null; }
  childrenByName() { return []; }
  getProperty(key) {
    switch (key) {
      case 'nodes': return { value: new NodeList(this.list.values.map(v => { const d = new DetachedNode('text', ''); d.assign(v); return d; })) };
      case 'save': return { value: this.list.save ? '1' : '0' };
      case 'presence': return { value: this.list.presence ?? 'visible' };
      case 'className': return { value: 'items' };
      case 'name': return { value: '' };
    }
    return undefined;
  }
  call(name) {
    if (name === 'isPropertySpecified') return false;
    throw new ScriptError(`items.${name}() is not supported`);
  }
}

// $form: the form model; its one child is the root subform
class FormRoot {
  constructor(dom) { this.dom = dom; this.className = 'form'; this.name = 'form'; }
  get parent() { return null; }
  childrenByName(name) {
    const root = this.dom.root;
    return (root.name || 'form1') === name ? [this.dom.wrap(root)] : [];
  }
  getProperty(name) {
    if (name === 'nodes') return { value: new NodeList([this.dom.wrap(this.dom.root)]) };
    if (name === 'className' || name === 'name') return { value: 'form' };
    return undefined;
  }
  call(name, args) {
    if (name === 'resolveNode') return this.dom.resolve(args[0], this.dom.wrap(this.dom.root))[0] ?? null;
    if (name === 'resolveNodes') return new NodeList(this.dom.resolve(args[0], this.dom.wrap(this.dom.root)));
    if (name === 'createNode') return new DetachedNode(String(args[0] ?? ''), String(args[1] ?? ''));
    if (name === 'execInitialize') { this.dom.fireEvent?.(this.dom.root, 'initialize', true); return null; }
    if (name === 'execCalculate' || name === 'recalculate') { this.dom.fireEvent?.(this.dom.root, 'calculate', true); return null; }
    if (['execValidate', 'remerge'].includes(name)) return null;
    throw new ScriptError(`form.${name}() is not supported`);
  }
}

// ---------------------------------------------------------------------------
// Data nodes: elements and their attributes
// ---------------------------------------------------------------------------

export class DataNode {
  constructor(dom, node) {
    this.dom = dom;
    this.node = node;
  }

  get name() { return localName(this.node); }
  get className() {
    if (this.node.nodeType === 2) return 'dataValue';
    for (let c = this.node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) return 'dataGroup';
    return 'dataValue';
  }
  get parent() {
    const p = this.node.nodeType === 2 ? this.node.ownerElement : this.node.parentNode;
    return p && p.nodeType === 1 ? this.dom.wrap(p) : null;
  }
  get children() {
    if (this.node.nodeType !== 1) return [];
    const out = [];
    for (let c = this.node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(this.dom.wrap(c));
    for (const a of dataAttributes(this.node)) out.push(this.dom.wrap(a));
    return out;
  }

  childrenByName(name) {
    if (this.node.nodeType !== 1) return [];
    const out = [];
    for (let c = this.node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && localName(c) === name) out.push(this.dom.wrap(c));
    }
    for (const a of dataAttributes(this.node)) if (localName(a) === name) out.push(this.dom.wrap(a));
    return out;
  }

  childrenByClass(cls) { return this.children.filter(c => c.className === cls); }

  descendantsByName(name) {
    const out = [];
    const walk = el => {
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        if (localName(c) === name) out.push(this.dom.wrap(c));
        walk(c);
      }
    };
    if (this.node.nodeType === 1) walk(this.node);
    return out;
  }

  getProperty(name) {
    switch (name) {
      case 'name': return { value: this.name };
      case 'className': return { value: this.className };
      case 'parent': return { value: this.parent };
      case 'value': return { value: this.value() };
      case 'isNull': return { value: this.value() === null };
      case 'nodes': return { value: new NodeList(this.children) };
      case 'index': {
        let i = 0;
        if (this.node.nodeType === 1) for (let s = this.node.previousSibling; s; s = s.previousSibling) if (s.nodeType === 1 && localName(s) === this.name) i++;
        return { value: i };
      }
      case 'isRecord': return { value: this.node === this.dom.record };
      case 'somExpression': return { value: this.somExpression() };
      case 'contentType': return { value: '' };
    }
    return undefined;
  }

  setProperty(name, value) {
    if (name !== 'value') {
      this.dom.log?.once('info', 'XFA_SCRIPT_PROPERTY_IGNORED', `data.${name}`, `Scripts setting data "${name}" are ignored`);
      return false;
    }
    this.assign(value);
    return true;
  }

  value() {
    if (this.node.nodeType === 2) return this.node.value;
    if (this.className === 'dataGroup') return null;
    return leafValue(this.node);
  }

  scalar() { return this.value(); }

  // "xfa[0].datasets[0].data[0].form1[0].name[0]"
  somExpression() {
    const segs = [];
    for (let n = this.node; n && n.nodeType === 1 && n !== this.dom.dataEl; n = n.parentNode) {
      let i = 0;
      for (let s = n.previousSibling; s; s = s.previousSibling) if (s.nodeType === 1 && localName(s) === localName(n)) i++;
      segs.unshift(`${localName(n)}[${i}]`);
    }
    return ['xfa[0]', 'datasets[0]', 'data[0]', ...segs].join('.');
  }

  assign(value) {
    const text = value === null || value === undefined ? '' : toText(value);
    if (this.node.nodeType === 2) { this.node.value = text; return; }
    if (this.className === 'dataGroup') throw new ScriptError('Cannot assign a value to a data group');
    while (this.node.firstChild) this.node.removeChild(this.node.firstChild);
    if (text) this.node.appendChild(this.node.ownerDocument.createTextNode(text));
  }

  call(name, args) {
    switch (name) {
      case 'resolveNode': return this.dom.resolve(args[0], this)[0] ?? null;
      case 'resolveNodes': return new NodeList(this.dom.resolve(args[0], this));
      case 'isPropertySpecified': return false;
      default: throw new ScriptError(`${this.className}.${name}() is not supported`);
    }
  }
}

// xfa.datasets.data of a form with no data
class EmptyData {
  get name() { return 'data'; }
  get className() { return 'dataGroup'; }
  get parent() { return null; }
  childrenByName() { return []; }
  descendantsByName() { return []; }
  getProperty(name) {
    switch (name) {
      case 'name': return { value: 'data' };
      case 'className': return { value: 'dataGroup' };
      case 'nodes': return { value: new NodeList([]) };
      case 'value': return { value: null };
      case 'somExpression': return { value: 'xfa[0].datasets[0].data[0]' };
      case 'index': return { value: 0 };
    }
    return undefined;
  }
  call(name) {
    if (name === 'resolveNode') return null;
    if (name === 'resolveNodes') return new NodeList([]);
    throw new ScriptError(`dataGroup.${name}() is not supported`);
  }
}

/**
 * A field's data node as a script sees it (field.dataNode): Acrobat's merge
 * gives every bound field one, so a field without data in the file still has
 * one, named as the field, holding the field's current value.
 */
class FieldData {
  constructor(dom, inst) { this.dom = dom; this.inst = inst; }
  get name() { return this.inst.name ?? ''; }
  get className() { return 'dataValue'; }
  get parent() { return null; }
  childrenByName() { return []; }
  getProperty(name) {
    let raw = this.inst.raw;
    // a radio group holds the on value of its selected button, else nothing
    // (echr-application-es's Sex group, whose buttons default to "Off")
    if (this.inst.type === 'exclGroup' && !(this.inst.children ?? []).some(c => c.type === 'field' && this.dom.wrap(c).itemPairs()[0]?.save === raw)) raw = null;
    switch (name) {
      case 'name': return { value: this.name };
      case 'className': return { value: 'dataValue' };
      case 'value': return { value: raw === null || raw === undefined ? '' : String(raw) };
      case 'isNull': return { value: raw === null || raw === undefined || raw === '' };
      case 'parent': return { value: null };
      case 'nodes': return { value: new NodeList([]) };
      case 'index': return { value: this.inst.index ?? 0 };
      case 'somExpression': {
        const parts = String(this.inst.som ?? this.name).split('.').filter(Boolean).map(s => (/\[\d+\]$/.test(s) ? s : `${s}[0]`));
        return { value: ['xfa[0]', 'datasets[0]', 'data[0]', ...parts].join('.') };
      }
      case 'contentType': return { value: '' };
    }
    return undefined;
  }
  setProperty(name, value) {
    if (name !== 'value') return false;
    this.dom.wrap(this.inst).assign(value);
    return true;
  }
  scalar() { return this.getProperty('value').value; }
  assign(value) { this.dom.wrap(this.inst).assign(value); }
  call(name) { throw new ScriptError(`dataValue.${name}() is not supported`); }
}

/**
 * A <variables> <manifest>: a named list of SOM references, resolved from its
 * container by evaluate() (a paper forms barcode collects its fields so)
 */
export class Manifest {
  constructor(dom, inst, name, refs) { this.dom = dom; this.inst = inst; this.name = name; this.refs = refs; this.className = 'manifest'; }
  childrenByName() { return []; }
  getProperty(name) {
    if (name === 'name') return { value: this.name };
    if (name === 'className') return { value: 'manifest' };
    return undefined;
  }
  call(name) {
    if (name !== 'evaluate') throw new ScriptError(`manifest.${name}() is not supported`);
    const out = [];
    for (const ref of this.refs) {
      try { out.push(...this.dom.resolve(ref, this.dom.wrap(this.inst)).filter(Boolean)); } catch { /* an unresolvable ref adds nothing */ }
    }
    return new NodeList(out);
  }
}

// Attributes that are data values: no namespace (xmlns, xfa:, xsi:, dd: are markup)
function dataAttributes(el) {
  return Array.from(el.attributes ?? []).filter(a => !a.namespaceURI && !/^xmlns(:|$)/.test(a.name) && !a.name.includes(':'));
}

function localName(n) {
  return n.localName || String(n.nodeName).split(':').pop();
}

// ---------------------------------------------------------------------------
// xfa, xfa.host, xfa.layout, xfa.event, xfa.datasets
// ---------------------------------------------------------------------------

class XfaRoot {
  constructor(dom) {
    this.dom = dom;
    this.className = 'xfa';
    this.name = 'xfa';
    this.host = new Host(dom);
    this.layout = new Layout(dom);
    this.event = new XfaEvent();
    this.datasets = new Datasets(dom);
  }
  get parent() { return null; }
  childrenByName(name) {
    const v = this.getProperty(name)?.value;
    return v ? [v] : [];
  }
  getProperty(name) {
    switch (name) {
      case 'form': return { value: this.dom.formRoot };
      case 'datasets': return { value: this.datasets };
      case 'record': return { value: this.dom.wrap(this.dom.record) };
      case 'data': return { value: this.dom.wrap(this.dom.dataEl) };
      case 'host': return { value: this.host };
      case 'layout': return { value: this.layout };
      case 'event': return { value: this.event };
      case 'name': case 'className': return { value: 'xfa' };
    }
    return undefined;
  }
  // xfa.resolveNode(s): from the xfa root, else (an unqualified name) from
  // the object whose script is running, as Acrobat resolves it
  // (hmrc-iform hides its wizard pages with xfa.resolveNodes("MainFormPage[*]"))
  resolveFromHere(som) {
    const hits = this.dom.resolve(som, this);
    if (hits.length) return hits;
    const here = this.event.target;
    return here ? this.dom.resolve(som, here) : [];
  }
  call(name, args) {
    if (name === 'resolveNode') return this.resolveFromHere(args[0])[0] ?? null;
    if (name === 'resolveNodes') return new NodeList(this.resolveFromHere(args[0]));
    throw new ScriptError(`xfa.${name}() is not supported`);
  }
}

class Datasets {
  constructor(dom) { this.dom = dom; this.className = 'dataModel'; this.name = 'datasets'; }
  get parent() { return this.dom.xfa; }
  childrenByName(name) { return name === 'data' ? [this.data()] : []; }
  // the data root; a form saved without data still has an (empty) one
  data() { return this.dom.dataEl ? this.dom.wrap(this.dom.dataEl) : (this.empty ??= new EmptyData()); }
  getProperty(name) {
    if (name === 'data') return { value: this.data() };
    if (name === 'name') return { value: 'datasets' };
    if (name === 'className') return { value: 'dataModel' };
    return undefined;
  }
  call(name, args) {
    if (name === 'resolveNode') return this.dom.resolve(args[0], this)[0] ?? null;
    if (name === 'resolveNodes') return new NodeList(this.dom.resolve(args[0], this));
    throw new ScriptError(`datasets.${name}() is not supported`);
  }
}

// What a script learns about the viewer: Acrobat, printing, no dialogs
class Host {
  constructor(dom) { this.dom = dom; this.className = 'hostPseudoModel'; this.name = 'host'; }
  get parent() { return null; }
  childrenByName() { return []; }
  getProperty(name) {
    switch (name) {
      case 'name': return { value: 'Acrobat' };
      case 'appType': return { value: 'Reader' };
      case 'platform': return { value: 'WIN' };
      case 'version': return { value: '11.0' };
      case 'variation': return { value: 'Reader' };
      case 'language': return { value: 'en_US' };
      case 'validationsEnabled': case 'calculationsEnabled': return { value: true };
      case 'currentPage': return { value: 0 };
      case 'title': return { value: '' };
      case 'className': return { value: 'hostPseudoModel' };
    }
    return undefined;
  }
  setProperty() { return true; }
  call(name) {
    switch (name) {
      case 'messageBox': return 1; // no dialogs: as if OK were pressed
      case 'beep': case 'setFocus': case 'resetData': case 'openList': case 'exportData':
      case 'gotoURL': case 'print': case 'importData':
        return null;
      case 'numPages': throw new ScriptError('The page count is not known before layout');
      default: throw new ScriptError(`host.${name}() is not supported`);
    }
  }
}

// Layout queries. Scripts run before layout, so the answers come from a
// first layout of the form (known: som → { page, span, x, y, w, h } and the
// page count), the form being laid out again with them; without one they
// are placeholders (page 1 of 1, sizes 0) and queried asks for that second
// pass. The boilerplate scripts run once per page after layout answer for
// their page (at). page() and pageCount() count from 1, absPage() and
// sheet() from 0.
const UNIT = { in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1, mp: 0.001 };
const LAYOUT_METHODS = new Set(['h', 'w', 'x', 'y', 'pageContent']);
class Layout {
  constructor(dom) { this.dom = dom; this.className = 'layoutPseudoModel'; this.name = 'layout'; this.at = null; this.known = null; this.queried = false; }
  get methods() { return LAYOUT_METHODS; }
  get parent() { return null; }
  childrenByName() { return []; }
  getProperty(name) {
    if (name === 'ready') return { value: !!this.known };
    if (name === 'className') return { value: 'layoutPseudoModel' };
    return undefined;
  }
  info(node) {
    this.queried = true;
    const som = node?.inst?.som ?? node?.som;
    return som && this.known ? this.known.nodes.get(som) ?? null : null;
  }
  call(name, args = []) {
    if (name === 'relayout' || name === 'relayoutPageArea') return null;
    const at = this.at;
    switch (name) {
      case 'page': return at ? at.page : this.info(args[0])?.page ?? 1;
      case 'absPage': case 'sheet': return at ? at.page - 1 : (this.info(args[0])?.page ?? 1) - 1;
      case 'pageCount': case 'absPageCount': case 'sheetCount':
        if (at) return at.count;
        this.queried = true;
        return this.known?.pageCount ?? 1;
      case 'pageSpan': return this.info(args[0])?.span ?? 1;
      case 'h': case 'w': case 'x': case 'y': {
        const v = this.info(args[0])?.[name] ?? 0;
        return v / (UNIT[String(args[1] ?? 'in').toLowerCase()] ?? 72);
      }
      case 'pageContent': {
        this.queried = true;
        const soms = this.known?.pages[Number(args[0]) || 0] ?? [];
        const cls = args[1] ? String(args[1]) : null;
        const root = this.dom.wrap(this.dom.root);
        const out = [];
        for (const som of soms) {
          const w = this.dom.resolve(som, root)?.[0];
          if (w && (!cls || w.className === cls)) out.push(w);
        }
        return new NodeList(out);
      }
    }
    throw new ScriptError(`layout.${name}() is not supported`);
  }
}

class XfaEvent {
  constructor() { this.className = 'eventPseudoModel'; this.name = 'event'; this.target = null; }
  get parent() { return null; }
  childrenByName() { return []; }
  getProperty(name) {
    switch (name) {
      case 'target': return { value: this.target };
      case 'name': return { value: this.activity ?? '' };
      case 'newText': case 'prevText': case 'change': case 'fullText': return { value: '' };
      case 'cancelAction': return { value: false };
      case 'className': return { value: 'eventPseudoModel' };
    }
    return undefined;
  }
  setProperty() { return true; }
  call(name) { throw new ScriptError(`event.${name}() is not supported`); }
}

/** A value as the text a field stores */
export function toText(v) {
  if (typeof v === 'number') return numberText(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

/** A number as FormCalc and Acrobat print it: no float noise */
export function numberText(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
}
