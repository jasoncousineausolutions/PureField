/**
 * Purefield / acroscript.js
 *
 * The JavaScript of an AcroForm (non-XFA) form, run as Acrobat runs it when
 * a form is opened and printed, so the flattened page shows what Reader
 * prints:
 *
 *   1. document-level scripts (the /Names /JavaScript tree), in order
 *   2. every field's format action (/AA /F) on its value, values unchanged:
 *      the formatted text is what a generated appearance shows
 *      ("1234.5" → "$1,234.50")
 *   3. the open action (/OpenAction), the first page's open action (/AA /O)
 *      and the document's will-print action (/AA /WP)
 *   4. when those changed a field's value, the calculations (/AA /C) in the
 *      AcroForm's /CO order, and the format of every changed field again
 *
 * Keystroke and validate actions belong to typing and do not run. Scripts
 * run in the library's own interpreter (xfa/script/js.js: no eval, a step
 * budget) on an object model of Acrobat's: this (the document: getField,
 * calculateNow, numFields…), event (target, value, rc, willCommit…),
 * fields (value, display, hidden, textColor, fillColor, borderColor,
 * getArray, isBoxChecked, checkThisBox…), app, util (printf, printd,
 * printx, scand), color, display and the AF functions Acrobat's forms
 * plug-in defines (AFNumber_Format, AFPercent_Format, AFDate_FormatEx,
 * AFTime_Format, AFSpecial_Format, AFSimple_Calculate, AFMakeNumber …),
 * whose behaviour follows pdf.js's scripting_api (Apache License 2.0).
 */

import { createInterpreter, runIn, Native, obj, toStr, toNum } from './xfa/script/js.js';
import { ScriptError } from './xfa/script/dom.js';
import { text } from './core/widgets.js';

const PUSH = 1 << 16, RADIO = 1 << 15, COMBO = 1 << 17;
export const DISPLAY = { visible: 0, hidden: 1, noPrint: 2, noView: 3 };

/**
 * @param {import('./core/parser.js').PdfDocument} doc
 * @param {object} form - collectWidgets() result
 * @returns {Promise<Map<number, FieldState>|null>} by field object number;
 *   null when the form has no scripts
 *
 * @typedef {{ num: number, name: string, type: string, value: *, widgets: object[],
 *             changed: boolean, formatted: string|null, display?: number,
 *             textColor?: number[], fillColor?: number[], borderColor?: number[], styled: boolean }} FieldState
 */
export async function runAcroScripts(doc, form, { log, now = new Date(), pageCount = 1 } = {}) {
  const res = async v => (v?.type === 'ref' ? unwrap(await doc.getObject(v.num)) : v);
  const js = new JsReader(doc, res);

  // fields by object number, their widgets and actions
  const fields = new Map();
  for (const w of form.widgets.flat()) {
    if (w.annot) continue;
    let f = fields.get(w.field);
    if (!f) {
      f = { num: w.field, name: w.name, type: fieldType(w), ft: w.ft, ff: w.ff, value: w.value, widgets: [], changed: false,
        formatted: null, styled: false, opt: w.opt, actions: {} };
      const aa = dictOf(await res(w.aa.field)) ?? {};
      for (const k of ['F', 'C', 'K', 'V']) if (aa[k]) f.actions[k] = await js.action(aa[k]);
      fields.set(w.field, f);
    }
    f.widgets.push(w);
  }

  const cat = dictOf(unwrap(await doc.catalog())) ?? {};
  const docScripts = await js.nameTree(cat.Names);
  const openAction = cat.OpenAction ? await js.action(cat.OpenAction) : null;
  const catAA = dictOf(await res(cat.AA)) ?? {};
  const willPrint = catAA.WP ? await js.action(catAA.WP) : null;
  const pagesRoot = dictOf(await res(cat.Pages));
  const firstPage = await firstPageDict(res, pagesRoot);
  const pageAA = dictOf(await res(firstPage?.AA)) ?? {};
  const pageOpen = pageAA.O ? await js.action(pageAA.O) : null;
  const anyField = [...fields.values()].some(f => f.actions.F || f.actions.C);
  if (!docScripts.length && !openAction && !willPrint && !pageOpen && !anyField) return null;

  const host = new AcroHost(fields, form, { log, now, pageCount });
  let run = 0, failed = 0;
  const exec = (src, what, target = null, event = {}, global = false) => {
    if (!src) return null;
    host.beginEvent({ target, ...event });
    try {
      runIn(host.interp, src, host.docObj, { global });
      run++;
      return host.event;
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      failed++;
      log?.once('info', 'ACRO_SCRIPT_FAILED', `${what}|${e.message}`, `${what}: ${e.message}`);
      return null;
    }
  };
  const format = f => {
    if (!f.actions.F) return;
    const ev = exec(f.actions.F, `${f.name} format`, f, { name: 'Format', willCommit: true, value: host.valueOf(f) });
    if (ev && ev.rc !== false && ev.value !== null && ev.value !== undefined) f.formatted = toStr(ev.value);
  };

  // document scripts define the functions and variables every other script sees
  for (const s of docScripts) exec(s, 'document script', null, {}, true);
  for (const f of fields.values()) format(f);
  exec(openAction, 'open action', null, { name: 'Open' });
  exec(pageOpen, 'page open action', null, { name: 'Open', type: 'Page' });
  exec(willPrint, 'will-print action', null, { name: 'WillPrint' });
  if (host.valuesChanged) {
    // a changed value triggers the calculations, in /CO order, and the
    // changed fields are formatted again
    host.calculateNow = () => {
      for (const num of form.co ?? []) {
        const f = fields.get(num);
        if (!f?.actions.C) continue;
        const ev = exec(f.actions.C, `${f.name} calculate`, f, { name: 'Calculate', value: null });
        if (ev && ev.rc !== false && ev.value !== null && ev.value !== undefined) host.setValue(f, ev.value);
      }
    };
    host.calculateNow();
    for (const f of fields.values()) if (f.changed) format(f);
  }
  if (run || failed) log?.info('ACRO_SCRIPTS', `AcroForm scripts run: ${run}, failed: ${failed}`);
  return fields;
}

function fieldType(w) {
  if (w.ft === 'Tx') return 'text';
  if (w.ft === 'Ch') return w.ff & COMBO ? 'combobox' : 'listbox';
  if (w.ft === 'Sig') return 'signature';
  if (w.ft === 'Btn') return w.ff & PUSH ? 'button' : w.ff & RADIO ? 'radiobutton' : 'checkbox';
  return 'text';
}

async function firstPageDict(res, node, depth = 0) {
  if (!node || depth > 32) return null;
  if (node.Type?.value === 'Page' || !node.Kids) return node;
  const kids = await res(node.Kids);
  const first = kids?.type === 'array' ? kids.value[0] : null;
  return firstPageDict(res, dictOf(await res(first)), depth + 1);
}

// JavaScript actions: their text, following /Next chains; the /Names
// /JavaScript name tree
class JsReader {
  constructor(doc, res) { this.doc = doc; this.res = res; }
  async action(v, depth = 0) {
    if (depth > 8) return '';
    const a = await this.res(v);
    if (a?.type === 'array') { let s = ''; for (const x of a.value) s += await this.action(x, depth + 1); return s; }
    const d = dictOf(a);
    if (!d) return '';
    let s = '';
    if (d.S?.value === 'JavaScript' && d.JS) s += await this.source(d.JS);
    if (d.Next) s += `\n${await this.action(d.Next, depth + 1)}`;
    return s.trim() ? s : '';
  }
  async source(v) {
    if (v?.type === 'ref') {
      const o = await this.doc.getObject(v.num);
      if (o?.streamBytes) return decodeBytes(o.streamBytes);
      return text(unwrap(o));
    }
    return text(v);
  }
  async nameTree(namesVal) {
    const names = dictOf(await this.res(namesVal));
    const root = dictOf(await this.res(names?.JavaScript));
    const out = [];
    const walk = async (node, depth) => {
      if (!node || depth > 16) return;
      const pairs = await this.res(node.Names);
      if (pairs?.type === 'array') for (let i = 1; i < pairs.value.length; i += 2) {
        const s = await this.action(pairs.value[i]);
        if (s) out.push(s);
      }
      const kids = await this.res(node.Kids);
      if (kids?.type === 'array') for (const k of kids.value) await walk(dictOf(await this.res(k)), depth + 1);
    };
    await walk(root, 0);
    return out;
  }
}

function decodeBytes(b) {
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  return new TextDecoder('latin1').decode(b);
}

function unwrap(o) {
  if (!o) return null;
  if (o.streamBytes) return { type: 'dict', value: o.dict };
  return o.value ?? o;
}
function dictOf(v) {
  if (!v) return null;
  if (v.type === 'dict') return v.value;
  if (v.value?.type === 'dict') return v.value.value;
  return null;
}

// ---------------------------------------------------------------------------
// The object model
// ---------------------------------------------------------------------------

const COLORS = {
  transparent: ['T'], black: ['G', 0], white: ['G', 1], red: ['RGB', 1, 0, 0], green: ['RGB', 0, 1, 0],
  blue: ['RGB', 0, 0, 1], cyan: ['CMYK', 1, 0, 0, 0], magenta: ['CMYK', 0, 1, 0, 0], yellow: ['CMYK', 0, 0, 1, 0],
  dkGray: ['G', 0.25], gray: ['G', 0.5], ltGray: ['G', 0.75],
};

/** An Acrobat colour array as RGB 0..1, or null for transparent */
export function colorToRgb(c) {
  if (!Array.isArray(c) || !c.length) return null;
  const [space, ...v] = c;
  const n = v.map(x => Math.min(1, Math.max(0, toNum(x))));
  switch (space) {
    case 'G': return [n[0], n[0], n[0]];
    case 'RGB': return n.slice(0, 3);
    case 'CMYK': return [(1 - n[0]) * (1 - n[3]), (1 - n[1]) * (1 - n[3]), (1 - n[2]) * (1 - n[3])];
    default: return null;
  }
}

class HostObject {
  get rawValues() { return true; }
  childrenByName() { return []; }
  // methods the interpreter calls by name (print, setFocus…) are the
  // functions getProperty hands out
  call(name, args) {
    const p = this.getProperty(name)?.value;
    if (p instanceof Native) return p.fn(this, args);
    throw new ScriptError(`${name}() is not supported`);
  }
}

class AcroEvent extends HostObject {
  constructor(props) { super(); Object.assign(this, { rc: true, value: '', change: '', willCommit: false, name: '', type: 'Field', modifier: false, shift: false, source: null, target: null }, props); }
  get className() { return 'Event'; }
  getProperty(k) {
    if (k === 'targetName') return { value: this.target?.f?.name ?? '' };
    if (['rc', 'value', 'change', 'willCommit', 'name', 'type', 'modifier', 'shift', 'source', 'target', 'changeEx', 'commitKey', 'selStart', 'selEnd'].includes(k)) return { value: this[k] ?? null };
    return undefined;
  }
  setProperty(k, v) {
    if (['rc', 'value', 'change', 'selStart', 'selEnd'].includes(k)) { this[k] = k === 'rc' ? !!v : v; return true; }
    return false;
  }
}

class AcroHost {
  constructor(fields, form, { log, now, pageCount }) {
    this.fields = fields;
    this.log = log;
    this.now = now;
    this.pageCount = pageCount;
    this.valuesChanged = false;
    this.calculate = true;
    this.byName = new Map();
    for (const f of fields.values()) {
      this.byName.set(f.name, f);
    }
    this.wrappers = new Map();
    this.docObj = new DocObject(this);
    this.event = new AcroEvent({});
    this.interp = createInterpreter(this);
    this.calculateNow = () => {};
  }
  beginEvent(props) {
    const target = props.target ? this.wrap(props.target) : null;
    // the event object is replaced in the globals: scripts read `event`
    Object.assign(this.event, { rc: true, value: '', change: '', willCommit: false, name: '', type: 'Field' }, props, { target, source: target });
  }
  wrap(f) {
    let w = this.wrappers.get(f);
    if (!w) { w = new FieldObject(this, f); this.wrappers.set(f, w); }
    return w;
  }
  // the fields under a name: the field itself, or those below a parent name
  find(name) {
    const n = toStr(name);
    if (this.byName.has(n)) return [this.byName.get(n)];
    const kids = [...this.fields.values()].filter(f => f.name.startsWith(`${n}.`));
    return kids;
  }
  /** Acrobat's value of a field: a number when the text is one */
  valueOf(f) {
    let v = f.value;
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) v = f.type === 'checkbox' || f.type === 'radiobutton' ? 'Off' : '';
    v = String(v);
    if ((f.type === 'text' || f.type === 'combobox') && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(v) && v.trim() !== '') return Number(v);
    return v;
  }
  setValue(f, v) {
    const s = Array.isArray(v) ? v.map(x => toStr(x)) : v === null || v === undefined ? '' : toStr(v);
    if (String(f.value ?? '') === String(s)) return;
    f.value = s;
    f.changed = true;
    this.valuesChanged = true;
  }
  // interpreter hooks: unqualified names are the document's properties
  shortcut() { return undefined; }
  lookup(name) {
    const p = this.docObj.getProperty(name);
    return p !== undefined ? [p.value] : [];
  }
  extendGlobals(set) {
    const host = this;
    const N = (name, fn) => new Native(name, (self, args) => fn(...args));
    const ev = () => host.event;
    set('event', this.event);
    set('color', obj({
      ...Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, [...v]])),
      convert: N('convert', (c, space) => convertColor(c, toStr(space))),
      equal: N('equal', (a, b) => JSON.stringify(colorToRgb(a)) === JSON.stringify(colorToRgb(b))),
    }));
    set('display', obj({ ...DISPLAY }));
    set('border', obj({ s: 'solid', b: 'beveled', d: 'dashed', i: 'inset', u: 'underline' }));
    set('style', obj({ ch: 'check', cr: 'cross', di: 'diamond', ci: 'circle', st: 'star', sq: 'square' }));
    set('position', obj({ textOnly: 0, iconOnly: 1, iconTextV: 2, iconTextH: 3, textIconV: 4, textIconH: 5, overlay: 6 }));
    set('scaleHow', obj({ proportional: 0, anamorphic: 1 }));
    set('scaleWhen', obj({ always: 0, never: 1, tooBig: 2, tooSmall: 3 }));
    set('highlight', obj({ n: 'none', i: 'invert', p: 'push', o: 'outline' }));
    set('global', obj());
    set('util', obj({
      printf: new Native('printf', (_, args) => printf(...args)),
      printd: N('printd', (fmt, d) => (d instanceof Date ? printd(fmt, d) : '')),
      printx: N('printx', (fmt, s) => printx(toStr(fmt), s)),
      scand: N('scand', (fmt, s) => scand(fmt, toStr(s)) ?? null),
      crackURL: N('crackURL', () => obj()),
    }));
    // the forms plug-in's functions
    const af = {
      AFMakeNumber: v => makeNumber(v),
      AFExtractNums: s => (typeof s === 'number' ? [s] : String(s ?? '').match(/\d+/g) ?? null),
      AFMergeChange: () => toStr(ev().value ?? ''),
      AFParseDateEx: (s, order) => parseDate(order, toStr(s)),
      AFNumber_Format: (nDec, sepStyle, negStyle, currStyle, strCurrency, bPrepend) =>
        numberFormat(ev(), toNum(nDec), toNum(sepStyle), toNum(negStyle), toStr(strCurrency ?? ''), !!bPrepend, host),
      AFPercent_Format: (nDec, sepStyle, prepend) => percentFormat(ev(), toNum(nDec), toNum(sepStyle), !!prepend),
      AFDate_FormatEx: fmt => dateFormat(ev(), toStr(fmt)),
      AFDate_Format: i => dateFormat(ev(), DATE_FORMATS[toNum(i)] ?? toStr(i)),
      AFTime_FormatEx: fmt => dateFormat(ev(), toStr(fmt)),
      AFTime_Format: i => dateFormat(ev(), TIME_FORMATS[toNum(i)] ?? toStr(i)),
      AFSpecial_Format: psf => specialFormat(ev(), toNum(psf)),
      AFSimple_Calculate: (fn, names) => simpleCalculate(ev(), toStr(fn), names, host),
      AFSimple: (fn, a, b) => { const x = makeNumber(a) ?? 0, y = makeNumber(b) ?? 0; return { AVG: (x + y) / 2, SUM: x + y, PRD: x * y, MIN: Math.min(x, y), MAX: Math.max(x, y) }[toStr(fn)]; },
      AFMakeArrayFromList: s => (typeof s === 'string' ? s.split(/, ?/g) : s),
      eMailValidate: s => /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/.test(toStr(s)),
    };
    // keystroke and validate actions belong to typing: they accept
    for (const k of ['AFNumber_Keystroke', 'AFPercent_Keystroke', 'AFDate_Keystroke', 'AFDate_KeystrokeEx', 'AFTime_Keystroke',
      'AFTime_KeystrokeEx', 'AFSpecial_Keystroke', 'AFSpecial_KeystrokeEx', 'AFRange_Validate']) af[k] = () => undefined;
    for (const [k, fn] of Object.entries(af)) set(k, N(k, fn));
  }
}

class DocObject extends HostObject {
  constructor(host) { super(); this.host = host; this.props = {}; }
  get className() { return 'Doc'; }
  getProperty(k) {
    const h = this.host;
    const fn = (name, f) => ({ value: new Native(name, (self, args) => f(...args)) });
    switch (k) {
      case 'getField': return fn('getField', name => { const fs = h.find(name); return fs.length === 1 && fs[0].name === toStr(name) ? h.wrap(fs[0]) : fs.length ? new GroupObject(h, toStr(name), fs) : null; });
      case 'getNthFieldName': return fn('getNthFieldName', i => [...h.fields.values()][toNum(i)]?.name ?? null);
      case 'numFields': return { value: h.fields.size };
      case 'calculateNow': return fn('calculateNow', () => h.calculateNow());
      case 'calculate': return { value: h.calculate };
      case 'numPages': return { value: h.pageCount };
      case 'pageNum': return { value: 0 };
      case 'dirty': return { value: false };
      case 'external': return { value: false };
      case 'path': case 'documentFileName': case 'title': case 'URL': return { value: '' };
      case 'info': return { value: obj({ Title: '', Author: '', Subject: '', Keywords: '', Creator: '', Producer: '' }) };
      case 'resetForm': return fn('resetForm', () => undefined);
      case 'print': case 'mailDoc': case 'submitForm': case 'saveAs': case 'exportAsFDF': case 'importAnFDF':
      case 'gotoNamedDest': case 'setPageAction': case 'setAction': case 'addScript': case 'syncAnnotScan':
        return fn(k, () => undefined);
      case 'getAnnots': return fn(k, () => []);
      case 'getOCGs': return fn(k, () => []);
      case 'getPageNumWords': return fn(k, () => 0);
      case 'getPageNthWord': return fn(k, () => '');
    }
    return undefined;
  }
  setProperty(k, v) {
    if (k === 'calculate') { this.host.calculate = !!v; return true; }
    if (['pageNum', 'dirty', 'zoom', 'zoomType'].includes(k)) return true;
    return false;
  }
}

class GroupObject extends HostObject {
  constructor(host, name, kids) { super(); this.host = host; this.name = name; this.kids = kids; }
  get className() { return 'Field'; }
  getProperty(k) {
    if (k === 'name') return { value: this.name };
    if (k === 'getArray') return { value: new Native('getArray', () => this.kids.map(f => this.host.wrap(f))) };
    if (k === 'value') return { value: this.kids.length ? this.host.valueOf(this.kids[0]) : '' };
    return undefined;
  }
  // a setting on a parent name applies to every field below it
  setProperty(k, v) {
    let ok = false;
    for (const f of this.kids) ok = this.host.wrap(f).setProperty(k, v) || ok;
    return ok;
  }
}

class FieldObject extends HostObject {
  constructor(host, f) { super(); this.host = host; this.f = f; }
  get className() { return 'Field'; }
  get name() { return this.f.name; }
  scalar() { return this.host.valueOf(this.f); }
  getProperty(k) {
    const f = this.f, h = this.host;
    const w0 = f.widgets[0];
    const fn = (name, g) => ({ value: new Native(name, (self, args) => g(...args)) });
    switch (k) {
      case 'name': return { value: f.name };
      case 'type': return { value: f.type };
      case 'value': return { value: h.valueOf(f) };
      case 'valueAsString': { const v = h.valueOf(f); return { value: Array.isArray(v) ? v.join(',') : toStr(v) }; }
      case 'defaultValue': return { value: w0?.defaultValue ?? '' };
      case 'display': return { value: f.display ?? displayOf(w0?.flags ?? 4) };
      case 'hidden': return { value: (f.display ?? displayOf(w0?.flags ?? 4)) === DISPLAY.hidden };
      case 'readonly': return { value: !!(f.ff & 1) };
      case 'required': return { value: !!(f.ff & 2) };
      case 'textColor': return { value: f.textColor ?? ['G', 0] };
      case 'fillColor': return { value: f.fillColor ?? (w0?.mk?.bg ? ['RGB', ...w0.mk.bg] : ['T']) };
      case 'borderColor': case 'strokeColor': return { value: f.borderColor ?? (w0?.mk?.bc ? ['RGB', ...w0.mk.bc] : ['T']) };
      case 'textSize': return { value: 0 };
      case 'textFont': return { value: 'Helvetica' };
      case 'multiline': return { value: !!(f.ff & (1 << 12)) };
      case 'comb': return { value: !!(f.ff & (1 << 24)) };
      case 'charLimit': return { value: w0?.maxLen ?? 0 };
      case 'page': return { value: f.widgets.length > 1 ? f.widgets.map(w => w.page) : (w0?.page ?? 0) };
      case 'rect': return { value: w0 ? [w0.rect[0], w0.rect[3], w0.rect[2], w0.rect[1]] : [0, 0, 0, 0] };
      case 'exportValues': return { value: f.widgets.map(w => w.onState).filter(Boolean) };
      case 'numItems': return { value: f.opt?.length ?? 0 };
      case 'currentValueIndices': { const i = (f.opt ?? []).findIndex(o => o.value === toStr(h.valueOf(f))); return { value: i }; }
      case 'getArray': return fn('getArray', () => [this]);
      case 'isBoxChecked': return fn('isBoxChecked', i => {
        const w = f.widgets[toNum(i)] ?? f.widgets[0];
        return !!w?.onState && toStr(h.valueOf(f)) === w.onState;
      });
      case 'checkThisBox': return fn('checkThisBox', (i, on = true) => {
        const w = f.widgets[toNum(i)] ?? f.widgets[0];
        if (w?.onState) h.setValue(f, on ? w.onState : 'Off');
      });
      case 'getItemAt': return fn('getItemAt', (i, exp = true) => { const o = f.opt?.[toNum(i)]; return o ? (exp ? o.value : o.label) : null; });
      case 'buttonGetCaption': return fn('buttonGetCaption', () => w0?.mk?.ca ?? '');
      case 'buttonSetCaption': return fn('buttonSetCaption', c => { for (const w of f.widgets) w.mk.ca = toStr(c); f.styled = true; });
      case 'setAction': case 'setFocus': case 'clearItems': case 'setItems': case 'insertItemAt': case 'deleteItemAt': case 'buttonImportIcon': case 'signatureSign':
        return fn(k, () => undefined);
    }
    return undefined;
  }
  setProperty(k, v) {
    const f = this.f, h = this.host;
    switch (k) {
      case 'value': h.setValue(f, v); return true;
      case 'display': f.display = toNum(v); return true;
      case 'hidden': f.display = v ? DISPLAY.hidden : DISPLAY.visible; return true;
      case 'textColor': case 'fillColor': case 'borderColor': case 'strokeColor':
        f[k === 'strokeColor' ? 'borderColor' : k] = Array.isArray(v) ? [...v] : v;
        f.styled = true;
        return true;
      case 'readonly': case 'required': case 'textSize': case 'textFont': case 'alignment': case 'userName':
      case 'doNotScroll': case 'doNotSpellCheck': case 'editable': case 'lineWidth': case 'borderStyle':
      case 'charLimit': case 'multiline': case 'comb': case 'defaultValue': case 'exportValues': case 'currentValueIndices':
        return true;
    }
    return false;
  }
}

function displayOf(flags) {
  if (flags & 2) return DISPLAY.hidden;
  if (flags & 32) return DISPLAY.noView;
  return flags & 4 ? DISPLAY.visible : DISPLAY.noPrint;
}

function convertColor(c, space) {
  const rgb = colorToRgb(c);
  if (!rgb) return ['T'];
  if (space === 'G') return ['G', 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]];
  if (space === 'CMYK') { const k = 1 - Math.max(...rgb); return k === 1 ? ['CMYK', 0, 0, 0, 1] : ['CMYK', ...rgb.map(x => (1 - x - k) / (1 - k)), k]; }
  return ['RGB', ...rgb];
}

// ---------------------------------------------------------------------------
// AF functions
// ---------------------------------------------------------------------------

export const DATE_FORMATS = ['m/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy', 'yy-mm-dd',
  'mmm-yy', 'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy', 'm/d/yy h:MM tt', 'm/d/yy HH:MM'];
export const TIME_FORMATS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];

export function makeNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function numberFormat(event, nDec, sepStyle, negStyle, currency, prepend, host) {
  let value = makeNumber(event.value);
  if (value === null) { event.value = ''; return; }
  const sign = Math.sign(value);
  let s = '';
  let paren = false;
  if (sign === -1 && prepend && negStyle === 0) s += '-';
  if ((negStyle === 2 || negStyle === 3) && sign === -1) { s += '('; paren = true; }
  if (prepend) s += currency;
  const fmt = `%,${Math.max(0, Math.min(4, Math.floor(sepStyle)))}.${nDec}f`;
  if ((negStyle !== 0 || prepend) && sign === -1) value = -value;
  s += printf(fmt, value);
  if (!prepend) s += currency;
  if (paren) s += ')';
  // red negatives (negStyle 1 and 3)
  if ((negStyle === 1 || negStyle === 3) && event.target) {
    event.target.f.textColor = sign === -1 ? ['RGB', 1, 0, 0] : ['G', 0];
    event.target.f.styled = true;
  }
  event.value = s;
  void host;
}

function percentFormat(event, nDec, sepStyle, prepend) {
  const value = makeNumber(event.value);
  if (value === null) { event.value = '%'; return; }
  const s = printf(`%,${Math.max(0, Math.min(4, Math.floor(sepStyle)))}.${Math.floor(Math.max(0, nDec))}f`, value * 100);
  event.value = prepend ? `%${s}` : `${s}%`;
}

function dateFormat(event, fmt) {
  const v = event.value;
  if (v === null || v === undefined || v === '') return;
  const d = parseDate(fmt, toStr(v));
  if (d) event.value = printd(fmt, d);
}

function specialFormat(event, psf) {
  const v = event.value;
  if (v === null || v === undefined || v === '') return;
  const s = toStr(v);
  const fmt = psf === 0 ? '99999' : psf === 1 ? '99999-9999'
    : psf === 2 ? (printx('9999999999', s).length >= 10 ? '(999) 999-9999' : '999-9999')
      : psf === 3 ? '999-99-9999' : null;
  if (fmt) event.value = printx(fmt, s);
}

function simpleCalculate(event, fn, names, host) {
  const list = Array.isArray(names) ? names : toStr(names).split(/, ?/g);
  const values = [];
  for (const n of list) {
    for (const f of host.find(toStr(n).trim())) values.push(makeNumber(host.valueOf(f)) ?? 0);
  }
  if (!values.length) { event.value = 0; return; }
  const r = { AVG: values.reduce((a, b) => a + b, 0) / values.length, SUM: values.reduce((a, b) => a + b, 0),
    PRD: values.reduce((a, b) => a * b, 1), MIN: Math.min(...values), MAX: Math.max(...values) }[fn];
  if (r !== undefined) event.value = Math.round(1e6 * r) / 1e6;
}

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

/** util.printf: %[,sep][flags][width][.prec](d|f|s|x), Acrobat's separators */
export function printf(fmt, ...args) {
  let i = 0;
  return toStr(fmt).replace(/%(,[0-4])?([+ 0#]+)?(\d+)?(\.\d+)?(.)/g, (m, sep, flags = '', width, prec, conv) => {
    if (!'dfsx'.includes(conv)) return m;
    const arg = args[i++];
    if (conv === 's') return toStr(arg ?? '');
    const num = toNum(arg);
    let intPart = Math.trunc(num);
    const w = width ? parseInt(width, 10) : undefined;
    if (conv === 'x') {
      let hex = Math.abs(intPart).toString(16).toUpperCase();
      if (w !== undefined) hex = hex.padStart(w, flags.includes('0') ? '0' : ' ');
      return flags.includes('#') ? `0x${hex}` : hex;
    }
    const p = prec ? parseInt(prec.slice(1), 10) : undefined;
    const [thousand, decimal] = { 0: [',', '.'], 1: ['', '.'], 2: ['.', ','], 3: ['', ','], 4: ["'", '.'] }[sep ? sep.slice(1) : '0'];
    let dec = '';
    if (conv === 'f') {
      dec = p !== undefined ? Math.abs(num - intPart).toFixed(p) : Math.abs(num - intPart).toString();
      if (dec.length > 2) {
        if (/^1\.0+$/.test(dec)) { intPart += Math.sign(num); dec = `${decimal}${dec.split('.')[1]}`; } else dec = `${decimal}${dec.slice(2)}`;
      } else {
        if (dec === '1') intPart += Math.sign(num);
        dec = flags.includes('#') ? '.' : '';
      }
    }
    let sign = '';
    if (intPart < 0 || (intPart === 0 && num < 0 && dec && /[1-9]/.test(dec))) { sign = '-'; intPart = Math.abs(intPart); }
    else if (flags.includes('+')) sign = '+';
    else if (flags.includes(' ')) sign = ' ';
    let ints = String(intPart);
    if (thousand && intPart >= 1000) ints = ints.replace(/\B(?=(\d{3})+(?!\d))/g, thousand);
    let out = `${ints}${dec}`;
    if (w !== undefined) out = out.padStart(w - sign.length, flags.includes('0') ? '0' : ' ');
    return `${sign}${out}`;
  });
}

/** util.printx: 9 digit, A letter, X letter or digit, ? any, * the rest, > < = case, \ escape */
export function printx(fmt, src) {
  const s = toStr(src ?? '');
  const cases = [x => x, x => x.toUpperCase(), x => x.toLowerCase()];
  let c = cases[0], i = 0, esc = false;
  let out = '';
  for (const cmd of fmt) {
    if (esc) { out += cmd; esc = false; continue; }
    if (i >= s.length) break;
    const take = test => { while (i < s.length) { const ch = s[i++]; if (test(ch)) { out += c(ch); break; } } };
    switch (cmd) {
      case '?': out += c(s[i++]); break;
      case 'X': take(ch => /[A-Za-z0-9]/.test(ch)); break;
      case 'A': take(ch => /[A-Za-z]/.test(ch)); break;
      case '9': take(ch => /[0-9]/.test(ch)); break;
      case '*': while (i < s.length) out += c(s[i++]); break;
      case '\\': esc = true; break;
      case '>': c = cases[1]; break;
      case '<': c = cases[2]; break;
      case '=': c = cases[0]; break;
      default: out += cmd;
    }
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** util.printd: Acrobat's date tokens, or its formats 0–2 */
export function printd(fmt, d) {
  let f = fmt;
  if (typeof f === 'number' || /^\d$/.test(String(f))) f = ['D:yyyymmddHHMMss', 'yyyy.mm.dd HH:MM:ss', 'm/d/yy h:MM:ss tt'][Number(f)] ?? String(f);
  f = toStr(f);
  const pad = n => String(n).padStart(2, '0');
  let out = '';
  for (let i = 0; i < f.length;) {
    if (f[i] === '\\') { out += f[i + 1] ?? ''; i += 2; continue; }
    const m = /^(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|HH|H|hh|h|MM|M|ss|s|tt|t)/.exec(f.slice(i));
    if (!m) { out += f[i++]; continue; }
    const t = m[1];
    i += t.length;
    const h = d.getHours();
    out += {
      yyyy: String(d.getFullYear()), yy: pad(d.getFullYear() % 100), mmmm: MONTHS[d.getMonth()], mmm: MONTHS[d.getMonth()].slice(0, 3),
      mm: pad(d.getMonth() + 1), m: String(d.getMonth() + 1), dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3),
      dd: pad(d.getDate()), d: String(d.getDate()), HH: pad(h), H: String(h), hh: pad(h % 12 || 12), h: String(h % 12 || 12),
      MM: pad(d.getMinutes()), M: String(d.getMinutes()), ss: pad(d.getSeconds()), s: String(d.getSeconds()),
      tt: h < 12 ? 'am' : 'pm', t: h < 12 ? 'a' : 'p',
    }[t];
  }
  return out;
}

/** util.scand: a date read by an Acrobat date format, or null */
export function scand(fmt, s) {
  let f = fmt;
  if (typeof f === 'number' || /^\d$/.test(String(f))) f = ['D:yyyymmddHHMMss', 'yyyy.mm.dd HH:MM:ss', 'm/d/yy h:MM:ss tt'][Number(f)] ?? String(f);
  f = toStr(f);
  const acts = [];
  let re = '';
  for (let i = 0; i < f.length;) {
    const m = /^(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|HH|H|hh|h|MM|M|ss|s|tt|t)/.exec(f.slice(i));
    if (!m) { re += f[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; continue; }
    const t = m[1];
    i += t.length;
    const num = (k, n) => { re += n === 4 ? '(\\d{4})' : n === 2 ? '(\\d{1,2})' : '(\\d{1,2})'; acts.push((v, d) => { d[k] = parseInt(v, 10); }); };
    switch (t) {
      case 'yyyy': num('year', 4); break;
      case 'yy': re += '(\\d{2})'; acts.push((v, d) => { d.year = 2000 + parseInt(v, 10); }); break;
      case 'mmmm': case 'mmm': re += '([A-Za-z]+)'; acts.push((v, d) => { const k = MONTHS.findIndex(x => x.toLowerCase().startsWith(v.toLowerCase().slice(0, 3))); if (k >= 0) d.month = k + 1; }); break;
      case 'mm': case 'm': num('month', 2); break;
      case 'dddd': case 'ddd': re += '[A-Za-z]+'; break;
      case 'dd': case 'd': num('day', 2); break;
      case 'HH': case 'H': case 'hh': case 'h': num('hours', 2); break;
      case 'MM': case 'M': num('minutes', 2); break;
      case 'ss': case 's': num('seconds', 2); break;
      case 'tt': case 't': re += '([apAP][mM]?)'; acts.push((v, d) => { d.am = /^a/i.test(v); }); break;
    }
  }
  const m = new RegExp(`^\\s*${re}\\s*$`).exec(s);
  if (!m) return null;
  const d = { year: 2000, month: 1, day: 1, hours: 0, minutes: 0, seconds: 0, am: null };
  acts.forEach((a, k) => a(m[k + 1], d));
  if (d.am !== null) d.hours = (d.hours % 12) + (d.am ? 0 : 12);
  const out = new Date(d.year, d.month - 1, d.day, d.hours, d.minutes, d.seconds);
  return Number.isNaN(out.getTime()) ? null : out;
}

// AFParseDateEx: the format first, then the date strings Acrobat accepts
function parseDate(fmt, s) {
  const d = scand(fmt, s);
  if (d) return d;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}
