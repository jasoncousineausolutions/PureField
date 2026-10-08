/**
 * Purefield / core / formfonts.js
 *
 * Advance widths of the typefaces a form declares in its AcroForm default
 * resources (/AcroForm /DR /Font). Designer writes one simple font dict per
 * face the template uses (Source Sans Pro, Calibri, Sparkasse Rg, …), each
 * with a /Widths array and a /FontDescriptor naming the family, weight and
 * italic angle, whether or not the font program is embedded. pdf.js measures
 * XFA text with these fonts (PDFDocument#loadXfaFonts) and Acrobat lays text
 * out with the same advances, so they beat any substitute's widths.
 *
 *   readFormFonts(doc) → Map(normalised family → { regular?, bold?, italic?, bolditalic? })
 *   each face: { family, width1000(cp) → number|null, ascent, descent }
 */

import { winAnsiCode } from './writer.js';

/** Family key used for matching: lower case, no spaces, dashes or underscores. */
export function familyKey(name) {
  return String(name ?? '').replace(/^['"]|['"]$/g, '').replace(/[\s_-]+/g, '').toLowerCase();
}

/**
 * @param {import('./parser.js').PdfDocument} doc
 * @returns {Promise<Map<string, object>>}
 */
export async function readFormFonts(doc) {
  const out = new Map();
  try {
    const R = async v => unwrap(v?.type === 'ref' ? await doc.getObject(v.num) : v);
    const catalog = unwrap(await doc.catalog());
    const acroForm = await R(catalog?.AcroForm);
    const dr = await R(acroForm?.DR);
    const fonts = await R(dr?.Font);
    if (!fonts || typeof fonts !== 'object') return out;
    for (const ref of Object.values(fonts)) {
      const font = await R(ref);
      if (!font || nameOf(font.Subtype) === 'Type0') continue;
      const desc = await R(font.FontDescriptor);
      const widths = await R(font.Widths);
      if (!desc || !Array.isArray(widths)) continue;
      const enc = nameOf(await R(font.Encoding));
      if (enc && enc !== 'WinAnsiEncoding') continue;
      const base = nameOf(font.BaseFont)?.replace(/^[A-Z]{6}\+/, '') ?? '';
      const family = strOf(desc.FontFamily) ?? base.split(/[-,]/)[0];
      if (!family) continue;
      const weight = num(desc.FontWeight) ?? (/bold|black|heavy/i.test(base) ? 700 : 400);
      const italic = (num(desc.ItalicAngle) ?? 0) !== 0 || /italic|oblique|-it$/i.test(base);
      const style = (weight >= 600 ? 'bold' : '') + (italic ? 'italic' : '') || 'regular';
      const first = num(font.FirstChar) ?? 0;
      const ws = [];
      for (const w of widths) ws.push(num(await R(w)) ?? 0);
      // the font program, when the form embeds a TrueType one
      const fileRef = desc.FontFile2;
      const file = fileRef?.type === 'ref' ? await doc.getObject(fileRef.num) : null;
      const face = {
        family,
        psName: base || family.replace(/\s+/g, ''),
        program: file?.streamBytes ?? null,
        code: cp => winAnsiCode(cp),
        ascent: num(desc.Ascent) ?? null,
        descent: num(desc.Descent) ?? null,
        width1000(cp) {
          const code = winAnsiCode(cp);
          if (code < 0) return null;
          const w = ws[code - first];
          return w > 0 ? w : null;
        },
      };
      const key = familyKey(family);
      if (!out.has(key)) out.set(key, {});
      const entry = out.get(key);
      entry[style] ??= face;
    }
  } catch {
    // unreadable resources: no form fonts, substitutes measure everything
  }
  return out;
}

/**
 * The declared face for a typeface and style, or null. Typeface names may
 * carry a style suffix (SourceSansPro-Bold); a missing style falls back to
 * the family's regular face.
 */
export function findFormFace(formFonts, typeface, bold, italic) {
  if (!formFonts?.size) return null;
  let entry = formFonts.get(familyKey(typeface));
  if (!entry) {
    const stripped = familyKey(String(typeface).replace(/(bold|italic|regular|oblique|-it)$/gi, '').replace(/[-,]+$/, ''));
    entry = formFonts.get(stripped);
  }
  if (!entry) return null;
  const style = (bold ? 'bold' : '') + (italic ? 'italic' : '') || 'regular';
  return entry[style] ?? (italic && bold ? entry.bold : null) ?? entry.regular ?? null;
}

function unwrap(v) {
  while (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v
    && (v.type === undefined || v.type === 'dict' || v.type === 'array' || 'objNum' in v)) v = v.value;
  return v;
}

function nameOf(v) {
  return v?.type === 'name' ? v.value : typeof v === 'string' ? v : null;
}

function strOf(v) {
  return v?.type === 'string' ? v.value : typeof v === 'string' ? v : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
