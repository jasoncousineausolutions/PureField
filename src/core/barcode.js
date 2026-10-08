/**
 * Purefield / core / barcode.js
 *
 * Barcode symbols for XFA <barcode> fields (xfa/paint.js), with no
 * dependency: the symbology's own tables and rules, so the printed symbol is
 * the one Acrobat prints for the same field.
 *
 *   1D   Code 39 (and its full-ASCII extension, and LOGMARS), Code 128
 *        (A, B, C, the automatic choice, and UCC/EAN-128 with FNC1); the
 *        others in barcode1d.js: Codabar, 2 of 5 (interleaved, industrial,
 *        matrix), Code 93, Code 11, MSI, EAN-8, EAN-13, UPC-A, UPC-E (and
 *        their 2 and 5-digit add-ons), and the POSTNET and RM4SCC postal
 *        bars; Intelligent Mail (imb.js), Australia Post (auspost.js);
 *        GS1 DataBar (RSS), linear and stacked (databar.js)
 *   2D   PDF417 (pdf417.js), QR Code (qr.js), Data Matrix ECC 200
 *        (datamatrix.js), MaxiCode (maxicode.js), Aztec Code (aztec.js)
 *
 * A 1D symbol is a list of element widths in narrow-module units, bars and
 * spaces alternating from a bar; a 2D symbol is a grid of rows of 0/1
 * modules (1 dark). Neither carries a quiet zone: the painter places it.
 */

import { encodePdf417 } from './pdf417.js';
import { encodeQr } from './qr.js';
import { encodeDataMatrix } from './datamatrix.js';
import { encodeMaxiCode } from './maxicode.js';
import { encodeAztec } from './aztec.js';
import { encodeImb } from './imb.js';
import { encodeAusPost } from './auspost.js';
import { encodeDataBar } from './databar.js';
import { codabar, interleaved2of5, industrial2of5, matrix2of5, code93, code11, msi, ean, upce, eanAddOn, eanWithAddOn, postnet, rm4scc } from './barcode1d.js';

/**
 * @typedef {{ kind: '1d', elements: number[], text: string, addOn?: { at: number, text: string } }
 *         | { kind: '2d', modules: Uint8Array[], rowHeight?: number, stacked?: boolean }
 *         | { kind: 'stacked', modules: Uint8Array[], heights: number[] }} Symbol
 *   addOn (EAN/UPC): the add-on's first element and its digits, printed
 *   above it; rowHeight (PDF417): rows are this many modules high at
 *   least; stacked: rows stretch to the height they are given. A 1D
 *   symbol opening with a space has a zero-width bar first. Kind 'stacked'
 *   (DataBar Stacked) is rows of modules and their nominal heights.
 */

/**
 * The symbol for one barcode field, or null (with the reason logged) when the
 * type is not supported or nothing can be encoded.
 * @param {string} type - the <barcode> type, any case
 * @param {{ text: string, bytes: Uint8Array }} payload
 * @param {object} b - the ui.barcode attributes (xfa/model.js)
 * @param {{ log: (code: string, msg: string) => void }} env
 * @returns {Symbol|null}
 */
export function encodeBarcode(type, payload, b, env) {
  switch (type.toLowerCase()) {
    case 'code3of9': return code39(payload.text, b, false, env);
    case 'code3of9extended': return code39(payload.text, b, true, env);
    case 'code128': return code128(payload.text, 'auto', false, env);
    case 'code128a': return code128(payload.text, 'A', false, env);
    case 'code128b': return code128(payload.text, 'B', false, env);
    case 'code128c': return code128(payload.text, 'C', false, env);
    case 'ucc128': case 'ucc128sscc': return code128(payload.text, 'auto', true, env);
    case 'pdf417': return encodePdf417(payload, b, env);
    case 'qrcode': return encodeQr(payload, b, env);
    case 'datamatrix': return encodeDataMatrix(payload, env);
    case 'logmars': return code39(payload.text, { ...b, checksum: b.checksum === 'none' ? 'none' : 'auto' }, false, env);
    case 'codabar': return codabar(payload.text, b, wideNarrow(b.wideNarrowRatio), env);
    case 'code2of5interleaved': return interleaved2of5(payload.text, b, wideNarrow(b.wideNarrowRatio), env);
    case 'code2of5industrial': case 'code2of5standard': return industrial2of5(payload.text, b, wideNarrow(b.wideNarrowRatio), env);
    case 'code2of5matrix': return matrix2of5(payload.text, b, wideNarrow(b.wideNarrowRatio), env);
    case 'code93': return code93(payload.text, b, env);
    case 'code11': return code11(payload.text, b, wideNarrow(b.wideNarrowRatio), env);
    case 'msi': case 'plessey': return msi(payload.text, b, 2, env);
    case 'ean13': case 'ean8': case 'upca': return ean(payload.text, type.toLowerCase(), env);
    case 'upce': return upce(payload.text, env);
    case 'ean13add2': case 'ean13add5': case 'ean8add2': case 'ean8add5':
    case 'upcaadd2': case 'upcaadd5': case 'upceadd2': case 'upceadd5': {
      const t = type.toLowerCase();
      return eanWithAddOn(payload.text, t.slice(0, -4), Number(t.at(-1)), env);
    }
    case 'upcean2': case 'upcean5': return eanAddOn(payload.text, Number(type.at(-1)), env);
    case 'postusstandard': case 'postus5zip': case 'postusdpbc': return postnet(payload.text, type.toLowerCase(), env);
    case 'postukrm4scc': return rm4scc(payload.text, env);
    case 'postusimb': return encodeImb(payload.text, env);
    case 'postausstandard': case 'postausreplypaid': case 'postauscust2': case 'postauscust3': return encodeAusPost(payload.text, type, env);
    case 'maxicode': return encodeMaxiCode(payload, env);
    case 'aztec': return encodeAztec(payload, b, env);
    case 'rss14': case 'rss14truncated': case 'rss14stacked': case 'rss14stackedomni': case 'rss14limited': case 'rss14expanded':
      return encodeDataBar(payload.text, type, env);
    default:
      env.log('XFA_BARCODE_UNSUPPORTED', `barcode type "${type}" is not drawn`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// Code 39
// ---------------------------------------------------------------------------

// nine elements, bar first: n narrow, w wide
const CODE39 = {
  0: 'nnnwwnwnn', 1: 'wnnwnnnnw', 2: 'nnwwnnnnw', 3: 'wnwwnnnnn', 4: 'nnnwwnnnw', 5: 'wnnwwnnnn',
  6: 'nnwwwnnnn', 7: 'nnnwnnwnw', 8: 'wnnwnnwnn', 9: 'nnwwnnwnn', A: 'wnnnnwnnw', B: 'nnwnnwnnw',
  C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn',
  I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww',
  O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', $: 'nwnwnwnnn', '/': 'nwnwnnnwn', '+': 'nwnnnwnwn',
  '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
};
const CODE39_ORDER = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

// Full ASCII Code 39: each byte as one or two Code 39 characters
const EXTENDED = (() => {
  const t = [];
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    if (c === 0) t.push('%U');
    else if (c < 27) t.push(`$${String.fromCharCode(64 + c)}`);
    else if (c < 32) t.push(`%${'ABCDE'[c - 27]}`);
    else if (c === 32 || c === 45 || c === 46 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90)) t.push(ch);
    else if (c <= 44) t.push(`/${String.fromCharCode(65 + c - 33)}`);
    else if (c === 47) t.push('/O');
    else if (c === 58) t.push('/Z');
    else if (c <= 63) t.push(`%${'FGHIJ'[c - 59]}`);
    else if (c === 64) t.push('%V');
    else if (c <= 95) t.push(`%${'KLMNO'[c - 91]}`);
    else if (c === 96) t.push('%W');
    else if (c <= 122) t.push(`+${String.fromCharCode(c - 32)}`);
    else t.push(`%${'PQRST'[c - 123]}`);
  }
  return t;
})();

function code39(text, b, extended, env) {
  let chars = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (extended && c < 128) chars += EXTENDED[c];
    else if (!extended && CODE39[ch.toUpperCase()] && ch !== '*') chars += ch.toUpperCase();
    else env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in Code 39; skipped`);
  }
  if (!chars) return null;
  let check = '';
  if (b.checksum === 'auto' || b.checksum === '1mod43') {
    let sum = 0;
    for (const ch of chars) sum += CODE39_ORDER.indexOf(ch);
    check = CODE39_ORDER[sum % 43];
  }
  const ratio = wideNarrow(b.wideNarrowRatio);
  const start = CODE39[b.startChar] ? b.startChar : '*';
  const stop = CODE39[b.endChar] ? b.endChar : '*';
  const elements = [];
  [...`${start}${chars}${check}${stop}`].forEach((ch, i) => {
    if (i) elements.push(1); // the gap between characters: one narrow space
    for (const e of CODE39[ch]) elements.push(e === 'w' ? ratio : 1);
  });
  return { kind: '1d', elements, text: text + (b.printCheckDigit ? check : '') };
}

/** "3:1", "3.0" or "2.5" → the wide element in narrow units (2 to 3; default 3) */
export function wideNarrow(v) {
  if (v === null || v === undefined || v === '') return 3;
  const [a, d = '1'] = String(v).split(':');
  const r = Number(a) / Number(d);
  return Number.isFinite(r) && r >= 2 && r <= 3 ? r : 3;
}

// ---------------------------------------------------------------------------
// Code 128
// ---------------------------------------------------------------------------

// six elements per value (stop: seven), widths in modules
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START = { A: 103, B: 104, C: 105 };
const CODE = { A: 101, B: 100, C: 99 }; // latch to the set from the others
const FNC1 = 102, FNC4 = { A: 101, B: 100 }, STOP = 106;

const isDigit = c => c >= 48 && c <= 57;
// a byte's value in set A or B, or -1
function valueIn(set, c) {
  if (set === 'A') return c < 32 ? c + 64 : c < 96 ? c - 32 : -1;
  return c >= 32 && c < 128 ? c - 32 : -1;
}

function code128(text, lock, fnc1, env) {
  const codes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c > 255 || (lock === 'C' && !isDigit(c))) env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in Code 128${lock === 'C' ? ' C' : ''}; skipped`);
    else codes.push(c);
  }
  if (lock === 'C' && codes.length % 2) {
    env.log('XFA_BARCODE_CHAR', 'Code 128 C takes digit pairs; a leading 0 added');
    codes.unshift(48);
  }
  if (!codes.length) return null;
  const n = codes.length;
  const digits = i => { let k = 0; while (i + k < n && isDigit(codes[i + k])) k++; return k; };
  const values = [];
  let set = null;
  const latch = to => {
    values.push(set === null ? START[to] : CODE[to]);
    if (set === null && fnc1) values.push(FNC1);
    set = to;
  };
  let i = 0;
  while (i < n) {
    // set C for digit pairs: four or more digits at the start or the end of
    // the data, six or more between (ISO/IEC 15417 Annex E)
    const run = digits(i);
    const edge = set === null || i + run === n;
    if (lock === 'C' || (lock === 'auto' && run >= 2 && (set === 'C' || run >= (edge ? 4 : 6) || (set === null && run === n && run % 2 === 0)))) {
      if (set !== 'C' && set !== null && run % 2) values.push(valueIn(set, codes[i++])); // the odd digit before the switch
      if (set !== 'C') latch('C');
      while (digits(i) >= 2) { values.push((codes[i] - 48) * 10 + (codes[i + 1] - 48)); i += 2; }
      continue;
    }
    const c = codes[i], low = c & 127;
    const to = lock === 'A' || lock === 'B' ? lock
      : (set === 'A' || set === 'B') && valueIn(set, low) >= 0 ? set
      : valueIn('B', low) >= 0 ? 'B' : 'A';
    if (set !== to) latch(to);
    const v = valueIn(set, low);
    if (v < 0) { env.log('XFA_BARCODE_CHAR', `"${String.fromCharCode(c)}" is not in Code 128 ${set}; skipped`); i++; continue; }
    if (c > 127) values.push(FNC4[set]);
    values.push(v);
    i++;
  }
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += k * values[k];
  values.push(sum % 103, STOP);
  const elements = [];
  for (const v of values) for (const w of C128[v]) elements.push(Number(w));
  return { kind: '1d', elements, text };
}
