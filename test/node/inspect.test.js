import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectPdf, PasswordError } from '../../src/index.js';
import { buildPdf } from './pdfbuild.js';

const file = name => readFileSync(new URL(`../../samples/${name}`, import.meta.url));

test('inspectPdf: an XFA form, its fields, data, scripts and barcodes with how Reader prints each', async () => {
  const i = await inspectPdf(file('reader-tests/barcodes.pdf'));
  assert.equal(i.xfa.dynamic, true);
  assert.equal(i.xfa.fields, 23);
  assert.equal(i.acroForm, null);
  const by = Object.fromEntries(i.xfa.barcodes.map(b => [b.type, b]));
  assert.deepEqual(by.aztec, { type: 'aztec', count: 2, reader: 'box' });
  assert.equal(by.ean13add2.reader, 'dropped');
  assert.equal(by.postAUSStandard.reader, 'drawn');
  const po = await inspectPdf(readFileSync(new URL('../../samples/xfa/Purchase.Order.pdf', import.meta.url)));
  assert.ok(po.xfa.scripts > 0 && po.xfa.filled > 0);
});

test('inspectPdf: AcroForm fields by type, filled ones, and the text beyond Latin', async () => {
  const i = await inspectPdf(file('reader-tests/fields.pdf'));
  assert.equal(i.xfa, null);
  assert.deepEqual(i.acroForm.types, { text: 6, checkbox: 0, radio: 0, choice: 0, button: 7, signature: 1 });
  assert.equal(i.acroForm.fields, 14);
  assert.equal(i.acroForm.needAppearances, true);
  assert.deepEqual(i.text, { otherScripts: true, cjk: true });
});

test('inspectPdf: printable markup by type; links, popups and hidden ones left out', async () => {
  const i = await inspectPdf(file('reader-tests/annotations.pdf'));
  assert.deepEqual(i.markup, { total: 19, types: { Stamp: 14, Square: 1, Circle: 1, Polygon: 1, FreeText: 2 } });
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R 5 0 R 6 0 R 7 0 R] >>',
    4: '<< /Type /Annot /Subtype /Highlight /F 4 /Rect [0 0 50 10] >>',
    5: '<< /Type /Annot /Subtype /Link /F 4 /Rect [0 20 50 30] >>',
    6: '<< /Type /Annot /Subtype /Square /F 6 /Rect [0 40 50 60] >>',   // hidden
    7: '<< /Type /Annot /Subtype /Ink /Rect [0 70 50 90] >>',            // no Print flag
  });
  const p = await inspectPdf(pdf);
  assert.deepEqual(p.markup, { total: 1, types: { Highlight: 1 } });
  assert.equal(p.acroForm, null);
  assert.equal(p.xfa, null);
});

test('inspectPdf: CJK page fonts the file does not embed; a password it needs', async () => {
  assert.equal((await inspectPdf(file('reader-tests/cjk-page-fonts.pdf'))).cjkPageFonts, true);
  const locked = file('nonxfa/pdfium-encrypted_hello_world_r6.pdf');
  await assert.rejects(inspectPdf(locked), PasswordError);
  const open = await inspectPdf(locked, { password: 'hôtel' });
  assert.equal(open.encrypted, true);
  assert.equal(open.pages, 1);
});
