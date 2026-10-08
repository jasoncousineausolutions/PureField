/**
 * Purefield / print.js
 *
 * Toner-saving print copies: a PDF whose pages are dark (slides, dark-mode
 * exports, black panels with white text) is rewritten as a black-on-white,
 * greyscale PDF. Pictures are left exactly as they are.
 *
 *   const { pdf, log } = await optimizeForPrint(arrayBuffer);
 *
 * The file is flattened first (index.js), so form fields and comments are
 * part of the page content. Then each page is read as a viewer would draw
 * it (content streams and the form XObjects they draw), and every vector
 * fill, stroke, text run and stencil mask becomes one element with its
 * colour (as a luminance, 0 black to 1 white) and its extent on the page.
 *
 * Each element sits on a backdrop: the latest larger fill, shading or image
 * under its centre, or the paper. Decisions run in painting order:
 *   - a dark fill that is a page background (over 60% of the page), or that
 *     has lighter elements on it (a panel with white text; a lighter fill
 *     covering most of it makes it a frame instead), becomes paper
 *     white (a page) or a light tint (a panel, `panels`), and everything on
 *     it is inverted: white text turns black, pale accents turn mid grey;
 *   - a pale fill covering most of the page becomes white;
 *   - a lighter box that other elements sit on prints no darker than the
 *     panel tint;
 *   - anything else keeps its luminance (inverted on an inverted backdrop);
 *   - text, strokes and masks keep at least a minimum contrast with what
 *     is now under them, unless they had none to begin with (hidden text);
 *   - shadings used as dark backgrounds are dropped; other shadings and all
 *     images are kept as they are, and text over an image is not inverted.
 * The content streams are rewritten with these greys (DeviceGray `g`/`G`
 * before each painting operator, the original colour operators removed).
 */

import { flattenXfa, printPreferences } from './index.js';
import { parsePdf } from './core/parser.js';
import { importPages } from './core/importer.js';
import { PdfWriter } from './core/writer.js';
import { tokenize } from './core/content.js';
import { XfaLog } from './xfa/log.js';

const PAGE_BACKGROUND = 0.6;  // share of the page a fill must cover to be the page's background
const DARK = 0.5;             // luminance below which a fill counts as dark
const LIGHTER = 0.25;         // how much lighter an element on a fill must be to make it a panel
const FRAME = 0.6;            // share of a dark fill a lighter fill on it covers when the dark one is only its frame
const TEXT_CONTRAST = 0.45;   // least contrast kept for text…
const LINE_CONTRAST = 0.3;    // …and for strokes and stencil masks
const MAX_DEPTH = 12;         // form XObjects inside form XObjects

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{ panels?: number } & Parameters<typeof flattenXfa>[1]} [options]
 *   panels: the grey (0 black … 1 white) dark panels smaller than the page
 *   become; default 0.92, a light tint that keeps their shape for little
 *   toner; 1 prints them white. Every other option is passed to flattenXfa.
 * @returns {Promise<{ pdf: Uint8Array, log: XfaLog, pageCount: number, inverted: number, recolored: number }>}
 *   inverted: dark backgrounds and panels turned light; recolored: elements
 *   given a grey
 */
export async function optimizeForPrint(input, options = {}) {
  const { panels = 0.92, ...flattenOptions } = options;
  if (!(panels >= 0 && panels <= 1)) throw new TypeError(`panels: expected a number from 0 to 1, got ${JSON.stringify(panels)}`);
  const flat = await flattenXfa(input, flattenOptions);
  const log = flat.log ?? new XfaLog();
  const doc = await parsePdf(flat.pdf.buffer.slice(flat.pdf.byteOffset, flat.pdf.byteOffset + flat.pdf.byteLength));

  const plan = new Plan();
  const stats = { inverted: 0, recolored: 0 };
  const objects = new ObjectCache(doc);
  const pageRefs = await pageList(objects);
  for (const ref of pageRefs) {
    try {
      const elements = await readPage(objects, ref, plan, log);
      decide(elements.list, elements.area, { panels }, plan, stats);
    } catch (e) {
      log.warn('PRINT_PAGE_SKIPPED', `page object ${ref.num} kept in its colours: ${e.message}`);
    }
  }
  const imported = await importPages(doc, { log, rewrite: (num, bytes) => plan.apply(num, bytes) });
  const pages = imported.pages.map(base => ({ width: base.width, height: base.height, content: '', images: [], base }));
  const pdf = new PdfWriter().build(pages, { Producer: 'Purefield' }, { imported, catalog: await printPreferences(doc) });
  log.info('PRINT_OPTIMIZED', `${stats.inverted} dark background(s) or panel(s) lightened, ${stats.recolored} element(s) printed in grey`);
  return { pdf, log, pageCount: pages.length, ...stats };
}

// ---------------------------------------------------------------------------
// Edits to the content streams: ranges taken out, greys put in, by offset in
// the decoded stream. A stream drawn more than once (a form XObject shared
// by pages) keeps the first greys decided for it.
// ---------------------------------------------------------------------------

class Plan {
  constructor() { this.streams = new Map(); }
  stream(num) {
    if (!this.streams.has(num)) this.streams.set(num, { cut: new Map(), put: new Map() });
    return this.streams.get(num);
  }
  cut(num, start, end) { this.stream(num).cut.set(start, end); }
  put(num, at, text) {
    const s = this.stream(num);
    if (!s.put.has(at)) s.put.set(at, text);
  }
  apply(num, bytes) {
    const s = this.streams.get(num);
    if (!s || (!s.cut.size && !s.put.size)) return null;
    const enc = new TextEncoder();
    const marks = [...new Set([...s.cut.keys(), ...s.put.keys()])].sort((a, b) => a - b);
    const parts = [];
    let pos = 0;
    for (const at of marks) {
      if (at < pos) continue; // inside a range already taken out
      parts.push(bytes.subarray(pos, at));
      if (s.put.has(at)) parts.push(enc.encode(`\n${s.put.get(at)}\n`));
      pos = at;
      if (s.cut.has(at)) { parts.push(enc.encode(' ')); pos = s.cut.get(at); }
    }
    parts.push(bytes.subarray(pos));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

// The source objects, each read (and inflated) once for all pages; of an
// image only its dictionary is kept
class ObjectCache {
  constructor(doc) { this.doc = doc; this.map = new Map(); }
  catalog() { return this.doc.catalog(); }
  getObject(num) {
    if (!this.map.has(num)) {
      this.map.set(num, this.doc.getObject(num).then(o => (o?.streamBytes && o.dict?.Subtype?.value === 'Image'
        ? { objNum: o.objNum, dict: o.dict, streamBytes: new Uint8Array(0) } : o)));
    }
    return this.map.get(num);
  }
}

// ---------------------------------------------------------------------------
// Reading a page: the elements it paints, in order
// ---------------------------------------------------------------------------

/**
 * @typedef {{ kind: 'fill'|'stroke'|'fillstroke'|'text'|'mask'|'image'|'shading',
 *   box: number[], area: number, fill?: number|null, stroke?: number|null,
 *   at?: { num: number, offset: number }|null, cut?: { num: number, start: number, end: number }|null,
 *   backdrop?: Element|null, kids?: Element[], out?: number|null, invert?: boolean }} Element
 */

async function pageList(doc) {
  const out = [];
  const seen = new Set();
  const walk = async (ref, inherited) => {
    if (ref?.type !== 'ref' || seen.has(ref.num)) return;
    seen.add(ref.num);
    const node = dictOf(await doc.getObject(ref.num));
    if (!node) return;
    const inh = { ...inherited };
    for (const k of ['Resources', 'MediaBox', 'CropBox']) if (node[k] !== undefined) inh[k] = node[k];
    if (node.Kids) for (const kid of items(await get(doc, node.Kids))) await walk(kid, inh);
    else out.push({ num: ref.num, dict: node, inherited: inh });
  };
  await walk(dictOf(await doc.catalog()).Pages, {});
  return out;
}

async function readPage(doc, page, plan, log) {
  const { dict, inherited } = page;
  const box = await numbers(doc, dict.CropBox ?? inherited.CropBox ?? dict.MediaBox ?? inherited.MediaBox) ?? [0, 0, 612, 792];
  const pageBox = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
  const resources = dictOf(await get(doc, dict.Resources ?? inherited.Resources)) ?? {};
  const contents = await get(doc, dict.Contents);
  const refs = contents?.type === 'array' ? contents.value : [dict.Contents];
  const reader = new PageReader(doc, plan, log, pageBox);
  // the graphics state carries over from one content stream to the next
  const frame = { gs: initialState(pageBox), stack: [] };
  for (const r of refs) {
    if (r?.type !== 'ref') continue;
    await reader.run(r.num, resources, frame, 0);
  }
  return { list: reader.elements, area: area(pageBox) };
}

function initialState(clip) {
  return { ctm: [1, 0, 0, 1, 0, 0], clip, fillCS: GRAY, strokeCS: GRAY, fill: 0, stroke: 0,
    font: null, size: 0, scale: 1, rise: 0, render: 0 };
}

const GRAY = { kind: 'gray', n: 1 };
const RGB = { kind: 'rgb', n: 3 };
const CMYK = { kind: 'cmyk', n: 4 };
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PAINT_OPS = { f: 'fill', F: 'fill', 'f*': 'fill', S: 'stroke', s: 'stroke', B: 'fillstroke', 'B*': 'fillstroke', b: 'fillstroke', 'b*': 'fillstroke', n: null };
const COLOR_OPS = new Set(['g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN']);
const STROKE_COLOR_OPS = new Set(['G', 'RG', 'K', 'CS', 'SC', 'SCN']);

class PageReader {
  constructor(doc, plan, log, pageBox) {
    this.doc = doc;
    this.plan = plan;
    this.log = log;
    this.pageBox = pageBox;
    this.elements = [];
    this.fonts = new Map();
    this.spaces = new Map();
  }

  async run(num, resources, frame, depth) {
    const obj = await this.doc.getObject(num);
    if (!obj?.streamBytes) return;
    const filters = items(obj.dict.Filter).map(f => f?.value ?? f);
    // a stream that cannot be rewritten (an unusual filter) is read for its
    // extents but keeps its colours
    const editable = filters.every(f => f === 'FlateDecode') && !obj.dict.DecodeParms;
    const b = obj.streamBytes;
    obj.tokens ??= tokenize(b);
    const tokens = obj.tokens;
    const stack = frame.stack;
    let gs = frame.gs;
    // the path under construction ({ box, at }) and a pending clip carry
    // over too: a path may be painted in the next content stream
    let { path = null, clipNext = false } = frame;
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
    let leading = 0, charSpace = 0, wordSpace = 0;
    let operands = [];
    const num_ = t => parseFloat(text(b, t));
    const nums = () => operands.filter(t => t.kind === 'number').map(num_);
    const opStart = t => operands[0]?.start ?? t.start;

    for (const t of tokens) {
      if (t.kind !== 'op') { operands.push(t); continue; }
      const op = t.text;
      try {
        if (COLOR_OPS.has(op)) {
          await this.color(op, operands, b, gs, resources);
          if (editable) this.plan.cut(num, opStart(t), t.end);
        } else if (PATH_OPS.has(op)) {
          const n = nums();
          path ??= { box: null, at: editable ? { num, offset: opStart(t) } : null };
          const pts = op === 're' ? [[n[0], n[1]], [n[0] + n[2], n[1]], [n[0], n[1] + n[3]], [n[0] + n[2], n[1] + n[3]]]
            : op === 'h' ? [] : pairs(n);
          for (const p of pts) path.box = grow(path.box, apply(gs.ctm, p));
        } else if (op in PAINT_OPS) {
          const kind = PAINT_OPS[op];
          const pbox = path?.box ?? null;
          if (kind && pbox) {
            // (line widths are left out of a stroke's extent)
            this.add({ kind, box: intersect(pbox, gs.clip), fill: kind === 'stroke' ? null : gs.fill, stroke: kind === 'fill' ? null : gs.stroke,
              at: path.at });
          }
          if (clipNext && pbox) gs.clip = intersect(gs.clip, pbox) ?? [0, 0, 0, 0];
          clipNext = false;
          path = null;
        } else switch (op) {
          case 'q': stack.push(gs); gs = { ...gs }; break;
          case 'Q': if (stack.length) gs = stack.pop(); break;
          case 'cm': { const n = nums(); if (n.length === 6) gs.ctm = mul(n, gs.ctm); break; }
          case 'W': case 'W*': clipNext = true; break;
          case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
          case 'Tf': {
            const name = operands.find(o => o.kind === 'name');
            gs.font = name ? text(b, name).slice(1) : null;
            gs.size = nums().at(-1) ?? 0;
            break;
          }
          case 'Tz': gs.scale = (nums()[0] ?? 100) / 100; break;
          case 'Ts': gs.rise = nums()[0] ?? 0; break;
          case 'Tr': gs.render = nums()[0] ?? 0; break;
          case 'TL': leading = nums()[0] ?? 0; break;
          case 'Tc': charSpace = nums()[0] ?? 0; break;
          case 'Tw': wordSpace = nums()[0] ?? 0; break;
          case 'Td': case 'TD': {
            const [x = 0, y = 0] = nums();
            if (op === 'TD') leading = -y;
            tlm = mul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice();
            break;
          }
          case 'Tm': { const n = nums(); if (n.length === 6) { tlm = n; tm = n.slice(); } break; }
          case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break;
          case "'": case '"': case 'Tj': case 'TJ': {
            if (op === "'" || op === '"') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); }
            if (op === '"') { const n = nums(); wordSpace = n[0] ?? wordSpace; charSpace = n[1] ?? charSpace; }
            const wide = await this.wideFont(gs.font, resources);
            let width = 0;
            for (const o of operands) {
              if (o.kind === 'string' || o.kind === 'hex') {
                const chars = Math.max(1, Math.round(stringLength(b, o) / (wide ? 2 : 1)));
                width += (chars * (0.5 * gs.size + charSpace)) * gs.scale;
              } else if (o.kind === 'number' && op === 'TJ') width -= num_(o) / 1000 * gs.size * gs.scale;
            }
            if (gs.render !== 3 && gs.render !== 7) {
              const m = mul(tm, gs.ctm);
              let box = null;
              for (const p of [[0, gs.rise - 0.2 * gs.size], [width, gs.rise - 0.2 * gs.size], [0, gs.rise + 0.8 * gs.size], [width, gs.rise + 0.8 * gs.size]]) box = grow(box, apply(m, p));
              const mode = gs.render % 4;
              this.add({ kind: 'text', box: intersect(box, gs.clip), fill: mode === 1 ? null : gs.fill, stroke: mode === 0 ? null : gs.stroke,
                at: editable ? { num, offset: opStart(t) } : null });
            }
            tm = mul([1, 0, 0, 1, width, 0], tm);
            break;
          }
          case 'Do': {
            const name = operands.at(-1);
            if (name?.kind === 'name') await this.xobject(text(b, name).slice(1), resources, gs, depth, editable ? { num, offset: opStart(t) } : null);
            break;
          }
          case 'BI': {
            const head = text(b, t, 400);
            const mask = /\/(IM|ImageMask)\s+true/.test(head);
            const box = intersect(unitBox(gs.ctm), gs.clip);
            this.add(mask ? { kind: 'mask', box, fill: gs.fill, at: editable ? { num, offset: t.start } : null } : { kind: 'image', box });
            break;
          }
          case 'sh': {
            const name = operands.at(-1);
            const lum = name?.kind === 'name' ? await this.shading(await this.resource(resources, 'Shading', text(b, name).slice(1))) : null;
            this.add({ kind: 'shading', box: gs.clip, fill: lum, cut: editable ? { num, start: opStart(t), end: t.end } : null });
            break;
          }
        }
      } catch (e) {
        this.log.once?.('warn', 'PRINT_OPERATOR', `${op}:${e.message}`, `${op} not read: ${e.message}`);
      }
      operands = [];
    }
    Object.assign(frame, { gs, path, clipNext });
  }

  add(el) {
    if (!el.box) return;
    el.area = area(el.box);
    this.elements.push(el);
  }

  async resource(resources, kind, name) {
    const sub = dictOf(await get(this.doc, resources?.[kind]));
    return sub?.[name] ?? null;
  }

  async xobject(name, resources, gs, depth, at) {
    const ref = await this.resource(resources, 'XObject', name);
    if (ref?.type !== 'ref') return;
    const obj = await this.doc.getObject(ref.num);
    const d = obj?.dict;
    if (!d) return;
    const subtype = d.Subtype?.value;
    if (subtype === 'Image') {
      const box = intersect(unitBox(gs.ctm), gs.clip);
      if (await get(this.doc, d.ImageMask) === true) this.add({ kind: 'mask', box, fill: gs.fill, at });
      else this.add({ kind: 'image', box });
      return;
    }
    if (subtype !== 'Form' || depth >= MAX_DEPTH) return;
    const inner = { ...gs };
    const matrix = await numbers(this.doc, d.Matrix, 6);
    if (matrix) inner.ctm = mul(matrix, gs.ctm);
    const bbox = await numbers(this.doc, d.BBox);
    if (bbox) {
      let box = null;
      for (const p of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]) box = grow(box, apply(inner.ctm, p));
      inner.clip = intersect(inner.clip, box) ?? [0, 0, 0, 0];
    }
    const res = dictOf(await get(this.doc, d.Resources)) ?? resources;
    await this.run(ref.num, res, { gs: inner, stack: [] }, depth + 1);
  }

  async wideFont(name, resources) {
    if (!name) return false;
    const ref = await this.resource(resources, 'Font', name);
    const key = ref?.type === 'ref' ? ref.num : name;
    if (!this.fonts.has(key)) {
      const d = dictOf(await get(this.doc, ref));
      this.fonts.set(key, d?.Subtype?.value === 'Type0');
    }
    return this.fonts.get(key);
  }

  // ---- colour ----

  async color(op, operands, b, gs, resources) {
    const stroke = STROKE_COLOR_OPS.has(op);
    const nums = operands.filter(t => t.kind === 'number').map(t => parseFloat(text(b, t)));
    const key = stroke ? 'stroke' : 'fill';
    const csKey = stroke ? 'strokeCS' : 'fillCS';
    switch (op.toLowerCase()) {
      case 'g': gs[csKey] = GRAY; gs[key] = luminance(GRAY, nums); break;
      case 'rg': gs[csKey] = RGB; gs[key] = luminance(RGB, nums); break;
      case 'k': gs[csKey] = CMYK; gs[key] = luminance(CMYK, nums); break;
      case 'cs': {
        const name = operands.find(t => t.kind === 'name');
        const cs = name ? await this.space(text(b, name).slice(1), resources) : GRAY;
        gs[csKey] = cs;
        gs[key] = luminance(cs, initial(cs));
        break;
      }
      case 'sc': case 'scn': {
        const cs = gs[csKey];
        const name = operands.find(t => t.kind === 'name');
        if (cs.kind === 'pattern' && name) {
          const pattern = dictOf(await get(this.doc, await this.resource(resources, 'Pattern', text(b, name).slice(1))));
          if (pattern?.PatternType === 2) gs[key] = await this.shading(pattern.Shading);
          else if (pattern?.PaintType === 2 && cs.base) gs[key] = luminance(cs.base, nums);
          else gs[key] = 0.5;
        } else gs[key] = luminance(cs, nums);
        break;
      }
    }
  }

  async space(name, resources) {
    if (name === 'DeviceGray' || name === 'G' || name === 'CalGray') return GRAY;
    if (name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB') return RGB;
    if (name === 'DeviceCMYK' || name === 'CMYK') return CMYK;
    if (name === 'Pattern') return { kind: 'pattern', n: 0 };
    const ref = await this.resource(resources, 'ColorSpace', name);
    if (!ref) return GRAY;
    return this.spaceOf(ref, 0);
  }

  async spaceOf(v, depth) {
    const key = v?.type === 'ref' ? v.num : null;
    if (key !== null && this.spaces.has(key)) return this.spaces.get(key);
    const val = await get(this.doc, v);
    let cs = GRAY;
    if (val?.type === 'name') cs = await this.space(val.value, {});
    else if (val?.type === 'array' && depth < 4) {
      const [family, ...rest] = val.value;
      const fam = family?.value;
      if (fam === 'ICCBased') {
        const n = Number(await get(this.doc, (await this.doc.getObject(rest[0]?.num))?.dict?.N)) || 3;
        cs = n === 1 ? GRAY : n === 4 ? CMYK : RGB;
      } else if (fam === 'CalGray') cs = GRAY;
      else if (fam === 'CalRGB') cs = RGB;
      else if (fam === 'Lab') cs = { kind: 'lab', n: 3 };
      else if (fam === 'Indexed' || fam === 'I') {
        const base = await this.spaceOf(rest[0], depth + 1);
        const hival = Number(await get(this.doc, rest[1])) || 0;
        const lookupVal = rest[2];
        let lookup = null;
        if (lookupVal?.type === 'ref') {
          const o = await this.doc.getObject(lookupVal.num);
          lookup = o?.streamBytes ?? (o?.value?.type === 'string' ? latin1(o.value.value) : null);
        } else if (lookupVal?.type === 'string') lookup = latin1(lookupVal.value);
        cs = { kind: 'indexed', n: 1, base, hival, lookup };
      } else if (fam === 'Separation') {
        const ink = rest[0]?.value;
        cs = { kind: 'separation', n: 1, ink };
      } else if (fam === 'DeviceN') {
        const inks = items(await get(this.doc, rest[0])).map(x => x?.value);
        cs = { kind: 'devicen', n: inks.length, inks };
      } else if (fam === 'Pattern') {
        cs = { kind: 'pattern', n: 0, base: rest[0] ? await this.spaceOf(rest[0], depth + 1) : null };
      }
    }
    if (key !== null) this.spaces.set(key, cs);
    return cs;
  }

  // the mean luminance of a shading's colours, or null when it cannot be told
  async shading(v) {
    const d = dictOf(await get(this.doc, v));
    if (!d) return null;
    const cs = d.ColorSpace ? await this.spaceOf(d.ColorSpace, 0) : GRAY;
    const ends = [];
    const collect = async (f, depth) => {
      const fd = dictOf(await get(this.doc, f));
      if (!fd || depth > 4) return;
      if (fd.FunctionType === 2) {
        const c0 = await numberList(this.doc, fd.C0) ?? [0];
        const c1 = await numberList(this.doc, fd.C1) ?? [1];
        ends.push(c0, c1);
      } else if (fd.FunctionType === 3) {
        for (const g of items(await get(this.doc, fd.Functions))) await collect(g, depth + 1);
      }
    };
    const fn = await get(this.doc, d.Function);
    if (fn?.type === 'array') {
      // one function per component: their ends, side by side
      const parts = [];
      for (const g of fn.value) {
        const gd = dictOf(await get(this.doc, g));
        if (gd?.FunctionType !== 2) return null;
        parts.push([(await numberList(this.doc, gd.C0) ?? [0])[0], (await numberList(this.doc, gd.C1) ?? [1])[0]]);
      }
      ends.push(parts.map(p => p[0]), parts.map(p => p[1]));
    } else await collect(d.Function, 0);
    if (!ends.length) return null;
    const lums = ends.map(c => luminance(cs, c)).filter(x => x !== null);
    return lums.length ? lums.reduce((a, x) => a + x, 0) / lums.length : null;
  }
}

function initial(cs) {
  if (cs.kind === 'cmyk') return [0, 0, 0, 1];
  if (cs.kind === 'separation' || cs.kind === 'devicen') return new Array(cs.n).fill(1);
  return new Array(cs.n).fill(0);
}

// The luminance (0 black … 1 white) of a colour, Rec. 601 weights on the
// device values; null for a colour that paints nothing or cannot be told
function luminance(cs, c) {
  const clamp = x => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  const rgb = (r, g, b) => 0.299 * clamp(r) + 0.587 * clamp(g) + 0.114 * clamp(b);
  switch (cs.kind) {
    case 'gray': return clamp(c[0] ?? 0);
    case 'rgb': return rgb(c[0], c[1], c[2]);
    case 'cmyk': { const k = clamp(c[3] ?? 0); return rgb((1 - clamp(c[0])) * (1 - k), (1 - clamp(c[1])) * (1 - k), (1 - clamp(c[2])) * (1 - k)); }
    case 'lab': return clamp((c[0] ?? 0) / 100);
    case 'indexed': {
      if (!cs.lookup) return 0.5;
      const i = Math.min(cs.hival, Math.max(0, Math.round(c[0] ?? 0)));
      const n = cs.base.n;
      const comps = Array.from(cs.lookup.subarray(i * n, i * n + n), x => x / 255);
      return luminance(cs.base, comps);
    }
    case 'separation': {
      if (cs.ink === 'None') return null;
      const t = clamp(c[0] ?? 1);
      // black and registration inks print black; other spot inks as a mid tone
      return cs.ink === 'All' || /^black$/i.test(cs.ink ?? '') ? 1 - t : 1 - 0.6 * t;
    }
    case 'devicen': {
      const t = Math.max(0, ...c.map(clamp));
      const black = cs.inks?.some((ink, i) => /^black$/i.test(ink ?? '') && clamp(c[i]) > 0);
      return black ? 1 - t : 1 - 0.6 * t;
    }
    case 'pattern': return 0.5;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deciding the greys
// ---------------------------------------------------------------------------

const BACKDROPS = new Set(['fill', 'fillstroke', 'shading', 'image']);
const LOOKBACK = 4000;

function decide(list, pageArea, { panels }, plan, stats) {
  // each element's backdrop: the latest larger backdrop under its centre
  const backdrops = [];
  for (const el of list) {
    const [cx, cy] = [(el.box[0] + el.box[2]) / 2, (el.box[1] + el.box[3]) / 2];
    el.backdrop = null;
    for (let i = backdrops.length - 1, seen = 0; i >= 0 && seen < LOOKBACK; i--, seen++) {
      const c = backdrops[i];
      if (c.area > el.area && cx >= c.box[0] && cx <= c.box[2] && cy >= c.box[1] && cy <= c.box[3]) { el.backdrop = c; break; }
    }
    el.kids = [];
    el.backdrop?.kids.push(el);
    if (BACKDROPS.has(el.kind) && el.area > 0) backdrops.push(el);
  }

  const fmt = v => String(+Math.min(1, Math.max(0, v)).toFixed(3));
  for (const el of list) {
    const b = el.backdrop;
    // under an image nothing is inverted; on paper nothing either
    const invert = b ? (b.kind === 'image' ? false : b.childInvert) : false;
    const under = b ? (b.kind === 'image' ? null : b.out) : 1;
    const underBefore = b ? (b.kind === 'image' ? null : b.fill) : 1;
    const flip = v => (v === null || v === undefined ? null : invert ? 1 - v : v);

    if (el.kind === 'image') { el.childInvert = false; continue; }

    if (el.kind === 'fill' || el.kind === 'fillstroke' || el.kind === 'shading') {
      const v = flip(el.fill);
      el.childInvert = invert;
      el.out = v;
      if (v === null) { el.out = el.kind === 'shading' ? null : under; continue; }
      const share = el.area / pageArea;
      // lighter elements on it, other than a fill covering most of it (a
      // dark fill with a lighter one inside is a frame, such as a box's border)
      const lighterOnTop = el.kids.some(k => {
        if (BACKDROPS.has(k.kind) && k.area > FRAME * el.area) return false;
        const kv = flip(k.kind === 'stroke' ? k.stroke : k.fill ?? k.stroke);
        return kv !== null && kv > v + LIGHTER;
      });
      if (v < DARK && (share > PAGE_BACKGROUND || lighterOnTop)) {
        el.out = share > PAGE_BACKGROUND ? 1 : apart(panels, under);
        el.childInvert = !invert;
        stats.inverted++;
      } else if (v > 0.85 && share > PAGE_BACKGROUND) {
        el.out = 1;
      } else if (v >= DARK && el.kids.length && el.kind !== 'shading') {
        // a light box things sit on (a card, a table header): a light tint
        el.out = apart(Math.max(v, panels), under);
      }
      if (el.kind === 'shading') {
        // a shading lightened is taken out: the paper shows instead
        if (el.out !== v && el.cut) { plan.cut(el.cut.num, el.cut.start, el.cut.end); el.out = 1; }
        else el.out = v;
        continue;
      }
      let line = '';
      if (el.kind === 'fillstroke') line = ` ${fmt(contrast(flip(el.stroke), el.stroke, under, underBefore, LINE_CONTRAST))} G`;
      if (el.at) { plan.put(el.at.num, el.at.offset, `${fmt(el.out)} g${line}`); stats.recolored++; }
      continue;
    }

    // text, strokes and stencil masks: kept readable against what is under them now
    const min = el.kind === 'text' ? TEXT_CONTRAST : LINE_CONTRAST;
    const fill = el.fill === null || el.fill === undefined ? null : contrast(flip(el.fill), el.fill, under, underBefore, min);
    const stroke = el.stroke === null || el.stroke === undefined ? null : contrast(flip(el.stroke), el.stroke, under, underBefore, min);
    el.out = fill ?? stroke;
    el.childInvert = invert;
    if (!el.at) continue;
    const ops = [];
    if (fill !== null) ops.push(`${fmt(fill)} g`);
    if (stroke !== null) ops.push(`${fmt(stroke)} G`);
    if (ops.length) { plan.put(el.at.num, el.at.offset, ops.join(' ')); stats.recolored++; }
  }
}

// A tint that would vanish into the tint under it (a button on a card):
// white instead, or a shade darker than a near-white one
function apart(v, under) {
  if (under === null || under === undefined || under >= 1 || Math.abs(v - under) >= 0.04) return v;
  return under < 0.96 ? 1 : under - 0.08;
}

// v (the new grey) moved, when it must be, to at least `min` from what is
// under it now; an element that had almost no contrast to begin with (text
// hidden in the page colour) is left as faint as it was
function contrast(v, before, under, underBefore, min) {
  if (v === null || under === null || under === undefined) return v;
  if (underBefore !== null && underBefore !== undefined && Math.abs(before - underBefore) < 0.1) return v;
  if (Math.abs(v - under) >= min) return v;
  return under >= min ? under - min : under + min;
}

// ---------------------------------------------------------------------------
// Geometry and values
// ---------------------------------------------------------------------------

function mul(a, b) {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}
function apply(m, [x, y]) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
function pairs(n) { const out = []; for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; }
function grow(box, [x, y]) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return box;
  return box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
}
function intersect(a, b) {
  if (!a) return null;
  if (!b) return a;
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] <= r[2] && r[1] <= r[3] ? r : null;
}
function area(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }
function unitBox(ctm) {
  let box = null;
  for (const p of [[0, 0], [1, 0], [0, 1], [1, 1]]) box = grow(box, apply(ctm, p));
  return box;
}

function text(b, t, max = 200) { return String.fromCharCode(...b.subarray(t.start, Math.min(t.end, t.start + max))); }

// the number of bytes a string operand holds
function stringLength(b, t) {
  if (t.kind === 'hex') return Math.ceil(text(b, t, 1e6).replace(/[^0-9A-Fa-f]/g, '').length / 2);
  let n = 0;
  for (let i = t.start + 1; i < t.end - 1; i++) {
    if (b[i] === 92) {
      i++;
      if (b[i] === 10 || b[i] === 13) continue; // a line continuation
      if (b[i] >= 48 && b[i] <= 55) for (let k = 0; k < 2 && b[i + 1] >= 48 && b[i + 1] <= 55; k++) i++;
    }
    n++;
  }
  return n;
}

function latin1(s) { return Uint8Array.from(s, c => c.charCodeAt(0) & 0xFF); }

async function get(doc, v) {
  if (v?.type === 'ref') {
    const obj = await doc.getObject(v.num);
    return obj?.value ?? obj?.dict ?? null;
  }
  return v ?? null;
}

function dictOf(v) {
  if (!v) return null;
  if (v.dict && v.streamBytes) return v.dict;
  const val = v.value !== undefined && v.type !== 'dict' && !v.type ? v.value : v;
  if (val?.type === 'dict') return val.value;
  if (val?.value?.type === 'dict') return val.value.value;
  return val && typeof val === 'object' && !val.type ? val : null;
}

function items(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (v.type === 'array') return v.value;
  return [v];
}

async function numberList(doc, v) {
  const arr = items(await get(doc, v));
  if (!arr.length) return null;
  const out = [];
  for (const x of arr) out.push(Number(await get(doc, x)));
  return out.every(Number.isFinite) ? out : null;
}

async function numbers(doc, v, n = 4) {
  const out = await numberList(doc, v);
  return out?.length === n ? out : null;
}
