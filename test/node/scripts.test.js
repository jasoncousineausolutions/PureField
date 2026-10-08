// Writing systems beyond Latin: Arabic joining, bidi order, CJK fonts
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeArabic, visualOrder, cjkOrdering, scriptsIn } from '../../src/xfa/scripts.js';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { buildPdf } from './pdfbuild.js';

const hex = s => [...s].map(c => c.codePointAt(0).toString(16).toUpperCase());

test('Arabic letters take their joined forms; lam-alef is one ligature', () => {
  // السلام: alef isolated, lam initial, seen medial, lam-alef final, meem isolated
  assert.deepEqual(hex(shapeArabic('السلام')), ['FE8D', 'FEDF', 'FEB4', 'FEFC', 'FEE1']);
  // harakat do not break joining: بَب is beh initial, fatha, beh final
  assert.deepEqual(hex(shapeArabic('بَب')), ['FE91', '64E', 'FE90']);
  // Persian peh and keheh
  assert.deepEqual(hex(shapeArabic('پک')), ['FB58', 'FB8F']);
  assert.equal(shapeArabic('Latin only'), 'Latin only');
});

test('bidi: right-to-left runs reversed, numbers kept left to right, brackets mirrored', () => {
  assert.equal(visualOrder('abc אבג def'), 'abc גבא def');
  assert.equal(visualOrder('אבג 123 דהו'), 'והד 123 גבא');
  assert.equal(visualOrder('שלום (עולם)'), '(םלוע) םולש');
  assert.equal(visualOrder('Total: מחיר 42'), 'Total: 42 ריחמ');
  assert.equal(visualOrder('3.50 ש"ח'), 'ח"ש 3.50');
  assert.equal(visualOrder('plain'), 'plain');
});

test('CJK collections and the scripts some text needs', () => {
  assert.equal(cjkOrdering('한국어'), 'Korea1');
  assert.equal(cjkOrdering('日本語のテキスト'), 'Japan1');
  assert.equal(cjkOrdering('中文'), 'GB1');
  assert.deepEqual(scriptsIn('abc'), { cjk: false, other: false });
  assert.deepEqual(scriptsIn('שלום'), { cjk: false, other: true });
  assert.deepEqual(scriptsIn('中文'), { cjk: true, other: false });
});

const u16 = s => '<FEFF' + [...s].map(c => c.codePointAt(0).toString(16).padStart(4, '0')).join('') + '>';
async function field(value) {
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Annots [10 0 R] >>',
    5: { dict: '<< >>', stream: '' },
    10: `<< /Type /Annot /Subtype /Widget /FT /Tx /T (f) /V ${u16(value)} /F 4 /DA (/Helv 12 Tf 0 g) /Rect [10 10 290 40] /P 3 0 R >>`,
  });
  const out = await flattenXfa(pdf);
  const doc = await parsePdf(out.pdf.buffer.slice(out.pdf.byteOffset, out.pdf.byteOffset + out.pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const page = (await doc.getObject((await doc.getObject(cat.Pages.num)).value.value.Kids.value[0].num)).value.value;
  let content = '';
  for (const r of page.Contents.value) content += new TextDecoder('latin1').decode((await doc.getObject(r.num)).streamBytes) + '\n';
  const res = page.Resources.type === 'ref' ? (await doc.getObject(page.Resources.num)).value.value : page.Resources.value;
  return { content, fonts: res.Font.value, doc, log: out.log };
}

test('Arabic is drawn with DejaVu Sans at Reader\'s Arial Arabic size, joined and right to left; Latin and Hebrew with Liberation Sans', async () => {
  const hebrew = await field('Name: שלום');
  assert.match(hebrew.content, /<0031004400500048001d0003050d0505050c0519> Tj/); // Name: then ם ו ל ש
  const { content, fonts, log } = await field('Name: سلام');
  assert.match(content, /\/JU_R 12 Tf/);
  assert.match(content, /\/JU_V 10\.2 Tf\n90 Tz/);           // 0.85 of 12pt, 90% wide
  assert.ok(fonts.JU_V);
  assert.equal(log.byCode('FONT_SCRIPTS').length, 1);
});

test('a field value is a left-to-right line: Hebrew first stays at the left, its run reversed', async () => {
  // Reader prints "שלום (test)" as ם ו ל ש then " (test)", not "(test) " then the Hebrew
  const { content } = await field('שלום (test)');
  assert.match(content, /<050d0505050c05190003000b0057004800560057000c> Tj/);
});

test('CJK values use the standard CJK font of their collection, addressed in UTF-16', async () => {
  const { content, fonts, doc } = await field('日本語です');
  assert.match(content, /\/JU_CJ 12 Tf/);
  assert.match(content, /<65e5672c8a9e30673059> Tj/);
  assert.match((await field('中文')).content, /\/JU_CG 12 Tf/);
  const f = (await doc.getObject(fonts.JU_CJ.num)).value.value;
  assert.equal(f.Encoding.value, 'UniJIS-UTF16-H');
  const cid = (await doc.getObject(f.DescendantFonts.value[0].num)).value.value;
  assert.equal(cid.BaseFont.value, 'KozGoPr6N-Medium');
  assert.equal(cid.CIDSystemInfo.value.Ordering.value, 'Japan1');
});
