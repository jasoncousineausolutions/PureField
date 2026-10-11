/**
 * Purefield / core / pdf417.js
 *
 * PDF417 (ISO/IEC 15438), laid out as Acrobat prints an XFA pdf417 field:
 *
 *   compaction   text (alpha, lower, mixed, punctuation submodes) by
 *                default; numeric for 13 digits or more; byte for what is
 *                not text, and for a flateCompress payload throughout
 *   error        errorCorrectionLevel 0–8: 2^(level+1) Reed-Solomon
 *                codewords over GF(929), generator ∏(x − 3^i)
 *   columns      dataColumnCount, else as many as fit the field's width at
 *                the module width, with two modules of quiet zone a side
 *   rows         dataRowCount, else as few as hold the codewords (3 to
 *                90); the painter stretches them to the field's height
 *                (moduleHeight is not used, as in Acrobat)
 *   truncate     the right row indicator and the stop pattern left out
 *
 * The codeword patterns are in pdf417table.js. The high-level encoding
 * follows ZXing's PDF417HighLevelEncoder (Apache License 2.0).
 */

import { CLUSTERS } from './pdf417table.js';

const START = '11111111010101000', STOP = '111111101000101001';
const LATCH_TEXT = 900, LATCH_BYTE_PADDED = 901, LATCH_NUMERIC = 902, SHIFT_BYTE = 913, LATCH_BYTE = 924;
const MIXED = '0123456789&\r\t,:#-.$/+%*=^\0 ';  // index = value (25 is unused: pl)
const PUNCT = ';<>@[\\]_`~!\r\t,:\n-.$/"|*()?{}\'';
const QUIET = 2;

/**
 * @param {{ text: string, bytes: Uint8Array, compressed?: boolean }} payload
 * @param {object} b - ui.barcode: errorCorrectionLevel, dataColumnCount, dataRowCount, truncate
 * @param {{ log: Function, box?: { w: number, h: number }, moduleWidth?: number }} env - the
 *   value rectangle and module width (points) the columns are fitted to
 */
export function encodePdf417(payload, b, env) {
  const data = payload.compressed ? bytesOnly(payload.bytes) : highLevel(payload.bytes);
  const level = Math.max(0, Math.min(8, Math.floor(b.errorCorrectionLevel ?? 0)));
  const k = 2 << level;
  const rowExtra = b.truncate ? 17 + 17 + 1 : 17 + 17 + 17 + 18; // start, indicators, stop
  let cols = b.dataColumnCount > 0 ? Math.min(30, Math.floor(b.dataColumnCount)) : 0;
  if (!cols) {
    const mw = env.moduleWidth ?? 0.25 * 72 / 25.4;
    const fit = env.box ? Math.floor((env.box.w / mw - 2 * QUIET - rowExtra) / 17) : 6;
    cols = Math.max(1, Math.min(30, fit));
  }
  let rows = b.dataRowCount > 0 ? Math.floor(b.dataRowCount) : Math.ceil((data.length + 1 + k) / cols);
  rows = Math.max(3, rows);
  while (rows > 90 && cols < 30) { cols++; rows = Math.max(3, Math.ceil((data.length + 1 + k) / cols)); }
  if (rows > 90 || data.length + 1 + k > rows * cols || data.length + 1 > 928) {
    env.log('XFA_BARCODE_DATA', 'too much data for a PDF417 symbol');
    return null;
  }
  // the length descriptor, the data, padding to fill the grid, then the error codewords
  const n = rows * cols - k;
  const cw = [n, ...data];
  while (cw.length < n) cw.push(LATCH_TEXT);
  cw.push(...errorCodewords(cw, k));

  const modules = [];
  for (let r = 0; r < rows; r++) {
    const c = r % 3, base = 30 * Math.floor(r / 3);
    const lri = base + [Math.floor((rows - 1) / 3), level * 3 + (rows - 1) % 3, cols - 1][c];
    const rri = base + [cols - 1, Math.floor((rows - 1) / 3), level * 3 + (rows - 1) % 3][c];
    let bits = START + pattern(c, lri);
    for (let i = 0; i < cols; i++) bits += pattern(c, cw[r * cols + i]);
    bits += b.truncate ? '1' : pattern(c, rri) + STOP;
    modules.push(Uint8Array.from(bits, ch => (ch === '1' ? 1 : 0)));
  }
  return { kind: '2d', modules, stacked: true };
}

function pattern(cluster, value) {
  return CLUSTERS[cluster][value].toString(2);
}

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(929)
// ---------------------------------------------------------------------------

const GENERATORS = new Map();
// g(x) = (x − 3)(x − 3²)…(x − 3^k), low-order coefficients first, the leading 1 left out
function generator(k) {
  if (GENERATORS.has(k)) return GENERATORS.get(k);
  let g = [1];
  let a = 1;
  for (let i = 1; i <= k; i++) {
    a = (a * 3) % 929;
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => {
      next[j + 1] = (next[j + 1] + c) % 929;
      next[j] = (next[j] + c * (929 - a)) % 929;
    });
    g = next;
  }
  const out = g.slice(0, k);
  GENERATORS.set(k, out);
  return out;
}

/** The k error correction codewords for the data codewords (ISO/IEC 15438 Annex A) */
export function errorCodewords(data, k) {
  const g = generator(k);
  const e = new Array(k).fill(0);
  for (const d of data) {
    const t1 = (d + e[k - 1]) % 929;
    for (let j = k - 1; j >= 1; j--) e[j] = (e[j - 1] + 929 - (t1 * g[j]) % 929) % 929;
    e[0] = (929 - (t1 * g[0]) % 929) % 929;
  }
  return e.reverse().map(v => (v ? 929 - v : 0));
}

// ---------------------------------------------------------------------------
// High-level encoding
// ---------------------------------------------------------------------------

const isDigit = c => c >= 48 && c <= 57;
const isText = c => c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126);

function highLevel(bytes) {
  const out = [];
  const len = bytes.length;
  // the first mode is latched even when it is text (Acrobat's symbols open
  // with 900)
  let mode = null, sub = 'alpha', p = 0;
  while (p < len) {
    const n = digitRun(bytes, p);
    if (n >= 13) {
      out.push(LATCH_NUMERIC);
      mode = 'numeric'; sub = 'alpha';
      numeric(bytes, p, n, out);
      p += n;
      continue;
    }
    const t = textRun(bytes, p);
    if (t >= 5 || n === len) {
      if (mode !== 'text') { out.push(LATCH_TEXT); mode = 'text'; sub = 'alpha'; }
      sub = text(bytes, p, t, out, sub);
      p += t;
      continue;
    }
    const bc = Math.max(1, binaryRun(bytes, p));
    if (bc === 1 && mode === 'text') {
      binary(bytes, p, 1, 'text', out);
    } else {
      binary(bytes, p, bc, mode, out);
      mode = 'byte'; sub = 'alpha';
    }
    p += bc;
  }
  return out;
}

function bytesOnly(bytes) {
  const out = [];
  binary(bytes, 0, bytes.length, 'byte-only', out);
  return out;
}

function digitRun(b, p) {
  let n = 0;
  while (p + n < b.length && isDigit(b[p + n])) n++;
  return n;
}

function textRun(b, p) {
  let i = p;
  while (i < b.length) {
    let digits = 0;
    while (digits < 13 && i < b.length && isDigit(b[i])) { digits++; i++; }
    if (digits >= 13) return i - p - digits;
    if (digits > 0) continue;
    if (!isText(b[i])) break;
    i++;
  }
  return i - p;
}

function binaryRun(b, p) {
  let i = p;
  while (i < b.length) {
    let digits = 0;
    while (digits < 13 && i + digits < b.length && isDigit(b[i + digits])) digits++;
    if (digits >= 13) return i - p;
    i++;
  }
  return i - p;
}

// Text compaction as Acrobat writes it: latches only, never the one-character
// shifts (ps, as), each character reached by the fewest latches from the
// submode in use (IRCC IMM 0008's paper forms barcodes: "0008_" is mixed,
// pl, "_", al, ml, … in Reader's print, not mixed, ps, "_")
const SUBMODES = {
  alpha: c => c === 32 || (c >= 65 && c <= 90),
  lower: c => c === 32 || (c >= 97 && c <= 122),
  mixed: c => c !== 0 && MIXED.indexOf(String.fromCharCode(c)) >= 0,
  punct: c => PUNCT.indexOf(String.fromCharCode(c)) >= 0,
};
// latch codewords between submodes
const LATCHES = {
  alpha: { lower: 27, mixed: 28 },
  lower: { mixed: 28 },
  mixed: { alpha: 28, lower: 27, punct: 25 },
  punct: { alpha: 29 },
};
const ORDER = ['alpha', 'lower', 'mixed', 'punct'];
function latchPath(from, c) {
  // breadth first over the latches, submodes tried in a fixed order
  const seen = new Map([[from, []]]);
  const queue = [from];
  while (queue.length) {
    const m = queue.shift();
    if (SUBMODES[m](c)) return { to: m, path: seen.get(m) };
    for (const to of ORDER) {
      const v = LATCHES[m][to];
      if (v === undefined || seen.has(to)) continue;
      seen.set(to, [...seen.get(m), v]);
      queue.push(to);
    }
  }
  return null;
}
function value(sub, c) {
  if (sub === 'alpha') return c === 32 ? 26 : c - 65;
  if (sub === 'lower') return c === 32 ? 26 : c - 97;
  if (sub === 'mixed') return c === 32 ? 26 : MIXED.indexOf(String.fromCharCode(c));
  return PUNCT.indexOf(String.fromCharCode(c));
}

function text(b, start, count, out, submode) {
  const tmp = [];
  let sub = submode;
  for (let i = 0; i < count; i++) {
    const c = b[start + i];
    if (!SUBMODES[sub](c)) {
      const r = latchPath(sub, c);
      if (!r) continue;
      tmp.push(...r.path);
      sub = r.to;
    }
    tmp.push(value(sub, c));
  }
  for (let j = 0; j < tmp.length; j += 2) out.push(tmp[j] * 30 + (j + 1 < tmp.length ? tmp[j + 1] : 29));
  return sub;
}

function numeric(b, start, count, out) {
  for (let i = 0; i < count; i += 44) {
    const len = Math.min(44, count - i);
    let v = BigInt(`1${String.fromCharCode(...b.subarray(start + i, start + i + len))}`);
    const part = [];
    do { part.push(Number(v % 900n)); v /= 900n; } while (v > 0n);
    out.push(...part.reverse());
  }
}

function binary(b, start, count, mode, out) {
  if (count === 1 && mode === 'text') out.push(SHIFT_BYTE);
  else out.push(count % 6 === 0 ? LATCH_BYTE : LATCH_BYTE_PADDED);
  let i = start;
  for (; start + count - i >= 6; i += 6) {
    let t = 0n;
    for (let j = 0; j < 6; j++) t = (t << 8n) + BigInt(b[i + j]);
    const five = [];
    for (let j = 0; j < 5; j++) { five.push(Number(t % 900n)); t /= 900n; }
    out.push(...five.reverse());
  }
  for (; i < start + count; i++) out.push(b[i]);
}
