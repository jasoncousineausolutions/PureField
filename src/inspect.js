/**
 * Purefield / inspect.js
 *
 * What a PDF holds that bears on flattening it, read without flattening:
 * so a caller can offer the options that apply before it does.
 *
 *   const info = await inspectPdf(arrayBuffer, { password });
 *
 * {
 *   pages,                  the page count
 *   encrypted,              the file had a security handler (and opened)
 *   portfolio,              a PDF Portfolio: flattening prints its PDFs
 *   xfa: null | {
 *     dynamic,              a dynamic form (laid out from the template)
 *     fields,               <field> elements in the template
 *     filled,               data values the form holds
 *     scripts,              script elements (FormCalc and JavaScript)
 *     barcodes: [{ type, count, reader }]   reader: how Adobe Reader prints
 *                           the type: 'drawn', 'box' (a grey box) or
 *                           'dropped' (not at all; see xfa/barcodes.js)
 *   },
 *   acroForm: null | {
 *     fields, filled,       its fields (widgets of one field count once),
 *                           and those with a value
 *     types: { text, checkbox, radio, choice, button, signature },
 *     scripts,              fields or the document carry JavaScript actions
 *     needAppearances,
 *   },
 *   markup: { total, types: { Highlight: 2, … } }   comments and markup
 *                           that print (not links, popups or hidden ones)
 *   text: { otherScripts, cjk },   text in alphabets beyond Latin
 *                           (Arabic, Hebrew…), and Chinese, Japanese or
 *                           Korean text in the form
 *   cjkPageFonts,           pages show CJK text in fonts the file does not
 *                           embed (a CJK font supplied embeds a substitute)
 *   dark: { checked, pages },   of up to 6 pages spread through the file,
 *                           how many were looked at and how many have a dark
 *                           background (print.js: optimizeForPrint helps)
 * }
 *
 * Throws as flattenXfa does: PasswordError when the file needs a password,
 * UnsupportedEncryptionError, or an Error for a file that is not a PDF.
 */

import { parsePdf } from './core/parser.js';
import { collectWidgets } from './core/widgets.js';
import { predefinedCMap } from './core/cjk.js';
import { extractXfa } from './xfa/extractor.js';
import { scriptsIn } from './xfa/scripts.js';
import { readerBarcode } from './xfa/barcodes.js';
import { XfaLog } from './xfa/log.js';
import { darkPages } from './print.js';

const RADIO = 1 << 15, PUSH = 1 << 16;

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{ password?: string }} [options]
 */
export async function inspectPdf(input, { password = '' } = {}) {
  const buffer = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    : input;
  const doc = await parsePdf(buffer, { password });
  const get = async v => (v?.type === 'ref' ? (await doc.getObject(v.num))?.value ?? null : v ?? null);
  const dictOf = async v => {
    if (v?.type === 'ref') {
      const o = await doc.getObject(v.num);
      return o?.dict ?? (o?.value?.type === 'dict' ? o.value.value : null);
    }
    return v?.type === 'dict' ? v.value : null;
  };
  const items = async v => { const a = await get(v); return a?.type === 'array' ? a.value : []; };
  const cat = (await doc.catalog())?.value?.value ?? {};

  // the pages, with their inherited resources
  const pages = [];
  const seen = new Set();
  const walk = async (ref, inheritedRes) => {
    if (ref?.type !== 'ref' || seen.has(ref.num)) return;
    seen.add(ref.num);
    const node = await dictOf(ref);
    if (!node) return;
    const res = node.Resources ?? inheritedRes;
    if (node.Kids) { for (const k of await items(node.Kids)) await walk(k, res); return; }
    pages.push({ num: ref.num, dict: node, res });
  };
  await walk(cat.Pages, null);

  const out = {
    pages: pages.length,
    encrypted: !!doc.trailer?.Encrypt,
    portfolio: !!cat.Collection,
    xfa: null,
    acroForm: null,
    markup: { total: 0, types: {} },
    text: { otherScripts: false, cjk: false },
    cjkPageFonts: false,
    dark: { checked: 0, pages: 0 },
  };
  const texts = [];

  // XFA
  let xfa = null;
  try { xfa = await extractXfa(doc, { log: new XfaLog() }); } catch { xfa = null; }
  const template = xfa?.template;
  if (template?.documentElement) {
    const els = name => [...template.getElementsByTagName('*')].filter(e => (e.localName ?? e.nodeName) === name);
    const barcodes = new Map();
    for (const b of els('barcode')) {
      const type = b.getAttribute('type') || '';
      barcodes.set(type, (barcodes.get(type) ?? 0) + 1);
    }
    const scripts = els('script').filter(s => (s.textContent ?? '').trim()).length;
    // the values the data holds: leaf elements with text
    let filled = 0;
    const data = xfa.datasets?.documentElement;
    if (data) {
      for (const e of [...data.getElementsByTagName('*')]) {
        const leaf = ![...e.childNodes].some(c => c.nodeType === 1);
        if (leaf && (e.textContent ?? '').trim()) filled++;
      }
    }
    out.xfa = {
      dynamic: !!xfa.isDynamic,
      fields: els('field').length,
      filled,
      scripts,
      barcodes: [...barcodes].map(([type, count]) => ({ type, count, reader: readerBarcode(type) })),
    };
    texts.push(xfa.get('template') ?? '', xfa.get('datasets') ?? '');
  }

  // AcroForm fields and the markup on the pages
  const form = await collectWidgets(doc, pages.map(p => p.num));
  const fields = new Map();
  for (const w of form.widgets.flat()) {
    texts.push(w.name ?? '', ...[w.value, w.markup?.contents].flat().filter(v => typeof v === 'string'));
    if (w.annot) {
      const prints = (w.flags & 4) && !(w.flags & 2);
      if (w.annot === 'Link' || !prints) continue;
      out.markup.total++;
      out.markup.types[w.annot] = (out.markup.types[w.annot] ?? 0) + 1;
      continue;
    }
    if (!fields.has(w.field)) fields.set(w.field, w);
  }
  if (form.acroForm && fields.size) {
    const types = { text: 0, checkbox: 0, radio: 0, choice: 0, button: 0, signature: 0 };
    let filled = 0;
    for (const w of fields.values()) {
      const kind = w.ft === 'Tx' ? 'text' : w.ft === 'Ch' ? 'choice' : w.ft === 'Sig' ? 'signature'
        : w.ft === 'Btn' ? (w.ff & PUSH ? 'button' : w.ff & RADIO ? 'radio' : 'checkbox') : null;
      if (kind) types[kind]++;
      const v = Array.isArray(w.value) ? w.value.join('') : w.value;
      if (kind === 'checkbox' || kind === 'radio' ? v && v !== 'Off' : kind !== 'button' && v !== null && v !== undefined && String(v) !== '') filled++;
    }
    const hasAction = aa => !!(aa && (aa.type === 'dict' ? Object.keys(aa.value).length : aa.type === 'ref'));
    const docScripts = !!((await dictOf(cat.Names))?.JavaScript) || !!cat.OpenAction;
    out.acroForm = {
      fields: fields.size,
      filled,
      types,
      scripts: docScripts || form.widgets.flat().some(w => hasAction(w.aa?.field) || hasAction(w.aa?.widget)),
      needAppearances: form.needAppearances,
    };
  }

  // text beyond Latin, in the form
  const need = scriptsIn(texts.join('\n').replace(/&#(x?)([0-9a-f]+);/gi, (m, x, d) => {
    try { return String.fromCodePoint(parseInt(d, x ? 16 : 10)); } catch { return m; }
  }));
  out.text = { otherScripts: !!need.other, cjk: !!need.cjk };

  // CJK page fonts the file does not embed (core/substitute.js)
  for (const p of pages) {
    const fonts = await dictOf((await dictOf(p.res))?.Font);
    for (const ref of Object.values(fonts ?? {})) {
      const f = await dictOf(ref);
      if (f?.Subtype?.value !== 'Type0' || f.Encoding?.type !== 'name' || !predefinedCMap(f.Encoding.value)) continue;
      const desc = await dictOf((await items(f.DescendantFonts))[0]);
      const fd = await dictOf(desc?.FontDescriptor);
      if (!fd || !(fd.FontFile || fd.FontFile2 || fd.FontFile3)) { out.cjkPageFonts = true; break; }
    }
    if (out.cjkPageFonts) break;
  }
  // dark backgrounds, for a print-friendly copy
  try {
    const { checked, dark } = await darkPages(doc);
    out.dark = { checked, pages: dark };
  } catch { /* left at none */ }
  return out;
}
