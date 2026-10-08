/**
 * Purefield / core / widgets.js
 *
 * The AcroForm widgets of a parsed PDF, by page: the field tree under
 * /AcroForm /Fields is walked with its inheritable attributes (FT, Ff, V,
 * DA, Q, MaxLen, Opt, TI, I, DV), each widget is assigned to the page its
 * /P names (else the page whose /Annots lists it), and widgets that only a
 * page's /Annots lists are picked up too, their attributes inherited
 * through /Parent, as are other annotations (annot: their subtype), for
 * their appearances. Each widget carries what flattening needs: its
 * rectangle, flags, border and colours (/MK, /BS, /Border), and its normal
 * appearance (/AP /N, chosen by /AS when it holds states).
 *
 * Values are the parser's: { type: 'name'|'string'|'array'|'dict'|'ref' }
 * or plain numbers and booleans. Strings are decoded here (PDFDocEncoding
 * or UTF-16BE with a byte order mark).
 */

const INHERITED = ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'MaxLen', 'Opt', 'TI', 'I'];

/**
 * @param {import('./parser.js').PdfDocument} doc
 * @param {number[]} pageNums - object numbers of the pages, in order
 * @returns {Promise<{ widgets: Widget[][], acroForm: object|null, needAppearances: boolean, dr: object|null, da: string|null, q: number }>}
 *
 * @typedef {{ num: number, name: string, page: number, rect: number[], flags: number,
 *             ft: string|null, ff: number, value: *, defaultValue: *, da: string|null, q: number|null,
 *             maxLen: number|null, opt: { value: string, label: string }[], topIndex: number, selected: number[],
 *             as: string|null, mk: { bg: number[]|null, bc: number[]|null, ca: string|null, r: number },
 *             border: { width: number, style: string, dash: number[] },
 *             ap: { num: number, bbox: number[], matrix: number[] }|null, hasAp: boolean,
 *             onState: string|null }} Widget
 */
export async function collectWidgets(doc, pageNums) {
  const cat = dictOf(await doc.catalog());
  const acroForm = dictOf(await res(doc, cat.AcroForm));
  const pageIndex = new Map(pageNums.map((n, i) => [n, i]));
  const widgets = pageNums.map(() => []);
  const empty = { widgets, acroForm: null, needAppearances: false, dr: null, da: null, q: 0 };

  // the page whose /Annots lists each annotation, and its place there
  const annotPage = new Map();
  for (const [i, num] of pageNums.entries()) {
    const page = dictOf(await doc.getObject(num));
    (await arr(doc, page.Annots)).forEach((a, k) => {
      if (a?.type === 'ref' && !annotPage.has(a.num)) annotPage.set(a.num, { page: i, order: k });
    });
  }

  const seen = new Set();
  const add = async (num, d, field, name) => {
    if (seen.has(num)) return;
    seen.add(num);
    const p = d.P?.type === 'ref' ? pageIndex.get(d.P.num) : undefined;
    const listed = annotPage.get(num);
    const page = p ?? listed?.page;
    if (page === undefined) return;
    const w = await describe(doc, num, d, field, name);
    if (!w) return;
    w.page = page;
    w.order = listed?.page === page ? listed.order : Infinity;
    widgets[page].push(w);
  };

  const walk = async (ref, inh, name, depth) => {
    if (ref?.type !== 'ref' || depth > 32 || seen.has(ref.num)) return;
    const d = dictOf(await doc.getObject(ref.num));
    if (!d) return;
    const t = d.T !== undefined ? text(await res(doc, d.T)) : null;
    const full = t === null ? name : name ? `${name}.${t}` : t;
    const mine = { ...inh };
    for (const k of INHERITED) if (d[k] !== undefined) mine[k] = await res(doc, d[k]);
    // the field a widget belongs to: the nearest node with a name, and its
    // actions (format, calculate…; acroscript.js)
    if (t !== null) { mine.fieldNum = ref.num; mine.fieldAA = d.AA ?? null; }
    const kids = await arr(doc, d.Kids);
    for (const kid of kids) await walk(kid, mine, full, depth + 1);
    if (d.Subtype?.value === 'Widget' || (!kids.length && d.Rect)) await add(ref.num, d, mine, full);
  };
  if (acroForm) for (const f of await arr(doc, acroForm.Fields)) await walk(f, {}, '', 0);

  // widgets only a page lists: their attributes come up the /Parent chain;
  // other annotations (highlights, ink, stamps…) are kept for their
  // appearances alone, popups aside (Reader prints none)
  for (const [num] of annotPage) {
    if (seen.has(num)) continue;
    const d = dictOf(await doc.getObject(num));
    const subtype = d?.Subtype?.value;
    if (!subtype || subtype === 'Popup') continue;
    if (subtype !== 'Widget') {
      await add(num, d, {}, '');
      const w = widgets[annotPage.get(num).page].at(-1);
      if (w?.num === num) { w.annot = subtype; if (!w.hasAp) w.markup = await markupData(doc, d); }
      continue;
    }
    const inh = {};
    const names = [];
    for (let f = d, fnum = num, depth = 0; f && depth < 32; depth++) {
      for (const k of INHERITED) if (inh[k] === undefined && f[k] !== undefined) inh[k] = await res(doc, f[k]);
      if (f.T !== undefined) {
        names.unshift(text(await res(doc, f.T)));
        if (inh.fieldNum === undefined) { inh.fieldNum = fnum; inh.fieldAA = f.AA ?? null; }
      }
      fnum = f.Parent?.type === 'ref' ? f.Parent.num : null;
      f = f.Parent?.type === 'ref' ? dictOf(await doc.getObject(f.Parent.num)) : null;
    }
    await add(num, d, inh, names.join('.'));
  }

  for (const list of widgets) list.sort((a, b) => a.order - b.order);
  if (!acroForm) return empty;
  return {
    widgets,
    acroForm,
    needAppearances: (await res(doc, acroForm.NeedAppearances)) === true,
    dr: dictOf(await res(doc, acroForm.DR)),
    da: acroForm.DA !== undefined ? text(await res(doc, acroForm.DA)) : null,
    q: Number(await res(doc, acroForm.Q)) || 0,
    // calculation order: field object numbers
    co: (await arr(doc, acroForm.CO)).filter(r => r?.type === 'ref').map(r => r.num),
  };
}

async function describe(doc, num, d, field, name) {
  const rect = await nums(doc, d.Rect);
  if (!rect || rect.length !== 4) return null;
  const mkd = dictOf(await res(doc, d.MK)) ?? {};
  const bs = dictOf(await res(doc, d.BS)) ?? {};
  const borderArr = await arr(doc, d.Border);
  const as = d.AS ? (await res(doc, d.AS))?.value ?? null : null;

  // the normal appearance: a stream, or a dictionary of states picked by /AS
  let ap = null, onState = null;
  const apStates = {}; // a button's appearance for each state, by name
  const apd = dictOf(await res(doc, d.AP));
  const hasAp = !!apd?.N;
  if (apd?.N) {
    let nref = apd.N;
    let states = null;
    if (nref?.type === 'ref') {
      const obj = await doc.getObject(nref.num);
      if (!obj?.streamBytes) states = dictOf(obj);
    } else if (nref?.type === 'dict') states = nref.value;
    if (states) {
      // a button's on state: the one that is not Off (its export value)
      onState = Object.keys(states).find(k => k !== 'Off') ?? null;
      nref = as !== null ? states[as] : null;
      for (const [k, r] of Object.entries(states)) {
        if (r?.type !== 'ref') continue;
        const o = await doc.getObject(r.num);
        if (o?.streamBytes) apStates[k] = { num: r.num, bbox: (await nums(doc, o.dict.BBox)) ?? [0, 0, 0, 0], matrix: (await nums(doc, o.dict.Matrix)) ?? [1, 0, 0, 1, 0, 0] };
      }
    }
    if (nref?.type === 'ref') {
      const obj = await doc.getObject(nref.num);
      if (obj?.streamBytes) {
        ap = {
          num: nref.num,
          bbox: (await nums(doc, obj.dict.BBox)) ?? [0, 0, 0, 0],
          matrix: (await nums(doc, obj.dict.Matrix)) ?? [1, 0, 0, 1, 0, 0],
        };
      }
    }
  }

  const opt = [];
  for (const o of await arr(doc, field.Opt)) {
    const v = await res(doc, o);
    if (v?.type === 'array') {
      const [e, l] = v.value;
      opt.push({ value: text(await res(doc, e)), label: text(await res(doc, l)) });
    } else {
      const s = text(v);
      opt.push({ value: s, label: s });
    }
  }
  const selected = [];
  for (const i of await arr(doc, field.I)) selected.push(Number(await res(doc, i)));

  const color = async v => {
    const a = [];
    for (const c of await arr(doc, v)) a.push(Number(await res(doc, c)));
    if (a.length === 1) return [a[0], a[0], a[0]];
    if (a.length === 3) return a;
    if (a.length === 4) return [(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3])];
    return null; // none: transparent
  };
  const dash = [];
  for (const x of await arr(doc, bs.D)) dash.push(Number(await res(doc, x)));
  const bw = bs.W !== undefined ? Number(await res(doc, bs.W)) : borderArr.length >= 3 ? Number(await res(doc, borderArr[2])) : 1;

  return {
    num,
    name,
    rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
    flags: Number(await res(doc, d.F)) || 0,
    ft: field.FT?.value ?? null,
    ff: Number(field.Ff) || 0,
    value: decodeValue(field.V),
    defaultValue: decodeValue(field.DV),
    da: field.DA !== undefined ? text(field.DA) : null,
    q: field.Q !== undefined ? Number(field.Q) : null,
    maxLen: field.MaxLen !== undefined ? Number(field.MaxLen) : null,
    opt,
    topIndex: Number(field.TI) || 0,
    selected,
    as,
    mk: {
      bg: await color(mkd.BG),
      bc: await color(mkd.BC),
      ca: mkd.CA !== undefined ? text(await res(doc, mkd.CA)) : null,
      r: Number(await res(doc, mkd.R)) || 0,
      // a push button's icon (a form XObject), its layout and how it fits
      icon: await iconOf(doc, mkd.I),
      tp: Number(await res(doc, mkd.TP)) || 0,
      fit: await iconFit(doc, mkd.IF),
    },
    // a rich text value (XHTML) and its default style
    border: { width: Number.isFinite(bw) ? bw : 1, style: (await res(doc, bs.S))?.value ?? 'S', dash: dash.length ? dash : [3] },
    ap,
    hasAp,
    onState,
    apStates,
    oc: d.OC ?? null,
    // the field's object number (its widgets share it) and the actions of
    // the field and of this widget, unresolved
    field: field.fieldNum ?? num,
    aa: { field: field.fieldAA ?? null, widget: d.AA ?? null },
  };
}

/**
 * What drawing an annotation that has no appearance needs (annotations.js):
 * its colours (C, IC: RGB, null for none), opacity (CA), geometry
 * (QuadPoints, InkList, L, Vertices, CL, RD), line endings (LE), cloudy
 * border (BE), icon (Name), intent (IT) and, for free text, its text and
 * style (Contents, DA, DS, Q, Rotate).
 */
async function markupData(doc, d) {
  const color = async v => {
    const a = (await nums(doc, v)) ?? [];
    if (a.length === 1) return [a[0], a[0], a[0]];
    if (a.length === 3) return a;
    if (a.length === 4) return [(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3])];
    return null;
  };
  const name = async v => (await res(doc, v))?.value ?? null;
  const str = async v => (v === undefined ? null : text(await res(doc, v)));
  const ink = [];
  for (const path of await arr(doc, d.InkList)) {
    const pts = await nums(doc, path);
    if (pts?.length >= 2) ink.push(pts);
  }
  const le = [];
  for (const e of await arr(doc, d.LE)) le.push((await res(doc, e))?.value ?? 'None');
  const be = dictOf(await res(doc, d.BE));
  const ca = Number(await res(doc, d.CA));
  return {
    c: await color(d.C),
    ic: await color(d.IC),
    ca: Number.isFinite(ca) ? Math.min(1, Math.max(0, ca)) : 1,
    quadPoints: await nums(doc, d.QuadPoints),
    inkList: ink,
    l: await nums(doc, d.L),
    vertices: await nums(doc, d.Vertices),
    cl: await nums(doc, d.CL),
    rd: await nums(doc, d.RD),
    le,
    cloudy: be && (await name(be.S)) === 'C' ? Number(await res(doc, be.I)) || 0 : null,
    icon: await name(d.Name),
    intent: await name(d.IT),
    contents: await str(d.Contents),
    da: await str(d.DA),
    ds: await str(d.DS),
    q: Number(await res(doc, d.Q)) || 0,
    rotate: Number(await res(doc, d.Rotate)) || 0,
  };
}

// A form XObject used as an icon: its object number, BBox and Matrix
async function iconOf(doc, ref) {
  if (ref?.type !== 'ref') return null;
  const o = await doc.getObject(ref.num);
  if (!o?.streamBytes) return null;
  return { num: ref.num, bbox: (await nums(doc, o.dict.BBox)) ?? [0, 0, 0, 0], matrix: (await nums(doc, o.dict.Matrix)) ?? [1, 0, 0, 1, 0, 0] };
}

// /MK /IF: when to scale (A always, B when bigger, S when smaller, N never),
// how (P proportionally, A anamorphically), where the leftover space goes,
// and whether the border is ignored
async function iconFit(doc, v) {
  const d = dictOf(await res(doc, v)) ?? {};
  const a = (await nums(doc, d.A)) ?? [0.5, 0.5];
  return { sw: (await res(doc, d.SW))?.value ?? 'A', s: (await res(doc, d.S))?.value ?? 'P', a, fb: (await res(doc, d.FB)) === true };
}

// A field value: a string, a name (check boxes), or an array of them
function decodeValue(v) {
  if (v === undefined || v === null) return null;
  if (v.type === 'string') return text(v);
  if (v.type === 'name') return v.value;
  if (v.type === 'array') return v.value.map(decodeValue);
  return v;
}

/** A PDF text string: UTF-16BE with a byte order mark, else PDFDocEncoding */
export function text(v) {
  const s = v?.type === 'string' ? v.value : typeof v === 'string' ? v : v?.value ?? '';
  if (typeof s !== 'string') return String(s ?? '');
  if (s.charCodeAt(0) === 0xFE && s.charCodeAt(1) === 0xFF) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += PDFDOC[c] ?? ch;
  }
  return out;
}

// PDFDocEncoding where it differs from Latin-1
const PDFDOC = {
  0x18: '˘', 0x19: 'ˇ', 0x1A: 'ˆ', 0x1B: '˙', 0x1C: '˝', 0x1D: '˛', 0x1E: '˚', 0x1F: '˜',
  0x80: '•', 0x81: '†', 0x82: '‡', 0x83: '…', 0x84: '—', 0x85: '–', 0x86: 'ƒ', 0x87: '⁄',
  0x88: '‹', 0x89: '›', 0x8A: '−', 0x8B: '‰', 0x8C: '„', 0x8D: '“', 0x8E: '”', 0x8F: '‘',
  0x90: '’', 0x91: '‚', 0x92: '™', 0x93: 'ﬁ', 0x94: 'ﬂ', 0x95: 'Ł', 0x96: 'Œ', 0x97: 'Š',
  0x98: 'Ÿ', 0x99: 'Ž', 0x9A: 'ı', 0x9B: 'ł', 0x9C: 'œ', 0x9D: 'š', 0x9E: 'ž', 0xA0: '€',
};

// ---------------------------------------------------------------------------

function dictOf(obj) {
  if (!obj) return null;
  if (obj.dict && obj.streamBytes) return obj.dict;
  const v = obj.value !== undefined && obj.type !== 'dict' ? obj.value : obj;
  if (v?.type === 'dict') return v.value;
  return v && typeof v === 'object' && !v.type ? v : null;
}

async function res(doc, v) {
  if (v?.type === 'ref') {
    const obj = await doc.getObject(v.num);
    if (!obj) return null;
    if (obj.streamBytes) return obj;
    return obj.value ?? obj;
  }
  return v;
}

async function arr(doc, v) {
  const r = await res(doc, v);
  if (Array.isArray(r)) return r;
  if (r?.type === 'array') return r.value;
  return [];
}

async function nums(doc, v) {
  const items = await arr(doc, v);
  if (!items.length) return null;
  const out = [];
  for (const it of items) out.push(Number(await res(doc, it)));
  return out.every(Number.isFinite) ? out : null;
}
