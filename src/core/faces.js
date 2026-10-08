/**
 * Purefield / core / faces.js
 *
 * The TrueType faces text is embedded with (spec §4): Liberation Sans for
 * Helvetica-class text, and, for faces whose widths are known (declared in
 * the form's AcroForm resources, or Myriad Pro), whichever bundled glyph set
 * fits those widths best, drawn at them. A TrueType program the form embeds
 * draws its own text.
 *
 *   prepareFaces({ regular, bold?, sourceSans? }) → {
 *     regular, bold, sans,
 *     forMyriad(bold, italic, text) → face,
 *     forForm(declared, bold, text, italic) → face,
 *     formFonts,          // set by the caller (core/formfonts.js)
 *   }
 *
 * A face is a parsed TrueType font (core/ttf.js) plus resName, psName,
 * width1000(cp), advanceFor(gid, cp), squeeze (horizontal scale its glyphs
 * are drawn at), glyphBold / glyphItalic (no synthesis needed) and native
 * (the form's own program).
 */

import { parseTtf } from './ttf.js';
import { MYRIAD_REGULAR, MYRIAD_BOLD, MYRIAD_ITALIC, MYRIAD_BOLD_ITALIC, myriadWidths } from './myriad.js';

export function prepareFaces(bytes) {
  const face = (b, resName, psName, glyphBold, glyphItalic, glyphsFrom = 'sourcesans') =>
    Object.assign(parseTtf(b), { resName, psName, glyphBold, glyphItalic, glyphsFrom });
  const regular = face(bytes.regular, 'JU_R', 'LiberationSans', false, false, 'liberation');
  const bold = bytes.bold ? face(bytes.bold, 'JU_B', 'LiberationSans-Bold', true, false, 'liberation') : null;
  // humanist glyphs for faces declared with Myriad-like widths
  const s = bytes.sourceSans;
  const sans = s?.regular ? {
    regular: face(s.regular, 'JU_S', 'SourceSansPro-Regular', false, false),
    bold: s.bold ? face(s.bold, 'JU_SB', 'SourceSansPro-Bold', true, false) : null,
    italic: s.italic ? face(s.italic, 'JU_SI', 'SourceSansPro-It', false, true) : null,
    boldItalic: s.boldItalic ? face(s.boldItalic, 'JU_SBI', 'SourceSansPro-BoldIt', true, true) : null,
  } : null;
  // glyph sets that can draw a style, closest style first
  const glyphSets = (wantBold, wantItalic) => [
    (wantBold && bold) || regular,
    sans && ((wantBold && wantItalic && sans.boldItalic) || (wantBold && !wantItalic && sans.bold)
      || (!wantBold && wantItalic && sans.italic) || (wantBold ? sans.bold : null) || sans.regular),
  ].filter(Boolean);
  // Faces with known widths (declared by the form, or Myriad Pro): the
  // bundled glyphs that fit those widths best, advanced at them
  let n = 0;
  const fitted = new Map();
  const fitFor = (widths, wantBold, wantItalic, text) => {
    if (!fitted.has(widths)) fitted.set(widths, new Map());
    const byStyle = fitted.get(widths);
    const key = `${!!wantBold}${!!wantItalic}`;
    if (!byStyle.has(key)) {
      byStyle.set(key, glyphSets(wantBold, wantItalic)
        .map(base => withFormWidths(base, widths, `JU_F${n++}`))
        .sort((a, b) => a.misfit - b.misfit));
    }
    // the best fit that has a glyph for every character (Liberation Sans
    // has the widest coverage)
    const ranked = byStyle.get(key);
    if (text === undefined) return ranked[0];
    return ranked.find(f => covers(f, text)) ?? ranked.find(f => f.glyphsFrom === 'liberation');
  };
  const myriad = {
    regular: { width1000: widthsOf(MYRIAD_REGULAR) },
    bold: { width1000: widthsOf(MYRIAD_BOLD) },
    italic: { width1000: widthsOf(MYRIAD_ITALIC) },
    boldItalic: { width1000: widthsOf(MYRIAD_BOLD_ITALIC) },
  };
  const forMyriad = (wantBold, wantItalic, text) => fitFor(
    myriad[wantBold ? (wantItalic ? 'boldItalic' : 'bold') : (wantItalic ? 'italic' : 'regular')],
    wantBold, wantItalic, text);
  const programs = new Map();
  const forForm = (declared, wantBold, text, wantItalic = false) => {
    // the form's own TrueType program, when it covers the text
    if (declared.program) {
      if (!programs.has(declared)) programs.set(declared, withProgram(declared, `JU_E${n++}`));
      const own = programs.get(declared);
      if (own && (text === undefined || covers(own, text))) return own;
    }
    return fitFor(declared, wantBold, wantItalic, text);
  };
  const out = { regular, bold, sans, forMyriad, forForm, formFonts: new Map(), fallback: null, cjk: new Map() };
  /**
   * Faces for writing systems the Latin faces lack, set once some text
   * needs them (index.js, scriptFaces): DejaVu Sans for Arabic, Hebrew,
   * Armenian and Georgian; for CJK, Adobe's standard CJK fonts, not
   * embedded (every PDF viewer carries them or a stand-in).
   */
  out.addFallback = (b, bb) => {
    out.fallback = {
      regular: face(b, 'JU_V', 'DejaVuSans', false, false, 'dejavu'),
      bold: bb ? face(bb, 'JU_VB', 'DejaVuSans-Bold', true, false, 'dejavu') : null,
    };
  };
  // a CJK TrueType font to embed instead, when one is supplied
  out.addCjk = b => { out.cjkEmbedded = face(b, 'JU_CE', 'CJKFallback', false, false, 'cjk'); };
  out.cjkFace = ordering => {
    if (!out.cjk.has(ordering)) out.cjk.set(ordering, cjkFace(ordering));
    return out.cjk.get(ordering);
  };
  return out;
}

// Adobe's standard CJK fonts (Acrobat's Asian font pack), addressed in
// UTF-16 through the collection's Unicode CMap; every character a full em
const CJK_FONTS = {
  Japan1: { baseFont: 'KozGoPr6N-Medium', cmap: 'UniJIS-UTF16-H', supplement: 6, res: 'JU_CJ' },
  GB1: { baseFont: 'AdobeHeitiStd-Regular', cmap: 'UniGB-UTF16-H', supplement: 5, res: 'JU_CG' },
  CNS1: { baseFont: 'AdobeMingStd-Light', cmap: 'UniCNS-UTF16-H', supplement: 6, res: 'JU_CC' },
  Korea1: { baseFont: 'AdobeGothicStd-Medium', cmap: 'UniKS-UTF16-H', supplement: 2, res: 'JU_CK' },
};

function cjkFace(ordering) {
  const f = CJK_FONTS[ordering] ?? CJK_FONTS.GB1;
  return {
    cjk: true,
    ordering: CJK_FONTS[ordering] ? ordering : 'GB1',
    ...f,
    resName: f.res,
    psName: f.baseFont,
    unitsPerEm: 1000,
    glyphFor: cp => cp, // a code point stands for itself: the CMap maps it
    width1000: () => 1000,
    advance: () => 1000,
  };
}

const covers = (face, text) => [...String(text)].every(ch => ch === ' ' || face.glyphFor(ch.codePointAt(0)));

const FIT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Squeeze: the median ratio of declared to glyph widths over letters and
// digits (1 when within 5%, clamped to 0.7–1.2); glyph outlines are drawn
// at that horizontal scale and advanced so that the scaled advance is the
// declared width. misfit: the spread of the ratios around that median (RMS
// of their logs), lower when the glyphs' proportions match the face's.
export function withFormWidths(base, face, resName) {
  const ratios = [];
  for (const ch of FIT_CHARS) {
    const cp = ch.codePointAt(0);
    const w = face.width1000(cp), b = base.width1000(cp);
    if (w && b) ratios.push(w / b);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios.length ? ratios[ratios.length >> 1] : 1;
  const misfit = ratios.length ? Math.sqrt(ratios.reduce((s, r) => s + Math.log(r / median) ** 2, 0) / ratios.length) : 1;
  const squeeze = Math.abs(median - 1) <= 0.05 ? 1 : Math.min(1.2, Math.max(0.7, median));
  // a no-break space the face does not list advances like its space
  const width = cp => face.width1000(cp) ?? (cp === 0xA0 ? face.width1000(32) : null) ?? base.width1000(cp) * squeeze;
  return {
    ...base,
    resName,
    squeeze,
    misfit,
    width1000: width,
    advanceFor: (gid, cp) => width(cp) / squeeze * base.unitsPerEm / 1000,
    // half the gap between the glyph's slot and its own advance (1000-unit
    // em, before the squeeze): the painter centres each glyph in its slot so
    // a narrow glyph does not leave a hole and a wide one does not collide
    centreOffset: (gid, cp) => (width(cp) / squeeze - base.advance(gid) * 1000 / base.unitsPerEm) / 2,
  };
}

// A TrueType program embedded in the form: its glyphs, the declared widths.
// Symbolic and Mac cmaps address glyphs by the simple-font (WinAnsi) code.
function withProgram(face, resName) {
  let ttf;
  try { ttf = parseTtf(face.program); } catch { return null; }
  const byCode = cp => {
    const code = face.code(cp);
    if (code < 0) return 0;
    return ttf.glyphFor(0xF000 + code) || ttf.glyphFor(code);
  };
  const glyphFor = ttf.cmapKind === 'unicode' ? cp => ttf.glyphFor(cp) || byCode(cp) : byCode;
  const width = cp => face.width1000(cp) ?? Math.round(ttf.advance(glyphFor(cp)) * 1000 / ttf.unitsPerEm);
  return {
    ...ttf,
    resName,
    psName: face.psName,
    squeeze: 1,
    native: true, // the face's own outlines: no synthesized bold or oblique
    glyphFor,
    width1000: width,
    advanceFor: (gid, cp) => width(cp) * ttf.unitsPerEm / 1000,
  };
}

function widthsOf(runs) {
  const widths = myriadWidths(runs);
  return cp => widths.get(cp) ?? null;
}
