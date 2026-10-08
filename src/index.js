/**
 * Purefield — flatten XFA PDFs into ordinary PDFs, in the browser or Node.
 *
 *   const { pdf, log } = await flattenXfa(arrayBuffer);
 *
 * Pipeline (docs/REDUCED_XFA_SPEC.txt): extract → template model → bind →
 * saved form state → format → layout → paint → write. Every stage logs what it skipped or
 * substituted to one XfaLog (XFA_* codes) instead of failing.
 */

import { parsePdf } from './core/parser.js';
import { PdfWriter } from './core/writer.js';
import { importPages, objectCopier } from './core/importer.js';
import { buildEmbeddedFonts } from './core/embed.js';
import { loadBundledFonts, loadBundledFont, addScriptFaces } from './fonts.js';
import { substituteFaces } from './core/substitute.js';
import { prepareFaces } from './core/faces.js';
import { readFormFonts } from './core/formfonts.js';
import { extractXfa } from './xfa/extractor.js';
import { parseTemplateModel } from './xfa/model.js';
import { bindData } from './xfa/bind.js';
import { applyFormState } from './xfa/formstate.js';
import { formatValues, displayValue } from './xfa/format.js';
import { parseLocaleSet } from './xfa/picture.js';
import { layoutForm } from './xfa/flow.js';
import { paintPages } from './xfa/paint.js';
import { dropReaderBarcodes } from './xfa/barcodes.js';
import { XfaLog } from './xfa/log.js';
import { runScripts } from './xfa/script/run.js';
import { flattenAcroForm, stampOp } from './acroform.js';
import { collectWidgets } from './core/widgets.js';

export { XfaLog, loadBundledFonts };
export { inspectPdf } from './inspect.js';
export { optimizeForPrint } from './print.js';
export { PasswordError, UnsupportedEncryptionError } from './core/crypto.js';

/**
 * @param {ArrayBuffer|Uint8Array} input - the XFA PDF
 * @param {{ fonts?: 'bundled'|null|{ regular: Uint8Array, bold?: Uint8Array, sourceSans?: object }, scripts?: boolean, now?: Date,
 *           xfa?: boolean, annotations?: boolean, password?: string, barcodes?: 'reader'|'all',
 *           labelFields?: boolean|{ color?: string|number[], minSize?: number, maxSize?: number, name?: 'full'|'short' } }} [options]
 *   fonts: TrueType faces embedded (subset) for Helvetica-class text and for
 *   any character the standard fonts cannot encode. 'bundled' (default)
 *   loads Liberation Sans and Source Sans Pro from ../fonts (see
 *   loadBundledFonts); null uses only the standard fonts.
 *   scripts: run the form's FormCalc and JavaScript (default true; see
 *   xfa/script/run.js). now: the date and time scripts see (default: now).
 *   xfa: false flattens the AcroForm widgets even when the file has XFA.
 *   password: the user (or owner) password of an encrypted file; files that
 *   open without one need none. A wrong or missing password throws.
 *   annotations: false leaves out the annotations that are not form fields
 *   (highlights, ink, shapes, stamps, notes, links); they are printed from
 *   their appearances by default, as Reader prints them.
 *   barcodes: 'reader' (default) prints barcode fields as Reader does: the
 *   types it does not draw (Aztec, GS1 DataBar, upcean2 and upcean5) as a
 *   grey box, and EAN/UPC fields with an add-on not at all; 'all' draws
 *   every type Purefield encodes.
 *   labelFields: true (or { color, minSize, maxSize, name }) replaces each
 *   form field by its name, on one line where the field's value goes, at the
 *   largest size from maxSize (12) down to minSize (5) that fits; a name too
 *   long at minSize is cut off. color: '#rrggbb' or [r, g, b] 0-255, default
 *   red. name: 'full' (default), the fully qualified field name
 *   ("form1[0].page1[0].LastName[0]"), or 'short', the partial field name
 *   ("LastName"; PDF 32000 §12.7.3.2).
 * @returns {Promise<{ pdf: Uint8Array, log: XfaLog, pageCount: number, dynamic: boolean, static: boolean, acroForm?: boolean }>}
 *   static — the original pages were kept and only values painted on them;
 *   acroForm — a PDF without XFA: its widgets were flattened (acroform.js)
 * @throws if the file is not a PDF (a form whose template is unusable
 *   prints its own PDF pages, as Reader does)
 */
export async function flattenXfa(input, options = {}) {
  return flattenOne(input, options, 0);
}

async function flattenOne(input, options, depth) {
  const { fonts = 'bundled', scripts = true, now, xfa: useXfa = true, annotations = true, labelFields = false, password = '', images = null, barcodes = 'reader' } = options;
  if (barcodes !== 'reader' && barcodes !== 'all') throw new TypeError(`barcodes: expected 'reader' or 'all', got ${JSON.stringify(barcodes)}`);
  const labels = labelOptions(labelFields);
  const log = new XfaLog();
  const faces = await prepareFonts(fonts, log);
  // faces for the fonts pages use without embedding them (core/substitute.js)
  const loader = fonts === 'bundled' ? loadBundledFont : typeof fonts?.load === 'function' ? fonts.load : null;
  const pageFonts = loader ? substituteFaces(loader) : null;
  // faces for the writing systems some text needs (Arabic, Hebrew, CJK…)
  const scriptFaces = text => addScriptFaces(faces, text, log, loader ?? (() => Promise.reject(new Error('no font loader'))));
  const buffer = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    : input;

  const doc = await parsePdf(buffer, { password });
  // a PDF Portfolio prints its PDF files, as Reader prints it
  if (depth < 4) {
    const portfolio = await flattenPortfolio(doc, options, depth, log);
    if (portfolio) return portfolio;
  }
  // print preferences the output keeps (ViewerPreferences)
  const catalog = await printPreferences(doc);
  const xfa = useXfa ? await extractXfa(doc, { log }) : null;
  // No XFA (or the XFA set aside): an AcroForm, whose widgets are stamped
  // from their appearances; a PDF without any form is copied as it is
  if (!xfa) {
    if (faces) faces.formFonts = await readFormFonts(doc);
    const glyphUsage = new Map();
    const extraGlyphs = new Map();
    const { painted, imported } = await flattenAcroForm(doc, { log, faces, glyphUsage, extraGlyphs, annotations, labels, scripts, now, pageFonts, scriptFaces });
    const embeddedFonts = await buildEmbeddedFonts(glyphUsage);
    const pdf = new PdfWriter().build(painted, { Producer: 'Purefield' }, { imported, embeddedFonts, extraGlyphs, catalog });
    return { pdf, log, pageCount: painted.length, dynamic: false, static: true, acroForm: true };
  }

  const dynamic = xfa.isDynamic;
  // the form's text (template and data, character references decoded)
  await scriptFaces(['template', 'datasets'].map(n => xfa.get(n) ?? '').join('')
    .replace(/&#(x?)([0-9a-f]+);/gi, (m, x, d) => { try { return String.fromCodePoint(parseInt(d, x ? 16 : 10)); } catch { return m; } }));

  // Widths of the typefaces the form declares (AcroForm /DR), drawn with the
  // bundled glyphs at those advances
  if (faces) faces.formFonts = await readFormFonts(doc);

  // A template that cannot be read (not well-formed, no root subform) is a
  // form Reader cannot render either: it prints the PDF's own pages, blank
  // or not (itext-empty-xfa; pdfium-rectangles-multipage, whose template
  // packet is a whole second XDP document)
  let model;
  try {
    model = parseTemplateModel(xfa, { log });
  } catch (e) {
    log.warn('XFA_TEMPLATE_UNUSABLE', `${e.message}: printing the PDF's own pages`);
    const imported = await importPages(doc, { log, fonts: pageFonts });
    const painted = imported.pages.map(p => ({ width: p.width, height: p.height, content: '', images: [], base: p }));
    const pdf = new PdfWriter().build(painted, { Producer: 'Purefield' }, { imported, catalog });
    return { pdf, log, pageCount: painted.length, dynamic: false, static: true };
  }
  const locales = parseLocaleSet(xfa.localeSet);
  // bind, restore the saved state, run the scripts and lay out; a script
  // that asks the layout (xfa.layout.page(), a ready:$layout event…) gets
  // the answers of a first layout, the form being built again with them
  const build = (streams, tpl, known, buildLog) => {
    const { root } = bindData(tpl, streams.dataRoot, { log: buildLog });
    // the saved form state is restored when the form opens; the scripts run
    // after it (prePrint scripts run at printing, long after the restore:
    // hmrc-c1800-chief shows every section it had saved hidden)
    applyFormState(root, streams.parseXml('form'), { log: buildLog });
    const run = scripts ? runScripts(root, { record: streams.dataRoot, locales, log: buildLog, now, layout: known }) : null;
    formatValues(root, { log: buildLog, locales });
    if (barcodes === 'reader') dropReaderBarcodes(root, buildLog);
    return { root, run, ...layoutForm(root, { log: buildLog, fonts: faces, pageValues: run?.pageValues,
      display: n => displayValue(n, { log: buildLog, locales, locale: root.locale ?? 'en_US' }) }) };
  };
  const firstLog = new XfaLog();
  let built = build(xfa, model, null, firstLog);
  if (built.run?.layoutQueried) {
    // again, from fresh packets: the first pass's scripts changed the data
    const again = await extractXfa(doc, { log: new XfaLog() });
    built = build(again, parseTemplateModel(again, { log: new XfaLog() }), knownLayout(built.pages), log);
    log.info('XFA_RELAYOUT', 'scripts asked for the layout: laid out a second time with its answers');
  } else {
    log.entries.push(...firstLog.entries);
  }
  const { run, pages, byId } = built;
  if (run?.pagePresence) hideByPage(pages, run.pagePresence);

  // Static forms keep their shell pages and get only the values painted on
  // top (spec §9); without usable shell pages they are synthesised instead
  let imported = null;
  if (!dynamic) {
    imported = await importPages(doc, { log, fonts: pageFonts });
    if (!imported.pages.some(p => p.hasContent)) {
      log.info('XFA_STATIC_EMPTY', 'Static form without shell page content: synthesising pages');
      imported = null;
    } else if (imported.pages.length !== pages.length) {
      log.warn('XFA_STATIC_PAGE_MISMATCH', `Template lays out ${pages.length} page(s) but the shell has ${imported.pages.length}: synthesising pages`);
      imported = null;
    } else {
      // the widgets each shell page was saved with (paint.js prefers one
      // whose rectangle disagrees with the template)
      const form = await collectWidgets(doc, imported.pages.map(p => p.num));
      imported.pages.forEach((p, i) => { p.widgets = form.widgets[i].filter(w => !w.annot); });
    }
  }

  const glyphUsage = new Map();
  const extraGlyphs = new Map();
  const painted = await paintPages(pages, { log, byId, overlay: !!imported, shells: imported?.pages, glyphUsage, extraGlyphs, xfaImages: xfa.images, labels, faces, resolveImage: images, barcodes });
  const embeddedFonts = await buildEmbeddedFonts(glyphUsage);
  if (imported) painted.forEach((p, i) => { p.base = imported.pages[i]; });
  // widget appearances preferred over the template (paint.js stamps)
  if (imported) {
    let k = 0;
    for (const [i, p] of painted.entries()) {
      for (const w of p.stamps ?? []) {
        const op = stampOp(w, imported.pages[i], `JcsAP${k + 1}`);
        if (!op) continue;
        const local = await imported.importObject(w.ap.num, { form: true });
        imported.pages[i].resources.xobject += `/JcsAP${++k} \u0000R${local}\u0000 `;
        p.content += `\n${op}`;
      }
    }
  }

  // signed signatures on pages made from scratch: each signature widget's
  // appearance stamped on its field
  const kept = !!imported;
  if (!kept) imported = await stampSignatures(doc, pages, painted, log);

  const pdf = new PdfWriter().build(painted, { Producer: 'Purefield' }, { imported, embeddedFonts, extraGlyphs, catalog });
  return { pdf, log, pageCount: pages.length, dynamic, static: kept };
}

// A dynamic form's signed signature fields: the appearance of the AcroForm
// signature widget of the same name (indexes [0] aside), with a value (the
// signature), stamped in the field's laid-out rectangle, as Reader shows a
// signed form. Returns the object copier, or null when nothing is stamped.
async function stampSignatures(doc, pages, painted, log) {
  const copier = await objectCopier(doc, { log });
  const form = await collectWidgets(doc, copier.pageNums);
  const norm = s => String(s).replace(/\[0\]/g, '').replace(/#subform(\[\d+\])?/g, '#');
  const signed = new Map();
  for (const w of form.widgets.flat()) if (w.ft === 'Sig' && w.value !== null && w.ap) signed.set(norm(w.name), w);
  if (!signed.size) return null;
  let k = 0;
  for (const [i, page] of pages.entries()) {
    for (const it of page.items) {
      const n = it.node;
      if (n.type !== 'field' || it.fragment || it.paint === false) continue;
      const w = signed.get(norm(n.som));
      if (!w) continue;
      const rect = [it.x, page.height - it.y - it.h, it.x + it.w, page.height - it.y];
      const op = stampOp({ ...w, rect }, { mediaBox: [0, 0] }, `JcsSig${k + 1}`);
      if (!op) continue;
      const local = await copier.importObject(w.ap.num, { form: true });
      painted[i].xobjects = `${painted[i].xobjects ?? ''} /JcsSig${++k} \u0000R${local}\u0000`;
      painted[i].content += `\n${op}`;
    }
  }
  if (!k) return null;
  log.info('XFA_SIGNATURES', `${k} signed signature(s) printed from their appearances`);
  return copier;
}

// ViewerPreferences entries that steer printing, as catalog source: page
// scaling, duplex, tray by page size, copies and page ranges
export async function printPreferences(doc) {
  const get = async v => (v?.type === 'ref' ? (await doc.getObject(v.num))?.value ?? null : v);
  const cat = (await doc.catalog())?.value?.value ?? {};
  const vp = await get(cat.ViewerPreferences);
  const d = vp?.type === 'dict' ? vp.value : null;
  if (!d) return '';
  const out = [];
  for (const k of ['PrintScaling', 'Duplex']) {
    const v = await get(d[k]);
    if (v?.type === 'name' && /^[A-Za-z]+$/.test(v.value)) out.push(`/${k} /${v.value}`);
  }
  const tray = await get(d.PickTrayByPDFSize);
  if (typeof tray === 'boolean') out.push(`/PickTrayByPDFSize ${tray}`);
  const copies = await get(d.NumCopies);
  if (Number.isInteger(copies) && copies > 0) out.push(`/NumCopies ${copies}`);
  const range = await get(d.PrintPageRange);
  if (range?.type === 'array' && range.value.every(Number.isInteger)) out.push(`/PrintPageRange [${range.value.join(' ')}]`);
  return out.length ? `/ViewerPreferences << ${out.join(' ')} >>` : '';
}

// A PDF Portfolio (/Collection) prints as Reader prints it: its PDF files,
// each flattened, one after another in the order of its embedded files;
// the cover sheet other viewers show is not printed. Null when the file is
// no portfolio or holds no PDF.
async function flattenPortfolio(doc, options, depth, log) {
  const get = async v => (v?.type === 'ref' ? await doc.getObject(v.num) : v);
  const val = o => (o?.value?.type === 'dict' ? o.value.value : o?.type === 'dict' ? o.value : null);
  const cat = val(await doc.catalog()) ?? {};
  if (!cat.Collection) return null;
  // the embedded files name tree, in key order
  const files = [];
  const seen = new Set();
  const walk = async ref => {
    const node = val(await get(ref));
    if (!node) return;
    const names = await get(node.Names);
    const list = names?.value?.type === 'array' ? names.value.value : names?.type === 'array' ? names.value : [];
    for (let i = 0; i + 1 < list.length; i += 2) files.push(list[i + 1]);
    const kids = await get(node.Kids);
    const kl = kids?.value?.type === 'array' ? kids.value.value : kids?.type === 'array' ? kids.value : [];
    for (const k of kl) if (k?.type === 'ref' && !seen.has(k.num)) { seen.add(k.num); await walk(k); }
  };
  const names = val(await get(cat.Names));
  if (names?.EmbeddedFiles) await walk(names.EmbeddedFiles);
  const pdfs = [];
  for (const spec of files) {
    const fs = val(await get(spec));
    const ef = val(await get(fs?.EF));
    const stream = await get(ef?.F ?? ef?.UF);
    const bytes = stream?.streamBytes;
    if (!bytes || !new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) continue;
    pdfs.push(bytes);
  }
  if (!pdfs.length) return null;
  const outputs = [];
  for (const [i, bytes] of pdfs.entries()) {
    try {
      const r = await flattenOne(bytes, { ...options, password: '' }, depth + 1);
      for (const e of r.log.entries) log.entries.push({ ...e, message: `portfolio file ${i + 1}: ${e.message}` });
      outputs.push(r.pdf);
    } catch (e) {
      log.warn('ACRO_PORTFOLIO_FILE_FAILED', `portfolio file ${i + 1} not printed: ${e.message}`);
    }
  }
  if (!outputs.length) return null;
  log.info('ACRO_PORTFOLIO', `PDF Portfolio: its ${outputs.length} PDF file(s) printed in place of the cover sheet`);
  const { pdf, pageCount } = await concatPdfs(outputs);
  return { pdf, log, pageCount, dynamic: false, static: true, acroForm: true, portfolio: outputs.length };
}

// Flattened PDFs one after another, their pages copied as they are
async function concatPdfs(pdfs) {
  const merged = { objects: [], pages: [] };
  for (const bytes of pdfs) {
    const doc = await parsePdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const imp = await importPages(doc);
    const shift = merged.objects.length;
    const fix = str => str.replace(/\u0000R(\d+)\u0000/g, (_, n) => `\u0000R${Number(n) + shift}\u0000`);
    for (const o of imp.objects) {
      merged.objects.push({ ...o, local: o.local + shift,
        ...(o.body !== undefined ? { body: fix(o.body) } : {}), ...(o.head !== undefined ? { head: fix(o.head) } : {}) });
    }
    for (const p of imp.pages) {
      merged.pages.push({ ...p, contents: p.contents.map(n => n + shift),
        resources: { other: fix(p.resources.other), font: fix(p.resources.font), xobject: fix(p.resources.xobject), extgstate: fix(p.resources.extgstate ?? '') } });
    }
  }
  const painted = merged.pages.map(p => ({ width: p.width, height: p.height, content: '', images: [], base: p }));
  return { pdf: new PdfWriter().build(painted, { Producer: 'Purefield' }, { imported: merged }), pageCount: painted.length };
}

// labelFields → { color (0..255), minSize, maxSize, name }, or null
function labelOptions(v) {
  if (!v) return null;
  const o = v === true ? {} : v;
  const minSize = Number(o.minSize ?? 5), maxSize = Number(o.maxSize ?? 12);
  const name = o.name ?? 'full';
  if (name !== 'full' && name !== 'short') throw new TypeError(`labelFields.name: expected 'full' or 'short', got ${JSON.stringify(name)}`);
  if (!(minSize > 0) || !(maxSize > 0)) throw new TypeError('labelFields: minSize and maxSize must be positive numbers');
  return { color: parseColor(o.color ?? [255, 0, 0]), minSize, maxSize: Math.max(minSize, maxSize), name };
}

function parseColor(c) {
  if (Array.isArray(c) && c.length === 3 && c.every(Number.isFinite)) return c.map(x => Math.min(255, Math.max(0, x)));
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map(x => x + x).join('') : m[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  throw new TypeError(`labelFields.color: expected '#rrggbb' or [r, g, b] (0-255), got ${JSON.stringify(c)}`);
}

async function prepareFonts(fonts, log) {
  if (!fonts) return null;
  try {
    return prepareFaces(fonts === 'bundled' ? await loadBundledFonts() : fonts);
  } catch (e) {
    log.warn('XFA_FONT_UNAVAILABLE', `Embedded font not available (${e.message}); using standard fonts only`);
    return null;
  }
}

// What layout queries need of a laid-out form: each object's first page
// (from 1), how many pages it spans, its first piece's position and size,
// and its whole height (points); the objects on each page; the page count
function knownLayout(pages) {
  const nodes = new Map();
  const onPage = pages.map(() => []);
  pages.forEach((page, i) => {
    for (const it of page.items) {
      const som = it.node?.som;
      if (!som) continue;
      const k = nodes.get(som);
      if (!k) {
        nodes.set(som, { page: i + 1, span: 1, x: it.x, y: it.y, w: it.w, h: it.h, last: i });
        onPage[i].push(som);
      } else {
        if (k.last !== i) { k.span++; k.last = i; onPage[i].push(som); }
        k.h += it.h;
      }
    }
  });
  return { nodes, pages: onPage, pageCount: pages.length };
}

// Boilerplate a page-dependent script hides on a page is not painted there
function hideByPage(pages, pagePresence) {
  const within = n => { const set = new Set(); const walk = m => { set.add(m); (m.children ?? []).forEach(walk); }; walk(n); return set; };
  pages.forEach((page, i) => {
    for (const [n, presence] of pagePresence(i + 1, pages.length)) {
      if (presence === 'visible') continue;
      const set = within(n);
      for (const item of page.items) if (set.has(item.node) || set.has(item.node.proto)) item.paint = false;
    }
  });
}
