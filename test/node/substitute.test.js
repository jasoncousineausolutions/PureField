// Fonts a page does not embed: substitutes at their widths
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { parseTtf } from '../../src/core/ttf.js';
import { glyphContours, buildTtf, postNames } from '../../src/core/outline.js';
import { parseToUnicode, classify, nameToUnicode } from '../../src/core/substitute.js';
import { glyphMapFor } from '../../src/core/glyphmaps.js';
import { predefinedCMap, splitCodes } from '../../src/core/cjk.js';
import { shownText } from '../../src/core/content.js';
import { buildPdf } from './pdfbuild.js';

const latin1 = u8 => new TextDecoder('latin1').decode(u8);
const sans = parseTtf(new Uint8Array(readFileSync(new URL('../../fonts/LiberationSans-Regular.ttf', import.meta.url))));

// A page showing text in font /F1 (given as object 10, with more objects)
async function flatten(font, extra = {}, opts = {}) {
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Resources << /Font << /F1 10 0 R >> >> >>',
    5: { dict: '<< >>', stream: 'BT /F1 12 Tf 10 10 Td (AB) Tj ET' },
    10: font,
    ...extra,
  });
  const out = await flattenXfa(pdf, opts);
  const doc = await parsePdf(out.pdf.buffer.slice(out.pdf.byteOffset, out.pdf.byteOffset + out.pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const page = (await doc.getObject((await doc.getObject(cat.Pages.num)).value.value.Kids.value[0].num)).value.value;
  const res = page.Resources.type === 'ref' ? (await doc.getObject(page.Resources.num)).value.value : page.Resources.value;
  const fontRef = res.Font.value.F1;
  const f = (await doc.getObject(fontRef.num)).value.value;
  const get = async v => (v?.type === 'ref' ? await doc.getObject(v.num) : v);
  return { font: f, doc, get, log: out.log };
}

test('a non-embedded TrueType font gets a symbolic program, one glyph per code at its /Widths', async () => {
  const { font, get, log } = await flatten(
    '<< /Type /Font /Subtype /TrueType /BaseFont /Verdana /FirstChar 65 /LastChar 66 /Widths [684 686] /Encoding /WinAnsiEncoding /FontDescriptor 11 0 R >>',
    { 11: '<< /Type /FontDescriptor /FontName /Verdana /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent -200 /CapHeight 700 /StemV 80 >>' });
  assert.match(font.BaseFont.value, /^[A-Z]{6}\+Verdana$/);
  assert.equal(font.Encoding, undefined);
  assert.deepEqual(font.Widths.value, [684, 686]);
  const fd = (await get(font.FontDescriptor)).value.value;
  assert.equal(fd.Flags, 4);
  const program = parseTtf((await get(fd.FontFile2)).streamBytes);
  assert.equal(program.cmapKind, 'symbol');
  const a = program.glyphFor(0xF041), b = program.glyphFor(0xF042);
  // advances are the declared widths (Liberation Sans: 2048 units an em)
  assert.equal(program.advance(a), Math.round(684 * 2048 / 1000));
  assert.equal(program.advance(b), Math.round(686 * 2048 / 1000));
  // the outline is Liberation Sans's A, stretched to 684/667 of its width
  const base = glyphContours(sans, sans.glyphFor(65)).flat();
  const ours = glyphContours(program, a).flat();
  assert.equal(ours.length, base.length);
  const maxX = pts => Math.max(...pts.map(p => p.x));
  assert.ok(Math.abs(maxX(ours) - maxX(base) * 684 / 667) <= 2);
  // text stays searchable
  assert.match(latin1((await get(font.ToUnicode)).streamBytes), /<41> <0041>/);
  assert.equal(log.byCode('FONT_SUBSTITUTED').length, 1);
});

test('glyph names from /Differences pick the characters; serif, bold and italic pick the face', async () => {
  const { font, get } = await flatten(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Garamond-BoldItalic /FirstChar 65 /LastChar 66 /Widths [600 600] /Encoding << /Differences [65 /Eacute /uni0416] >> /FontDescriptor 11 0 R >>',
    { 11: '<< /Type /FontDescriptor /FontName /Garamond-BoldItalic /Flags 34 /ItalicAngle -12 >>' });
  const tu = latin1((await get(font.ToUnicode)).streamBytes);
  assert.match(tu, /<41> <00C9>/);
  assert.match(tu, /<42> <0416>/);
  const fd = (await get(font.FontDescriptor)).value.value;
  assert.equal(fd.ItalicAngle, parseTtf(new Uint8Array(readFileSync(new URL('../../fonts/LiberationSerif-BoldItalic.ttf', import.meta.url)))).italicAngle);
});

test('standard 14 fonts, symbol fonts and embedded fonts are left as they are; fonts: null substitutes nothing', async () => {
  for (const f of ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /TrueType /BaseFont /Wingdings /FirstChar 65 /LastChar 65 /Widths [800] /Encoding /WinAnsiEncoding >>']) {
    const { font } = await flatten(f);
    assert.ok(!/\+/.test(font.BaseFont.value));
  }
  const { font } = await flatten('<< /Type /Font /Subtype /TrueType /BaseFont /Tahoma /FirstChar 65 /LastChar 66 /Widths [600 600] >>', {}, { fonts: null });
  assert.equal(font.BaseFont.value, 'Tahoma');
});

test('a Type0 font with /ToUnicode: each CID gets its character\'s glyph through /CIDToGIDMap', async () => {
  const { font, get } = await flatten(
    '<< /Type /Font /Subtype /Type0 /BaseFont /Calibri /Encoding /Identity-H /DescendantFonts [11 0 R] /ToUnicode 13 0 R >>',
    {
      11: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Calibri /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 12 0 R /DW 1000 /W [3 [226] 68 [479 525]] >>',
      12: '<< /Type /FontDescriptor /FontName /Calibri /Flags 32 >>',
      13: { dict: '<< >>', stream: '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0003> <0020> endbfchar\n1 beginbfrange <0044> <0045> <0061> endbfrange' },
    });
  const cid = (await get(font.DescendantFonts.value[0])).value.value;
  assert.equal(cid.Subtype.value, 'CIDFontType2');
  const map = (await get(cid.CIDToGIDMap)).streamBytes;
  const gidOf = c => (map[2 * c] << 8) | map[2 * c + 1];
  assert.deepEqual([gidOf(3), gidOf(68), gidOf(69), gidOf(4)], [1, 2, 3, 0]);
  const fd = (await get(cid.FontDescriptor)).value.value;
  const program = parseTtf((await get(fd.FontFile2)).streamBytes);
  // b (CID 69) advanced at its /W width
  assert.equal(program.advance(3), Math.round(525 * program.unitsPerEm / 1000));
  assert.match(cid.BaseFont.value, /\+Calibri$/);
});

test('a Type0 Arial with no /ToUnicode: CIDs read as Arial\'s glyph numbers', async () => {
  const { font, get, log } = await flatten(
    '<< /Type /Font /Subtype /Type0 /BaseFont /ArialMT /Encoding /Identity-H /DescendantFonts [11 0 R] >>',
    {
      11: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ArialMT /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 12 0 R >>',
      12: '<< /Type /FontDescriptor /FontName /ArialMT /Flags 32 >>',
    });
  assert.equal(log.byCode('FONT_GLYPH_ORDER').length, 1);
  const tu = latin1((await get(font.ToUnicode)).streamBytes);
  assert.match(tu, /<0024> <0041>/); // glyph 36 is A
  assert.equal(glyphMapFor('Verdana', () => null).get(68), 97);
  assert.equal(glyphMapFor('Wingdings', () => null), null);
});

test('/ToUnicode /Identity-H: each CID its /W names is its own character', async () => {
  const { font, get, log } = await flatten(
    '<< /Type /Font /Subtype /Type0 /BaseFont /TimesNewRomanPS-BoldMT /Encoding /Identity-H /DescendantFonts [11 0 R] /ToUnicode /Identity-H >>',
    {
      11: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TimesNewRomanPS-BoldMT /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 12 0 R /W [85 [722] 8211 [500]] >>',
      12: '<< /Type /FontDescriptor /FontName /TimesNewRomanPS-BoldMT /Flags 34 >>',
    });
  assert.equal(log.byCode('FONT_GLYPH_ORDER').length, 0);
  const tu = latin1((await get(font.ToUnicode)).streamBytes);
  assert.match(tu, /<0055> <0055>/);
  assert.match(tu, /<2013> <2013>/); // the en dash
});

test('ToUnicode CMaps: single codes, ranges, arrays and ligatures', () => {
  const m = parseToUnicode('2 beginbfchar <01> <0041> <02> <00660069> endbfchar 2 beginbfrange <10> <12> <0061> <20> <21> [<0058> <D835DC00>] endbfrange');
  assert.equal(m.get(1), 0x41);
  assert.equal(m.get(2), 0xFB01);
  assert.deepEqual([m.get(0x10), m.get(0x12)], [0x61, 0x63]);
  assert.deepEqual([m.get(0x20), m.get(0x21)], [0x58, 0x1D400]);
});

test('font classes from names and flags', () => {
  assert.deepEqual(classify('TimesNewRoman,BoldItalic'), { bold: true, italic: true, mono: false, serif: true });
  assert.deepEqual(classify('CenturyGothic'), { bold: false, italic: false, mono: false, serif: false });
  assert.deepEqual(classify('Consolas', 0), { bold: false, italic: false, mono: true, serif: false });
  assert.deepEqual(classify('Foo', 2 | 64, 700), { bold: true, italic: true, mono: false, serif: true });
  assert.equal(nameToUnicode('uni20AC'), 0x20AC);
  assert.equal(nameToUnicode('a.sc', new Map([['a', 97]])), 97);
});

test('outlines read and written back unchanged, composite glyphs flattened', () => {
  const ids = ['A', 'é', 'Å'].map(ch => sans.glyphFor(ch.codePointAt(0)));
  const glyphs = [{ contours: [], advance: 0 }, ...ids.map(g => ({ contours: glyphContours(sans, g), advance: sans.advance(g) }))];
  const back = parseTtf(buildTtf(sans, glyphs, { codes: new Map([[65, 1], [66, 2], [67, 3]]) }));
  for (let i = 1; i < glyphs.length; i++) {
    const want = glyphs[i].contours.map(c => c.map(p => [Math.round(p.x), Math.round(p.y), p.on]));
    assert.deepEqual(glyphContours(back, i).map(c => c.map(p => [p.x, p.y, p.on])), want);
    assert.equal(back.advance(i), glyphs[i].advance);
  }
  assert.ok(glyphs[2].contours.length >= 2); // é: e and its accent
  assert.equal(postNames(sans).get('Eacute'), sans.glyphFor(0xC9));
});

// The CJK font a user supplies (fonts/CJK.ttf): a subset of Droid Sans Fallback
const cjkBytes = new Uint8Array(readFileSync(new URL('../fixtures/fonts/cjk-subset.ttf', import.meta.url)));
const withCjk = { fonts: { regular: readFileSync(new URL('../../fonts/LiberationSans-Regular.ttf', import.meta.url)),
  load: async name => (name === 'CJK' ? cjkBytes : new Uint8Array(readFileSync(new URL(`../../fonts/${name}.ttf`, import.meta.url)))) } };
const ryumin = '<< /Type /Font /Subtype /Type0 /BaseFont /Ryumin-Light-90ms-RKSJ-H /Encoding /90ms-RKSJ-H /DescendantFonts [11 0 R] >>';
const ryuminCid = {
  11: '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Ryumin-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 12 0 R /DW 1180 /W [231 389 590] >>',
  12: '<< /Type /FontDescriptor /FontName /Ryumin-Light /Flags 6 /FontBBox [-170 -331 1024 903] /ItalicAngle 0 /Ascent 723 /Descent -241 /CapHeight 709 /StemV 69 >>',
};
// "(57)【要約】" in Shift-JIS
const shiftJis = 'BT /F1 16 Tf 10 20 Td <283537298179977696F1817A> Tj ET';

test('a CJK font with a predefined CMap gets an embedded CMap and the supplied CJK font\'s glyphs', async () => {
  const { font, get } = await flatten(ryumin, { ...ryuminCid, 5: { dict: '<< >>', stream: shiftJis } }, withCjk);
  assert.match(font.BaseFont.value, /^[A-Z]{6}\+Ryumin-Light$/);
  const cmap = latin1((await get(font.Encoding)).streamBytes);
  assert.match(cmap, /5 begincodespacerange\n<00> <80>\n<A0> <DF>\n<FD> <FF>\n<8140> <9FFC>\n<E040> <FCFC>/);
  assert.match(cmap, /<28> 1\n<29> 2\n<35> 3\n<37> 4\n<8179> 5\n<817A> 6\n<96F1> 7\n<9776> 8/);
  const tu = latin1((await get(font.ToUnicode)).streamBytes);
  assert.match(tu, /<9776> <8981>/);   // 要
  assert.match(tu, /<8179> <3010>/);   // 【
  const cid = (await get(font.DescendantFonts.value[0])).value.value;
  assert.equal(cid.Subtype.value, 'CIDFontType2');
  assert.equal(cid.CIDToGIDMap.value, 'Identity');
  // single bytes at the half-width CIDs' /W width, double bytes at /DW
  assert.deepEqual(cid.W.value[1].value, [590, 590, 590, 590, 1180, 1180, 1180, 1180]);
  const program = parseTtf((await get((await get(cid.FontDescriptor)).value.value.FontFile2)).streamBytes);
  assert.equal(program.numGlyphs, 9);
  assert.equal(program.advance(8), Math.round(1180 * program.unitsPerEm / 1000));
});

test('with no /W a CJK font\'s single bytes advance /DW, as Reader prints them', async () => {
  const noW = { ...ryuminCid, 11: ryuminCid[11].replace(' /W [231 389 590]', '') };
  const { font, get } = await flatten(ryumin, { ...noW, 5: { dict: '<< >>', stream: shiftJis } }, withCjk);
  const cid = (await get(font.DescendantFonts.value[0])).value.value;
  assert.deepEqual(cid.W.value[1].value, [1180, 1180, 1180, 1180, 1180, 1180, 1180, 1180]);
});

test('without a CJK font the CJK font is left as it is, and said so', async () => {
  const { font, log } = await flatten(ryumin, { ...ryuminCid, 5: { dict: '<< >>', stream: shiftJis } });
  assert.equal(font.Encoding.value, '90ms-RKSJ-H');
  assert.equal(log.byCode('FONT_CJK_NOT_EMBEDDED').length, 1);
});

test('an Identity-H CJK font with /ToUnicode, CFF-based, is drawn with the CJK font', async () => {
  const { font, get } = await flatten(
    '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /Identity-H /DescendantFonts [11 0 R] /ToUnicode 13 0 R >>',
    {
      11: '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 12 0 R /DW 1000 >>',
      12: '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 >>',
      13: { dict: '<< >>', stream: '1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0F0F> <8981> <1E2D> <7D04> endbfchar' },
      5: { dict: '<< >>', stream: 'BT /F1 12 Tf 10 10 Td <0F0F1E2D> Tj ET' },
    }, withCjk);
  const cid = (await get(font.DescendantFonts.value[0])).value.value;
  assert.equal(cid.Subtype.value, 'CIDFontType2');
  const map = (await get(cid.CIDToGIDMap)).streamBytes;
  const gidOf = c => (map[2 * c] << 8) | map[2 * c + 1];
  assert.ok(gidOf(0x0F0F) > 0 && gidOf(0x1E2D) > 0);
});

test('CJK code spaces and encodings: Shift-JIS, GBK, Big5, UHC, UCS-2, UTF-16, raw JIS', () => {
  const read = (name, bytes) => {
    const c = predefinedCMap(name);
    return splitCodes(Uint8Array.from(bytes), c.ranges).map(x => String.fromCodePoint(c.decode(x))).join('');
  };
  assert.equal(read('90ms-RKSJ-V', [0x28, 0x35, 0x81, 0x79, 0x97, 0x76, 0xB1]), '(5【要ｱ');
  assert.equal(read('GBK-EUC-H', [0xD6, 0xD0, 0xCE, 0xC4, 0x41]), '中文A');
  assert.equal(read('ETen-B5-H', [0xA4, 0xA4]), '中');
  assert.equal(read('KSCms-UHC-H', [0xB0, 0xA1]), '가');
  assert.equal(read('UniGB-UCS2-H', [0x4E, 0x2D]), '中');
  assert.equal(read('UniJIS-UTF16-H', [0xD8, 0x40, 0xDC, 0x0B, 0x00, 0x41]), '𠀋A');
  assert.equal(read('H', [0x30, 0x21]), '亜');
  assert.equal(predefinedCMap('Adobe-Japan1-6'), null);
  assert.equal(predefinedCMap('90ms-RKSJ-V').wmode, 1);
});

test('the text a content stream shows, by font, and the XObjects it draws', () => {
  const { runs, xobjects } = shownText(new TextEncoder().encode('BT /F1 12 Tf (a\\(b\\101) Tj [<8140> -5 (x)] TJ /F2 9 Tf (y) \' ET /Fm0 Do'));
  assert.deepEqual(runs.map(r => [r.font, [...r.bytes]]), [['F1', [97, 40, 98, 65]], ['F1', [0x81, 0x40]], ['F1', [120]], ['F2', [121]]]);
  assert.deepEqual(xobjects, ['Fm0']);
});
