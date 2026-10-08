/**
 * Purefield / core / aztec.js
 *
 * Aztec Code (ISO/IEC 24778): the bytes in the fewest bits over the Upper,
 * Lower, Mixed, Punct and Digit modes, their latches and shifts, the
 * two-character Punct codes and binary shift for anything else (the
 * shortest-path search of ZXing's high-level encoder, by Frank Yellin and
 * Rustam Abdullaev, as zint adapts it); then the smallest compact (1 to 4
 * layers) or full-range (1 to 32 layers) symbol that holds them with the
 * error correction asked for (23% + 3 codewords by default), bit-stuffed
 * codewords, Reed-Solomon over GF(2^6), GF(2^8), GF(2^10) or GF(2^12), the
 * mode message over GF(16), and the spiral of layers round the bullseye
 * (with the reference grid of a full-range symbol).
 *
 * Ported from zint (backend/aztec.c, aztec.h, reedsol.c; BSD-3-Clause,
 * Copyright (C) 2009-2026 Robin Stuart), whose encodation search is adapted
 * from ZXing (Apache-2.0, Copyright 2013 ZXing authors) via zxing-cpp
 * (Copyright 2016 Huy Cuong Nguyen); the capacity tables are ISO/IEC 24778's.
 *
 *   encodeAztec({ bytes }, b, env) → { kind: '2d', modules } | null
 *   aztecModules(bytes, { ecc, version }) → { modules, compact, layers } | { error }
 */

const U = 0, L = 1, M = 2, P = 3, D = 4;

// Table 2: each ASCII character's value in each mode (0: not in that mode)
const CHAR = Array.from({ length: 5 }, () => new Uint8Array(128));
CHAR[U][32] = CHAR[L][32] = CHAR[M][32] = CHAR[D][32] = 1;
for (let i = 0; i < 26; i++) { CHAR[U][65 + i] = 2 + i; CHAR[L][97 + i] = 2 + i; }
for (let c = 1; c <= 13; c++) CHAR[M][c] = c + 1;
for (let c = 27; c <= 31; c++) CHAR[M][c] = c - 12;
[64, 92, 94, 95, 96, 124, 126, 127].forEach((c, i) => { CHAR[M][c] = 20 + i; });
CHAR[P][13] = 1;
for (let c = 33; c <= 47; c++) CHAR[P][c] = c - 27;
for (let c = 58; c <= 63; c++) CHAR[P][c] = c - 37;
[91, 93, 123, 125].forEach((c, i) => { CHAR[P][c] = 27 + i; });
for (let c = 48; c <= 57; c++) CHAR[D][c] = c - 46;
CHAR[D][44] = 12; CHAR[D][46] = 13;
// the modes holding each character, a bit per mode
const FLAGS = new Uint8Array(128);
for (let c = 0; c < 128; c++) for (let m = 0; m < 5; m++) if (CHAR[m][c]) FLAGS[c] |= 1 << m;

// latch from a mode (row) to another (column): the bits and their count
const LATCH = [
  [0, 28, 29, (29 << 5) + 30, 30],
  [(30 << 4) + 14, 0, 29, (29 << 5) + 30, 30],
  [29, 28, 0, 30, (29 << 5) + 30],
  [31, (31 << 5) + 28, (31 << 5) + 29, 0, (31 << 5) + 30],
  [14, (14 << 5) + 28, (14 << 5) + 29, (14 << 10) + (29 << 5) + 30, 0],
];
const LATCH_BITS = [
  [0, 5, 5, 10, 5],
  [9, 0, 5, 10, 5],
  [5, 5, 0, 5, 10],
  [5, 10, 10, 0, 10],
  [4, 9, 9, 14, 0],
];
// shift from a mode (row) to Upper or Punct for one character (-1: none)
const SHIFT = [
  [-1, -1, -1, 0, -1],
  [28, -1, -1, 0, -1],
  [-1, -1, -1, 0, -1],
  [-1, -1, -1, -1, -1],
  [15, -1, -1, 0, -1],
];

// Symbol sizes: codewords in each full-range and compact symbol, and the
// data bits each holds at error correction 10%, 23%, 36% and 50% (+ 3
// codewords)
const SIZES = [
  21, 48, 60, 88, 120, 156, 196, 240, 230, 272, 316, 364, 416, 470, 528, 588,
  652, 720, 790, 864, 940, 1020, 920, 992, 1066, 1144, 1224, 1306, 1392, 1480, 1570, 1664,
];
const COMPACT_SIZES = [17, 40, 51, 64]; // 64 data codewords at most, of 76
const DATA_SIZES = [
  [95, 241, 408, 609, 840, 1099, 1387, 1704, 2040, 2418, 2814, 3246, 3714, 4200, 4722, 5262,
    5838, 6450, 7080, 7746, 8430, 9150, 9900, 10677, 11476, 12319, 13183, 14068, 14997, 15948, 16920, 17935],
  [79, 203, 345, 518, 715, 936, 1183, 1454, 1741, 2064, 2403, 2772, 3173, 3589, 4035, 4497,
    4990, 5514, 6053, 6622, 7208, 7824, 8464, 9130, 9813, 10534, 11273, 12031, 12826, 13639, 14470, 15339],
  [62, 166, 283, 426, 590, 774, 979, 1204, 1442, 1710, 1992, 2299, 2632, 2978, 3349, 3733,
    4142, 4578, 5026, 5499, 5986, 6498, 7029, 7582, 8150, 8749, 9364, 9994, 10654, 11330, 12021, 12743],
  [45, 126, 216, 328, 456, 600, 760, 936, 1120, 1330, 1550, 1790, 2050, 2320, 2610, 2910,
    3230, 3570, 3920, 4290, 4670, 5070, 5484, 5916, 6360, 6828, 7308, 7800, 8316, 8844, 9384, 9948],
];
const COMPACT_DATA_SIZES = [[73, 198, 343, 512], [60, 166, 290, 444], [47, 135, 237, 365], [33, 102, 180, 280]];
// a full-range symbol's margin in the 151-module grid of the largest
const OFFSET = [
  66, 64, 62, 60, 57, 55, 53, 51, 49, 47, 45, 42, 40, 38, 36, 34,
  32, 30, 28, 25, 23, 21, 19, 17, 15, 13, 10, 8, 6, 4, 2, 0,
];
const BIN_CAPACITY = 19932; // 19968 bits less three 12-bit codewords

// ---------------------------------------------------------------------------
// Encodation: the shortest bit string, searched over states (mode, bits so
// far, bytes pending in a binary shift), the dominated ones dropped
// ---------------------------------------------------------------------------

// tokens are a list linked backwards: { v, n, prev }, n < 0 a value of -n
// bits, else a binary shift of n bytes from v
const token = (s, v, n) => { s.tok = { v, n, prev: s.tok }; };

function endShift(s, from) {
  if (s.byteCount) { token(s, from - s.byteCount, s.byteCount); s.byteCount = 0; }
}

// latch to mode if not in it, then the value (and value2)
function latchAppend(state, from, mode, value, value2, list) {
  const s = { ...state };
  endShift(s, from);
  let bits = state.bitCount;
  if (mode !== state.mode) { token(s, LATCH[state.mode][mode], -LATCH_BITS[state.mode][mode]); bits += LATCH_BITS[state.mode][mode]; }
  const w = mode === D ? 4 : 5;
  token(s, value, -w); bits += w;
  if (value2 !== -1) { token(s, value2, -w); bits += w; }
  s.mode = mode;
  s.bitCount = bits;
  list.push(s);
}

// shift to mode for the one value
function shiftAppend(state, from, mode, value, list) {
  const s = { ...state };
  const w = state.mode === D ? 4 : 5;
  endShift(s, from);
  token(s, SHIFT[state.mode][mode], -w);
  token(s, value, -5);
  s.bitCount = state.bitCount + w + 5;
  list.push(s);
}

// latch to Digit, then shift (4 bits rather than 5) to Upper or Punct
function digitLatchShiftAppend(state, from, shiftMode, value, list) {
  const s = { ...state };
  endShift(s, from);
  token(s, LATCH[state.mode][D], -LATCH_BITS[state.mode][D]);
  token(s, SHIFT[D][shiftMode], -4);
  token(s, value, -5);
  s.mode = D;
  s.bitCount = state.bitCount + LATCH_BITS[state.mode][D] + 4 + 5;
  list.push(s);
}

// one more byte (or two, from and from2) in binary shift
function byteShiftAppend(state, from, from2, list) {
  const s = { ...state };
  let mode = state.mode, bits = state.bitCount;
  const delta = n => (n === 0 || n === 31 ? 18 : n === 62 ? 9 : 8);
  if (mode === P || mode === D) { token(s, LATCH[mode][U], -LATCH_BITS[mode][U]); bits += LATCH_BITS[mode][U]; mode = U; }
  s.mode = mode;
  s.byteCount = state.byteCount + 1;
  s.bitCount = bits + delta(state.byteCount);
  if (s.byteCount === 2047 + 31) endShift(s, from + 1); // as long as a shift can be
  if (from2 !== -1) {
    s.bitCount += delta(s.byteCount);
    s.byteCount++;
    if (s.byteCount === 2047 + 31) endShift(s, from2 + 1);
  }
  list.push(s);
}

const shiftCost = s => (s.byteCount > 0 ? (s.byteCount > 31 ? 20 + (s.byteCount > 62 ? 1 : 0) : 10) : 0);

// state is at least as good as other whatever follows
function betterOrEqual(state, other) {
  let bits = state.bitCount + LATCH_BITS[state.mode][other.mode];
  if (other.byteCount > 0) {
    if (state.byteCount < other.byteCount) bits += shiftCost(other) - shiftCost(state);
    else if (state.byteCount > other.byteCount) bits += 10;
  }
  return bits <= other.bitCount;
}

function simplify(list) {
  const removed = new Uint8Array(list.length);
  for (let i = 0; i < list.length; i++) {
    if (removed[i]) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (removed[j]) continue;
      if (betterOrEqual(list[j], list[i])) { removed[i] = 1; break; }
      if (betterOrEqual(list[i], list[j])) removed[j] = 1;
    }
  }
  return list.filter((_, i) => !removed[i]);
}

// the two-character Punct codes: CR LF 2, ". " 3, ", " 4, ": " 5
function pairStates(state, from, code, list) {
  latchAppend(state, from, P, code, -1, list);
  if (state.mode !== P) shiftAppend(state, from, P, code, list);
  if (code === 3 || code === 4) latchAppend(state, from, D, 16 - code, 1, list); // both in Digit
  if (state.byteCount > 0) byteShiftAppend(state, from, from + 1, list);
}

function charStates(state, src, from, list) {
  const ch = src[from];
  const flags = ch < 128 ? FLAGS[ch] : 0;
  const inCurrent = flags & (1 << state.mode);
  for (let mode = 0; mode < 5; mode++) {
    if (!(flags & (1 << mode))) continue;
    // latching elsewhere to a character the current mode has saves nothing
    // after it, except to Digit's 4 bits
    if (!inCurrent || mode === state.mode || mode === D) latchAppend(state, from, mode, CHAR[mode][ch], -1, list);
    if (!inCurrent && SHIFT[state.mode][mode] >= 0) shiftAppend(state, from, mode, CHAR[mode][ch], list);
  }
  if (state.mode !== D && !inCurrent && !(flags & (1 << D)) && (flags & ((1 << U) | (1 << P)))) {
    const shiftMode = flags & (1 << U) ? U : P;
    digitLatchShiftAppend(state, from, shiftMode, CHAR[shiftMode][ch], list);
  }
  if (state.byteCount > 0 || !inCurrent) byteShiftAppend(state, from, -1, list);
}

const isPair = (s, i) => i + 1 < s.length
  && ((s[i] === 13 && s[i + 1] === 10) || (s[i + 1] === 32 && (s[i] === 46 || s[i] === 44 || s[i] === 58)));

// The shortest bit string for src; null when too long for any symbol
function shortestBits(src) {
  let list = [{ tok: null, mode: U, byteCount: 0, bitCount: 0 }];
  for (let i = 0; i < src.length; i++) {
    const next = [];
    if (isPair(src, i)) {
      const code = src[i] === 13 ? 2 : 3 + 7 - ((src[i] & 0x0F) >> 1);
      for (const s of list) pairStates(s, i, code, next);
      list = simplify(next);
      i++;
    } else {
      for (const s of list) charStates(s, src, i, next);
      list = next.length > 1 ? simplify(next) : next;
    }
  }
  let best = list[0];
  for (const s of list) if (s.bitCount < best.bitCount) best = s;
  const end = { ...best };
  endShift(end, src.length);
  if (end.bitCount > BIN_CAPACITY) return null;
  const toks = [];
  for (let t = end.tok; t; t = t.prev) toks.push(t);
  const bits = [];
  for (const t of toks.reverse()) {
    if (t.n < 0) { put(bits, t.v, -t.n); continue; }
    for (let j = 0; j < t.n; j++) {
      if (j === 0 || (j === 31 && t.n <= 62)) {
        put(bits, 31, 5); // B/S
        if (t.n > 62) put(bits, t.n - 31, 16);
        else put(bits, j === 0 ? Math.min(t.n, 31) : t.n - 31, 5);
      }
      put(bits, src[t.v + j], 8);
    }
  }
  return bits;
}

function put(bits, v, n) { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); }

// Text all of one kind (Upper, Lower, digits, or none encodable but in
// binary) in that mode alone, as zint takes it
function singleModeBits(src) {
  if (src.length < 2) return null;
  let bytes = 0;
  for (const c of src) if (c >= 128 || !FLAGS[c]) bytes++;
  const bits = [];
  if (bytes) {
    if (bytes !== src.length) return null;
    let i = 0, count = src.length, big = 0;
    put(bits, 31, 5); // B/S
    if (count > 2047 + 2078) return [];
    const bytesOut = n => { for (let k = 0; k < n; k++) put(bits, src[i++], 8); };
    if (count > 2047) {
      big = Math.min(count, 2078);
      put(bits, big - 31, 16);
      bytesOut(big);
      count -= big;
    }
    if (count) {
      if (big) put(bits, 31, 5);
      if (count > 62) put(bits, count - 31, 16);
      else {
        if (count > 31) { put(bits, 31, 5); bytesOut(31); put(bits, 31, 5); count -= 31; }
        put(bits, count, 5);
      }
      bytesOut(count);
    }
    return bits;
  }
  const all = test => src.every(test);
  if (all(c => FLAGS[c] & (1 << U))) src.forEach(c => put(bits, CHAR[U][c], 5));
  else if (all(c => FLAGS[c] & (1 << L))) { put(bits, 28, 5); src.forEach(c => put(bits, CHAR[L][c], 5)); }
  else if (all(c => c >= 48 && c <= 57)) { put(bits, 30, 5); src.forEach(c => put(bits, CHAR[D][c], 4)); }
  else return null;
  return bits;
}

// ---------------------------------------------------------------------------
// Codewords
// ---------------------------------------------------------------------------

const codewordSize = layers => (layers <= 2 ? 6 : layers <= 8 ? 8 : layers <= 22 ? 10 : 12);

// 7.3.1.2: a codeword whose first B-1 bits are all 0 (or all 1) gets a
// dummy 1 (or 0) as its last; null when that passes maxSize
function bitStuff(bits, size, maxSize) {
  const out = [];
  let count = 0;
  for (const b of bits) {
    if ((out.length + 1) % size === 0) {
      if (count === 0 || count === size - 1) {
        if (out.length > maxSize) return null;
        out.push(count === 0 ? 1 : 0);
        count = b;
      } else count = 0;
    } else if (b) count++;
    if (out.length > maxSize) return null;
    out.push(b);
  }
  return out;
}

// pad with 1s to a whole codeword, the last 0 if it would be all 1s
function pad(bits, size) {
  const rem = bits.length % size;
  if (!rem) return bits;
  for (let i = rem; i < size; i++) bits.push(1);
  if (bits.slice(-size).every(b => b)) bits[bits.length - 1] = 0;
  return bits;
}

// Reed-Solomon over GF(2^m) with the given prime polynomial, generator
// ∏(x − α^i), i = 1..k
function rs(data, k, m, poly) {
  const n = (1 << m) - 1;
  const exp = new Uint16Array(2 * n), log = new Uint16Array(n + 1);
  for (let i = 0, x = 1; i < n; i++) { exp[i] = exp[i + n] = x; log[x] = i; x <<= 1; if (x > n) x ^= poly; }
  const mul = (a, b) => (a && b ? exp[log[a] + log[b]] : 0);
  let g = [1];
  for (let i = 1; i <= k; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, exp[i % n]); });
    g = next;
  }
  const r = new Array(k).fill(0);
  for (const d of data) {
    const f = d ^ r[0];
    for (let j = 0; j < k - 1; j++) r[j] = r[j + 1] ^ mul(g[j + 1], f);
    r[k - 1] = mul(g[k], f);
  }
  return r;
}
const POLY = { 4: 0x13, 6: 0x43, 8: 0x12d, 10: 0x409, 12: 0x1069 };

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

/**
 * The modules for bytes. ecc 1–4: at least 10%, 23% (the default), 36% or
 * 50% of the codewords for error correction, plus 3; version 1–4 a compact
 * symbol of that many layers, 5–36 a full-range one of version − 4, else
 * the smallest that holds the data.
 * @param {Uint8Array|number[]} bytes
 * @param {{ ecc?: number, version?: number }} [opts]
 */
export function aztecModules(bytes, opts = {}) {
  const src = Array.from(bytes, c => c & 0xFF);
  const bits = singleModeBits(src) ?? shortestBits(src);
  if (!bits || !bits.length || bits.length > BIN_CAPACITY) return { error: 'too long' };
  const level = opts.ecc >= 1 && opts.ecc <= 4 ? opts.ecc : 2;
  let compact, layers, size, stuffed, maxSize;
  if (opts.version) {
    compact = opts.version <= 4;
    layers = compact ? opts.version : opts.version - 4;
    size = codewordSize(layers);
    maxSize = size * ((compact ? COMPACT_SIZES : SIZES)[layers - 1] - 3);
    stuffed = bitStuff(bits, size, maxSize);
    if (!stuffed || stuffed.length > maxSize) return { error: 'too long for the version' };
    pad(stuffed, size);
  } else {
    // the smallest symbol that holds the data; again if stuffing outgrows it
    let adjust = 0;
    do {
      compact = false; layers = 0;
      const need = bits.length + adjust;
      if (need <= COMPACT_DATA_SIZES[level - 1][3]) {
        for (let i = 4; i > 0; i--) if (need <= COMPACT_DATA_SIZES[level - 1][i - 1]) { layers = i; compact = true; maxSize = COMPACT_DATA_SIZES[level - 1][i - 1]; }
      }
      if (!compact && need <= DATA_SIZES[level - 1][31]) {
        for (let i = 32; i > 0; i--) if (need <= DATA_SIZES[level - 1][i - 1]) { layers = i; maxSize = DATA_SIZES[level - 1][i - 1]; }
      }
      if (!layers) return { error: 'too long' };
      size = codewordSize(layers);
      stuffed = bitStuff(bits, size, adjust ? maxSize : BIN_CAPACITY);
      if (!stuffed) return { error: 'too long' };
      pad(stuffed, size);
      adjust = stuffed.length - bits.length;
    } while (stuffed.length > maxSize);
  }

  const nData = stuffed.length / size;
  const nEcc = compact ? COMPACT_SIZES[layers - 1] - nData + (layers === 4 ? 12 : 0) : SIZES[layers - 1] - nData;
  const data = [];
  for (let i = 0; i < nData; i++) data.push(stuffed.slice(i * size, (i + 1) * size).reduce((a, b) => (a << 1) | b, 0));
  const all = [...stuffed];
  for (const e of rs(data, nEcc, size, POLY[size])) put(all, e, size);
  // the data outermost, the error codewords inside it
  const pattern = all.reverse();

  // mode message: layers − 1 and data codewords − 1, and its own error codewords
  const desc = [];
  if (compact) { put(desc, layers - 1, 2); put(desc, nData - 1, 6); } else { put(desc, layers - 1, 5); put(desc, nData - 1, 11); }
  const nibbles = [];
  for (let i = 0; i < desc.length; i += 4) nibbles.push(desc.slice(i, i + 4).reduce((a, b) => (a << 1) | b, 0));
  for (const e of rs(nibbles, compact ? 5 : 6, 4, POLY[4])) put(desc, e, 4);

  const modules = compact ? compactSymbol(layers, pattern, desc) : fullSymbol(layers, pattern, desc);
  return { modules, compact, layers };
}

// The data layers in order round a core whose sides run from a to b in the
// (grid-free) coordinates f maps to the symbol's
function placeLayers(grid, layers, a, b, f, pattern) {
  let n = 0;
  const set = (x, y) => { if (pattern[n++]) grid[f(y)][f(x)] = 1; };
  for (let l = 0; l < layers; l++) {
    const len = b - a + 3 + 4 * l; // bit pairs a side
    for (let k = 0, x = a - 2 * l, y = a - 1 - 2 * l; k < len; k++, x++) { set(x, y); set(x, y - 1); } // top
    for (let k = 0, x = b + 1 + 2 * l, y = a - 2 * l; k < len; k++, y++) { set(x, y); set(x + 1, y); } // right
    for (let k = 0, x = b + 2 * l, y = b + 1 + 2 * l; k < len; k++, x--) { set(x, y); set(x, y + 1); } // bottom
    for (let k = 0, x = a - 1 - 2 * l, y = b + 2 * l; k < len; k++, y--) { set(x, y); set(x - 1, y); } // left
  }
}

// The bullseye (rings 0 to r − 1 from the centre c, dark at even
// distances), the orientation marks at the ring r corners and the mode
// message round them, its positions along each side
function placeCore(grid, c, r, desc, sides) {
  for (let y = c - r + 1; y < c + r; y++) for (let x = c - r + 1; x < c + r; x++) grid[y][x] = Math.max(Math.abs(x - c), Math.abs(y - c)) % 2 ? 0 : 1;
  const lo = c - r, hi = c + r;
  for (const [x, y] of [[lo, lo], [lo + 1, lo], [lo, lo + 1], [hi, lo], [hi, lo + 1], [hi, hi - 1]]) grid[y][x] = 1;
  let n = 0;
  const set = (x, y) => { grid[y][x] = desc[n++]; };
  for (const p of sides) set(p, lo);
  for (const p of sides) set(hi, p);
  for (const p of [...sides].reverse()) set(p, hi);
  for (const p of [...sides].reverse()) set(lo, p);
}

const square = n => Array.from({ length: n }, () => new Uint8Array(n));

function compactSymbol(layers, pattern, desc) {
  const grid = square(27);
  placeLayers(grid, layers, 8, 18, v => v, pattern);
  placeCore(grid, 13, 5, desc, [10, 11, 12, 13, 14, 15, 16]);
  const off = 2 * (4 - layers);
  return grid.slice(off, 27 - off).map(row => row.slice(off, 27 - off));
}

// skips the reference grid lines (every 16th module from the centre)
const avoidGrid = v => (v > 10 ? v + Math.floor((v - 11) / 15) + 1 : v);

function fullSymbol(layers, pattern, desc) {
  const grid = square(151);
  placeLayers(grid, layers, 64, 77, avoidGrid, pattern);
  placeCore(grid, 75, 7, desc, [70, 71, 72, 73, 74, 76, 77, 78, 79, 80]);
  const off = OFFSET[layers - 1], end = 151 - off;
  // the reference grid: lines through the centre and every 16 modules,
  // dark and light alternating
  for (let g = 75 % 16; g < end; g += 16) {
    if (g < off) continue;
    for (let t = off; t < end; t++) grid[g][t] = grid[t][g] = t & 1;
  }
  return grid.slice(off, end).map(row => row.slice(off, end));
}

/**
 * An XFA aztec field: payload.bytes in the smallest symbol;
 * errorCorrectionLevel 0–3 as for QR Code (L M Q H) at 10%, 23% (absent),
 * 36% and 50%.
 * @param {{ bytes: Uint8Array }} payload
 * @param {{ errorCorrectionLevel?: number|null }} b
 */
export function encodeAztec(payload, b, env) {
  const e = b.errorCorrectionLevel;
  const ecc = e === null || e === undefined || !Number.isFinite(e) ? 2 : 1 + Math.max(0, Math.min(3, Math.floor(e)));
  const r = aztecModules(payload.bytes, { ecc });
  if (r.error) { env.log('XFA_BARCODE_DATA', 'too much data for an Aztec Code symbol'); return null; }
  return { kind: '2d', modules: r.modules };
}
