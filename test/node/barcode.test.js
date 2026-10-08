// Barcode fields: the symbol encoders and how a <barcode> field prints
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBarcode, wideNarrow } from '../../src/core/barcode.js';
import { errorCodewords } from '../../src/core/pdf417.js';
import { CLUSTERS } from '../../src/core/pdf417table.js';
import { dataMatrixCodewords } from '../../src/core/datamatrix.js';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { buildPdf } from './pdfbuild.js';
import { barcodePayload, compressPayloads } from '../../src/xfa/barcodes.js';
import { inflateSync } from 'node:zlib';

const B = (attrs = {}) => ({ checksum: 'none', errorCorrectionLevel: null, dataColumnCount: null, dataRowCount: null, ...attrs });
const enc = (type, text, attrs, env = {}) => {
  const logs = [];
  const s = encodeBarcode(type, { text, bytes: new TextEncoder().encode(text) }, B(attrs), { log: (c, m) => logs.push(c + ' ' + m), ...env });
  return { s, logs };
};

// Code 39 / Code 128 elements back to characters (narrow units)
const C39 = { '*': 'nwnnwnwnn', A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', 1: 'wnnwnnnnw', 2: 'nnwwnnnnw', 3: 'wnwwnnnnn', U: 'wwnnnnnnw', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', $: 'nwnwnwnnn', '/': 'nwnwnnnwn', '-': 'nwnnnnwnw', ' ': 'nwwnnnwnn', '.': 'wwnnnnwnn', O: 'wnnnwnnwn', N: 'nnnnwnnww' };
function code39Chars(elements, ratio = 3) {
  const out = [];
  for (let i = 0; i < elements.length; i += 10) {
    const p = elements.slice(i, i + 9).map(w => (w === ratio ? 'w' : 'n')).join('');
    out.push(Object.keys(C39).find(k => C39[k] === p) ?? '?');
  }
  return out.join('');
}
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232'];
function code128Values(elements) {
  const out = [];
  for (let i = 0; i + 6 <= elements.length - 7; i += 6) out.push(C128.indexOf(elements.slice(i, i + 6).join('')));
  return out;
}

test('Code 39: start and stop, Mod 43 check character, full ASCII, skipped characters', () => {
  const { s } = enc('code3Of9', 'abc123');
  assert.equal(code39Chars(s.elements), '*ABC123*');
  assert.equal(s.elements.length, 8 * 10 - 1); // nine elements a character, a narrow gap between
  assert.equal(s.text, 'abc123');
  // Mod 43 over the payload: A10 B11 C12 1 2 3 → 39 → "$"
  const chk = enc('code3of9', 'ABC123', { checksum: 'auto', printCheckDigit: true }).s;
  assert.equal(code39Chars(chk.elements), '*ABC123$*');
  assert.equal(chk.text, 'ABC123$');
  assert.equal(enc('code3of9', 'ABC123', { checksum: 'auto' }).s.text, 'ABC123');
  // wide bars at the template's ratio
  assert.ok(enc('code3of9', 'A', { wideNarrowRatio: '2.5:1' }).s.elements.includes(2.5));
  assert.equal(wideNarrow('3.0'), 3);
  assert.equal(wideNarrow(null), 3);
  // extended: "a" is "+A", "/" is "/O"
  assert.equal(code39Chars(enc('code3of9extended', 'a/').s.elements), '*+A/O*');
  const bad = enc('code3of9', 'A#B');
  assert.equal(code39Chars(bad.s.elements), '*AB*');
  assert.match(bad.logs[0], /XFA_BARCODE_CHAR/);
});

test('Code 128: subset B, C for long digit runs, the mod 103 check value', () => {
  // "Test1234": B, then four digits at the end go into C (ISO/IEC 15417 Annex E)
  const v = code128Values(enc('code128', 'Test1234').s.elements);
  assert.deepEqual(v.slice(0, 5), [104, 52, 69, 83, 84]); // start B, T e s t
  assert.deepEqual(v.slice(5, 8), [99, 12, 34]);          // code C, 12, 34
  let sum = v[0];
  for (let i = 1; i < v.length - 1; i++) sum += i * v[i];
  assert.equal(v.at(-1), sum % 103);
  // a short digit run in the middle stays in B
  assert.deepEqual(code128Values(enc('code128', 'A12B').s.elements).slice(0, 5), [104, 33, 17, 18, 34]);
  // starting with digits: start C
  assert.equal(code128Values(enc('code128', '123456').s.elements)[0], 105);
  // UCC/EAN-128: FNC1 after the start code
  assert.equal(code128Values(enc('ucc128', '0012345678').s.elements)[1], 102);
  // the stop pattern: seven elements, 13 modules
  const el = enc('code128', 'X').s.elements;
  assert.deepEqual(el.slice(-7), [2, 3, 3, 1, 1, 1, 2]);
});

test('PDF417: Reed-Solomon generators, and the symbol Acrobat prints for "1234567890"', () => {
  // the 64 error codewords of Reader's print for the 13 data codewords below
  const data = [13, 900, 841, 63, 125, 187, 249, 29, 900, 900, 900, 900, 900];
  assert.deepEqual(errorCodewords(data, 64).slice(0, 8), [480, 462, 359, 166, 722, 880, 253, 760]);
  assert.deepEqual(errorCodewords(data, 64).slice(-3), [165, 712, 109]);

  // pdfium-barcodes: a 66.7 × 25.4 mm field, 0.0133in modules, level 5:
  // 7 columns, 11 rows, opening with a text latch (as Reader's print reads)
  const { s } = enc('pdf417', '1234567890', { errorCorrectionLevel: 5 }, { box: { w: 189.36, h: 72 }, moduleWidth: 0.9576 });
  assert.equal(s.modules.length, 11);
  assert.equal(s.modules[0].length, 17 * (7 + 4) + 1);
  const inv = CLUSTERS.map(t => new Map(t.map((v, i) => [v.toString(2), i])));
  const row = r => {
    const bits = Array.from(s.modules[r]).join('');
    return Array.from({ length: 9 }, (_, i) => inv[r % 3].get(bits.slice(17 + 17 * i, 34 + 17 * i)));
  };
  assert.deepEqual(row(0), [3, 13, 900, 841, 63, 125, 187, 249, 6]);
  assert.deepEqual(row(1), [16, 29, 900, 900, 900, 900, 900, 480, 3]);
  assert.deepEqual(row(10), [106, 230, 709, 198, 450, 165, 712, 109, 93]);
  // template columns and truncation
  const t = enc('pdf417', 'ABCDEFG', { errorCorrectionLevel: 2, dataColumnCount: 3, truncate: true }).s;
  assert.equal(t.modules[0].length, 17 + 17 + 3 * 17 + 1);
});

test('QR Code: the version, level and mask Acrobat prints for "1234567890"', () => {
  // pdfium-barcodes' QR field (errorCorrectionLevel 1 = M), read off Reader's print
  const reader = [
    '111111101010101111111', '100000101101101000001', '101110100100101011101', '101110101001001011101',
    '101110100111001011101', '100000100111101000001', '111111101010101111111', '000000001001100000000',
    '101101110111101001011', '001110001011111001111', '001100111011000000100', '100101000111001110001',
    '101100101110100100010', '000000001011001001001', '111111101011100101111', '100000101100000110101',
    '101110100000111110001', '101110101101001011010', '101110101110101101100', '100000100000010001011',
    '111111101110010010010',
  ];
  const { s } = enc('QRCode', '1234567890', { errorCorrectionLevel: 1 });
  assert.deepEqual(s.modules.map(r => Array.from(r).join('')), reader);
  // byte mode for other text; larger versions
  assert.equal(enc('qrcode', 'https://example.com/über?x=1', { errorCorrectionLevel: 3 }).s.modules.length, 33);
});

test('Data Matrix ECC 200: the ISO example codewords and the finder pattern', () => {
  assert.deepEqual(dataMatrixCodewords(new TextEncoder().encode('123456')).cw, [142, 164, 186, 114, 25, 5, 88, 102]);
  const { s } = enc('dataMatrix', 'ABC123');
  const m = s.modules.map(r => Array.from(r).join(''));
  assert.equal(m.length, 12);
  assert.equal(m[11], '1'.repeat(12));                // solid bottom
  assert.ok(m.every(r => r[0] === '1'));              // solid left
  assert.equal(m[0], '101010101010');                 // clock track
});

test('unknown and unsupported types print nothing and are logged', () => {
  const { s, logs } = enc('code49', '123');
  assert.equal(s, null);
  assert.match(logs[0], /XFA_BARCODE_UNSUPPORTED/);
});

// --- printing ---

const latin1 = u8 => new TextDecoder('latin1').decode(u8);
async function pageContent(pdf) {
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const kids = (await doc.getObject(cat.Pages.num)).value.value.Kids.value;
  const page = (await doc.getObject(kids[0].num)).value.value;
  const refs = page.Contents.type === 'array' ? page.Contents.value : [page.Contents];
  let content = '';
  for (const r of refs) content += latin1((await doc.getObject(r.num)).streamBytes) + '\n';
  return content;
}

function xfaForm(fields, { scriptsAfter = '' } = {}) {
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="position">
    <pageSet><pageArea name="P1"><contentArea x="0" y="0" w="300pt" h="300pt"/><medium short="300pt" long="300pt"/></pageArea></pageSet>
    <subform name="page1" w="300pt" h="300pt">${fields}</subform>${scriptsAfter}</subform></template>`;
  return buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm << /Fields [] /XFA [(template) 6 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>',
    6: { dict: '<< >>', stream: template },
  });
}
const field = (ui, value, extra = '') => `<field name="bc" x="10pt" y="10pt" w="180pt" h="40pt">
  <ui><barcode ${ui}/></ui><font typeface="Helvetica" size="8pt"/>${value === null ? '' : `<value><text>${value}</text></value>`}${extra}</field>`;
const rects = c => [...c.matchAll(/([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+) re/g)].map(m => m.slice(1).map(Number));

test('a Code 39 field: bars across the whole field, no quiet zone, full height without text', async () => {
  const { pdf } = await flattenXfa(xfaForm(field('type="code3Of9" textLocation="none"', 'DHS-4258A-ENG')), { fonts: null });
  const c = await pageContent(pdf);
  const r = rects(c);
  assert.equal(r.length, 15 * 5); // five bars a character
  assert.ok(Math.abs(r[0][0] - 10) < 1e-3);
  const last = r.at(-1);
  assert.ok(Math.abs(last[0] + last[2] - 190) < 1e-3);
  // the field's 40pt (PDF y 250..290)
  assert.ok(r.every(([, y, , h]) => Math.abs(y - 250) < 1e-3 && Math.abs(h - 40) < 1e-3));
  assert.doesNotMatch(c, /Tj/);
});

test('a Code 128 field prints its text below the bars by default', async () => {
  const { pdf } = await flattenXfa(xfaForm(field('type="code128"', 'Test1234')), { fonts: null });
  const c = await pageContent(pdf);
  assert.match(c, /\(Test1234\) Tj/);
  const r = rects(c);
  assert.ok(r.every(([, y, , h]) => y > 250 && y + h <= 290.001)); // above the text line
});

test('PDF417 and QR fields: modules on a 300 dpi grid, centred; empty values print nothing', async () => {
  const { pdf, log } = await flattenXfa(xfaForm(
    field('type="pdf417" moduleWidth="0.0133in" errorCorrectionLevel="5"', '1234567890')
    + field('type="QRCode" moduleWidth="0.0167in" errorCorrectionLevel="1"', '1234567890').replace('y="10pt"', 'y="100pt"')
    + field('type="pdf417"', null).replace('y="10pt"', 'y="200pt"')), { fonts: null });
  const c = await pageContent(pdf);
  const r = rects(c);
  // 0.0133in → 4 pixels at 300 dpi = 0.96pt; the start pattern's first bar is 8 modules
  assert.ok(r.some(([, , w]) => Math.abs(w - 7.68) < 1e-3));
  // QR: 0.0167in → 5 pixels = 1.2pt; a finder pattern's top row, 7 modules
  assert.ok(r.some(([, , w, h]) => Math.abs(w - 8.4) < 1e-3 && Math.abs(h - 1.2) < 1e-3));
  assert.ok(log.entries.some(e => e.code === 'XFA_BARCODE_EMPTY'));
});

test('flateCompress: the payload is a zlib stream (RFC 1950), in byte compaction', async () => {
  const n = { type: 'field', ui: { kind: 'barcode', barcode: { type: 'pdf417', dataPrep: 'flateCompress', charEncoding: null } }, raw: 'AAAAAAAAAAAAAAAAAAAAAAAA' };
  const z = (await compressPayloads([{ items: [{ node: n }] }])).get(n);
  assert.deepEqual([z[0], z[1]], [0x78, 0x9c]);
  assert.equal(inflateSync(z).toString(), n.raw);
  assert.equal(barcodePayload(n, new Map([[n, z]])).compressed, true);
  // byte compaction from the first codeword: 924/901 latch
  const sym = encodeBarcode('pdf417', { text: n.raw, bytes: z, compressed: true }, B({ errorCorrectionLevel: 2, dataColumnCount: 4 }), { log() {} });
  const inv = CLUSTERS.map(t => new Map(t.map((v, i) => [v.toString(2), i])));
  const first = inv[0].get(Array.from(sym.modules[0]).join('').slice(51, 68)); // after the row indicator and the length
  assert.ok(first === 901 || first === 924);
  // charEncoding: ISO-8859-1 one byte a character, UTF-16 big-endian
  const p = (raw, charEncoding) => barcodePayload({ ui: { barcode: { charEncoding, dataPrep: 'none' } }, raw }).bytes;
  assert.deepEqual([...p('é', 'ISO-8859-1')], [0xe9]);
  assert.deepEqual([...p('é', 'UTF-16')], [0x00, 0xe9]);
  assert.deepEqual([...p('é', null)], [0xc3, 0xa9]);
});

test('a static form: the barcode prints over the shell page, on white', async () => {
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="position">
    <pageSet><pageArea name="P1"><contentArea x="0" y="0" w="300pt" h="300pt"/><medium short="300pt" long="300pt"/></pageArea></pageSet>
    <subform name="page1" w="300pt" h="300pt">${field('type="code3Of9" textLocation="none"', 'AB')}</subform></subform></template>`;
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA [(template) 6 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R >>',
    5: { dict: '<< >>', stream: '0 g 10 250 180 40 re f' }, // a design-time placeholder
    6: { dict: '<< >>', stream: template },
  });
  const { pdf: out, static: kept } = await flattenXfa(pdf, { fonts: null });
  assert.equal(kept, true);
  const c = await pageContent(out);
  const white = c.indexOf('1 1 1 rg'), bars = c.lastIndexOf(' re');
  assert.ok(white > c.indexOf('10 250 180 40 re f') && white < bars);
  assert.equal(rects(c.slice(white)).length, 1 + 4 * 5); // the white box, then *AB* in bars
});

test('the other linear symbologies: check digits and module counts', async () => {
  const { encodeBarcode } = await import('../../src/core/barcode.js');
  const logs = [];
  const env = { log: (c, m) => logs.push(c) };
  const sum = e => e.reduce((a, b) => a + b, 0);
  // EAN-13 4006381333931: 95 modules, its check digit 1
  const e13 = encodeBarcode('ean13', { text: '400638133393' }, {}, env);
  assert.equal(e13.text, '4006381333931');
  assert.equal(sum(e13.elements), 95);
  // first digit 4: parity LGLLGG; the next two digits, 0 and 0, in L (3211) then G (1123)
  assert.deepEqual(e13.elements.slice(3, 11), [3, 2, 1, 1, 1, 1, 2, 3]);
  assert.equal(sum(encodeBarcode('ean8', { text: '9638507' }, {}, env).elements), 67);
  assert.equal(encodeBarcode('upcA', { text: '03600029145' }, {}, env).text, '036000291452');
  // UPC-E 0425261 → 04252614 (UPC-A 04210000526, check 4), 51 modules
  const ue = encodeBarcode('upcE', { text: '425261' }, {}, env);
  assert.equal(ue.text, '04252614');
  assert.equal(sum(ue.elements), 51);
  // Code 93: nine modules a character (start, data, C, K, stop) and a termination bar
  assert.equal(sum(encodeBarcode('code93', { text: 'TEST93' }, {}, env).elements), 9 * 10 + 1);
  // Codabar: start/stop A by default, 7 elements a character and a gap
  assert.equal(encodeBarcode('codabar', { text: '123' }, { checksum: 'none' }, env).elements.length, 5 * 8 - 1);
  // Interleaved 2 of 5: an odd count gets a leading 0; 4 + 10 a pair + 3 elements
  assert.equal(encodeBarcode('code2Of5Interleaved', { text: '123' }, {}, env).elements.length, 4 + 20 + 3);
  // MSI 1234 with its Luhn check digit 4
  assert.equal(encodeBarcode('msi', { text: '1234' }, {}, env).text, '1234');
  // POSTNET 55555: check 5, two frame bars
  assert.equal(encodeBarcode('postUS5Zip', { text: '55555' }, {}, env).bars.join(''), `F${'TFTFT'.repeat(6)}F`);
  // RM4SCC SN34RD1A: check character K, start ascender, stop full bar
  const rm = encodeBarcode('postUKRM4SCC', { text: 'SN34RD1A' }, {}, env).bars;
  assert.equal(rm.length, 1 + 9 * 4 + 1);
  assert.deepEqual([rm[0], rm.at(-1)], ['A', 'F']);
  // K: row 4 (1001 ascenders), column 3 (0110 descenders)
  assert.deepEqual(rm.slice(-5, -1), ['A', 'D', 'D', 'A']);
  assert.equal(encodeBarcode('code49', { text: 'x' }, {}, env), null);
  assert.ok(logs.includes('XFA_BARCODE_UNSUPPORTED'));
});

test('postal bars: equal bars and gaps across the field; trackers, ascenders and descenders by state', async () => {
  const { pdf } = await flattenXfa(xfaForm(field('type="postUKRM4SCC" textLocation="none"', 'SN34RD1A')), { fonts: null });
  const r = rects(await pageContent(pdf));
  assert.equal(r.length, 38);
  // 38 bars and 37 gaps over 180pt; the first an ascender (top two thirds), the last a full bar
  const pitch = 180 / 75;
  assert.ok(Math.abs(r[0][2] - pitch) < 1e-3 && Math.abs(r.at(-1)[0] - (10 + 74 * pitch)) < 1e-2);
  assert.ok(Math.abs(r[0][3] - 40 * 2 / 3) < 1e-2);
  assert.ok(Math.abs(r.at(-1)[3] - 40) < 1e-2);
  const postnet = rects(await pageContent((await flattenXfa(xfaForm(field('type="postUS5Zip" textLocation="none"', '55555')), { fonts: null })).pdf));
  assert.equal(postnet.length, 32);
  assert.ok(Math.abs(postnet[1][3] - 16) < 1e-2); // a short bar: 40% of the height
});

test('MaxiCode: codewords and modules as ISO/IEC 16023 and zint give them', async () => {
  const { maxiCodewords, encodeMaxiCode } = await import('../../src/core/maxicode.js');
  const hex = a => a.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  // Mode 4 "A" (zint test_maxicode)
  assert.equal(hex(maxiCodewords(new TextEncoder().encode('A')).cw.slice(0, 28)),
    '04 01 21 21 21 21 21 21 21 21 08 0E 19 2B 20 0C 24 06 32 1C 21 21 21 21 21 21 21 21');
  // Mode 2 from a structured carrier message: postal code 123456, country 123, service 456
  const m2 = maxiCodewords(Uint8Array.from('[)>\x1E01\x1D99123456\x1D123\x1D456\x1DA', c => c.charCodeAt(0)));
  assert.equal(m2.mode, 2);
  assert.equal(hex(m2.cw.slice(0, 28)), '02 10 22 07 00 20 31 1E 20 1C 0E 29 13 1B 0D 26 36 25 3B 22 3B 2A 29 3B 28 1E 30 31');
  // ISO/IEC 16023 Figure 2: a 93-character Code Set A message filling a Mode 4 symbol
  const sym = encodeMaxiCode({ bytes: new TextEncoder().encode('THIS IS A 93 CHARACTER CODE SET A MESSAGE THAT FILLS A MODE 4, UNAPPENDED, MAXICODE SYMBOL...') }, { log() {} });
  assert.equal(sym.modules.map(r => [...r].join('')).join(''), '011111010000001000001000100111000100000001000000001010000000001011001100100110110010010010100000010001100010010000000000001011000000101000001010110011111010001000001011001000111100100000000110000010010000000000000010100010010010001001111100111011100000001000000110000000000000011011000000010100011000101111000001010110001100000011001110001010000000111010001110000111100000000000100001011000100010000000000000000111001000100000001000000000011000001000000010111000000000000010000010111000001000000000001000001101011000000000000000001000100100000000101100000000001001010001101010001000000000100111001100001000011000000000011100001010000000000000000000110000100000101011001010100001000101010001100011110010101001101010001010011010000000000101011010011111000001110011111111111100010100001110100111000101011000011100110111011100100001101001010110000001011011101010010111001100111000110111100010001111011110101111010111111000010110111001001001101111101101101010011100001011000000111101100100001000');
});

test('Intelligent Mail: USPS-B-3200 Figure 5', async () => {
  const { encodeImb } = await import('../../src/core/imb.js');
  assert.equal(encodeImb('01234567094987654321-01234567891', { log() {} }).bars.join(''),
    'AADTFFDFTDADTAADAATFDTDDAAADDTDTTDAFADADDDTFFFDDTTTADFAAADFTDAADA');
  const logs = [];
  assert.equal(encodeImb('123', { log: c => logs.push(c) }), null);
  assert.deepEqual(logs, ['XFA_BARCODE_DATA']);
});

test('a MaxiCode field: hexagons on the grid and a bullseye of three rings, at most 28.14mm wide', async () => {
  const { pdf } = await flattenXfa(xfaForm(field('type="maxicode"', 'A').replace('h="40pt"', 'h="150pt"').replace('w="180pt"', 'w="180pt"')), { fonts: null });
  const c = await pageContent(pdf);
  assert.ok((c.match(/ m\n[^m]* l\n[^m]* l\n[^m]* l\n[^m]* l\n[^m]* l\nh/g) ?? []).length > 100);
  assert.match(c, /f\*\nQ/);
  // nominal width: 30 modules of 28.14mm / 30
  const xs = [...c.matchAll(/([\d.]+) [\d.]+ l/g)].map(m => Number(m[1]));
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 28.14 * 72 / 25.4 + 0.01);
});

test('Aztec Code: modules as ISO/IEC 24778 and zint give them, in the smallest symbol', async () => {
  const { aztecModules } = await import('../../src/core/aztec.js');
  const grid = (bytes, opts) => aztecModules(typeof bytes === 'string' ? Uint8Array.from(bytes, c => c.charCodeAt(0)) : bytes, opts).modules.map(r => r.join('')).join('');
  // zint test_aztec test_encode vectors, default options
  // ISO/IEC 24778 Figure 1 (left): digits, compact 1 layer
  assert.equal(grid('123456789012'), '000111000011100110111001110010111100001000100001111111111100010100000001000100101111101010100101000101110001101010101100101101000101111101101111101010110100000001101000111111111111110001010010001101011110101010100010001000101');
  // Figure G.2: Upper, Lower and a Punct shift
  assert.equal(grid('Code 2D!'), '000110001100000000000110000010101100001000101011111111111100111100000001101000101111101100100101000101111001101010101001001101000101010010101111101001100100000001011100111111111101010001100010010011000011011010111001101100000');
  // Figure 1 (right), as zint encodes it: 41 x 41, full-range 4 layers with the reference grid
  assert.equal(grid('Aztec Code is a public domain 2D matrix barcode symbology of nominally square symbols built on a square grid with a distinctive square bullseye pattern at their center.'),
    '0000110011001001001011100001010000101100001000110010110110001000000100101101000001010111001010110011101011000000011000110011110000001010000100001001001010011000101010101010101010101010101010101010101010101001101010111000000010001000110011011000101100100010001111010110001011010001101101001000101001101011011011111101100000101011110110101111011111111010100011011110111000100010100100011001101010100110111010011101011101100011100001100000101010111011001001001011001111001010011110110110111001011110100000010000111110101101010110101010100000100011101100101000001011110110000000010011010100011111111111111101011010111000011000000001010000000000011010001000011100001011011111101111111110100110000011110000001110100101010000000101100111011000001100100101010110101111101011111110001011111110001000101101010001010100111001100011101010101010101010101010101010101010101010010010001000010101000101010010110000000000001100111110101011111010111001111010000100101010000101010000000101101101110010100101110101101110111111111011000011001111000110101011100100000000000111011010100100001111010000101111111111111101000110110110000001010110001111100111000100011100001010001000010111101001100110011000001010001100100011111001011110111001000111101011010111110000000100111010001101101111001100010000001000010110110010010010101111000000001011000100100010111111011011111111101010010000110100010010101000100111001000111110011001111110000001110100000001010010011101100100000001111100110011111111001010111010101010101010101010101010101010101010110000010011110010010000100001010001101110101011011101000011001111001101010010100010001001001001100101101101000011000100010110001000001010100110100000001001001110000');
  // every mode latched to and from, between byte shifts
  assert.equal(grid('ABCDEFGH\x1Aabcdefgh\x1AABCDEFGH\x1A~~~~~~~~\x1AABCDEFGH\x1A;;;;;;;;;\x1AABCDEFGH\x1A123456789\x1AABCDEFGH'),
    '0010100101001100111100111001110011111010111110000111110001110011100111000110101010101010101010101010101010101010000000110111011000111100001110100001001011011010000010111001010011100011111000000001000111100001011000101100010010011001000011101110110111100011101100110111110001010001101111101001001000100010011111111110111111101010001000101001101110001110110010111111011010011001101011010000101111101001010010000001110010110010000000101101100100011110101010011111111111111110001010111000001111000100000000000101101110001101111110000010111111111010101110011101100000001011010000000101000100100001011010010100101011111010111001111110000011100111010101000101010101101000001010101010101010101010101010101010101000010000010101010001010110111100001010100111010010101111101011000000101110100001001001010000000101011111100010111100011011101111111110111011110110011001000000010000000000011001001010111011110010001111111111111101101110100000110011100010010010011000011010001001110010111101101010011001000011101100000010111001001000001110001001000000011010111010010000110000100100000110110000001011101001000111101011100110001010100010010001011110111101111011111110100110101110001011100000010111100010101011001110011110011100111001111000001111111100111000111001110011110010101010101010101010101010101010101010100001010000100100001011100001111010000110010001101011101001110010100111101');
  // 62 bytes outside ASCII: two 31-byte binary shifts
  assert.equal(grid(new Uint8Array(62).fill(0xA1)), '1110010001000100011000100010001000110110011001100110011000110011001100101010101010101010101010101010101010101011100001000100010000100010001000100000101111100110011001110011001100110011011011001100101100101100010110011100111111100100001100101100010011010011100010111101111010000011000100010010000000111010010000111010111101100100001100001100000001011100100010000001010011111010010111111000100100001011001110001000110001110010000000101000100000000010001011111111111111111110011000110000110000111100000000000101001111001111101001110010111111111010110010111000100011011111010000000101000101000000001000100011101011111010100001110011000011000010010101000101010110000100111010101010101010101010101010101010101110010001100101010001010100010111100001100111000110101111101010011010001000000001101001010000000101010110000010001110010010101111111110111011111011111001000100010000000000011001101110000110011011001111111111111101000100100000001101000011101001110000111000001000111100100000100011110011111111101111100101100101111100110011011001111000011001010111010100100100111010100010000000110100110101000001111100111000100011101101001011001010100011010010111110010010110000011010100000100011100001100110011001100111001100110011001000000010001000100010000100010001000010101010101010101010101010101010101010101010011001100110001100110011001100110110001000100010001100010001000100100');
  // sizes: 500 characters need a full-range symbol; error correction 50% a larger one
  const long = 'The quick brown fox jumps over the lazy dog 0123456789. '.repeat(9).slice(0, 500);
  const r = aztecModules(new TextEncoder().encode(long));
  assert.ok(!r.compact && r.layers > 4 && r.modules.length === r.modules[0].length);
  assert.ok(aztecModules(new TextEncoder().encode('Code 2D!'), { ecc: 4 }).modules.length > 15);
  const logs = [];
  assert.equal(encodeBarcode('aztec', { text: '', bytes: new Uint8Array(3000).fill(0xFF) }, B(), { log: c => logs.push(c) }), null);
  assert.deepEqual(logs, ['XFA_BARCODE_DATA']);
});

test('an Aztec field: the symbol drawn module for module, centred in the field', async () => {
  const { aztecModules } = await import('../../src/core/aztec.js');
  const { pdf, log } = await flattenXfa(xfaForm(field('type="aztec"', 'Code 2D!')), { fonts: null, barcodes: 'all' });
  assert.ok(!JSON.stringify(log).includes('XFA_BARCODE_UNSUPPORTED'));
  const r = rects(await pageContent(pdf));
  // runs of dark modules, one rectangle each, back to a grid
  const mw = Math.min(...r.map(q => q[3]));
  const x0 = Math.min(...r.map(q => q[0])), top = Math.max(...r.map(q => q[1] + q[3]));
  const want = aztecModules(new TextEncoder().encode('Code 2D!')).modules;
  const got = want.map(row => new Uint8Array(row.length));
  for (const [x, y, w, h] of r) {
    const row = Math.round((top - y - h) / mw);
    for (let c = Math.round((x - x0) / mw); c < Math.round((x + w - x0) / mw); c++) got[row][c] = 1;
  }
  assert.deepEqual(got.map(g => g.join('')), want.map(g => g.join('')));
  // centred in the 180 x 40pt field at (10, 10)
  assert.ok(Math.abs(x0 + 15 * mw / 2 - 100) < 0.01 && Math.abs(300 - top + 15 * mw / 2 - 30) < 0.01);
});

// --- symbologies checked against zint's test vectors (backend/tests) ---

// elements (bar first) → a module string, 1 dark
const moduleString = el => el.map((w, i) => (i % 2 ? '0' : '1').repeat(w)).join('');

test('Code 2 of 5 Matrix: zint test_2of5 vectors, 4X start and stop bars', () => {
  assert.equal(moduleString(enc('code2Of5Matrix', '87654321').s.elements),
    '1111010101110100010101000111010001110101110111010101110111011100010101000101110111010111011110101');
  assert.equal(moduleString(enc('code2of5matrix', '87654321', { checksum: 'auto' }).s.elements),
    '11110101011101000101010001110100011101011101110101011101110111000101010001011101110101110100010111011110101');
  assert.equal(moduleString(enc('code2of5matrix', '1234567890').s.elements),
    '111101010111010111010001011101110001010101110111011101110101000111010101000111011101000101000100010101110001011110101');
});

test('EAN/UPC add-ons: zint test_upcean vectors (GS1 figures), 7 or 9-module gaps', () => {
  const m = (type, text) => moduleString(enc(type, text).s.elements);
  // GGS Figure 5.2.2.5.1-2: EAN-13 with a two-digit add-on
  assert.equal(m('ean13add2', '9771384524017+12'),
    '10101110110010001011001101111010001001010001101010100111011011001011100111001011001101000100101000000010110011001010010011');
  // GGS Figure 5.2.2.5.2-2: five digits (also given run on)
  const e13 = '10101110110001001010011101101110010001011101101010100010011101001110100100001011100101010000101000000010110111001010100011010100001010010011010011001';
  assert.equal(m('ean13add5', '9780877799306+54321'), e13);
  assert.equal(m('ean13add5', '978087779930654321'), e13);
  // GGS Figure 5.2.6.6-5: UPC-A, a 9-module gap
  assert.equal(m('upcAadd2', '01234567890+24'),
    '1010001101001100100100110111101010001101100010101010100001000100100100011101001110010100111010100000000010110010011010100011');
  assert.equal(m('upcEadd2', '1234567+12'),
    '101001001101111010100011011100100001010010001010101000000010110011001010010011');
  assert.equal(m('upcEadd5', '12345670+12345'),
    '101001001101111010100011011100100001010010001010101000000010110110011010010011010100001010100011010110001');
  assert.equal(m('ean8add2', '1234567+12'),
    '1010011001001001101111010100011010101001110101000010001001110010101000000010110011001010010011');
  assert.equal(m('ean8add5', '12345670+12345'),
    '1010011001001001101111010100011010101001110101000010001001110010101000000010110110011010010011010100001010100011010110001');
  assert.equal(m('upcAadd5', '614141234417+12345'),
    '1010101111001100101000110011001010001100110010101011011001000010101110010111001100110100010010100000000010110110011010010011010100001010100011010110001');
  assert.equal(m('upcean5', '54321'), '10110111001010100011010100001010010011010011001');
  assert.equal(m('upcean2', '21'), '10110010011010110011');
  // the add-on's first element (after the gap), and its digits
  const s = enc('upcAadd5', '61414123441712345').s;
  assert.deepEqual(s.addOn, { at: 60, text: '12345' });
  assert.equal(s.elements[59], 9);
  assert.equal(s.text, '614141234417');
});

test('Australia Post: zint test_auspost vectors (the specification\'s figures), FCC by type, N and C tables', () => {
  const bars = (type, text) => enc(type, text).s.bars.join('');
  // zint's three rows (ascender, tracker, descender) to bar states
  const states = rows => {
    const w = rows.length / 3, out = [];
    for (let i = 0; i < w; i += 2) out.push(rows[i] === '1' ? (rows[2 * w + i] === '1' ? 'F' : 'A') : (rows[2 * w + i] === '1' ? 'D' : 'T'));
    return out.join('');
  };
  // Technical Specifications Diagram 1: FCC 11, DPID 96184209
  assert.equal(bars('postAUSStandard', '96184209'), states('100010101010001000101010000010101000101000100000101000001000100000100010010101010101010101010101010101010101010101010101010101010101010101010101010000100010000010101010001010000010101010001000101010001000100010000010000'));
  // Guide Figure 4: Customer Barcode 2 with "ABA 9" in the C table
  assert.equal(bars('postAUSCust2', '56439111ABA 9'), states('100010000010100000101010101000101010101010101010101010101010101010000000000000101010001010101000001010010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010000001000100010101000000010001010001000100010101010100010101010100000101000000010001000101010000000000'));
  // Customer Barcode 3, 15 digits in the N table
  assert.equal(bars('postAUSCust3', '32211324123456789012345'), states('100000101000101010001000101010101010100010101010100010101010100000100010000000101010101010001010101010000010000010001010101010001010010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010000101010100010101010101000100000101010000010001010001000000010101010001010001010101000101000100000001000001010000010001010100010000'));
  assert.equal(bars('postAUSReplyPaid', '12345678'), states('100010101000101010001010101010000010001000000000100000100000000010001010010101010101010101010101010101010101010101010101010101010101010101010101010000000000101000101000100000001010101000101000000000100010101000101000000'));
  assert.deepEqual([bars('postAUSStandard', '1').length, bars('postAUSCust2', '1').length, bars('postAUSCust3', '1').length], [37, 52, 67]);
  // too much customer information is cut to what the format holds
  const { s, logs } = enc('postAUSCust2', '12345678123456789');
  assert.equal(s.bars.length, 52);
  assert.match(logs[0], /XFA_BARCODE_DATA/);
  assert.equal(enc('postAUSStandard', 'AB').s, null);
});

test('GS1 DataBar: zint test_rss vectors (GS1 and ISO/IEC 24724 figures), linear, stacked, Limited, Expanded', () => {
  // a linear DataBar opens with a space: a zero-width bar first
  const m = (type, text) => { const { s } = enc(type, text); return s.kind === '1d' ? moduleString(s.elements) : s.modules.map(r => r.join('')).join(''); };
  // GGS Figure 5.5.2.1.1-1, 96 modules; the check digit computed, or given and verified, (01) allowed
  const omn = '010000010100000101000111110000010111101101011100100011011101000101100000000111001110110111001101';
  assert.equal(m('rss14', '0950110153001'), omn);
  assert.equal(m('rss14Truncated', '(01)09501101530010'), omn);
  assert.equal(enc('rss14', '0950110153001').s.text, '(01)09501101530010');
  // Stacked: two rows of 50 and the separator between, 5:7
  const stk = enc('rss14Stacked', '0001234567890').s;
  assert.equal(stk.modules.map(r => r.join('')).join(''), '010101001000000001001111111000010111001011011110100000101010101111101000000011101010001101001000000010111001010110000101111111000111001100111101110101');
  assert.deepEqual(stk.heights, [5, 1, 7]);
  assert.equal(m('rss14StackedOmni', '0003456789012'), '0101010010000000010011111000000101001110011001101000001011011111111010000001010100101100011001100000000001010101010101010101010101010101010101010100000000100010001011101001010101000011110100110111000010110111011101000101100000000111000010110010001101');
  assert.equal(m('rss14Limited', '1501234567890'), '0100011001100011011010100111010010101101001101001001011000110111001100110100000');
  // Expanded: GGS Figure 5.5.2.3.1-1, (01) and (3202) (method 4)
  assert.equal(m('rss14Expanded', '(01)90614141000015(3202)000150'), '0101100011001100001011111111000010100100010000111101110011100010100010111100000011100111010111111011010100000100000110001111110000101000000100011010010');
  // (01), (3202) and (15) (method 12); (01) and (3103) (method 3); (01) then the general field (method 1)
  assert.equal(m('rss14Expanded', '(01)98898765432106(3202)012345(15)991231'), '01001000011000110110111111110000101110000110010100011010000001100010101111110000111010011100000010010100111110111001100011111100001011101100000100100100011110010110001011111111001110001101111010000101');
  assert.equal(m('rss14Expanded', '[01]90012345678908[3103]001750'), '0101110010000010011011111111000010111000010011000101011110111001100010111100000011100101110001110111011110101111000110001111110000101011000010011111010');
  assert.equal(m('rss14Expanded', '(01)00012345678905(10)ABC123'), '0100011000001011011011111111000010110011000010111101011110011011111010111110000001100010110000110111000111101101011110001111110000101110001100100001010011101111110110101111111100111001011011111101110011011100101111100011110000001010');
  // the general field alone (method 2): ISO 646, alphanumeric and numeric modes
  assert.equal(m('rss14Expanded', '(91)a1234ABCDEF'), '0100001011010000111011111111000010110000010001011101011011111100111010111110000001100001101101000111000011100001010110001111110000101001110000101100010000001001101100101111111100111010000011100100010011100111000101100011110000001010');
  assert.equal(m('rss14Expanded', '(255)95011015340010123456789'), '0100011000110001011011111111000010100000010101100001100001100111001010111110000001100100001110100001001000011011111010001111110000101001011111100111011001000111100100101111111100111011111001100100110010011100010111100011110000001010');
  // Limited takes GTINs from 0 or 1; a wrong check digit is logged and recomputed
  assert.equal(enc('rss14Limited', '2001234567890').s, null);
  const bad = enc('rss14', '09501101530011');
  assert.equal(moduleString(bad.s.elements), omn);
  assert.match(bad.logs[0], /XFA_BARCODE_DATA/);
});

test('fields of the zint-checked symbologies print a symbol, with nothing unsupported logged', async () => {
  const cases = [['code2Of5Matrix', '87654321'], ['ean13add5', '9780877799306+54321'], ['upcean2', '21'],
    ['postAUSStandard', '96184209'], ['postAUSCust2', '56439111ABA 9'], ['postAUSCust3', '32211324aBCd#F hIz'], ['postAUSReplyPaid', '12345678'],
    ['rss14', '0950110153001'], ['rss14Truncated', '0950110153001'], ['rss14Stacked', '0001234567890'], ['rss14StackedOmni', '0003456789012'],
    ['rss14Limited', '1501234567890'], ['rss14Expanded', '(01)98898765432106(3202)012345(15)991231']];
  for (const [type, value] of cases) {
    const { pdf, log } = await flattenXfa(xfaForm(field(`type="${type}" textLocation="none"`, value)), { fonts: null, barcodes: 'all' });
    assert.ok(rects(await pageContent(pdf)).length > 5, type);
    assert.ok(!log.entries.some(e => e.code.startsWith('XFA_BARCODE')), `${type}: ${log.entries.map(e => e.code)}`);
  }
});

test('a DataBar Stacked field: the rows across the width, 5:7, a separator row a module high at most', async () => {
  const { pdf } = await flattenXfa(xfaForm(field('type="rss14Stacked"', '0001234567890')), { fonts: null, barcodes: 'all' });
  const r = rects(await pageContent(pdf));
  // 180pt / 50 modules = 3.6pt; 13 nominal modules over 40pt: the separator 40/13, the rows share the rest 5:7
  const sep = 40 / 13, top = (40 - sep) * 5 / 12, bottom = (40 - sep) * 7 / 12;
  const heights = [...new Set(r.map(([, , , h]) => h.toFixed(2)))].sort();
  assert.deepEqual(heights, [sep, top, bottom].map(h => h.toFixed(2)).sort());
  assert.ok(Math.abs(Math.max(...r.map(([x, , w]) => x + w)) - 190) < 0.01);
});

test('an EAN-13 with an add-on: its digits above the add-on, its bars a text line shorter', async () => {
  const { pdf } = await flattenXfa(xfaForm(field('type="ean13add2"', '9771384524017+12')), { fonts: null, barcodes: 'all' });
  const c = await pageContent(pdf);
  assert.match(c, /\(9771384524017\) Tj/);
  assert.match(c, /\(12\) Tj/);
  const r = rects(c);
  // 95 + 9 + 20 modules over 180pt; the add-on's bars start after 102 modules
  const unit = 180 / 122, addX = 10 + 102 * unit;
  const main = r.filter(([x]) => x < addX - 1e-6), add = r.filter(([x]) => x >= addX - 1e-6);
  assert.equal(add.length, 7);
  assert.ok(add.every(([, y, , h]) => Math.abs(y - main[0][1]) < 1e-6 && h < main[0][3] - 5));
  // each text centred over its part: the add-on's in the line its bars leave at the top
  const [, ax, ay] = /([\d.]+) ([\d.]+) Td\n\(12\) Tj/.exec(c).map(Number);
  assert.ok(ax > addX && ay > 280);
  assert.ok(Number(/([\d.]+) [\d.]+ Td\n\(9771384524017\) Tj/.exec(c)[1]) + 40 < addX);
});

test('by default barcode fields print as Reader prints them: a grey box for the types it does not draw', async () => {
  for (const type of ['aztec', 'rss14', 'rss14Expanded', 'upcean5']) {
    const { pdf, log } = await flattenXfa(xfaForm(field(`type="${type}"`, type === 'upcean5' ? '54321' : '0950110153001')), { fonts: null });
    const c = await pageContent(pdf);
    assert.match(c, /0\.5 0\.5 0\.5 rg\n0 0 0 RG\n0\.5 w\n10\.25 250\.25 179\.5 39\.5 re\nB/, type);
    assert.equal(rects(c).length, 1, type);
    assert.equal(log.byCode('XFA_BARCODE_READER').length, 1, type);
  }
});

test('by default an EAN/UPC field with an add-on leaves the layout, as in Reader\'s print', async () => {
  const flow = type => `<subform name="page1" layout="tb" w="300pt"><draw name="a" w="100pt" h="20pt"><value><text>A</text></value></draw>
    <field name="bc" w="180pt" h="40pt"><ui><barcode type="${type}"/></ui><font typeface="Helvetica" size="8pt"/><value><text>9771384524017+12</text></value></field>
    <draw name="b" w="100pt" h="20pt"><value><text>B</text></value></draw></subform>`;
  const form = type => buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm << /Fields [] /XFA [(template) 6 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>',
    6: { dict: '<< >>', stream: `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"><contentArea x="0" y="0" w="300pt" h="300pt"/><medium short="300pt" long="300pt"/></pageArea></pageSet>${flow(type)}</subform></template>` },
  });
  const ys = c => [...c.matchAll(/[\d.]+ ([\d.]+) Td\n\((A|B)\) Tj/g)].map(m => Number(m[1]));
  const reader = await flattenXfa(form('ean13add2'), { fonts: null });
  const c = await pageContent(reader.pdf);
  const [a, b] = ys(c);
  assert.ok(Math.abs(a - b - 20) < 0.01);                // B straight under A
  assert.equal(reader.log.byCode('XFA_BARCODE_READER').length, 1);
  const all = await pageContent((await flattenXfa(form('ean13add2'), { fonts: null, barcodes: 'all' })).pdf);
  const [a2, b2] = ys(all);
  assert.ok(Math.abs(a2 - b2 - 60) < 0.01);              // the 40pt field between them
  assert.ok(rects(all).length > rects(c).length + 20);  // the bars, only with 'all'
  await assert.rejects(flattenXfa(form('ean13add2'), { barcodes: 'some' }), /barcodes: expected 'reader' or 'all'/);
});

test('an Australia Post field: Reader\'s fixed bar size from the top-left, the value under it', async () => {
  const { pdf } = await flattenXfa(xfaForm(field('type="postAUSStandard"', '39987520')), { fonts: null });
  const c = await pageContent(pdf);
  const r = rects(c);
  assert.equal(r.length, 37);
  // bars 1.559pt wide every 3.118pt from x 10; full bars 14.28pt from the top (PDF y 290)
  r.forEach(([x, , w], i) => assert.ok(Math.abs(x - (10 + i * 3.118)) < 1e-3 && Math.abs(w - 1.559) < 1e-3));
  const full = r.filter(([, , , h]) => Math.abs(h - 14.28) < 1e-3);
  assert.ok(full.length > 0 && full.every(([, y]) => Math.abs(y - (290 - 14.28)) < 1e-3));
  assert.deepEqual([...new Set(r.map(([, , , h]) => h.toFixed(2)))].sort(), ['14.28', '4.08', '9.18']);
  // the value centred under the symbol, its baseline 12pt below the bars
  const [, tx, ty] = /([\d.]+) ([\d.]+) Td\n\(39987520\) Tj/.exec(c).map(Number);
  assert.ok(Math.abs(ty - (290 - 14.28 - 12)) < 0.01);
  const width = 36 * 3.118 + 1.559;
  assert.ok(Math.abs(tx + 8 * 8 * 0.556 / 2 - (10 + width / 2)) < 0.5);
});

