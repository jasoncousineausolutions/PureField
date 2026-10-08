// Document-level printing: portfolios, print preferences, UserUnit
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { buildPdf } from './pdfbuild.js';

const latin1 = u8 => new TextDecoder('latin1').decode(u8);
const page = (extra = '', content = '0 0 1 rg 10 10 20 20 re f') => ({
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R ${extra} >>`,
  5: { dict: '<< >>', stream: content },
});

async function read(pdf) {
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const kids = (await doc.getObject(cat.Pages.num)).value.value.Kids.value;
  const pages = [];
  for (const k of kids) {
    const p = (await doc.getObject(k.num)).value.value;
    let content = '';
    for (const r of p.Contents.value) content += latin1((await doc.getObject(r.num)).streamBytes) + '\n';
    pages.push({ dict: p, content });
  }
  return { cat, pages };
}

test('a page with /UserUnit is scaled to points so every viewer prints it at its size', async () => {
  const objs = page('/UserUnit 2');
  const { pages } = await read((await flattenXfa(buildPdf(objs))).pdf);
  assert.deepEqual(pages[0].dict.MediaBox.value, [0, 0, 600, 600]);
  assert.match(pages[0].content, /^q\n2 0 0 2 0 0 cm\n/);
  assert.equal(pages[0].dict.UserUnit, undefined);
});

test('print preferences are kept: page scaling, duplex, tray, copies and page ranges', async () => {
  const objs = page();
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None /Duplex /DuplexFlipLongEdge /PickTrayByPDFSize true /NumCopies 2 /PrintPageRange [0 0] /HideToolbar true >> >>';
  const { cat } = await read((await flattenXfa(buildPdf(objs))).pdf);
  const vp = cat.ViewerPreferences.value;
  assert.equal(vp.PrintScaling.value, 'None');
  assert.equal(vp.Duplex.value, 'DuplexFlipLongEdge');
  assert.equal(vp.PickTrayByPDFSize, true);
  assert.equal(vp.NumCopies, 2);
  assert.deepEqual(vp.PrintPageRange.value, [0, 0]);
  assert.equal(vp.HideToolbar, undefined);
});

test('a PDF Portfolio prints its PDF files, each flattened, in place of its cover sheet', async () => {
  const inner = (color, extra = {}) => new TextDecoder().decode(buildPdf({ ...page('', `${color} rg 50 50 100 100 re f`), ...extra }));
  // the second file has a text field without an appearance: it is flattened too
  const second = inner('0 1 0', {
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R] >> >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Annots [10 0 R] >>',
    10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (f) /V (Inside) /F 4 /DA (/Helv 10 Tf 0 g) /Rect [10 10 100 30] /P 3 0 R >>',
  });
  const objs = page('', '0 0 0 rg BT /F1 12 Tf 10 10 Td (Cover) Tj ET');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /Collection << /Type /Collection >> /Names << /EmbeddedFiles << /Names [(a.pdf) 20 0 R (b.pdf) 22 0 R (c.txt) 24 0 R] >> >> >>';
  Object.assign(objs, {
    20: '<< /Type /Filespec /F (a.pdf) /EF << /F 21 0 R >> >>',
    21: { dict: '<< /Type /EmbeddedFile >>', stream: inner('1 0 0') },
    22: '<< /Type /Filespec /F (b.pdf) /EF << /F 23 0 R >> >>',
    23: { dict: '<< /Type /EmbeddedFile >>', stream: second },
    24: '<< /Type /Filespec /F (c.txt) /EF << /F 25 0 R >> >>',
    25: { dict: '<< /Type /EmbeddedFile >>', stream: 'just text' },
  });
  const out = await flattenXfa(buildPdf(objs), { fonts: null });
  assert.equal(out.pageCount, 2);
  assert.equal(out.portfolio, 2);
  const { pages } = await read(out.pdf);
  assert.match(pages[0].content, /1 0 0 rg 50 50 100 100 re f/);
  assert.match(pages[1].content, /0 1 0 rg 50 50 100 100 re f/);
  assert.match(pages[1].content, /\(Inside\) Tj/);
  assert.doesNotMatch(pages.map(p => p.content).join(''), /Cover/);
  assert.ok(out.log.entries.some(e => e.code === 'ACRO_PORTFOLIO'));
});

test('a /Collection without embedded PDFs prints its own pages', async () => {
  const objs = page();
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /Collection << >> >>';
  const out = await flattenXfa(buildPdf(objs));
  assert.equal(out.pageCount, 1);
  assert.equal(out.portfolio, undefined);
});

test('numbers with a plus sign or no digits before or after the point', async () => {
  // pdfdiff-NegativeFontSize's /Font [4 0 R +20] in an ExtGState
  const pdf = buildPdf({ ...page(), 7: '<< /A [+20 .5 -.25 5. 3 0 R -3] >>' });
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  const a = (await doc.getObject(7)).value.value.A.value;
  assert.deepEqual(a.slice(0, 4), [20, 0.5, -0.25, 5]);
  assert.deepEqual([a[4].type, a[4].num, a[5]], ['ref', 3, -3]);
});
