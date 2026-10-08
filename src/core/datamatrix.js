/**
 * Purefield / core / datamatrix.js
 *
 * Data Matrix ECC 200 (ISO/IEC 16022): ASCII encodation (digit pairs as one
 * codeword, bytes above 127 behind an upper shift), the smallest square
 * symbol that holds the data, Reed-Solomon over GF(256) (0x12D) in
 * interleaved blocks, and the module placement of Annex F.
 */

// size, data region side, data codewords, error codewords, blocks
const SYMBOLS = [
  [10, 8, 3, 5, 1], [12, 10, 5, 7, 1], [14, 12, 8, 10, 1], [16, 14, 12, 12, 1], [18, 16, 18, 14, 1],
  [20, 18, 22, 18, 1], [22, 20, 30, 20, 1], [24, 22, 36, 24, 1], [26, 24, 44, 28, 1], [32, 14, 62, 36, 1],
  [36, 16, 86, 42, 1], [40, 18, 114, 48, 1], [44, 20, 144, 56, 1], [48, 22, 174, 68, 1], [52, 24, 204, 84, 2],
  [64, 14, 280, 112, 2], [72, 16, 368, 144, 4], [80, 18, 456, 192, 4], [88, 20, 576, 224, 4], [96, 22, 696, 272, 4],
  [104, 24, 816, 336, 6], [120, 18, 1050, 408, 6], [132, 20, 1304, 496, 8], [144, 22, 1558, 620, 10],
];

/** @param {{ bytes: Uint8Array }} payload */
export function encodeDataMatrix(payload, env) {
  const r = dataMatrixCodewords(payload.bytes);
  if (!r) { env.log('XFA_BARCODE_DATA', 'too much data for a Data Matrix symbol'); return null; }
  const { cw, sym: [size, region] } = r;
  const regions = size / (region + 2); // data regions a side
  const n = regions * region; // mapping matrix side
  const map = placement(n, n);
  const bit = v => (v === 1 ? 1 : v === 0 ? 0 : (cw[Math.floor(v / 10) - 1] >> (8 - (v % 10))) & 1);
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const B = region + 2;
  for (let ry = 0; ry < regions; ry++) for (let rx = 0; rx < regions; rx++) {
    for (let r = 0; r < B; r++) for (let c = 0; c < B; c++) {
      let v;
      if (c === 0 || r === B - 1) v = 1;
      else if (r === 0) v = c % 2 === 0 ? 1 : 0;
      else if (c === B - 1) v = r % 2;
      else v = bit(map[ry * region + r - 1][rx * region + c - 1]);
      modules[ry * B + r][rx * B + c] = v;
    }
  }
  return { kind: '2d', modules };
}

/**
 * The symbol size and its codewords, data then interleaved error correction
 * (ISO/IEC 16022's example "123456": 142 164 186, then 114 25 5 88 102)
 * @returns {{ sym: number[], cw: number[] }|null}
 */
export function dataMatrixCodewords(bytes) {
  const data = ascii(bytes);
  const sym = SYMBOLS.find(s => s[2] >= data.length);
  if (!sym) return null;
  const [, , cap, eccLen, blocks] = sym;
  // pad: 129, then pseudo-random pads (253-state algorithm)
  for (let i = data.length; i < cap; i++) {
    if (i === data.length) data.push(129);
    else { let v = ((149 * (i + 1)) % 253) + 1 + 129; if (v > 254) v -= 254; data.push(v); }
  }
  const cw = data.concat(new Array(eccLen).fill(0));
  const per = eccLen / blocks;
  for (let b = 0; b < blocks; b++) {
    const block = [];
    for (let i = b; i < cap; i += blocks) block.push(data[i]);
    rs(block, per).forEach((e, j) => { cw[cap + b + j * blocks] = e; });
  }
  return { sym, cw };
}

function ascii(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i], d = bytes[i + 1];
    if (c >= 48 && c <= 57 && d >= 48 && d <= 57) { out.push(130 + (c - 48) * 10 + (d - 48)); i++; }
    else if (c < 128) out.push(c + 1);
    else out.push(235, c - 127);
  }
  return out;
}

// GF(256), primitive polynomial x^8 + x^5 + x^3 + x^2 + 1
const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x12d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// k error codewords: the remainder of data · x^k by ∏(x − 2^i), i = 1..k
function rs(data, k) {
  let g = [1];
  for (let i = 1; i <= k; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    g = next;
  }
  const r = new Array(k).fill(0);
  for (const d of data) {
    const f = d ^ r[0];
    r.shift(); r.push(0);
    for (let j = 0; j < k; j++) r[j] ^= mul(g[j + 1], f);
  }
  return r;
}

// Annex F: each cell names codeword·10 + bit (1 the most significant), or
// 0/1 for the fixed corner of some sizes
function placement(nrow, ncol) {
  const a = Array.from({ length: nrow }, () => new Array(ncol).fill(-1));
  const mod = (row, col, chr, bit) => {
    if (row < 0) { row += nrow; col += 4 - ((nrow + 4) % 8); }
    if (col < 0) { col += ncol; row += 4 - ((ncol + 4) % 8); }
    a[row][col] = chr * 10 + bit;
  };
  const utah = (r, c, ch) => {
    mod(r - 2, c - 2, ch, 1); mod(r - 2, c - 1, ch, 2); mod(r - 1, c - 2, ch, 3); mod(r - 1, c - 1, ch, 4);
    mod(r - 1, c, ch, 5); mod(r, c - 2, ch, 6); mod(r, c - 1, ch, 7); mod(r, c, ch, 8);
  };
  const corner = (cells, ch) => cells.forEach(([r, c], i) => mod(r, c, ch, i + 1));
  let chr = 1, row = 4, col = 0;
  do {
    if (row === nrow && col === 0) corner([[nrow - 1, 0], [nrow - 1, 1], [nrow - 1, 2], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]], chr++);
    if (row === nrow - 2 && col === 0 && ncol % 4) corner([[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 4], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1]], chr++);
    if (row === nrow - 2 && col === 0 && ncol % 8 === 4) corner([[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]], chr++);
    if (row === nrow + 4 && col === 2 && !(ncol % 8)) corner([[nrow - 1, 0], [nrow - 1, ncol - 1], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 3], [1, ncol - 2], [1, ncol - 1]], chr++);
    do { if (row < nrow && col >= 0 && a[row][col] < 0) utah(row, col, chr++); row -= 2; col += 2; } while (row >= 0 && col < ncol);
    row += 1; col += 3;
    do { if (row >= 0 && col < ncol && a[row][col] < 0) utah(row, col, chr++); row += 2; col -= 2; } while (row < nrow && col >= 0);
    row += 3; col += 1;
  } while (row < nrow || col < ncol);
  if (a[nrow - 1][ncol - 1] < 0) {
    a[nrow - 1][ncol - 1] = a[nrow - 2][ncol - 2] = 1;
    a[nrow - 1][ncol - 2] = a[nrow - 2][ncol - 1] = 0;
  }
  return a;
}
