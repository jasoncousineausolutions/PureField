/**
 * Purefield / xfa / scripts.js
 *
 * Writing systems beyond the bundled Latin faces, as far as a PDF needs
 * them without a shaping engine:
 *
 *   shapeArabic(text)    Arabic letters in their joined forms (initial,
 *                        medial, final, isolated) from the Presentation
 *                        Forms blocks, lam-alef as one ligature, as a font's
 *                        shaping would draw them; harakat are left as they
 *                        are (transparent to joining)
 *   visualOrder(text)    a line in display order: the Unicode bidirectional
 *                        algorithm reduced to what form text needs (strong
 *                        Hebrew and Arabic runs right to left, numbers inside
 *                        them left to right, neutrals taking the direction
 *                        around them, mirrored brackets)
 *   cjkOrdering(text)    the Adobe character collection CJK text is drawn
 *                        with: Korea1 with Hangul, Japan1 with kana, else
 *                        GB1
 *
 * Thai and the Indic scripts need glyph reordering and positioning that
 * this does not do; they are drawn as their characters come.
 */

// ---------------------------------------------------------------------------
// Arabic joining

// letter → [isolated, final, initial, medial]; two forms: joins on the right only
const FORMS = new Map([
  [0x0621, [0xFE80]], [0x0622, [0xFE81, 0xFE82]], [0x0623, [0xFE83, 0xFE84]], [0x0624, [0xFE85, 0xFE86]],
  [0x0625, [0xFE87, 0xFE88]], [0x0626, [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C]], [0x0627, [0xFE8D, 0xFE8E]],
  [0x0628, [0xFE8F, 0xFE90, 0xFE91, 0xFE92]], [0x0629, [0xFE93, 0xFE94]], [0x062A, [0xFE95, 0xFE96, 0xFE97, 0xFE98]],
  [0x062B, [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C]], [0x062C, [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0]], [0x062D, [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4]],
  [0x062E, [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8]], [0x062F, [0xFEA9, 0xFEAA]], [0x0630, [0xFEAB, 0xFEAC]],
  [0x0631, [0xFEAD, 0xFEAE]], [0x0632, [0xFEAF, 0xFEB0]], [0x0633, [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4]],
  [0x0634, [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8]], [0x0635, [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC]], [0x0636, [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0]],
  [0x0637, [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4]], [0x0638, [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8]], [0x0639, [0xFEC9, 0xFECA, 0xFECB, 0xFECC]],
  [0x063A, [0xFECD, 0xFECE, 0xFECF, 0xFED0]], [0x0641, [0xFED1, 0xFED2, 0xFED3, 0xFED4]], [0x0642, [0xFED5, 0xFED6, 0xFED7, 0xFED8]],
  [0x0643, [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC]], [0x0644, [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0]], [0x0645, [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4]],
  [0x0646, [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8]], [0x0647, [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC]], [0x0648, [0xFEED, 0xFEEE]],
  [0x0649, [0xFEEF, 0xFEF0]], [0x064A, [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4]],
  // Persian and Urdu letters (Presentation Forms-A)
  [0x0671, [0xFB50, 0xFB51]], [0x067E, [0xFB56, 0xFB57, 0xFB58, 0xFB59]], [0x0686, [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D]],
  [0x0698, [0xFB8A, 0xFB8B]], [0x06A9, [0xFB8E, 0xFB8F, 0xFB90, 0xFB91]], [0x06AF, [0xFB92, 0xFB93, 0xFB94, 0xFB95]],
  [0x06CC, [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF]],
]);
const TATWEEL = 0x0640;
// lam + alef → [isolated, final]
const LAM_ALEF = new Map([[0x0622, [0xFEF5, 0xFEF6]], [0x0623, [0xFEF7, 0xFEF8]], [0x0625, [0xFEF9, 0xFEFA]], [0x0627, [0xFEFB, 0xFEFC]]]);
const transparent = cp => (cp >= 0x064B && cp <= 0x065F) || cp === 0x0670 || (cp >= 0x06D6 && cp <= 0x06ED);
const joinsBoth = cp => cp === TATWEEL || FORMS.get(cp)?.length === 4;
const joining = cp => cp === TATWEEL || FORMS.has(cp);

/** Arabic text with its letters in their joined presentation forms */
export function shapeArabic(text) {
  if (!/[؀-ۿ]/.test(text)) return text;
  const cps = [...text].map(c => c.codePointAt(0));
  const out = [];
  const near = (i, step) => { for (let j = i + step; j >= 0 && j < cps.length; j += step) if (!transparent(cps[j])) return j; return -1; };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const forms = FORMS.get(cp);
    if (!forms) { out.push(cp); continue; }
    const p = near(i, -1);
    const prev = p >= 0 && joinsBoth(cps[p]);
    const n = near(i, 1);
    // lam-alef: one ligature
    if (cp === 0x0644 && n >= 0 && LAM_ALEF.has(cps[n])) {
      out.push(LAM_ALEF.get(cps[n])[prev ? 1 : 0]);
      for (let j = i + 1; j < n; j++) out.push(cps[j]); // its harakat
      i = n;
      continue;
    }
    const next = forms.length === 4 && n >= 0 && joining(cps[n]);
    const form = forms.length === 1 ? 0 : prev && next ? 3 : prev ? 1 : next ? 2 : 0;
    out.push(forms[form] ?? forms[0]);
  }
  return String.fromCodePoint(...out);
}

// ---------------------------------------------------------------------------
// Bidirectional text

const isR = cp => (cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F);
const isAL = cp => ((cp >= 0x0600 && cp <= 0x07BF) || (cp >= 0x0860 && cp <= 0x08FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF))
  && !isAN(cp);
const isAN = cp => (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06F0 && cp <= 0x06F9);
const isEN = cp => cp >= 0x30 && cp <= 0x39;
const isL = cp => /\p{L}|\p{M}/u.test(String.fromCodePoint(cp)) && !isR(cp) && !isAL(cp);
const MIRROR = new Map([['(', ')'], [')', '('], ['[', ']'], [']', '['], ['{', '}'], ['}', '{'], ['<', '>'], ['>', '<'], ['«', '»'], ['»', '«']]);

/** Whether text holds right-to-left letters */
export function hasRtl(text) {
  return /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(text);
}

/**
 * A line in display order, left to right.
 * @param {string} text - one line, in logical order
 * @param {'ltr'|'rtl'|null} [base] - the paragraph direction; by default
 *   that of its first strong character
 */
export function visualOrder(text, base = null) {
  if (!hasRtl(text)) return text;
  const chars = [...text];
  const cps = chars.map(c => c.codePointAt(0));
  // classes: L, R (R and AL), EN, AN, N (neutral)
  const cls = cps.map(cp => (isR(cp) || isAL(cp) ? 'R' : isAN(cp) ? 'AN' : isEN(cp) ? 'EN' : isL(cp) ? 'L' : 'N'));
  // numbers keep their separators and signs: a , . : / between digits, % and currency after
  for (let i = 1; i < cls.length - 1; i++) {
    if (cls[i] === 'N' && /[.,:/٫٬]/.test(chars[i]) && (cls[i - 1] === 'EN' || cls[i - 1] === 'AN') && cls[i + 1] === cls[i - 1]) cls[i] = cls[i - 1];
  }
  const firstStrong = cls.find(c => c === 'L' || c === 'R');
  const paraLevel = base ? (base === 'rtl' ? 1 : 0) : firstStrong === 'R' ? 1 : 0;
  // neutrals between strong types of the same direction take it (numbers
  // count as right to left); others the paragraph's
  const dir = c => (c === 'L' ? 'L' : c === 'R' || c === 'EN' || c === 'AN' ? 'R' : null);
  const resolved = cls.slice();
  for (let i = 0; i < resolved.length;) {
    if (resolved[i] !== 'N') { i++; continue; }
    let j = i;
    while (j < resolved.length && resolved[j] === 'N') j++;
    let before = paraLevel ? 'R' : 'L', after = before;
    for (let k = i - 1; k >= 0; k--) { const d = dir(cls[k]); if (d) { before = d; break; } }
    for (let k = j; k < cls.length; k++) { const d = dir(cls[k]); if (d) { after = d; break; } }
    // European digits next to left-to-right text count as left to right
    const fill = before === after ? before : paraLevel ? 'R' : 'L';
    for (let k = i; k < j; k++) resolved[k] = fill === 'R' ? 'Rn' : 'Ln';
    i = j;
  }
  // levels (rules I1, I2)
  const levels = resolved.map((c, i) => {
    const t = c === 'Rn' ? 'R' : c === 'Ln' ? 'L' : c;
    // European digits after left-to-right text in a right-to-left paragraph are left-to-right text
    if (paraLevel % 2 === 0) return t === 'R' ? 1 : t === 'AN' || t === 'EN' ? (precededByR(cls, i) ? 2 : 0) : 0;
    return t === 'R' ? 1 : 2;
  });
  // rule L2: reverse each run at or above each level, highest first
  const order = chars.map((c, i) => i);
  const max = Math.max(...levels);
  const lowestOdd = levels.some(l => l % 2) ? Math.min(...levels.filter(l => l % 2)) : max + 1;
  for (let lvl = max; lvl >= lowestOdd; lvl--) {
    for (let i = 0; i < order.length;) {
      if (levels[order[i]] < lvl) { i++; continue; }
      let j = i;
      while (j < order.length && levels[order[j]] >= lvl) j++;
      order.splice(i, j - i, ...order.slice(i, j).reverse());
      i = j;
    }
  }
  return order.map(i => (levels[i] % 2 && MIRROR.has(chars[i]) ? MIRROR.get(chars[i]) : chars[i])).join('');
}

// Digits in a left-to-right paragraph sit with the right-to-left text before
// them (rule W2: Arabic letters make them Arabic numbers)
function precededByR(cls, i) {
  for (let k = i - 1; k >= 0; k--) {
    if (cls[k] === 'R') return true;
    if (cls[k] === 'L') return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// CJK

/** Whether a code point is drawn with a CJK font */
export function isCjk(cp) {
  return (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x2E80 && cp <= 0x2FDF) || (cp >= 0x3000 && cp <= 0x303F)
    || (cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x3100 && cp <= 0x312F) || (cp >= 0x3130 && cp <= 0x318F)
    || (cp >= 0x31F0 && cp <= 0x31FF) || (cp >= 0x3200 && cp <= 0x33FF) || (cp >= 0x3400 && cp <= 0x4DBF)
    || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFFEF) || (cp >= 0x20000 && cp <= 0x2FA1F);
}

/** The Adobe collection for CJK text: Korea1, Japan1 or GB1 */
export function cjkOrdering(text) {
  if (/[가-힯ᄀ-ᇿ㄰-㆏]/.test(text)) return 'Korea1';
  if (/[぀-ヿㇰ-ㇿ]/.test(text)) return 'Japan1';
  return 'GB1';
}

/** Which extra scripts some text needs: { rtl, other, cjk } */
export function scriptsIn(text) {
  const s = String(text ?? '');
  return {
    cjk: /[ᄀ-ᇿ⺀-㏿㐀-䶿一-鿿가-힯豈-﫿＀-￯]|[\uD840-\uD87E][\uDC00-\uDFFF]/.test(s),
    // Arabic, Hebrew, Armenian, Georgian: the bundled fallback face
    other: /[԰-ࣿႠ-ჿﬓ-﷿ﹰ-﻿]/.test(s),
  };
}
