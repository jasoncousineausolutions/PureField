/**
 * Purefield / xfa / text.js
 *
 * Font resolution and text measurement (spec §4 Typography, §10 Measurement).
 *
 * Requested typefaces map to a substitute face; widths always come from the
 * substitute, never from the face the form asked for:
 *
 *   Myriad Pro, Myriad, Adobe Clean, Arial, Helvetica  → Helvetica
 *   Times New Roman, Minion Pro, Times                 → Times-Roman
 *   Courier, Courier New                               → Courier
 *   anything else                                      → Helvetica (logged once)
 *
 * Helvetica-class metrics come from Liberation Sans (metric-compatible with
 * Arial/Helvetica), or from an embedded TrueType face when one is given.
 * Times-Roman uses the Core 14 AFM widths (core/times.js). Courier is
 * fixed-pitch 600/1000.
 *
 * A node with no font anywhere is Courier 10pt (spec §4).
 */

import { LIBERATION_SANS_REGULAR, LIBERATION_SANS_BOLD, charWidth } from '../core/fonts.js';
import { winAnsiCode, standardCovers, EXTRA_GLYPHS } from '../core/writer.js';
import { TIMES_ROMAN, TIMES_BOLD, TIMES_ITALIC, TIMES_BOLD_ITALIC } from '../core/times.js';
import { findFormFace } from '../core/formfonts.js';
import { shapeArabic, isCjk, cjkOrdering } from './scripts.js';

const FACE_MAP = new Map([
  ['myriad pro', 'Helvetica'], ['myriad', 'Helvetica'], ['adobe clean', 'Helvetica'],
  ['arial', 'Helvetica'], ['helvetica', 'Helvetica'], ['arial narrow', 'Helvetica'],
  ['times new roman', 'Times-Roman'], ['minion pro', 'Times-Roman'], ['times', 'Times-Roman'],
  ['courier', 'Courier'], ['courier new', 'Courier'],
]);

export const DEFAULT_FONT = Object.freeze({
  typeface: 'Courier', size: 10, weight: 'normal', posture: 'normal',
});

/**
 * Resolve the effective font for a node: its own font values, then the
 * nearest ancestor that sets each property, then the Courier 10pt default.
 *
 * @param {object|null} own        - a model font object (may be undefined)
 * @param {object|null} inherited  - an already-resolved parent font
 * @param {import('./log.js').XfaLog} [log]
 * @returns {ResolvedFont}
 */
export function resolveFont(own, inherited, log) {
  const base = inherited ?? null;
  const pick = (k, def) => own?.[k] ?? base?.[k] ?? def;

  const typeface = pick('typeface', DEFAULT_FONT.typeface);
  const face = substituteFace(typeface, log);
  const clampScale = v => (v === 0 ? 0 : Math.min(1000, Math.max(1, v)) / 100);
  const bold = own?.weight ? own.weight === 'bold' : !!base?.bold;
  const italic = own?.posture ? own.posture === 'italic' : !!base?.italic;
  const ttf = base?.ttf ?? null;
  const key = String(typeface).trim().toLowerCase();
  const myriad = MYRIAD_FAMILY.has(key);
  // A sans face the form declares in its resources (and that is not already
  // measured exactly) is drawn with the bundled glyphs at its own widths
  // (any face whose TrueType program the form embeds is drawn with it)
  const declared = ttf?.forForm && !EXACT_SANS.has(key) ? findFormFace(ttf.formFonts, typeface, bold, italic) : null;
  // (a declared serif face is measured at its widths and drawn with the
  // standard Times scaled to them, see timesScale)
  const form = declared && (declared.program || (face === 'Helvetica' && !myriad) || face === 'Times-Roman') ? declared : null;
  return {
    typeface,
    face,
    size: pick('size', DEFAULT_FONT.size),
    // a resolved parent carries bold/italic, not weight/posture
    bold,
    italic,
    color: pick('color', [0, 0, 0]),
    // percentages are inherited raw; the fractions are derived per node
    hScalePct: own?.hScale ?? base?.hScalePct ?? 100,
    vScalePct: own?.vScale ?? base?.vScalePct ?? 100,
    hScale: clampScale(own?.hScale ?? base?.hScalePct ?? 100),
    vScale: clampScale(own?.vScale ?? base?.vScalePct ?? 100),
    baselineShift: pick('baselineShift', 0),
    letterSpacing: pick('letterSpacing', 0),
    underline: pick('underline', 0),
    lineThrough: pick('lineThrough', 0),
    // embedded Unicode faces ({ regular, bold, forMyriad, forForm }), passed down the tree
    ttf,
    // Myriad family: drawn at Myriad Pro widths with the best-fitting bundled glyphs
    myriad,
    // declared face from the form's resources (core/formfonts.js), or null
    form,
    // a symbol face (Wingdings, Symbol): its codes are drawn as the Unicode
    // characters they stand for (symbolText)
    symbol: SYMBOL_FACES.get(key.replace(/[-\s]?(regular|mt)$/, '')) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Symbol faces. Their text holds font codes, either as the code itself
// (U+0020–U+00FF, "ü" for a Wingdings check mark) or in the private-use
// block a symbol cmap maps them to (U+F020–U+F0FF). Each code becomes the
// Unicode character it draws, so the bundled faces can draw it
// (campania-scia-it's Wingdings U+F0FC prints as Reader's check mark).
// ---------------------------------------------------------------------------

const WINGDINGS = {
  0x6C: 0x25CF, 0x6D: 0x25CB, 0x6E: 0x25A0, 0x6F: 0x25A1, 0x70: 0x25A1, 0x71: 0x25A1, 0x72: 0x25A1,
  0x73: 0x25C6, 0x74: 0x25C6, 0x75: 0x25C6, 0x76: 0x25C6, 0x77: 0x25C6, 0x9E: 0x00B7, 0x9F: 0x2022,
  0xA1: 0x25CB, 0xA2: 0x25CB, 0xA4: 0x25CF, 0xA7: 0x25AA, 0xA8: 0x25A1, 0xD8: 0x25BA, 0xE0: 0x2192,
  0xE8: 0x2192, 0xF0: 0x2192, 0xFB: 0x00D7, 0xFC: 0x2713, 0xFD: 0x2612, 0xFE: 0x2611,
};
const SYMBOL_GREEK_UPPER = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';
const SYMBOL_GREEK_LOWER = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
const SYMBOL = {
  0x22: 0x2200, 0x24: 0x2203, 0x27: 0x220B, 0x2A: 0x2217, 0x2D: 0x2212, 0x40: 0x2245, 0x5C: 0x2234,
  0x5E: 0x22A5, 0x60: 0x203E, 0xA3: 0x2264, 0xA5: 0x221E, 0xAC: 0x2190, 0xAD: 0x2191, 0xAE: 0x2192,
  0xAF: 0x2193, 0xB0: 0x00B0, 0xB1: 0x00B1, 0xB3: 0x2265, 0xB4: 0x00D7, 0xB7: 0x2022, 0xB8: 0x00F7,
  0xB9: 0x2260, 0xBA: 0x2261, 0xBB: 0x2248, 0xBC: 0x2026, 0xD6: 0x221A, 0xE5: 0x2211,
};
for (let i = 0; i < 26; i++) {
  SYMBOL[0x41 + i] = SYMBOL_GREEK_UPPER.codePointAt(i);
  SYMBOL[0x61 + i] = SYMBOL_GREEK_LOWER.codePointAt(i);
}
const SYMBOL_FACES = new Map([['wingdings', WINGDINGS], ['symbol', SYMBOL]]);

/** Text of a symbol face as the Unicode characters its codes draw */
export function symbolText(font, text) {
  const table = font?.symbol;
  if (!table || !text) return text;
  let out = '';
  for (const ch of text) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xF020 && cp <= 0xF0FF) cp -= 0xF000;
    out += cp === 0x20 || cp === 0xA0 || cp > 0xFF ? (cp === 0xA0 ? ' ' : String.fromCodePoint(cp))
      : String.fromCodePoint(table[cp] ?? cp);
  }
  return out;
}

/**
 * The embedded TrueType face a run is drawn with, or null for a standard
 * font. Helvetica-class text always uses the embedded face when one is
 * available (it is metric-identical); Times and Courier use it only for
 * characters WinAnsi cannot encode.
 */
export function embeddedFace(font, text) {
  if (!font.ttf) return null;
  if (font.form) {
    const f = font.ttf.forForm(font.form, font.bold, text, font.italic);
    if (f.native || font.face === 'Helvetica') return f;
  }
  // Times and Courier draw WinAnsi and the Latin Extended-A letters the
  // standard faces carry (writer.js EXTRA_GLYPHS)
  if (font.face !== 'Helvetica' && standardCovers(text)) return null;
  if (font.myriad && font.ttf.forMyriad) return font.ttf.forMyriad(font.bold, font.italic, text);
  const face = (font.bold && font.ttf.bold) || font.ttf.regular;
  if (text === undefined || covers(face, text)) return face;
  // a character Liberation Sans lacks (✓, ☐, ☑): the bundled Source Sans
  // face of the same style, when it has them all
  const s = font.ttf.sans;
  const alt = s && ((font.bold && font.italic && s.boldItalic) || (font.bold && s.bold) || (font.italic && s.italic) || s.regular);
  return alt && covers(alt, text) ? alt : face;
}

const covers = (face, text) => [...String(text)].every(ch => ch === ' ' || face.glyphFor(ch.codePointAt(0)) > 0);

/**
 * The text in runs of one face each. Text the run's face covers is one run;
 * otherwise each character the face lacks goes to a face that has it: the
 * bundled Source Sans, the fallback face for other alphabets (Arabic,
 * Hebrew…), or for CJK the standard CJK font of the text's collection.
 * Spaces stay with the run before them. Arabic in the fallback face is
 * drawn smaller and narrower (`scale`, `squeeze`): Reader draws it in
 * Arial's Arabic, about 0.85 of DejaVu's height and 0.77 of its width
 * (measured on Reader's print of pdf.js's freetext_no_appearance).
 * @returns {{ face: object|null, text: string, scale?: number, squeeze?: number }[]}
 */
export function faceRuns(font, text) {
  const primary = embeddedFace(font, text);
  const ttf = font.ttf;
  if (!primary || !ttf || !text || typeof primary.glyphFor !== 'function' || covers(primary, text)) return [{ face: primary, text }];
  const s = ttf.sans;
  const alt = s && ((font.bold && font.italic && s.boldItalic) || (font.bold && s.bold) || (font.italic && s.italic) || s.regular);
  const fb = ttf.fallback && ((font.bold && ttf.fallback.bold) || ttf.fallback.regular);
  let cjk;
  const runs = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let face;
    if (ch === ' ' && runs.length) face = runs.at(-1).face;
    else if (primary.glyphFor(cp) > 0 || ch === ' ') face = primary;
    else if (alt && alt.glyphFor(cp) > 0) face = alt;
    else if (fb && fb.glyphFor(cp) > 0) face = fb;
    else if (ttf.cjkEmbedded && ttf.cjkEmbedded.glyphFor(cp) > 0) face = ttf.cjkEmbedded;
    else if (ttf.cjkFace && isCjk(cp)) face = cjk ??= ttf.cjkFace(cjkOrdering(text));
    else face = primary;
    const arabic = face === fb && (ch === ' ' ? runs.at(-1)?.scale !== undefined : isArabic(cp));
    if (runs.length && runs.at(-1).face === face && (runs.at(-1).scale !== undefined) === arabic) runs.at(-1).text += ch;
    else runs.push(arabic ? { face, text: ch, scale: ARABIC_SCALE, squeeze: ARABIC_SQUEEZE } : { face, text: ch });
  }
  return runs;
}

const ARABIC_SCALE = 0.85, ARABIC_SQUEEZE = 0.9;
const isArabic = cp => (cp >= 0x600 && cp <= 0x6FF) || (cp >= 0x750 && cp <= 0x77F) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF);

/** A run's width in points: its face's advances at its size */
export function runWidth(font, r) {
  let w = 0;
  for (const ch of r.text) w += r.face.width1000(ch.codePointAt(0)) * font.size / 1000;
  return w * (r.scale ?? 1) * (r.squeeze ?? 1);
}

// Helvetica-class faces whose substitute widths are already exact
const EXACT_SANS = new Set(['arial', 'helvetica', 'arial mt', 'arialmt', 'liberation sans']);

const MYRIAD_FAMILY = new Set(['myriad pro', 'myriad', 'myriadpro', 'myriad pro light', 'myriad pro semibold']);

/**
 * @typedef {object} ResolvedFont
 * @property {string} typeface - what the form asked for
 * @property {'Helvetica'|'Times-Roman'|'Courier'} face - the substitute
 * @property {number} size, hScale, vScale, baselineShift, letterSpacing
 * @property {boolean} bold, italic
 * @property {number[]} color - r,g,b 0..255
 */

export function substituteFace(typeface, log) {
  const key = String(typeface ?? '').trim().toLowerCase();
  const face = FACE_MAP.get(key);
  if (face) {
    if (key !== face.toLowerCase()) {
      log?.once('info', 'XFA_METRIC_SUBSTITUTE', key, `"${typeface}" measured as ${face}`);
    }
    return face;
  }
  log?.once('info', 'XFA_METRIC_SUBSTITUTE', key, `Unknown typeface "${typeface}" measured as Helvetica`);
  return 'Helvetica';
}

/**
 * Width of a string in points: substituted face × horizontal scale, plus
 * letter spacing after every glyph but the last (spec §10).
 */
export function textWidth(font, text) {
  if (!text) return 0;
  text = symbolText(font, text);
  // floating-field tokens (\u0001id\u0002) measure as what they will show
  if (text.includes('\u0001')) text = text.replace(/\u0001([^\u0002]*)\u0002/g, (_, id) => embedText(id));

  // Arabic is measured in its joined forms (drawRun draws those)
  text = shapeArabic(text);
  let w = 0;
  let n = 0;
  const runs = faceRuns(font, text);
  if (runs.length > 1 || runs[0].scale) {
    for (const r of runs) { w += runWidth(font, r); n += [...r.text].length; }
    return w * font.hScale + Math.max(0, n - 1) * font.letterSpacing;
  }
  const ttf = runs[0].face;
  if (ttf) {
    for (const ch of text) { w += ttf.width1000(ch.codePointAt(0)) * font.size / 1000; n++; }
  } else if (font.face === 'Times-Roman') {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      w += (font.form?.width1000(cp) ?? timesWidth1000(font, cp)) * font.size / 1000;
      n++;
    }
  } else if (font.face === 'Courier') {
    for (const _ of text) n++;
    w = n * 0.6 * font.size;
  } else {
    const metrics = font.bold ? LIBERATION_SANS_BOLD : LIBERATION_SANS_REGULAR;
    for (const ch of text) { w += charWidth(metrics, ch.codePointAt(0), font.size); n++; }
  }
  return w * font.hScale + Math.max(0, n - 1) * font.letterSpacing;
}

// Typographic ascender/descender (OS/2 typo metrics, 1000-unit em) of faces
// whose substitute's differ; Adobe faces and Calibri use 750/250
const TYPO_METRICS = new Map([
  ['myriadpro', [750, 250]], ['myriad', [750, 250]], ['sourcesanspro', [750, 250]], ['calibri', [750, 250]],
]);

/**
 * The face's own line height (ascent + descent + line gap) at size ×
 * vScale: Arial/Liberation Sans 1.149em, Times 1.15em, Courier 1.133em,
 * Myriad-class faces 1.2em (pdf.js font lineHeight). A paragraph with a set
 * line height still sizes its first line at this (on-a-103e's 18.75pt
 * Arial bullets and hmrc-iform's 11.5pt ones, as Reader prints them).
 */
export function naturalLineHeight(font) {
  const s = font.size * font.vScale;
  const typo = TYPO_METRICS.get(String(font.typeface ?? '').replace(/[\s_-]+/g, '').toLowerCase().replace(/(bold|italic|regular|it)$/, ''));
  if (typo && font.face === 'Helvetica') return 1.2 * s;
  if (font.face === 'Courier') return 1.133 * s;
  if (font.face === 'Times-Roman') return 1.15 * s;
  return 1.149 * s;
}

/** Ascender/descender of the face at size × vScale (positive numbers). */
export function emBox(font) {
  const s = font.size * font.vScale;
  const typo = TYPO_METRICS.get(String(font.typeface ?? '').replace(/[\s_-]+/g, '').toLowerCase().replace(/(bold|italic|regular|it)$/, ''));
  if (typo && font.face === 'Helvetica') return { ascent: typo[0] / 1000 * s, descent: typo[1] / 1000 * s };
  if (font.face === 'Courier') return { ascent: 0.629 * s, descent: 0.157 * s };
  if (font.face === 'Times-Roman' && !font.ttf) {
    const t = timesMetrics(font);
    return { ascent: t.ascender / 1000 * s, descent: -t.descender / 1000 * s };
  }
  const m = font.bold ? LIBERATION_SANS_BOLD : LIBERATION_SANS_REGULAR;
  return { ascent: m.ascender / 1000 * s, descent: -m.descender / 1000 * s };
}

function timesWidth1000(font, cp) {
  const t = timesMetrics(font);
  // a Latin Extended-A letter is as wide as its base letter
  const extra = EXTRA_GLYPHS.get(cp);
  const code = winAnsiCode(extra ? extra.base.codePointAt(0) : cp);
  return code >= 32 ? t.widths[code - 32] : t.widths[0];
}

/**
 * Horizontal scale that brings a run drawn with the standard Times font to
 * the widths of the serif face the form declares (Minion Pro on
 * Attestation, which Reader prints with its own Minion Pro), else 1.
 */
export function timesScale(font, text) {
  if (font.face !== 'Times-Roman' || !font.form || font.form.program) return 1;
  let declared = 0, times = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const t = timesWidth1000(font, cp);
    declared += font.form.width1000(cp) ?? t;
    times += t;
  }
  return times > 0 ? declared / times : 1;
}

function timesMetrics(font) {
  return font.bold ? (font.italic ? TIMES_BOLD_ITALIC : TIMES_BOLD) : (font.italic ? TIMES_ITALIC : TIMES_ROMAN);
}

/** Line advance: para lineHeight if set, else 1.2 × size × vScale. */
export function lineHeightOf(font, para) {
  return para?.lineHeight > 0 ? para.lineHeight : 1.2 * font.size * font.vScale;
}

// Floating fields (<span xfa:embed="#id"/>, \u0001id\u0002) are measured
// as the text they will show: the referenced field's value, or a page number
// of as many digits as the page count. layoutForm sets the resolver for the
// duration of a layout; without one an embed measures as two digits.
let embedResolver = null;
export function setEmbedResolver(fn) { embedResolver = fn; }
export function embedText(id) { return embedResolver ? embedResolver(id) : '00'; }

/**
 * A line may overrun its width by this much (em) before it breaks: Acrobat
 * fits text that overruns by a rounding error (evince's title, 0.018pt
 * over; Stammdatenaenderung's 'Änderungen aus.', 0.022pt) or by 0.4pt in
 * 9pt Arial (on-11075e's ", am the"), and breaks 8pt text that overruns
 * by 0.46pt (imm5707e's 'If you')
 */
export const FIT_TOLERANCE = 0.05;
export const fitTolerance = font => FIT_TOLERANCE * (font?.size ?? 1);

/**
 * Offset of a line from the paragraph's left edge for a textIndent: a
 * positive indent moves the first line in; a negative one never outdents
 * the first line but indents the lines after it by as much (Acrobat prints
 * of a registration form's textIndent="-18pt" bullets, whose wrapped lines
 * align with the text after the bullet; evince's CSS
 * margin-left:13.5pt; text-indent:-18pt bullets start at the margin)
 */
export function lineIndent(textIndent, first) {
  if (!textIndent) return 0;
  return textIndent > 0 ? (first ? textIndent : 0) : (first ? 0 : -textIndent);
}

/**
 * A word split at its break opportunities other than spaces: after a slash
 * that is not followed by a digit or another slash (Unicode line breaking;
 * Acrobat prints break 'he/ she' (imm0157f) and '(https:// www…'
 * (a registration form)). Hyphens are not break opportunities here.
 */
export function breakPieces(word) {
  return word.split(/(?<=\/)(?=[^\d/])/);
}

/**
 * Break text into lines that fit maxWidth (spec §10): explicit newlines
 * always break; otherwise break on spaces; a token wider than the line is
 * one line (it will clip); no hyphenation. maxWidth of Infinity only splits
 * on newlines. textIndent shortens the first line.
 *
 * @returns {string[]}
 */
export function wrapText(font, text, maxWidth, { textIndent = 0 } = {}) {
  if (text === null || text === undefined || text === '') return [];
  const lines = [];
  // indices of lines that end a paragraph (justify leaves them ragged)
  lines.paraEnds = new Set();
  // a tab in plain text is a space: never a .notdef box (on-1965e's
  // footer ends in a tab Reader leaves blank)
  for (const para of String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n')) {
    // leading spaces stay at the start of the first line (anaf-d093's
    // space-indented captions print indented in Reader)
    const lead = /^ */.exec(para)[0];
    const words = para.slice(lead.length).split(' ');
    let cur = lead;
    let first = true;
    for (const word of words) {
      breakPieces(word).forEach((piece, k) => {
        const limit = maxWidth - lineIndent(textIndent, lines.length === 0);
        const test = first ? cur + piece : cur === '' ? piece : `${cur}${k ? '' : ' '}${piece}`;
        first = false;
        if (cur.trim() !== '' && textWidth(font, test) > limit + fitTolerance(font)) {
          lines.push(cur);
          cur = piece;
        } else {
          cur = test;
        }
      });
    }
    lines.push(cur);
    lines.paraEnds.add(lines.length - 1);
  }
  return lines;
}
