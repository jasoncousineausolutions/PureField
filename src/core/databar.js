/**
 * Purefield / core / databar.js
 *
 * GS1 DataBar (ISO/IEC 24724, formerly RSS) for the XFA rss14 types:
 *
 *   rss14, rss14Truncated   a GTIN as four data characters and two finder
 *                           patterns, 96 modules on one row (Truncated is
 *                           the same row, only lower)
 *   rss14Stacked            the same characters in two rows of 50 modules,
 *                           5 and 7 high, a 1-module separator between
 *   rss14StackedOmni        two rows 33 high, three separator rows
 *   rss14Limited            a GTIN opening with 0 or 1, 79 modules
 *   rss14Expanded           GS1 element strings ("(01)…(3202)…"): a
 *                           compressed field (methods 1 to 14 for (01) with
 *                           weights, prices and dates) and the general-
 *                           purpose field (numeric, alphanumeric and ISO 646
 *                           modes), 12 bits a character, in pairs round
 *                           finder patterns; one row
 *
 * A GTIN is 13 digits (the check digit added) or 14 (its check digit
 * verified), "(01)" before it allowed; fewer digits are padded with zeros.
 * The linear symbols open with a space: their elements start with a
 * zero-width bar. The stacked ones are kind 'stacked', rows of modules
 * with their nominal heights in modules (separator rows 1).
 *
 * Ported from zint (backend/rss.c, rss.h, general_field.c; BSD-3-Clause,
 * Copyright (C) 2008-2026 Robin Stuart), whose tables are ISO/IEC 24724's;
 * combins() and getRSSwidths() are the standard's Annex B routines.
 *
 *   encodeDataBar(text, type, env) → { kind: '1d', elements, text } | { kind: 'stacked', modules, heights } | null
 */

// ISO/IEC 24724 Annex B: n choose r (1 when r > n)
function combins(n, r) {
  const [minDenom, maxDenom] = n - r > r ? [r, n - r] : [n - r, r];
  let val = 1, j = 1;
  for (let i = n; i > maxDenom; i--) {
    val *= i;
    if (j <= minDenom) { val /= j; j++; }
  }
  for (; j <= minDenom; j++) val /= j;
  return val;
}

// Annex B getRSSwidths: the element widths of value val in an n-module set
// of `elements` elements, none wider than maxWidth; noNarrow skips the
// patterns without a 1-module element
function getWidths(val, n, elements, maxWidth, noNarrow) {
  const widths = [];
  let narrowMask = 0, bar;
  for (bar = 0; bar < elements - 1; bar++) {
    let elmWidth, subVal;
    for (elmWidth = 1, narrowMask |= 1 << bar; ; elmWidth++, narrowMask &= ~(1 << bar)) {
      subVal = combins(n - elmWidth - 1, elements - bar - 2);
      if (noNarrow && !narrowMask && n - elmWidth - (elements - bar - 1) >= elements - bar - 1) {
        subVal -= combins(n - elmWidth - (elements - bar), elements - bar - 2);
      }
      if (elements - bar - 1 > 1) {
        let lessVal = 0;
        for (let mxw = n - elmWidth - (elements - bar - 2); mxw > maxWidth; mxw--) {
          lessVal += combins(n - elmWidth - mxw - 1, elements - bar - 3);
        }
        subVal -= lessVal * (elements - 1 - bar);
      } else if (n - elmWidth > maxWidth) subVal--;
      val -= subVal;
      if (val < 0) break;
    }
    val += subVal;
    n -= elmWidth;
    widths[bar] = elmWidth;
  }
  widths[bar] = n;
  return widths;
}

// a character's odd and even elements interleaved, odd first
function charWidths(vOdd, vEven, nOdd, nEven, elements, maxWidth, noNarrow) {
  const odd = getWidths(vOdd, nOdd, elements, maxWidth, noNarrow);
  const even = getWidths(vEven, nEven, elements, 9 - maxWidth, !noNarrow);
  return odd.flatMap((w, i) => [w, even[i]]);
}

const digitList = s => [...s].map(Number);
const gs1Check = d => { let sum = 0; [...d].reverse().forEach((c, i) => { sum += Number(c) * (i % 2 ? 1 : 3); }); return String((10 - (sum % 10)) % 10); };

// widths → modules (1 dark) from `latch` (1: a bar first)
function expand(widths, latch = 0) {
  const out = [];
  for (const w of widths) { for (let k = 0; k < w; k++) out.push(latch); latch ^= 1; }
  return out;
}

// ---------------------------------------------------------------------------
// Omnidirectional, Truncated, Stacked, Stacked Omnidirectional

// tables 1 and 2: outside groups 0-4, inside 5-8
const OMN_G_SUM = [0, 161, 961, 2015, 2715, 0, 336, 1036, 1516];
const OMN_T = [1, 10, 34, 70, 126, 4, 20, 48, 81]; // outside Teven, inside Todd
const OMN_MODULES = [12, 10, 8, 6, 4, 5, 7, 9, 11, 4, 6, 8, 10, 12, 10, 8, 6, 4]; // odd, then even
const OMN_WIDEST = [8, 6, 4, 3, 1, 2, 4, 6, 8];
const OMN_FINDER = ['38211', '35511', '33711', '31911', '27411', '25611', '23811', '15711', '13911'].map(digitList); // table 4
const OMN_WEIGHT = [ // table 5
  [1, 3, 9, 27, 2, 6, 18, 54], [4, 12, 36, 29, 8, 24, 72, 58],
  [16, 48, 65, 37, 32, 17, 51, 74], [64, 34, 23, 69, 49, 68, 46, 59],
];

function omnGroup(val, outside) {
  let i;
  for (i = outside ? 0 : 5; i < (outside ? 4 : 8); i++) if (val < OMN_G_SUM[i + 1]) return i;
  return i;
}

/** The GTIN-13 (no check digit) of a DataBar value, or null (logged) */
function gtin(text, env) {
  let d = text.replace(/^\s*[([]01[)\]]/, '').replace(/[\s-]/g, '');
  if (/^01\d{13,14}$/.test(d)) d = d.slice(2);
  if (!/^\d{1,14}$/.test(d)) {
    env.log('XFA_BARCODE_DATA', 'GS1 DataBar takes a GTIN of 13 or 14 digits');
    return null;
  }
  if (d.length === 14) {
    if (gs1Check(d.slice(0, 13)) !== d[13]) env.log('XFA_BARCODE_DATA', `GTIN check digit ${d[13]} is wrong (${gs1Check(d.slice(0, 13))}); recomputed`);
    d = d.slice(0, 13);
  } else if (d.length < 13) {
    env.log('XFA_BARCODE_DATA', `a GTIN takes 13 digits, got ${d.length}; padded with zeros`);
    d = d.padStart(13, '0');
  }
  return d;
}

function omnidirectional(text, type, env) {
  const g = gtin(text, env);
  if (!g) return null;
  const val = Number(g);
  const left = Math.floor(val / 4537077), right = val % 4537077;
  const chars = [Math.floor(left / 1597), left % 1597, Math.floor(right / 1597), right % 1597];
  // characters 1 and 3 outside, 2 and 4 inside
  const widths = chars.map((v, i) => {
    const outside = !(i & 1);
    const group = omnGroup(v, outside);
    const value = v - OMN_G_SUM[group];
    const div = Math.floor(value / OMN_T[group]), mod = value % OMN_T[group];
    return charWidths(outside ? div : mod, outside ? mod : div, OMN_MODULES[group], OMN_MODULES[group + 9], 4, OMN_WIDEST[group], !outside);
  });
  let checksum = 0;
  widths.forEach((w, i) => w.forEach((e, j) => { checksum += OMN_WEIGHT[i][j] * e; }));
  checksum %= 79;
  if (checksum >= 8) checksum++;
  if (checksum >= 72) checksum++;
  const cLeft = Math.floor(checksum / 9), cRight = checksum % 9;
  const total = [1, 1, ...widths[0], ...OMN_FINDER[cLeft], ...[...widths[1]].reverse(),
    ...widths[3], ...[...OMN_FINDER[cRight]].reverse(), ...[...widths[2]].reverse(), 1, 1];
  const hrt = `(01)${g}${gs1Check(g)}`;
  if (type === 'rss14' || type === 'rss14truncated') return { kind: '1d', elements: [0, ...total], text: hrt };

  // stacked: the left half and a 1-module bar and space, then a bar and a
  // space and the right half
  const top = [...expand(total.slice(0, 23)), 1, 0];
  const bottom = [1, 0, ...expand(total.slice(23), 1)];
  const row = () => new Array(50).fill(0);
  if (type === 'rss14stacked') {
    // ISO/IEC 24724 5.3.2.1 as zint reads it (its issue 183)
    const sep = row();
    for (let i = 1; i < 46; i++) {
      if (top[i] === bottom[i]) { if (!top[i]) sep[i] = 1; }
      else if (!sep[i - 1]) sep[i] = 1;
    }
    sep[1] = sep[2] = sep[3] = 0;
    return { kind: 'stacked', modules: [top, sep, bottom].map(r => Uint8Array.from(r)), heights: [5, 1, 7], text: hrt };
  }
  const mid = row();
  for (let i = 5; i < 46; i += 2) mid[i] = 1;
  const above = omnSeparator(top, 18, false);
  // 17 + 2: over the finder's elements 4 and 5, right to left
  const below = omnSeparator(bottom, 19, cRight === 3);
  return { kind: 'stacked', modules: [top, above, mid, below, bottom].map(r => Uint8Array.from(r)), heights: [33, 1, 1, 1, 33], text: hrt };
}

// a separator row of Stacked Omnidirectional: the complement of the row it
// borders, the 13 modules over the finder alternating light and dark
// where the row is light (ISO/IEC 24724 5.3.2.2); over finder value 3 one
// dark module only, over the start of its 3-module bar
function omnSeparator(modules, finderStart, finderValue3) {
  const sep = new Array(50).fill(0);
  for (let i = 4; i < 46; i++) if (!modules[i]) sep[i] = 1;
  if (finderValue3) {
    for (let i = finderStart; i < finderStart + 13; i++) sep[i] = i === finderStart + 10 ? 1 : 0;
  } else {
    let latch = 1;
    for (let i = finderStart; i < finderStart + 13; i++) {
      if (!modules[i]) { sep[i] = latch; latch ^= 1; } else { sep[i] = 0; latch = 1; }
    }
  }
  return sep;
}

// ---------------------------------------------------------------------------
// Limited

const LTD_G_SUM = [0, 183064, 820064, 1000776, 1491021, 1979845, 1996939];
const LTD_T_EVEN = [28, 728, 6454, 203, 2408, 1, 16632]; // table 6
const LTD_MODULES = [17, 13, 9, 15, 11, 19, 7]; // odd; even is 26 - odd
const LTD_WIDEST = [6, 5, 3, 5, 4, 8, 1];
const LTD_WEIGHT = [ // table 7
  [1, 3, 9, 27, 81, 65, 17, 51, 64, 14, 42, 37, 22, 66],
  [20, 60, 2, 6, 18, 54, 73, 41, 34, 13, 39, 28, 84, 74],
];
const LTD_FINDER = [ // Annex C
  '11111111113311', '11111111123211', '11111111133111', '11111112113211', '11111112123111', '11111113113111',
  '11111211113211', '11111211123111', '11111212113111', '11111311113111', '11121111113211', '11121111123111',
  '11121112113111', '11121211113111', '11131111113111', '12111111113211', '12111111123111', '12111112113111',
  '12111211113111', '12121111113111', '13111111113111', '11111111212311', '11111111222211', '11111111232111',
  '11111112212211', '11111112222111', '11111113212111', '11111211212211', '11111211222111', '11111212212111',
  '11111311212111', '11121111212211', '11121111222111', '11121112212111', '11121211212111', '11131111212111',
  '12111111212211', '12111111222111', '12111112212111', '12111211212111', '12121111212111', '13111111212111',
  '11111111311311', '11111111321211', '11111112311211', '11121111311211', '12111111311211', '11111121112311',
  '11111121122211', '11111121132111', '11111122112211', '11121121112211', '11121121122111', '11121122112111',
  '11121221112111', '11131121112111', '12111121112211', '12111121122111', '12121121112111', '11112111112311',
  '11112111122211', '11112111132111', '11112112112211', '11112112122111', '11112211112211', '12112111112211',
  '12112111122111', '12112112112111', '12112211112111', '12122111112111', '13112111112111', '11211111112311',
  '11211111122211', '11211111132111', '11211112112211', '11211112122111', '11211113112111', '11211211112211',
  '11211211122111', '11221111112211', '21111111122211', '21111111132111', '21111112112211', '21111112122111',
  '21111113112111', '21111211122111', '21111212112111', '21121111122111', '21111111221211',
];

function limited(text, env) {
  const g = gtin(text, env);
  if (!g) return null;
  if (g[0] > '1') {
    env.log('XFA_BARCODE_DATA', 'GS1 DataBar Limited takes a GTIN opening with 0 or 1');
    return null;
  }
  const val = Number(g);
  const pairs = [Math.floor(val / 2013571), val % 2013571].map(v => {
    let group = 0;
    for (let i = 6; i > 0; i--) if (v >= LTD_G_SUM[i]) { v -= LTD_G_SUM[i]; group = i; break; }
    return charWidths(Math.floor(v / LTD_T_EVEN[group]), v % LTD_T_EVEN[group], LTD_MODULES[group], 26 - LTD_MODULES[group], 7, LTD_WIDEST[group], false);
  });
  let checksum = 0;
  for (let i = 0; i < 14; i++) checksum += LTD_WEIGHT[0][i] * pairs[0][i] + LTD_WEIGHT[1][i] * pairs[1][i];
  const elements = [0, 1, 1, ...pairs[0], ...digitList(LTD_FINDER[checksum % 89]), ...pairs[1], 1, 1, 5];
  return { kind: '1d', elements, text: `(01)${g}${gs1Check(g)}` };
}

// ---------------------------------------------------------------------------
// Expanded

const EXP_G_SUM = [0, 348, 1388, 2948, 3988]; // table 8
const EXP_T_EVEN = [4, 20, 52, 104, 204];
const EXP_MODULES = [12, 10, 8, 6, 4]; // odd; even is 17 - odd
const EXP_WIDEST = [7, 5, 4, 3, 1];
const EXP_WEIGHT = [ // table 14
  [1, 3, 9, 27, 81, 32, 96, 77], [20, 60, 180, 118, 143, 7, 21, 63], [189, 145, 13, 39, 117, 140, 209, 205],
  [193, 157, 49, 147, 19, 57, 171, 91], [62, 186, 136, 197, 169, 85, 44, 132], [185, 133, 188, 142, 4, 12, 36, 108],
  [113, 128, 173, 97, 80, 29, 87, 50], [150, 28, 84, 41, 123, 158, 52, 156], [46, 138, 203, 187, 139, 206, 196, 166],
  [76, 17, 51, 153, 37, 111, 122, 155], [43, 129, 176, 106, 107, 110, 119, 146], [16, 48, 144, 10, 30, 90, 59, 177],
  [109, 116, 137, 200, 178, 112, 125, 164], [70, 210, 208, 202, 184, 130, 179, 115], [134, 191, 151, 31, 93, 68, 204, 190],
  [148, 22, 66, 198, 172, 94, 71, 2], [6, 18, 54, 162, 64, 192, 154, 40], [120, 149, 25, 75, 14, 42, 126, 167],
  [79, 26, 78, 23, 69, 207, 199, 175], [103, 98, 83, 38, 114, 131, 182, 124], [161, 61, 183, 127, 170, 88, 53, 159],
  [55, 165, 73, 8, 24, 72, 5, 15], [45, 135, 194, 160, 58, 174, 100, 89],
];
const EXP_FINDER = ['18411', '11481', '36411', '11463', '34611', '11643', '32811', '11823', '26511', '11562', '22911', '11922'].map(digitList); // table 15
const EXP_FINDER_SEQ = [ // table 16
  [1, 2], [1, 4, 3], [1, 6, 3, 8], [1, 10, 3, 8, 5], [1, 10, 3, 8, 7, 12], [1, 10, 3, 8, 9, 12, 11],
  [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 10, 9], [1, 2, 3, 4, 5, 6, 7, 10, 11, 12], [1, 2, 3, 4, 5, 8, 7, 10, 9, 12, 11],
];
const EXP_WEIGHT_ROWS = [
  [0, 1, 2], [0, 5, 6, 3, 4], [0, 9, 10, 3, 4, 13, 14], [0, 17, 18, 3, 4, 13, 14, 7, 8],
  [0, 17, 18, 3, 4, 13, 14, 11, 12, 21, 22], [0, 17, 18, 3, 4, 13, 14, 15, 16, 21, 22, 19, 20],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 18, 15, 16],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 22],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 11, 12, 17, 18, 15, 16, 21, 22, 19, 20],
];

// GS1 AIs of a predefined length need no FNC1 after them (GS1 General
// Specifications figure 7-6)
const predefined = ai => { const n = Number(ai.slice(0, 2)); return n <= 4 || (n >= 11 && n <= 20) || (n >= 31 && n <= 36) || n === 41; };

/** "(01)…(10)…" (or [ ]) → the element string with FNC1 (␝) after variable-length AIs; else the value as it is */
function elementString(text) {
  const t = text.trim();
  if (!/^[([]/.test(t)) return t;
  const parts = [...t.matchAll(/[([](\d{2,4})[)\]]([^([]*)/g)];
  return parts.map(([, ai, data], i) => ai + data + (i < parts.length - 1 && !predefined(ai) ? '\x1D' : '')).join('');
}

const bits = (v, n) => v.toString(2).padStart(n, '0');
const int = (s, from, n) => Number(s.slice(from, from + n));

// YYMMDD → the date's value, or -1
function dateValue(s, at) {
  if (!/^\d{6}$/.test(s.slice(at, at + 6))) return -1;
  const yy = int(s, at, 2), mm = int(s, at + 2, 2), dd = int(s, at + 4, 2);
  return mm < 1 || mm > 12 || dd > 31 ? -1 : yy * 384 + (mm - 1) * 32 + dd;
}

// General-purpose field (ISO/IEC 24724 7.2.5.5): FNC1 counts as numeric
const NUMERIC = 1, ALPHA = 2, ISO = 3;
const ISO_PUNCT = '!"%&\'()*+,-./:;<=>?_ ';
function gfType(c) {
  if (c === '\x1D' || (c >= '0' && c <= '9')) return NUMERIC;
  if ((c >= 'A' && c <= 'Z') || '*,-./'.includes(c)) return ALPHA;
  if ((c >= 'a' && c <= 'z') || ISO_PUNCT.includes(c)) return ISO;
  return 0;
}

function generalField(gf) {
  let out = '', mode = NUMERIC, lastDigit = null;
  const n = gf.length;
  const typeAt = i => gfType(gf[i]);
  const next = (i, num, type, type2 = 0) => {
    if (i + num > n) return false;
    for (let k = i; k < i + num; k++) { const t = typeAt(k); if (t !== type && t !== type2) return false; }
    return true;
  };
  const nextTerminate = (i, num, maxNum, type) => {
    if (i + maxNum < n) return false;
    for (; i < n; i++, num--) if (typeAt(i) !== type) return false;
    return num <= 0;
  };
  const nextNone = (i, num, type) => {
    for (; i < n && num; i++, num--) if (typeAt(i) === type) return false;
    return true;
  };
  for (let i = 0; i < n;) {
    const type = typeAt(i);
    if (!type) return null;
    const c = gf[i];
    if (mode === NUMERIC) {
      if (i < n - 1) {
        if (type !== NUMERIC || typeAt(i + 1) !== NUMERIC) { out += '0000'; mode = ALPHA; }
        else {
          const d1 = c === '\x1D' ? 10 : Number(c), d2 = gf[i + 1] === '\x1D' ? 10 : Number(gf[i + 1]);
          out += bits(11 * d1 + d2 + 8, 7);
          i += 2;
        }
      } else if (type !== NUMERIC) { out += '0000'; mode = ALPHA; }
      else { lastDigit = c; i++; }
    } else if (mode === ALPHA) {
      if (c === '\x1D') { out += '01111'; mode = NUMERIC; i++; }
      else if (type === ISO) { out += '00100'; mode = ISO; }
      else if (next(i, 6, NUMERIC) || nextTerminate(i, 4, 5, NUMERIC)) { out += '000'; mode = NUMERIC; }
      else if (c >= '0' && c <= '9') { out += bits(c.charCodeAt(0) - 43, 5); i++; }
      else if (c >= 'A' && c <= 'Z') { out += bits(c.charCodeAt(0) - 33, 6); i++; }
      else { out += bits('*,-./'.indexOf(c) + 58, 6); i++; }
    } else if (c === '\x1D') { out += '01111'; mode = NUMERIC; i++; }
    else {
      const no10Iso = nextNone(i, 10, ISO);
      if (no10Iso && next(i, 4, NUMERIC)) { out += '000'; mode = NUMERIC; }
      else if (no10Iso && next(i, 5, ALPHA, NUMERIC)) { out += '00100'; mode = ALPHA; }
      else if (c >= '0' && c <= '9') { out += bits(c.charCodeAt(0) - 43, 5); i++; }
      else if (c >= 'A' && c <= 'Z') { out += bits(c.charCodeAt(0) - 1, 7); i++; }
      else if (c >= 'a' && c <= 'z') { out += bits(c.charCodeAt(0) - 7, 7); i++; }
      else { out += bits(ISO_PUNCT.indexOf(c) + 232, 8); i++; }
    }
  }
  return { bits: out, mode, lastDigit };
}

// The data bits (7.2.5): linkage flag 0, the encoding method, the compressed
// field and the general-purpose field, padded to whole 12-bit characters
function expandedBits(s, env) {
  let method = s.length >= 16 && s.startsWith('01') ? 1 : 2;
  if (method === 1 && s.length >= 20 && s[2] === '9' && s[16] === '3') {
    const weight = /^\d{6}$/.test(s.slice(20, 26)) ? int(s, 20, 6) : -1;
    const dated = s.length === 34 && s[26] === '1' && '1357'.includes(s[27]) && dateValue(s, 28) >= 0;
    if (s.length >= 26 && s[17] === '1' && s[18] === '0' && weight >= 0 && weight <= 99999) {
      if (s.length === 26) method = s[19] === '3' && weight <= 32767 ? 3 : 7; // (01)(3103), or (310x) with no date
      else if (dated) method = 6 + Number(s[27]);
    } else if (s.length >= 26 && s[17] === '2' && s[18] === '0' && weight >= 0 && weight <= 99999) {
      if (s.length === 26) method = (s[19] === '2' && weight <= 9999) || (s[19] === '3' && weight <= 22767) ? 4 : 8;
      else if (dated) method = 7 + Number(s[27]);
    } else if (s[17] === '9' && s[19] >= '0' && s[19] <= '3') {
      if (s[18] === '2') method = 5;
      else if (s.length >= 23 && s[18] === '3' && /^\d{3}$/.test(s.slice(20, 23))) method = 6;
    }
  }
  let out = '0', read;
  if (method === 1) { out += '1XX'; read = 16; }
  else if (method === 2) { out += '00XX'; read = 0; }
  else if (method <= 4) { out += bits(4 + method - 3, 4); read = 26; }
  else if (method === 5) { out += '01100XX'; read = 20; }
  else if (method === 6) { out += '01101XX'; read = 23; }
  else { out += bits(56 + method - 7, 7); read = s.length; }
  if (!/^[\d\x1D]*$/.test(s.slice(0, read))) { env.log('XFA_BARCODE_DATA', 'GS1 DataBar Expanded: a non-digit in the compressed field'); return null; }
  const gtin12 = () => { let b = ''; for (let i = 3; i < 15; i += 3) b += bits(int(s, i, 3), 10); return b; };
  if (method === 1) out += bits(int(s, 2, 1), 4) + gtin12();
  else if (method === 3 || method === 4) out += gtin12() + bits(int(s, 20, 6) + (method === 4 && s[19] === '3' ? 10000 : 0), 15);
  else if (method === 5 || method === 6) out += gtin12() + bits(Number(s[19]), 2) + (method === 6 ? bits(int(s, 20, 3), 10) : '');
  else if (method >= 7) out += gtin12() + bits(Number(s[19] + s.slice(21, 26)), 20) + bits(s.length === 34 ? dateValue(s, 28) : 38400, 16);

  const gf = generalField(s.slice(read));
  if (!gf) { env.log('XFA_BARCODE_DATA', 'GS1 DataBar Expanded: a character outside its sets'); return null; }
  out += gf.bits;
  const size = () => {
    let chars = Math.ceil(out.length / 12) + 1;
    if (chars < 4) chars = 4;
    return chars;
  };
  let chars = size();
  let remainder = 12 * (chars - 1) - out.length;
  if (gf.lastDigit !== null) {
    // the odd last digit: 4 bits when that fills the character, else with FNC1
    out += remainder >= 4 && remainder <= 6 ? bits(Number(gf.lastDigit) + 1, 4) : bits(Number(gf.lastDigit) * 11 + 10 + 8, 7);
    chars = size();
    remainder = 12 * (chars - 1) - out.length;
  }
  if (out.length > 252) { env.log('XFA_BARCODE_DATA', 'GS1 DataBar Expanded holds 21 symbol characters at most'); return null; }
  // padding (7.2.5.5.4): numeric mode's latch, then 00100s
  let pad = gf.mode === NUMERIC && remainder > 0 ? '0000' : '';
  while (pad.length < remainder) pad += '00100';
  out = (out + pad).slice(0, 12 * (chars - 1));
  // the variable length field: symbol characters odd, more than 14
  const v = `${chars & 1 ? 1 : 0}${chars > 14 ? 1 : 0}`;
  return out.replace('XX', v);
}

function expandedWidths(value) {
  let group = 4;
  while (value < EXP_G_SUM[group]) group--;
  const v = value - EXP_G_SUM[group];
  return charWidths(Math.floor(v / EXP_T_EVEN[group]), v % EXP_T_EVEN[group], EXP_MODULES[group], 17 - EXP_MODULES[group], 4, EXP_WIDEST[group], true);
}

function expanded(text, env) {
  const s = elementString(text);
  const b = s && expandedBits(s, env);
  if (!b) return null;
  const dataChars = b.length / 12;
  const symbolChars = dataChars + 1;
  const widths = [];
  for (let i = 0; i < dataChars; i++) widths.push(expandedWidths(parseInt(b.slice(12 * i, 12 * i + 12), 2)));
  // 7.2.6: the weighted widths mod 211, and the symbol size
  let checksum = 0;
  widths.forEach((w, i) => { const row = EXP_WEIGHT_ROWS[(dataChars - 2) >> 1][i]; w.forEach((e, j) => { checksum += e * EXP_WEIGHT[row][j]; }); });
  const check = expandedWidths(211 * (symbolChars - 4) + (checksum % 211));
  const blocks = (symbolChars + 1) >> 1;
  const width = blocks * 5 + symbolChars * 8 + 4;
  const el = new Array(width).fill(0);
  const seq = EXP_FINDER_SEQ[((symbolChars - 1) >> 1) - 1];
  for (let i = 0; i < blocks; i++) for (let j = 0; j < 5; j++) el[21 * i + j + 10] = EXP_FINDER[seq[i] - 1][j];
  for (let j = 0; j < 8; j++) el[j + 2] = check[j];
  // odd characters forward after their finder, even ones reversed before the next
  for (let i = 1; i < dataChars; i += 2) for (let j = 0; j < 8; j++) el[((i - 1) >> 1) * 21 + 23 + j] = widths[i][j];
  for (let i = 0; i < dataChars; i += 2) for (let j = 0; j < 8; j++) el[(i >> 1) * 21 + 15 + j] = widths[i][7 - j];
  el[0] = el[1] = el[width - 2] = el[width - 1] = 1;
  const hrt = /^[([]/.test(text.trim()) ? text.trim().replace(/\[/g, '(').replace(/\]/g, ')') : text;
  return { kind: '1d', elements: [0, ...el], text: hrt };
}

export function encodeDataBar(text, type, env) {
  const t = type.toLowerCase();
  if (t === 'rss14limited') return limited(text, env);
  if (t === 'rss14expanded') return expanded(text, env);
  return omnidirectional(text, t, env);
}
