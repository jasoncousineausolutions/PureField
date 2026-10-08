/**
 * Purefield / core / barcode1d.js
 *
 * The other linear symbologies of XFA <barcode> fields (core/barcode.js
 * has Code 39 and Code 128): their published tables and check digits.
 *
 *   Codabar               start/stop A–D (startChar/endChar), optional mod 16
 *   2 of 5 interleaved    digit pairs, a leading 0 for an odd count, mod 10
 *   2 of 5 industrial     (also "standard"): five bars a digit
 *   2 of 5 matrix         bars and spaces, a narrow space between digits
 *   Code 93               two check characters (C, K)
 *   Code 11               C, and K from ten digits on
 *   MSI                   (also Plessey here) mod 10 (Luhn)
 *   EAN-13, EAN-8,        guard bars, parity patterns, check digit
 *   UPC-A, UPC-E
 *   POSTNET               (US: 5-digit, ZIP+4, delivery point) tall and
 *                         short bars, mod 10
 *   RM4SCC                (Royal Mail 4-state customer code) ascenders,
 *                         descenders, trackers, row/column check
 *
 * Linear symbols are element widths in narrow units, bars first; the postal
 * ones are kind 'bars': one equal bar per state, F full, A ascender, D
 * descender, T tracker (POSTNET: F tall, T short).
 */

const narrowWide = (pattern, ratio) => [...pattern].map(e => (e === 'w' || e === '1' ? ratio : 1));

// ---------------------------------------------------------------------------
// Codabar: 7 elements a character, bar first; a set bit is a wide element
const CODABAR_CHARS = '0123456789-$:/.+ABCD';
const CODABAR = [0x003, 0x006, 0x009, 0x060, 0x012, 0x042, 0x021, 0x024, 0x030, 0x048,
  0x00C, 0x018, 0x045, 0x051, 0x054, 0x015, 0x01A, 0x029, 0x00B, 0x00E];

export function codabar(text, b, ratio, env) {
  const start = /^[ABCD]$/i.test(b.startChar ?? '') ? b.startChar.toUpperCase() : 'A';
  const stop = /^[ABCD]$/i.test(b.endChar ?? '') ? b.endChar.toUpperCase() : 'A';
  let body = '';
  for (const ch of text.toUpperCase()) {
    if ('0123456789-$:/.+'.includes(ch)) body += ch;
    else env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in Codabar; skipped`);
  }
  if (!body) return null;
  let check = '';
  if (b.checksum === '1mod16' || b.checksum === 'auto') {
    let sum = CODABAR_CHARS.indexOf(start) + CODABAR_CHARS.indexOf(stop);
    for (const ch of body) sum += CODABAR_CHARS.indexOf(ch);
    check = CODABAR_CHARS[(16 - (sum % 16)) % 16];
  }
  const elements = [];
  [...`${start}${body}${check}${stop}`].forEach((ch, i) => {
    if (i) elements.push(1);
    const bits = CODABAR[CODABAR_CHARS.indexOf(ch)];
    for (let k = 6; k >= 0; k--) elements.push((bits >> k) & 1 ? ratio : 1);
  });
  return { kind: '1d', elements, text: body + (b.printCheckDigit ? check : '') };
}

// ---------------------------------------------------------------------------
// 2 of 5: five elements a digit, two wide
const TWO_OF_FIVE = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];

// mod 10 with weights 3 and 1 from the right (2 of 5, EAN/UPC)
function mod10(digits) {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => { sum += Number(d) * (i % 2 ? 1 : 3); });
  return String((10 - (sum % 10)) % 10);
}

const digitsOnly = (text, name, env) => {
  let out = '';
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') out += ch;
    else env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in ${name}; skipped`);
  }
  return out;
};

export function interleaved2of5(text, b, ratio, env) {
  let digits = digitsOnly(text, '2 of 5', env);
  if (!digits) return null;
  const check = b.checksum === '1mod10' || b.checksum === 'auto' ? mod10(digits) : '';
  digits += check;
  if (digits.length % 2) digits = `0${digits}`;
  const elements = [1, 1, 1, 1];
  for (let i = 0; i < digits.length; i += 2) {
    const bars = TWO_OF_FIVE[digits[i]], spaces = TWO_OF_FIVE[digits[i + 1]];
    for (let k = 0; k < 5; k++) elements.push(bars[k] === 'w' ? ratio : 1, spaces[k] === 'w' ? ratio : 1);
  }
  elements.push(ratio, 1, 1);
  return { kind: '1d', elements, text: text + (b.printCheckDigit ? check : '') };
}

export function industrial2of5(text, b, ratio, env) {
  let digits = digitsOnly(text, '2 of 5', env);
  if (!digits) return null;
  const check = b.checksum === '1mod10' || b.checksum === 'auto' ? mod10(digits) : '';
  digits += check;
  // bars only, narrow spaces: start wide wide narrow, stop wide narrow wide
  const bars = ['wwn', ...[...digits].map(d => TWO_OF_FIVE[d]), 'wnw'].join('');
  const elements = [];
  [...bars].forEach((e, i) => { if (i) elements.push(1); elements.push(e === 'w' ? ratio : 1); });
  return { kind: '1d', elements, text: text + (b.printCheckDigit ? check : '') };
}

// Matrix: the five elements of a digit are bar, space, bar, space, bar, and
// a narrow space follows; start and stop open with a bar one module wider
// than a wide one (zint's 4X at 3:1; BWIPP's is 3X)
export function matrix2of5(text, b, ratio, env) {
  let digits = digitsOnly(text, '2 of 5', env);
  if (!digits) return null;
  const check = b.checksum === '1mod10' || b.checksum === 'auto' ? mod10(digits) : '';
  digits += check;
  const elements = [ratio + 1, 1, 1, 1, 1, 1];
  for (const d of digits) elements.push(...narrowWide(TWO_OF_FIVE[d], ratio), 1);
  elements.push(ratio + 1, 1, 1, 1, 1);
  return { kind: '1d', elements, text: text + (b.printCheckDigit ? check : '') };
}

// ---------------------------------------------------------------------------
// Code 93: nine modules a character, bar first
const C93_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%abcd*';
const C93 = [0x114, 0x148, 0x144, 0x142, 0x128, 0x124, 0x122, 0x150, 0x112, 0x10A,
  0x1A8, 0x1A4, 0x1A2, 0x194, 0x192, 0x18A, 0x168, 0x164, 0x162, 0x134,
  0x11A, 0x158, 0x14C, 0x146, 0x12C, 0x116, 0x1B4, 0x1B2, 0x1AC, 0x1A6,
  0x196, 0x19A, 0x16C, 0x166, 0x136, 0x13A,
  0x12E, 0x1D4, 0x1D2, 0x1CA, 0x16E, 0x176, 0x1AE,
  0x126, 0x1DA, 0x1D6, 0x132, 0x15E];

export function code93(text, b, env) {
  let body = '';
  for (const ch of text.toUpperCase()) {
    if (C93_CHARS.indexOf(ch) >= 0 && ch !== '*' && !/[a-d]/.test(ch)) body += ch;
    else env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in Code 93; skipped`);
  }
  if (!body) return null;
  const check = (s, max) => {
    let sum = 0;
    [...s].reverse().forEach((ch, i) => { sum += C93_CHARS.indexOf(ch) * ((i % max) + 1); });
    return C93_CHARS[sum % 47];
  };
  const c = check(body, 20);
  const k = check(body + c, 15);
  const modules = [];
  for (const ch of `*${body}${c}${k}*`) {
    const bits = C93[C93_CHARS.indexOf(ch)];
    for (let i = 8; i >= 0; i--) modules.push((bits >> i) & 1);
  }
  modules.push(1); // the termination bar
  return { kind: '1d', elements: runs(modules), text };
}

// modules (1 bar, 0 space), from a bar, → element widths
function runs(modules) {
  const out = [];
  let cur = modules[0], n = 0;
  for (const m of modules) {
    if (m === cur) n++;
    else { out.push(n); cur = m; n = 1; }
  }
  out.push(n);
  return out;
}

// ---------------------------------------------------------------------------
// Code 11: five elements a character
const C11_CHARS = '0123456789-';
const C11 = ['nnnnw', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'wnnnn', 'nnwnn'];
const C11_START = 'nnwwn';

export function code11(text, b, ratio, env) {
  let body = '';
  for (const ch of text) {
    if (C11_CHARS.includes(ch)) body += ch;
    else env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in Code 11; skipped`);
  }
  if (!body) return null;
  const weigh = (s, max) => {
    let sum = 0;
    [...s].reverse().forEach((ch, i) => { sum += C11_CHARS.indexOf(ch) * ((i % max) + 1); });
    return C11_CHARS[sum % 11];
  };
  let check = '';
  if (b.checksum !== 'none') {
    check = weigh(body, 10);
    if (body.length >= 10) check += weigh(body + check, 9);
  }
  const elements = [];
  [C11_START, ...[...body + check].map(ch => C11[C11_CHARS.indexOf(ch)]), C11_START].forEach((p, i) => {
    if (i) elements.push(1);
    elements.push(...narrowWide(p, ratio));
  });
  return { kind: '1d', elements, text: text + (b.printCheckDigit ? check : '') };
}

// ---------------------------------------------------------------------------
// MSI: four bits a digit, a 0 bit narrow bar wide space, a 1 bit the reverse
export function msi(text, b, ratio, env) {
  let digits = digitsOnly(text, 'MSI', env);
  if (!digits) return null;
  let check = '';
  if (b.checksum !== 'none') {
    // Luhn: every other digit from the right doubled
    let sum = 0;
    [...digits].reverse().forEach((d, i) => {
      let v = Number(d);
      if (i % 2 === 0) { v *= 2; if (v > 9) v -= 9; }
      sum += v;
    });
    check = String((10 - (sum % 10)) % 10);
  }
  const elements = [ratio, 1];
  for (const d of digits + check) {
    for (let k = 3; k >= 0; k--) elements.push(...((Number(d) >> k) & 1 ? [ratio, 1] : [1, ratio]));
  }
  elements.push(1, ratio, 1);
  return { kind: '1d', elements, text: text + (b.printCheckDigit ? check : '') };
}

// ---------------------------------------------------------------------------
// EAN / UPC: L (odd parity) codes, space first; G codes reversed; R codes bar first
const EAN_L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'];
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const UPCE_PARITY = ['GGGLLL', 'GGLGLL', 'GGLLGL', 'GGLLLG', 'GLGGLL', 'GLLGGL', 'GLLLGG', 'GLGLGL', 'GLGLLG', 'GLLGLG'];
const code = (d, set) => [...(set === 'G' ? [...EAN_L[d]].reverse().join('') : EAN_L[d])].map(Number);

export function ean(text, kind, env) {
  let digits = digitsOnly(text, kind.toUpperCase(), env);
  const len = { ean13: 12, upca: 11, ean8: 7 }[kind];
  if (digits.length < len) { env.log('XFA_BARCODE_DATA', `${kind.toUpperCase()} takes ${len} digits; padded with zeros`); digits = digits.padStart(len, '0'); }
  digits = digits.slice(0, len);
  if (kind === 'upca') digits = `0${digits}`;
  digits += mod10(digits);
  const elements = [1, 1, 1];
  if (digits.length === 13) {
    const parity = EAN13_PARITY[digits[0]];
    for (let i = 1; i <= 6; i++) elements.push(...code(digits[i], parity[i - 1]));
    elements.push(1, 1, 1, 1, 1);
    for (let i = 7; i <= 12; i++) elements.push(...code(digits[i], 'L'));
  } else {
    for (let i = 0; i < 4; i++) elements.push(...code(digits[i], 'L'));
    elements.push(1, 1, 1, 1, 1);
    for (let i = 4; i < 8; i++) elements.push(...code(digits[i], 'L'));
  }
  elements.push(1, 1, 1);
  return { kind: '1d', elements, text: kind === 'upca' ? digits.slice(1) : digits };
}

/** UPC-E: six digits (number system 0), else a UPC-A that compresses */
export function upce(text, env) {
  let d = digitsOnly(text, 'UPC-E', env);
  if (d.length === 6) d = `0${d}`;
  if (d.length === 8) d = d.slice(0, 7);
  if (d.length !== 7 || (d[0] !== '0' && d[0] !== '1')) {
    env.log('XFA_BARCODE_DATA', 'UPC-E takes six digits (or seven with number system 0 or 1)');
    return null;
  }
  const six = d.slice(1);
  // the UPC-A it stands for gives the check digit
  const last = six[5];
  const upcA = last <= '2' ? `${d[0]}${six.slice(0, 2)}${last}0000${six.slice(2, 5)}`
    : last === '3' ? `${d[0]}${six.slice(0, 3)}00000${six.slice(3, 5)}`
      : last === '4' ? `${d[0]}${six.slice(0, 4)}00000${six[4]}`
        : `${d[0]}${six.slice(0, 5)}0000${last}`;
  const check = mod10(upcA);
  let parity = UPCE_PARITY[check];
  if (d[0] === '1') parity = [...parity].map(p => (p === 'G' ? 'L' : 'G')).join('');
  const elements = [1, 1, 1];
  for (let i = 0; i < 6; i++) elements.push(...code(six[i], parity[i]));
  elements.push(1, 1, 1, 1, 1, 1);
  return { kind: '1d', elements, text: `${d}${check}` };
}

// EAN-2 and EAN-5 add-ons (ISO/IEC 15420 Annex, GS1 5.2.2.5): start 112,
// the digits in L or G codes by a parity pattern (the value mod 4; the
// digits weighted 3 and 9, mod 10), a 11 separator between them
const ADDON2_PARITY = ['LL', 'LG', 'GL', 'GG'];
const ADDON5_PARITY = ['GGLLL', 'GLGLL', 'GLLGL', 'GLLLG', 'LGGLL', 'LLGGL', 'LLLGG', 'LGLGL', 'LGLLG', 'LLGLG'];

function addOnElements(digits) {
  const v = [...digits].map(Number);
  const parity = v.length === 2 ? ADDON2_PARITY[(10 * v[0] + v[1]) % 4]
    : ADDON5_PARITY[(3 * (v[0] + v[2] + v[4]) + 9 * (v[1] + v[3])) % 10];
  const elements = [1, 1, 2];
  v.forEach((d, i) => { if (i) elements.push(1, 1); elements.push(...code(d, parity[i])); });
  return elements;
}

/** A bare EAN-2 or EAN-5 add-on (upcean2, upcean5) */
export function eanAddOn(text, n, env) {
  let d = digitsOnly(text, `EAN-${n}`, env);
  if (!d) return null;
  if (d.length !== n) env.log('XFA_BARCODE_DATA', `EAN-${n} takes ${n} digits, got ${d.length}`);
  d = d.slice(-n).padStart(n, '0');
  return { kind: '1d', elements: addOnElements(d), text: d };
}

/**
 * EAN-13, EAN-8, UPC-A or UPC-E with an n-digit add-on: the main symbol's
 * digits then the add-on's ("+" or a space may part them; else the last n
 * digits are the add-on), the add-on after a gap of 9 modules from UPC-A,
 * 7 from the others (zint's defaults; GS1 allows 7 to 12). addOn.at is the
 * add-on's first element.
 */
export function eanWithAddOn(text, kind, n, env) {
  const parts = text.split(/[+ ]/);
  let main, add;
  if (parts.length === 2) { main = parts[0]; add = digitsOnly(parts[1], `EAN-${n}`, env); }
  else { const d = digitsOnly(text, kind.toUpperCase(), env); main = d.slice(0, Math.max(0, d.length - n)); add = d.slice(-n); }
  if (add.length !== n) {
    env.log('XFA_BARCODE_DATA', `the add-on takes ${n} digits, got ${add.length}`);
    add = add.slice(-n).padStart(n, '0');
  }
  const sym = kind === 'upce' ? upce(main, env) : ean(main, kind, env);
  if (!sym) return null;
  const at = sym.elements.length + 1;
  return { kind: '1d', elements: [...sym.elements, kind === 'upca' ? 9 : 7, ...addOnElements(add)], text: sym.text, addOn: { at, text: add } };
}

// ---------------------------------------------------------------------------
// POSTNET: five bars a digit, two tall; tall frame bars at both ends
const POSTNET = ['11000', '00011', '00101', '00110', '01001', '01010', '01100', '10001', '10010', '10100'];

export function postnet(text, kind, env) {
  let d = digitsOnly(text, 'POSTNET', env);
  const want = { postus5zip: 5, postusstandard: 9, postusdpbc: 11 }[kind];
  if (want && d.length !== want && !(kind === 'postusstandard' && (d.length === 5 || d.length === 11))) {
    env.log('XFA_BARCODE_DATA', `POSTNET takes ${want} digits here, got ${d.length}`);
  }
  if (!d) return null;
  let sum = 0;
  for (const ch of d) sum += Number(ch);
  d += String((10 - (sum % 10)) % 10);
  const bars = ['F'];
  for (const ch of d) for (const bit of POSTNET[ch]) bars.push(bit === '1' ? 'F' : 'T');
  bars.push('F');
  return { kind: 'bars', bars, text: '' };
}

// ---------------------------------------------------------------------------
// RM4SCC: 36 characters on a 6 × 6 grid; a character's row gives its
// ascenders, its column its descenders
const RM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const RM_SETS = ['0011', '0101', '0110', '1001', '1010', '1100'];

export function rm4scc(text, env) {
  let body = '';
  for (const ch of text.toUpperCase()) {
    if (RM_CHARS.includes(ch)) body += ch;
    else env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in RM4SCC; skipped`);
  }
  if (!body) return null;
  let rows = 0, cols = 0;
  for (const ch of body) { const i = RM_CHARS.indexOf(ch); rows += Math.floor(i / 6) + 1; cols += (i % 6) + 1; }
  const r = rows % 6 || 6, c = cols % 6 || 6;
  const check = RM_CHARS[(r - 1) * 6 + (c - 1)];
  const bars = ['A'];
  for (const ch of body + check) {
    const i = RM_CHARS.indexOf(ch);
    const up = RM_SETS[Math.floor(i / 6)], down = RM_SETS[i % 6];
    for (let k = 0; k < 4; k++) bars.push(up[k] === '1' ? (down[k] === '1' ? 'F' : 'A') : (down[k] === '1' ? 'D' : 'T'));
  }
  bars.push('F');
  return { kind: 'bars', bars, text: '' };
}
