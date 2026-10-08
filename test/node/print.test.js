import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf } from './pdfbuild.js';
import { parsePdf } from '../../src/core/parser.js';
import { optimizeForPrint } from '../../src/index.js';

const bytesOf = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// A one-page PDF (200 × 200) with the given content stream(s) and resources
function page(contents, { resources = '', objects = {} } = {}) {
  const streams = [contents].flat();
  const nums = streams.map((_, i) => 10 + i);
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents [${nums.map(n => `${n} 0 R`).join(' ')}]
          /Resources << /Font << /F1 4 0 R >> ${resources} >> >>`,
    4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ...objects,
  };
  streams.forEach((s, i) => { objs[nums[i]] = { dict: '<< >>', stream: s }; });
  return buildPdf(objs);
}

// The page's content as text: its content streams and the form XObjects
// they draw, one after another
async function printed(input, options) {
  const { pdf, inverted } = await optimizeForPrint(input, { fonts: null, ...options });
  const doc = await parsePdf(bytesOf(pdf));
  const cat = (await doc.catalog()).value.value;
  const kid = (await doc.getObject(cat.Pages.num)).value.value.Kids.value[0];
  const pg = (await doc.getObject(kid.num)).value.value;
  const refs = pg.Contents.type === 'array' ? pg.Contents.value : [pg.Contents];
  let txt = '';
  for (const r of refs) txt += new TextDecoder('latin1').decode((await doc.getObject(r.num)).streamBytes) + '\n';
  const res = pg.Resources.type === 'ref' ? (await doc.getObject(pg.Resources.num)).value.value : pg.Resources.value;
  const xo = res.XObject?.type === 'ref' ? (await doc.getObject(res.XObject.num)).value.value : res.XObject?.value ?? {};
  const xobjects = {};
  for (const [name, ref] of Object.entries(xo)) {
    const o = await doc.getObject(ref.num);
    xobjects[name] = { dict: o.dict, bytes: o.streamBytes, text: new TextDecoder('latin1').decode(o.streamBytes) };
  }
  return { txt, xobjects, inverted };
}

// the grey set just before the first occurrence of `marker`
function greyBefore(txt, marker, op = 'g') {
  const at = txt.indexOf(marker);
  assert.ok(at >= 0, `${marker} not found in\n${txt}`);
  const before = txt.slice(0, at);
  const all = [...before.matchAll(new RegExp(`([\\d.]+) ${op}\\b`, 'g'))];
  return all.length ? Number(all.at(-1)[1]) : null;
}

test('a dark page with light text prints black on white', async () => {
  const { txt, inverted } = await printed(page(
    '0.1 0.1 0.12 rg 0 0 200 200 re f\n' +
    'BT /F1 12 Tf 1 1 1 rg 20 150 Td (Title) Tj ET\n' +
    'BT /F1 10 Tf 0.3 0.8 0.8 rg 20 120 Td (Accent) Tj ET\n'));
  assert.equal(inverted, 1);
  assert.equal(greyBefore(txt, '0 0 200 200 re'), 1);
  assert.equal(greyBefore(txt, '(Title)'), 0);
  const accent = greyBefore(txt, '(Accent)');
  assert.ok(accent > 0.2 && accent < 0.4, `accent grey ${accent}`);
  assert.doesNotMatch(txt, /\brg\b/);
});

test('an ordinary page keeps its greys, and hidden white text stays hidden', async () => {
  const { txt, inverted } = await printed(page(
    'BT /F1 12 Tf 0 0 0 rg 20 150 Td (Body) Tj ET\n' +
    'BT /F1 12 Tf 1 1 1 rg 20 120 Td (Hidden) Tj ET\n' +
    '0 0 0 RG 10 10 m 190 10 l S\n'));
  assert.equal(inverted, 0);
  assert.equal(greyBefore(txt, '(Body)'), 0);
  assert.equal(greyBefore(txt, '(Hidden)'), 1);
  assert.equal(greyBefore(txt, '10 10 m', 'G'), 0);
});

test('a dark panel with white text becomes a light tint with black text', async () => {
  const src = page(
    '0 0 0 rg 20 100 160 40 re f\n' +
    'BT /F1 12 Tf 1 1 1 rg 30 115 Td (Banner) Tj ET\n');
  let { txt } = await printed(src);
  assert.equal(greyBefore(txt, '20 100 160 40 re'), 0.92);
  assert.equal(greyBefore(txt, '(Banner)'), 0);
  ({ txt } = await printed(src, { panels: 1 }));
  assert.equal(greyBefore(txt, '20 100 160 40 re'), 1);
  await assert.rejects(optimizeForPrint(src, { panels: 2 }), TypeError);
});

test('a dark fill framing a lighter one is a border, not a panel', async () => {
  const { txt } = await printed(page(
    '0 g 50 50 20 20 re f\n' +
    '1 g 51 51 18 18 re f\n'));
  assert.equal(greyBefore(txt, '50 50 20 20 re'), 0);
  assert.equal(greyBefore(txt, '51 51 18 18 re'), 1);
});

test('a path painted in the next content stream gets its grey', async () => {
  const { txt } = await printed(page([
    '0.1 g 0 0 200 200 re f 0 0 0 rg 0.9 0.9 0.9 rg 20 20 50 50 re',
    'f\n',
  ]));
  assert.equal(greyBefore(txt, '20 20 50 50 re'), 0.1);
});

test('images are kept as they are, and text over them is not inverted', async () => {
  const pixels = '\x00\x40\x7f'.repeat(4); // ASCII: buildPdf writes UTF-8
  const { txt, xobjects } = await printed(page(
    '0 g 0 0 200 200 re f\n' +
    'q 100 0 0 100 50 50 cm /Im1 Do Q\n' +
    'BT /F1 12 Tf 1 1 0 rg 60 90 Td (Caption) Tj ET\n', {
      resources: '/XObject << /Im1 20 0 R >>',
      objects: { 20: { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>', stream: pixels } },
    }));
  const image = Object.values(xobjects).find(x => x.dict.Subtype?.value === 'Image');
  assert.deepEqual([...image.bytes], [...pixels].map(c => c.charCodeAt(0)));
  // yellow (luminance 0.886), as it was: the photo under it is not inverted
  assert.ok(Math.abs(greyBefore(txt, '(Caption)') - 0.886) < 0.01);
});

test('a dark shading used as the page background is taken out', async () => {
  const { txt } = await printed(page('/Sh1 sh\nBT /F1 12 Tf 1 g 20 150 Td (On gradient) Tj ET\n', {
    resources: '/Shading << /Sh1 << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 0 200] /Function << /FunctionType 2 /Domain [0 1] /C0 [0 0 0.2] /C1 [0.2 0.2 0.3] /N 1 >> >> >>',
  }));
  assert.doesNotMatch(txt, /\bsh\b/);
  assert.equal(greyBefore(txt, '(On gradient)'), 0);
});

test('form XObjects are recoloured with the page they are drawn on', async () => {
  const { xobjects } = await printed(page('0 g 0 0 200 200 re f /Fm1 Do\n', {
    resources: '/XObject << /Fm1 20 0 R >>',
    objects: { 20: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> >>',
      stream: 'BT /F1 12 Tf 0.95 0.95 0.95 rg 20 150 Td (In form) Tj ET' } },
  }));
  const form = Object.values(xobjects).find(x => /In form/.test(x.text));
  assert.equal(greyBefore(form.text, '(In form)'), 0.05);
  assert.doesNotMatch(form.text, /\brg\b/);
});

test('a fill in the colour of the background under it stays invisible', async () => {
  const { txt } = await printed(page(
    '0.36 0.08 0.08 rg 0 0 200 200 re f\n' +
    '0.36 0.08 0.08 rg 20 80 160 30 re f\n' +
    'BT /F1 12 Tf 1 1 1 rg 30 90 Td (Spaced) Tj ET\n'));
  assert.equal(greyBefore(txt, '20 80 160 30 re'), 1);
  assert.equal(greyBefore(txt, '(Spaced)'), 0);
});
