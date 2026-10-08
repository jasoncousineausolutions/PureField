/**
 * Purefield / core / imb.js
 *
 * The USPS Intelligent Mail barcode (USPS-B-3200): a 20-digit tracking code
 * and a routing code of 0, 5, 9 or 11 digits ("tracking-routing" or the
 * 20 to 31 digits run together) as 65 bars of four states. The two values
 * become one number; an 11-bit CRC checks it; it is split into ten
 * codewords (one base 636, nine base 1365), each a 13-bit character of five
 * or two bits set (Appendix D tables I and II, generated as the
 * specification's InitializeNof13Table does), inverted where the CRC has a
 * 1, and the 130 bits are spread over the bars by Appendix D table IV.
 *
 * Table IV as zint has it (backend/imail.c; BSD-3-Clause, Copyright (C)
 * 2008-2025 Robin Stuart), from the USPS specification.
 *
 *   encodeImb(text, env) → { kind: 'bars', bars: 65 of 'F' | 'A' | 'D' | 'T' } | null
 */

const BAR_MAP = [
  67, 6, 78, 16, 86, 95, 34, 40, 45, 113, 117, 121, 62, 87, 18, 104, 41, 76, 57, 119,
  115, 72, 97, 2, 127, 26, 105, 35, 122, 52, 114, 7, 24, 82, 68, 63, 94, 44, 77, 112,
  70, 100, 39, 30, 107, 15, 125, 85, 10, 65, 54, 88, 20, 106, 46, 66, 8, 116, 29, 61,
  99, 80, 90, 37, 123, 51, 25, 84, 129, 56, 4, 109, 96, 28, 36, 47, 11, 71, 33, 102,
  21, 9, 17, 49, 124, 79, 64, 91, 42, 69, 53, 60, 14, 1, 27, 103, 126, 75, 89, 50,
  120, 19, 32, 110, 92, 111, 130, 59, 31, 12, 81, 43, 55, 5, 74, 22, 101, 128, 58, 118,
  48, 108, 38, 98, 93, 23, 83, 13, 73, 3,
];

// The 13-bit characters with n bits set: each with its bit reversal beside
// it, from the front; the symmetric ones from the back
function nOf13(n, length) {
  const table = new Array(length);
  let lower = 0, upper = length - 1;
  for (let count = 0; count < 8192; count++) {
    let bits = 0;
    for (let b = count; b; b >>= 1) bits += b & 1;
    if (bits !== n) continue;
    let rev = 0;
    for (let b = 0; b < 13; b++) if (count & (1 << b)) rev |= 1 << (12 - b);
    if (rev < count) continue;
    if (rev === count) table[upper--] = count;
    else { table[lower++] = count; table[lower++] = rev; }
  }
  return table;
}
let TABLE_I = null, TABLE_II = null;

// CRC-11 (generator 0xF35) over the 102 bits of the 13-byte big-endian value
function crc11(bytes) {
  let fcs = 0x7FF;
  let data = bytes[0] << 5;
  for (let bit = 2; bit < 8; bit++) {
    fcs = ((fcs ^ data) & 0x400) ? ((fcs << 1) ^ 0xF35) : (fcs << 1);
    fcs &= 0x7FF;
    data <<= 1;
  }
  for (let i = 1; i < 13; i++) {
    data = bytes[i] << 3;
    for (let bit = 0; bit < 8; bit++) {
      fcs = ((fcs ^ data) & 0x400) ? ((fcs << 1) ^ 0xF35) : (fcs << 1);
      fcs &= 0x7FF;
      data <<= 1;
    }
  }
  return fcs;
}

export function encodeImb(text, env) {
  const s = String(text).replace(/\s+/g, '');
  let tracker, zip;
  if (s.includes('-')) [tracker, zip = ''] = s.split('-');
  else { tracker = s.slice(0, 20); zip = s.slice(20); }
  if (!/^\d{20}$/.test(tracker) || tracker[1] > '4' || !/^(\d{5}|\d{9}|\d{11})?$/.test(zip)) {
    env.log('XFA_BARCODE_DATA', 'Intelligent Mail takes a 20-digit tracking code (second digit 0–4) and a 0, 5, 9 or 11-digit routing code');
    return null;
  }
  TABLE_I ??= nOf13(5, 1287);
  TABLE_II ??= nOf13(2, 78);
  // the routing and tracking codes as one number
  let v = zip ? BigInt(zip) : 0n;
  if (zip.length === 11) v += 1000100001n;
  else if (zip.length === 9) v += 100001n;
  else if (zip.length === 5) v += 1n;
  v = v * 10n + BigInt(tracker[0]);
  v = v * 5n + BigInt(tracker[1]);
  for (let i = 2; i < 20; i++) v = v * 10n + BigInt(tracker[i]);
  // its CRC, over 102 bits in 13 bytes
  const bytes = new Array(13);
  let t = v & ((1n << 102n) - 1n);
  for (let i = 12; i >= 0; i--) { bytes[i] = Number(t & 0xFFn); t >>= 8n; }
  const crc = crc11(bytes);
  // codewords: J base 636, I to B base 1365, A what is left
  const cw = new Array(10);
  cw[9] = Number(v % 636n); v /= 636n;
  for (let j = 8; j > 0; j--) { cw[j] = Number(v % 1365n); v /= 1365n; }
  cw[0] = Number(v);
  cw[9] *= 2;
  if (crc >= 1024) cw[0] += 659;
  const chars = cw.map((c, i) => {
    const ch = c < 1287 ? TABLE_I[c] : TABLE_II[c - 1287];
    return crc & (1 << i) ? 0x1FFF - ch : ch;
  });
  // bars: the first 65 bits are descenders, the next 65 ascenders
  const map = new Array(130);
  for (let i = 0; i < 10; i++) for (let j = 0; j < 13; j++) map[BAR_MAP[13 * i + j] - 1] = (chars[i] >> j) & 1;
  const bars = [];
  for (let i = 0; i < 65; i++) {
    const down = map[i] === 1, up = map[i + 65] === 1;
    bars.push(up && down ? 'F' : up ? 'A' : down ? 'D' : 'T');
  }
  return { kind: 'bars', bars, text: '' };
}
