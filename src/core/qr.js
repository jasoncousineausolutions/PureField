/**
 * Purefield / core / qr.js
 *
 * QR Code model 2 (ISO/IEC 18004): one segment, numeric, alphanumeric or
 * byte, in the smallest version that holds it at the field's error
 * correction level (not raised when there is room, as Acrobat prints it),
 * and the mask with the lowest penalty. Acrobat scores masks by runs of five
 * or more (N1), 2×2 blocks (N2) and the dark proportion (N4), without the
 * finder-like pattern rule (N3): its print of pdfium-barcodes uses mask 3,
 * which only that scoring picks. The tables and the other rules follow
 * Project Nayuki's QR Code generator (MIT License,
 * https://www.nayuki.io/page/qr-code-generator-library).
 */

// [level][version]: error correction codewords per block, and blocks
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const FORMAT_BITS = [1, 0, 3, 2]; // L M Q H
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/**
 * @param {{ text: string, bytes: Uint8Array }} payload
 * @param {{ errorCorrectionLevel: number|null }} b - 0 L, 1 M, 2 Q, 3 and up H; absent M
 */
export function encodeQr(payload, b, env) {
  const e = b.errorCorrectionLevel;
  const ecl = e === null || e === undefined ? 1 : Math.max(0, Math.min(3, Math.floor(e)));
  const seg = segment(payload);
  let version = 1;
  for (; version <= 40; version++) if (seg.bits(version) <= dataCodewords(version, ecl) * 8) break;
  if (version > 40) { env.log('XFA_BARCODE_DATA', 'too much data for a QR Code'); return null; }

  // data bits, terminator, pad bytes
  const cap = dataCodewords(version, ecl) * 8;
  const bb = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bb.push((v >>> i) & 1); };
  put(seg.mode, 4);
  put(seg.count, countBits(seg.mode, version));
  seg.write(put);
  put(0, Math.min(4, cap - bb.length));
  put(0, (8 - bb.length % 8) % 8);
  for (let pad = 0xec; bb.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bb.length; i += 8) data.push(bb.slice(i, i + 8).reduce((a, x) => (a << 1) | x, 0));

  const q = new Grid(version);
  q.functionPatterns(ecl);
  q.codewords(interleave(data, version, ecl));
  let best = 0, min = Infinity;
  for (let m = 0; m < 8; m++) {
    q.mask(m); q.format(ecl, m);
    const p = q.penalty();
    if (p < min) { min = p; best = m; }
    q.mask(m);
  }
  q.mask(best); q.format(ecl, best);
  return { kind: '2d', modules: q.m.map(r => Uint8Array.from(r)) };
}

function segment({ text, bytes }) {
  if (/^[0-9]*$/.test(text) && text.length) {
    return {
      mode: 1, count: text.length,
      bits: v => 4 + countBits(1, v) + Math.floor(text.length / 3) * 10 + [0, 4, 7][text.length % 3],
      write: put => { for (let i = 0; i < text.length; i += 3) { const s = text.slice(i, i + 3); put(Number(s), s.length * 3 + 1); } },
    };
  }
  if ([...text].every(c => ALNUM.includes(c)) && text.length) {
    return {
      mode: 2, count: text.length,
      bits: v => 4 + countBits(2, v) + Math.floor(text.length / 2) * 11 + (text.length % 2) * 6,
      write: put => {
        for (let i = 0; i < text.length; i += 2) {
          if (i + 1 < text.length) put(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
          else put(ALNUM.indexOf(text[i]), 6);
        }
      },
    };
  }
  return {
    mode: 4, count: bytes.length,
    bits: v => 4 + countBits(4, v) + bytes.length * 8,
    write: put => { for (const x of bytes) put(x, 8); },
  };
}

function countBits(mode, v) {
  const i = v < 10 ? 0 : v < 27 ? 1 : 2;
  return { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16] }[mode][i];
}

function rawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(v, ecl) {
  return Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[ecl][v] * BLOCKS[ecl][v];
}

// Blocks with their Reed-Solomon codewords, read across
function interleave(data, v, ecl) {
  const nb = BLOCKS[ecl][v], ecLen = ECC_PER_BLOCK[ecl][v];
  const raw = Math.floor(rawModules(v) / 8);
  const short = nb - raw % nb, shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - ecLen + (i < short ? 0 : 1));
    k += d.length;
    const ec = rsRemainder(d, div);
    if (i < short) d.push(0);
    blocks.push(d.concat(ec));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((bl, j) => { if (i !== shortLen - ecLen || j >= short) out.push(bl[i]); });
  }
  return out;
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(deg) {
  const r = new Array(deg - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

class Grid {
  constructor(v) {
    this.v = v;
    this.n = v * 4 + 17;
    this.m = Array.from({ length: this.n }, () => new Array(this.n).fill(0));
    this.fn = Array.from({ length: this.n }, () => new Array(this.n).fill(false));
  }
  set(x, y, dark) { this.m[y][x] = dark ? 1 : 0; this.fn[y][x] = true; }
  functionPatterns(ecl) {
    const n = this.n;
    for (let i = 0; i < n; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) this.set(x, y, d !== 2 && d !== 4);
      }
    }
    const al = this.alignment();
    al.forEach((a, i) => al.forEach((c, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(a + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    this.format(ecl, 0);
    if (this.v >= 7) {
      let rem = this.v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.v << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = (bits >>> i) & 1, a = n - 11 + i % 3, b2 = Math.floor(i / 3);
        this.set(a, b2, dark); this.set(b2, a, dark);
      }
    }
  }
  alignment() {
    if (this.v === 1) return [];
    const num = Math.floor(this.v / 7) + 2;
    const step = Math.floor((this.v * 8 + num * 3 + 5) / (num * 4 - 4)) * 2;
    const r = [6];
    for (let pos = this.n - 7; r.length < num; pos -= step) r.splice(1, 0, pos);
    return r;
  }
  format(ecl, mask) {
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = i => (bits >>> i) & 1, n = this.n;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true);
  }
  codewords(data) {
    let i = 0;
    const n = this.n;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
          if (!this.fn[y][x] && i < data.length * 8) { this.m[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1; i++; }
        }
      }
    }
  }
  mask(k) {
    const f = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
    ][k];
    for (let y = 0; y < this.n; y++) for (let x = 0; x < this.n; x++) if (!this.fn[y][x] && f(x, y)) this.m[y][x] ^= 1;
  }
  penalty() {
    const n = this.n, m = this.m;
    let score = 0;
    // N1: a run of five or more modules of one colour, 3 plus 1 a module over five
    const lines = (get) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) { run++; continue; }
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    };
    lines((y, x) => m[y][x]);
    lines((x, y) => m[y][x]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
    let dark = 0;
    for (const r of m) for (const c of r) dark += c;
    const total = n * n;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}
