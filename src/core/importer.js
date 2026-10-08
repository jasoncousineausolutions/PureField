/**
 * Purefield / core / importer.js
 *
 * Copies pages of a parsed source PDF into a new document (spec §9: static
 * XFA forms keep their shell pages). Each page's content streams and the
 * object graph its resources reference are copied with fresh object
 * numbers; annotations (the form widgets) are left behind, which is what
 * flattening wants, except that comb text widgets are reported so their
 * boxes can be drawn (Reader prints them; the shell page lacks them).
 *
 * Objects are emitted in a local number space. Bodies refer to other
 * imported objects through "\u0000R<local>\u0000" placeholders that
 * PdfWriter rewrites once it knows the final numbers.
 *
 * Streams are written decrypted. A stream whose filter chain contains
 * FlateDecode was inflated by the parser; it is deflated again so its
 * dictionary (Filter, DecodeParms, predictors) stays valid unchanged.
 *
 * Optional content that does not print (optional.js) is taken out of page
 * content streams and form XObjects as they are copied.
 */

import { printVisibility, filterContent } from './optional.js';
import { substituteFont } from './substitute.js';
import { shownText } from './content.js';

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

/**
 * @param {import('./parser.js').PdfDocument} doc
 * @param {{ log?: object, fonts?: object|null, rewrite?: ((num: number, bytes: Uint8Array) => Uint8Array|null)|null }} [opts]
 *   rewrite: called with each stream copied whose filters are none or
 *   FlateDecode alone (decoded bytes, by source object number); what it
 *   returns is written in their place
 * @returns {Promise<ImportedDoc>}
 *
 * @typedef {{ objects: { local: number, body?: string, head?: string, bytes?: Uint8Array }[],
 *             pages: ImportedPage[], importObject: (num: number, opts?: { form?: boolean }) => Promise<number> }} ImportedDoc
 * @typedef {{ num: number, mediaBox: number[], rotate: number, width: number, height: number,
 *             contents: number[], hasContent: boolean,
 *             resources: { other: string, font: string, xobject: string, extgstate: string },
 *             combs: { rect: number[], cells: number, color: number[], width: number }[] }} ImportedPage
 */
export async function importPages(doc, { log, fonts = null, rewrite = null } = {}) {
  const ctx = { doc, map: new Map(), objects: [], next: 1, pending: [], forms: new Set(),
    oc: await printVisibility(doc).catch(() => null), contentRes: new Map(), log, filtered: 0, fonts, rewrite };
  const catalog = await doc.catalog();
  const cat = valueOf(catalog);
  const pageDicts = [];
  await collectPages(ctx, cat.Pages, {}, pageDicts, new Set());
  ctx.pageDicts = pageDicts;

  const pages = [];
  for (const { dict, inherited, num } of pageDicts) {
    const mediaBox = (await nums(ctx, dict.MediaBox ?? inherited.MediaBox)) ?? [0, 0, 612, 792];
    const cropBox = await nums(ctx, dict.CropBox ?? inherited.CropBox);
    const box = cropBox ?? mediaBox;
    const rotate = (await resolve(ctx, dict.Rotate ?? inherited.Rotate)) ?? 0;

    // contents: a stream or an array of streams
    const contentsVal = dict.Contents;
    const contentRefs = [];
    if (contentsVal?.type === 'ref') {
      const obj = await ctx.doc.getObject(contentsVal.num);
      if (obj?.streamBytes) contentRefs.push(contentsVal);
      else if (valueOf(obj)?.type === 'array' || Array.isArray(valueOf(obj))) {
        for (const r of arrayItems(valueOf(obj))) if (r?.type === 'ref') contentRefs.push(r);
      }
    } else if (contentsVal?.type === 'array') {
      for (const r of contentsVal.value) if (r?.type === 'ref') contentRefs.push(r);
    }
    const contents = [];
    let hasContent = false;
    // the resources the page's content streams name their layers and XObjects in
    if (ctx.oc) {
      const res = await resolve(ctx, dict.Resources ?? inherited.Resources);
      for (const r of contentRefs) ctx.contentRes.set(r.num, res);
      ctx.pageRes ??= res;
    }
    for (const r of contentRefs) {
      contents.push(await copyRef(ctx, r));
      const obj = await ctx.doc.getObject(r.num);
      if (obj?.streamBytes?.length) hasContent = true;
    }

    const resources = await splitResources(ctx, dict.Resources ?? inherited.Resources);
    const combs = await combWidgets(ctx, dict.Annots);
    pages.push({
      num,
      mediaBox: box,
      rotate: ((rotate % 360) + 360) % 360,
      width: box[2] - box[0],
      height: box[3] - box[1],
      contents,
      hasContent,
      resources,
      combs,
      // the page's unit in 1/72 inch (PDF 1.6); the writer scales by it
      userUnit: Number(await resolve(ctx, dict.UserUnit)) > 0 ? Number(await resolve(ctx, dict.UserUnit)) : 1,
    });
  }
  await drain(ctx);
  // a further object (a widget appearance stream) copied into the same
  // numbering, after the pages; forms get /Type /XObject /Subtype /Form
  const importObject = async (num, { form = false } = {}) => {
    if (form) ctx.forms.add(num);
    const local = await copyRef(ctx, { type: 'ref', num });
    await drain(ctx);
    return local;
  };
  if (ctx.filtered) ctx.log?.info?.('ACRO_OC_HIDDEN', `${ctx.oc.hidden.size} layer(s) that do not print taken out of ${ctx.filtered} content stream(s)`);
  return { objects: ctx.objects, pages, importObject, oc: ctx.oc };
}

/**
 * A copier of objects alone, for pages made from scratch (a dynamic XFA
 * form): importObject copies an object and what it refers to; objects are
 * what the writer adds; pageNums are the document's page objects.
 */
export async function objectCopier(doc, { log } = {}) {
  const ctx = { doc, map: new Map(), objects: [], next: 1, pending: [], forms: new Set(), oc: null, contentRes: new Map(), log, filtered: 0, fonts: null };
  const pageDicts = [];
  await collectPages(ctx, valueOf(await doc.catalog()).Pages, {}, pageDicts, new Set());
  const importObject = async (num, { form = false } = {}) => {
    if (form) ctx.forms.add(num);
    const local = await copyRef(ctx, { type: 'ref', num });
    await drain(ctx);
    return local;
  };
  return { objects: ctx.objects, pages: [], importObject, pageNums: pageDicts.map(p => p.num) };
}

// Comb text fields (Ff bit 25, MaxLen cells) among the page's widgets: their
// box and cell dividers are drawn only by the widget appearance, which a
// flattened page loses, while Reader prints them
async function combWidgets(ctx, annots) {
  const out = [];
  for (const ref of arrayItems(await resolve(ctx, annots))) {
    const a = valueOf(ref?.type === 'ref' ? await ctx.doc.getObject(ref.num) : ref);
    if (!a || a.Subtype?.value !== 'Widget') continue;
    const flags = Number(await resolve(ctx, a.F)) || 0;
    if (flags & 0x22) continue; // hidden or no-view
    // field attributes may sit on the widget or be inherited from parents
    const inh = { FT: null, Ff: null, MaxLen: null };
    for (let f = a, depth = 0; f && depth < 16; depth++) {
      for (const k of Object.keys(inh)) if (inh[k] === null && f[k] !== undefined) inh[k] = await resolve(ctx, f[k]);
      f = f.Parent ? valueOf(await ctx.doc.getObject(f.Parent.num)) : null;
    }
    const cells = Number(inh.MaxLen);

    if (inh.FT?.value !== 'Tx' || !(Number(inh.Ff) & (1 << 24)) || !(cells > 1)) continue;
    const rect = await nums(ctx, a.Rect);
    if (!rect) continue;
    const mk = valueOf(await resolve(ctx, a.MK)) ?? {};
    const bc = [];
    for (const c of arrayItems(await resolve(ctx, mk.BC))) bc.push(Number(await resolve(ctx, c)));
    if (!bc.length) continue; // no border colour: the widget draws no box
    const bs = valueOf(await resolve(ctx, a.BS)) ?? {};
    const width = Number(await resolve(ctx, bs.W)) || 1;
    const color = bc.length === 3 ? bc : bc.length === 1 ? [bc[0], bc[0], bc[0]]
      : [(1 - bc[0]) * (1 - bc[3]), (1 - bc[1]) * (1 - bc[3]), (1 - bc[2]) * (1 - bc[3])];
    out.push({ rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])], cells, color, width });
  }
  return out;
}

async function collectPages(ctx, ref, inherited, out, seen) {
  if (!ref || ref.type !== 'ref' || seen.has(ref.num)) return;
  seen.add(ref.num);
  const node = valueOf(await ctx.doc.getObject(ref.num));
  if (!node) return;
  const type = node.Type?.value;
  const inh = { ...inherited };
  for (const k of INHERITED) if (node[k] !== undefined) inh[k] = node[k];
  if (type === 'Pages' || node.Kids) {
    for (const kid of arrayItems(await resolve(ctx, node.Kids))) await collectPages(ctx, kid, inh, out, seen);
  } else {
    out.push({ dict: node, inherited: inh, num: ref.num });
  }
}

// Resources split so the writer can merge its own fonts and images in
async function splitResources(ctx, val) {
  const res = await resolve(ctx, val);
  const dict = res?.type === 'dict' ? res.value : (res && typeof res === 'object' && !res.type ? res : {});
  const out = { other: '', font: '', xobject: '', extgstate: '' };
  for (const [k, v] of Object.entries(dict)) {
    if (k === 'Font' || k === 'XObject' || k === 'ExtGState') {
      const sub = await resolve(ctx, v);
      const entries = sub?.type === 'dict' ? sub.value : {};
      let s = '';
      for (const [name, item] of Object.entries(entries)) s += `/${pdfName(name)} ${await serialize(ctx, item)} `;
      out[k === 'Font' ? 'font' : k === 'XObject' ? 'xobject' : 'extgstate'] = s;
    } else {
      out.other += `/${pdfName(k)} ${await serialize(ctx, v)} `;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Object graph copy
// ---------------------------------------------------------------------------

async function copyRef(ctx, ref) {
  if (ctx.map.has(ref.num)) return ctx.map.get(ref.num);
  const local = ctx.next++;
  ctx.map.set(ref.num, local);
  ctx.pending.push({ num: ref.num, local });
  return local;
}

async function drain(ctx) {
  while (ctx.pending.length) {
    const { num, local } = ctx.pending.shift();
    const obj = await ctx.doc.getObject(num);
    if (!obj) { ctx.objects.push({ local, body: 'null' }); continue; }
    if (obj.streamBytes) {
      const dict = { ...obj.dict };
      delete dict.Length;
      if (ctx.forms.has(num)) {
        dict.Type = { type: 'name', value: 'XObject' };
        dict.Subtype = { type: 'name', value: 'Form' };
      }
      const filters = filterNames(dict.Filter);
      let bytes = obj.streamBytes;
      // layers are resolved here: an XObject that prints keeps no /OC
      if (ctx.oc) delete dict.OC;
      if (ctx.oc && (ctx.contentRes.has(num) || dict.Subtype?.value === 'Form')) {
        const cut = await withoutHiddenContent(ctx, num, dict, bytes, filters);
        if (cut) { bytes = cut; ctx.filtered++; }
      }
      // a caller's change to a content stream (print.js recolours them)
      if (ctx.rewrite && filters.every(f => f === 'FlateDecode') && !dict.DecodeParms) {
        bytes = ctx.rewrite(num, bytes) ?? bytes;
      }
      if (filters.includes('FlateDecode')) {
        bytes = await deflate(bytes);
      }
      let head = '<<';
      for (const [k, v] of Object.entries(dict)) head += ` /${pdfName(k)} ${await serialize(ctx, v)}`;
      head += ` /Length ${bytes.length} >>`;
      ctx.objects.push({ local, head, bytes });
    } else {
      // a font the file does not embed: a substitute at its widths
      const d = obj.value?.type === 'dict' ? obj.value.value : null;
      if (ctx.fonts && d && (d.Type?.value === 'Font' || d.FontDescriptor || d.DescendantFonts) && d.Subtype) {
        let body = null;
        try { body = await substituteFont(d, fontApi(ctx, num)); } catch (e) {
          ctx.log?.once?.('warn', 'FONT_SUBSTITUTE_FAILED', num, `font ${d.BaseFont?.value ?? num} not substituted: ${e.message}`);
        }
        if (body) { ctx.objects.push({ local, body }); continue; }
      }
      ctx.objects.push({ local, body: await serialize(ctx, obj.value) });
    }
  }
}

// What core/substitute.js needs of the copy: values resolved, streams
// decoded, values serialized into the copy, new objects added, and the
// strings the pages show in the font
function fontApi(ctx, num) {
  return {
    faces: ctx.fonts,
    log: ctx.log,
    shown: async () => (await shownByFont(ctx)).get(num) ?? [],
    resolve: v => resolve(ctx, v),
    stream: async v => (v?.type === 'ref' ? (await ctx.doc.getObject(v.num))?.streamBytes ?? null : null),
    serialize: v => serialize(ctx, v),
    add: o => { const local = ctx.next++; ctx.objects.push({ local, ...o }); return local; },
    ref: local => `\u0000R${local}\u0000`,
    deflate,
  };
}

// The strings each font (by object number) shows: in the pages' content,
// the form XObjects it draws, and the annotations' normal appearances;
// read once, when a substitute first asks
function shownByFont(ctx) {
  ctx.shown ??= (async () => {
    const out = new Map();
    const seen = new Set();
    const dictIn = async (res, key) => {
      res = await resolve(ctx, res);
      const v = await resolve(ctx, (res?.type === 'dict' ? res.value : res ?? {})?.[key]);
      return v?.type === 'dict' ? v.value : {};
    };
    const scan = async (num, res) => {
      if (seen.has(num)) return;
      seen.add(num);
      const obj = await ctx.doc.getObject(num);
      if (!obj?.streamBytes) return;
      const fonts = await dictIn(res, 'Font');
      const xobjects = await dictIn(res, 'XObject');
      const { runs, xobjects: drawn } = shownText(obj.streamBytes);
      for (const { font, bytes } of runs) {
        const ref = font !== null ? fonts[font] : null;
        if (ref?.type !== 'ref') continue;
        if (!out.has(ref.num)) out.set(ref.num, []);
        out.get(ref.num).push(bytes);
      }
      for (const name of new Set(drawn)) await scanForm(xobjects[name], res);
    };
    const scanForm = async (ref, parentRes) => {
      if (ref?.type !== 'ref') return;
      const o = await ctx.doc.getObject(ref.num);
      if (o?.dict?.Subtype?.value !== 'Form') return;
      await scan(ref.num, o.dict.Resources ?? parentRes);
    };
    for (const { dict, inherited } of ctx.pageDicts ?? []) {
      const res = await resolve(ctx, dict.Resources ?? inherited.Resources);
      const contents = await resolve(ctx, dict.Contents);
      for (const r of contents?.type === 'array' ? contents.value : [dict.Contents]) if (r?.type === 'ref') await scan(r.num, res);
      for (const a of arrayItems(await resolve(ctx, dict.Annots))) {
        const ap = valueOf(await resolve(ctx, valueOf(await resolve(ctx, a))?.AP));
        const n = ap?.N;
        if (n?.type === 'dict') for (const st of Object.values(n.value)) await scanForm(st, res);
        else if (n?.type === 'ref') {
          const o = await ctx.doc.getObject(n.num);
          if (o?.streamBytes) await scanForm(n, res);
          else for (const st of Object.values(valueOf(o) ?? {})) await scanForm(st, res);
        }
      }
    }
    return out;
  })();
  return ctx.shown;
}

// A content stream (page or form XObject) without the optional content that
// does not print, or null when nothing changes or it cannot be read
async function withoutHiddenContent(ctx, num, dict, bytes, filters) {
  if (filters.some(f => f !== 'FlateDecode') || dict.DecodeParms) {
    ctx.log?.once?.('info', 'ACRO_OC_UNFILTERED', num, `content stream ${num} with filters ${filters.join(', ')} kept whole: hidden layers in it still print`);
    return null;
  }
  const res = ctx.contentRes.get(num) ?? (dict.Resources ? await resolve(ctx, dict.Resources) : ctx.pageRes);
  const resDict = res?.type === 'dict' ? res.value : res ?? {};
  const sub = async key => {
    const v = await resolve(ctx, resDict?.[key]);
    return v?.type === 'dict' ? v.value : v ?? {};
  };
  const properties = await sub('Properties');
  const xobjects = await sub('XObject');
  return filterContent(bytes, {
    properties: name => properties?.[name] ?? null,
    xobject: name => xobjects?.[name] ?? null,
    visible: oc => ctx.oc.visible(oc),
    xobjectVisible: async ref => {
      const o = ref?.type === 'ref' ? await ctx.doc.getObject(ref.num) : null;
      return o?.dict?.OC ? ctx.oc.visible(o.dict.OC) : true;
    },
  });
}

async function serialize(ctx, v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  switch (v.type) {
    case 'ref': return `\u0000R${await copyRef(ctx, v)}\u0000`;
    case 'name': return `/${pdfName(v.value)}`;
    case 'string': return `<${Array.from(v.value, c => (c.charCodeAt(0) & 0xFF).toString(16).padStart(2, '0')).join('')}>`;
    case 'array': {
      const parts = [];
      for (const item of v.value) parts.push(await serialize(ctx, item));
      return `[${parts.join(' ')}]`;
    }
    case 'dict': {
      let s = '<<';
      for (const [k, item] of Object.entries(v.value)) {
        // never follow page tree parents or annotations out of the page
        if (k === 'Parent' || k === 'Annots' || k === 'StructParent' || k === 'StructParents') continue;
        s += ` /${pdfName(k)} ${await serialize(ctx, item)}`;
      }
      return s + ' >>';
    }
  }
  return 'null';
}

const NAME_SAFE = /[!-~]/;
const DELIMS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%', '#']);

function pdfName(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    out += NAME_SAFE.test(ch) && !DELIMS.has(ch) ? ch : `#${(c & 0xFF).toString(16).padStart(2, '0')}`;
  }
  return out;
}

// ---------------------------------------------------------------------------

function valueOf(obj) {
  if (!obj) return null;
  if (obj.dict && obj.streamBytes) return obj.dict;
  const v = obj.value ?? obj;
  return v?.type === 'dict' ? v.value : v;
}

async function resolve(ctx, v) {
  if (v?.type === 'ref') {
    const obj = await ctx.doc.getObject(v.num);
    return obj?.value ?? obj?.dict ?? null;
  }
  return v;
}

async function nums(ctx, v) {
  const r = await resolve(ctx, v);
  const items = arrayItems(r);
  if (items.length !== 4) return null;
  const out = [];
  for (const it of items) out.push(Number(await resolve(ctx, it)));
  return out.every(Number.isFinite) ? out : null;
}

function arrayItems(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (v.type === 'array') return v.value;
  return [];
}

function filterNames(f) {
  if (!f) return [];
  if (f.type === 'array') return f.value.map(x => x?.value ?? x);
  return [f.value ?? f];
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
