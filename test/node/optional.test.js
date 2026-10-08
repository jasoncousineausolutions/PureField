// Optional content (layers): what does not print is taken out of the page
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { filterContent } from '../../src/core/optional.js';
import { buildPdf } from './pdfbuild.js';

const latin1 = u8 => new TextDecoder('latin1').decode(u8);
async function content(pdf) {
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  assert.equal(cat.OCProperties, undefined);
  const kids = (await doc.getObject(cat.Pages.num)).value.value.Kids.value;
  const page = (await doc.getObject(kids[0].num)).value.value;
  const refs = page.Contents.type === 'array' ? page.Contents.value : [page.Contents];
  let s = '';
  for (const r of refs) s += latin1((await doc.getObject(r.num)).streamBytes) + '\n';
  return s;
}

// groups 10 (on), 11 (off in /D), 12 (on, but PrintState OFF), 13 (off, PrintState ON)
function layered(stream, { extra = {}, annots = '', fields = '' } = {}) {
  return buildPdf({
    1: `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [10 0 R 11 0 R 12 0 R 13 0 R]
         /D << /ON [10 0 R 12 0 R] /OFF [11 0 R 13 0 R] /AS [<< /Event /Print /Category [/Print] /OCGs [12 0 R 13 0 R] >>] >> >>
         ${fields ? `/AcroForm << /Fields [${fields}] >>` : ''} >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Annots [${annots}]
         /Resources << /Properties << /On 10 0 R /Off 11 0 R /PrintOff 12 0 R /PrintOn 13 0 R /All 14 0 R /Not 15 0 R >>
           /XObject << /Xon 20 0 R /Xoff 21 0 R >> >> >>`,
    5: { dict: '<< >>', stream },
    10: '<< /Type /OCG /Name (on) >>',
    11: '<< /Type /OCG /Name (off) >>',
    12: '<< /Type /OCG /Name (screen only) /Usage << /Print << /PrintState /OFF >> >> >>',
    13: '<< /Type /OCG /Name (print only) /Usage << /Print << /PrintState /ON >> >> >>',
    14: '<< /Type /OCMD /OCGs [10 0 R 11 0 R] /P /AllOn >>',
    15: '<< /Type /OCMD /VE [/Not 11 0 R] >>',
    20: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /OC 10 0 R >>', stream: '0 0 5 5 re f' },
    21: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /OC 11 0 R >>', stream: '0 0 6 6 re f' },
    ...extra,
  });
}

test('layers: the default configuration, print usage and membership dictionaries decide what prints', async () => {
  const pdf = layered([
    '/OC /On BDC (on) Tj EMC',
    '/OC /Off BDC (off) Tj /Span <</ActualText (x)>> BDC (nested) Tj EMC (still off) Tj EMC',
    '/OC /PrintOff BDC (screen only) Tj EMC',
    '/OC /PrintOn BDC (print only) Tj EMC',
    '/OC /All BDC (all on) Tj EMC',
    '/OC /Not BDC (not off) Tj EMC',
    '/Xon Do /Xoff Do',
    '(a string with EMC inside) Tj',
  ].join('\n'));
  const c = await content((await flattenXfa(pdf, { fonts: null })).pdf);
  for (const kept of ['(on)', '(print only)', '(not off)', '/Xon Do', '(a string with EMC inside)']) assert.ok(c.includes(kept), kept);
  for (const gone of ['(off)', '(nested)', '(still off)', '(screen only)', '(all on)', '/Xoff Do']) assert.ok(!c.includes(gone), gone);
});

test('layers: an annotation whose /OC does not print is left out', async () => {
  const ap = '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] >>';
  const pdf = layered('(page) Tj', {
    annots: '30 0 R 31 0 R',
    extra: {
      30: '<< /Type /Annot /Subtype /Square /F 4 /Rect [10 10 20 20] /OC 11 0 R /AP << /N 32 0 R >> >>',
      31: '<< /Type /Annot /Subtype /Square /F 4 /Rect [30 30 40 40] /OC 13 0 R /AP << /N 32 0 R >> >>',
      32: { dict: ap, stream: '0 0 10 10 re S' },
    },
  });
  const c = await content((await flattenXfa(pdf, { fonts: null })).pdf);
  assert.doesNotMatch(c, /cm \/JcsAP\d Do Q[^]*cm \/JcsAP\d Do Q/); // one stamp only
  assert.match(c, /1 0 0 1 30 30 cm \/JcsAP1 Do Q/);
});

test('layers: the content filter keeps everything else byte for byte', async () => {
  const src = new TextEncoder().encode('q 1 0 0 1 0 0 cm\nBI /W 1 /H 1 /BPC 8 /CS /G ID \x00EMC EI\n/OC /h BDC (x) Tj EMC Q');
  const out = await filterContent(src, { properties: n => (n === 'h' ? { hide: true } : null), xobject: () => null,
    visible: async oc => !oc.hide, xobjectVisible: async () => true });
  const s = latin1(out);
  assert.match(s, /^q 1 0 0 1 0 0 cm\nBI \/W 1 \/H 1 \/BPC 8 \/CS \/G ID \x00EMC EI\n/);
  assert.match(s, /\n Q\n$/);
  assert.doesNotMatch(s, /\(x\)/);
  // nothing hidden: unchanged (null)
  assert.equal(await filterContent(src, { properties: () => null, xobject: () => null, visible: async () => true, xobjectVisible: async () => true }), null);
});

test('layers: a group that prints keeps its content as plain marked content, without the group', async () => {
  const src = new TextEncoder().encode('/OC /v BDC (shown) Tj EMC /OC /h BDC (gone) Tj EMC');
  const out = latin1(await filterContent(src, { properties: n => ({ hide: n === 'h' }), xobject: () => null,
    visible: async oc => !oc.hide, xobjectVisible: async () => true }));
  assert.match(out, /\/JcsOC BMC\n \(shown\) Tj EMC/);
  assert.doesNotMatch(out, /\/OC|gone/);
});
