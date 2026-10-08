// Regressions from the third test batch (samples/xfa)
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';

const B3 = name => readFileSync(new URL(`../../samples/xfa/${name}.pdf`, import.meta.url));

test('an unusable template prints the PDF\'s own pages, as Reader does', async () => {
  // an empty <template/>: one blank page
  const empty = await flattenXfa(B3('itext-empty-xfa'), { fonts: null });
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.log.byCode('XFA_TEMPLATE_UNUSABLE').length, 1);
  // a template packet that is a whole second XDP document: the 5 shell pages
  const { pdf, pageCount } = await flattenXfa(B3('pdfium-rectangles-multipage'), { fonts: null });
  assert.equal(pageCount, 5);
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  assert.ok(await doc.catalog());
  assert.ok(!new TextDecoder('latin1').decode(pdf).includes('/XFA'));
});

test('saved form state is restored before scripts run; banner, menu and main content areas', async () => {
  // prePrint shows every section the saved state had hidden; a visible
  // subform's contentArea break sends the content to the main area: 2 pages
  const { pageCount, log } = await flattenXfa(B3('hmrc-c1800-chief'), { fonts: null });
  assert.equal(pageCount, 2);
  assert.ok(log.byCode('XFA_SCRIPT_FAILED').length <= 2);
});

test('a record inside a nested xfa:data binds; startNew breaks start a new page', async () => {
  const { pdf, pageCount } = await flattenXfa(B3('itext-dataset-2page'), { fonts: null });
  assert.equal(pageCount, 2);
  assert.ok(new TextDecoder('latin1').decode(pdf).includes('(HH Mining operations) Tj'));
});

test('a saved fill turned blue by a script; a text field holding a PNG draws it', async () => {
  const blue = await flattenXfa(B3('itext-release-objects'), { fonts: null });
  assert.ok(new TextDecoder('latin1').decode(blue.pdf).includes('0 0 1 rg'));
  const png = await flattenXfa(B3('pdfium-png-image'), { fonts: null });
  assert.ok(/\/Subtype \/Image/.test(new TextDecoder('latin1').decode(png.pdf)));
});

test('an imageEdit field with a template image and no data draws the template image', async () => {
  const { pdf } = await flattenXfa(B3('adobe-master-pages-test'), { fonts: null });
  assert.ok(/\/Subtype \/Image/.test(new TextDecoder('latin1').decode(pdf)));
});

test('an image href is resolved in the PDF\'s /XFAImages name tree', async () => {
  const { pdf } = await flattenXfa(B3('itext-dataset-2page'), { fonts: null });
  const text = new TextDecoder('latin1').decode(pdf);
  // the logo and the two product images
  assert.ok((text.match(/\/Subtype \/Image/g) ?? []).length >= 3);
});
