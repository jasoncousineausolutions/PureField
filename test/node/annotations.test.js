// Annotations without an appearance, drawn from their dictionaries
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { ContentStream } from '../../src/core/writer.js';
import { lineEnding } from '../../src/annotations.js';
import { buildPdf } from './pdfbuild.js';

const latin1 = u8 => new TextDecoder('latin1').decode(u8);

// One page holding the given annotations; the page's own content and
// resources (pageRes) can be set
async function flatten(annots, { pageRes = '', mediaBox = '0 0 300 300', opts = {} } = {}) {
  const extra = {};
  const refs = annots.map((a, i) => { extra[10 + i] = a; return `${10 + i} 0 R`; });
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Contents 5 0 R /Annots [${refs.join(' ')}] ${pageRes} >>`,
    5: { dict: '<< >>', stream: '0 0 1 rg 10 10 20 20 re f' },
    ...extra,
  });
  const out = await flattenXfa(pdf, { fonts: null, ...opts });
  const doc = await parsePdf(out.pdf.buffer.slice(out.pdf.byteOffset, out.pdf.byteOffset + out.pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const kids = (await doc.getObject(cat.Pages.num)).value.value.Kids.value;
  const page = (await doc.getObject(kids[0].num)).value.value;
  let content = '';
  for (const r of page.Contents.value) content += latin1((await doc.getObject(r.num)).streamBytes) + '\n';
  const res = page.Resources.type === 'ref' ? (await doc.getObject(page.Resources.num)).value.value : page.Resources.value;
  return { content, res, log: out.log, doc };
}

test('a highlight fills its quadrilaterals in /C, multiplied with the page', async () => {
  const { content, res } = await flatten([
    '<< /Type /Annot /Subtype /Highlight /F 4 /Rect [10 10 110 40] /C [1 1 0] /QuadPoints [10 40 110 40 10 28 110 28 10 24 60 24 10 12 60 12] >>',
  ]);
  assert.match(content, /\/PfGS1 gs\n1 1 0 rg\n10 40 m\n110 40 l\n110 28 l\n10 28 l\nh\n10 24 m\n60 24 l\n60 12 l\n10 12 l\nh\nf/);
  assert.equal(res.ExtGState.value.PfGS1.value.BM.value, 'Multiply');
});

test('underline, strike-out and squiggly lines follow each quadrilateral', async () => {
  const quad = '/QuadPoints [10 22 70 22 10 10 70 10]';
  const { content } = await flatten([
    `<< /Type /Annot /Subtype /Underline /F 4 /Rect [10 10 70 22] /C [0 0.5 0] ${quad} >>`,
    `<< /Type /Annot /Subtype /StrikeOut /F 4 /Rect [10 10 70 22] /C [1 0 0] ${quad} >>`,
    `<< /Type /Annot /Subtype /Squiggly /F 4 /Rect [10 10 70 22] ${quad} >>`,
  ]);
  // as Reader draws them, from the 12pt height: lines 12/14 wide, 0.15 and
  // 0.44 of the height up; the zig-zag 1.5 high in 1.5pt steps, 0.75 up
  assert.match(content, /0 0\.5 0 RG\n0\.857 w\n10 11\.8 m\n70 11\.8 l\nS/);
  assert.match(content, /1 0 0 RG\n0\.857 w\n10 15\.28 m\n70 15\.28 l\nS/);
  assert.match(content, /0 0 0 RG\n0\.24 w\n10 10\.75 m\n11\.5 12\.25 l\n13 10\.75 l\n14\.5 12\.25 l/);
});

test('lines, squares, circles, polygons and ink take their border and colours', async () => {
  const { content } = await flatten([
    '<< /Type /Annot /Subtype /Line /F 4 /Rect [0 0 300 300] /L [20 20 120 20] /C [0 0 1] /IC [1 0 0] /BS << /W 2 >> /LE [/None /ClosedArrow] >>',
    '<< /Type /Annot /Subtype /Square /F 4 /Rect [20 50 120 100] /C [0 0 1] /IC [0.5 0.5 0.5] /Border [0 0 4] /RD [2 2 2 2] >>',
    '<< /Type /Annot /Subtype /Circle /F 4 /Rect [20 150 120 200] /Border [0 0 0] >>',
    '<< /Type /Annot /Subtype /Polygon /F 4 /Rect [0 0 300 300] /Vertices [10 210 50 250 90 210] /C [0 1 0] /BS << /W 3 /S /D /D [4 2] >> >>',
    '<< /Type /Annot /Subtype /Ink /F 4 /Rect [0 0 300 300] /InkList [[200 200 210 220 220 200] [230 230]] /C [1 0 0] /CA 0.5 >>',
  ]);
  // the line, then its arrow at the end: 12pt (6 × width) long, 30° each side, filled in /IC
  assert.match(content, /0 0 1 RG\n2 w\n20 20 m\n120 20 l\nS\n108 26\.928 m\n120 20 l\n108 13\.072 l\nh\n1 0 0 rg\nB/);
  // the square inside its rectangle less /RD, its 4pt border inside that
  assert.match(content, /0\.5 0\.5 0\.5 rg\n0 0 1 RG\n4 w\n24 54 92 42 re\nB/);
  // a circle with no border and no fill draws nothing
  assert.doesNotMatch(content, /150/);
  // the polygon closed, dashed
  assert.match(content, /0 1 0 RG\n3 w\n\[4 2\] 0 d\n1 j\n10 210 m\n50 250 l\n90 210 l\nh\nS/);
  // ink: round caps and joins; a single point is a dot; /CA half opaque
  assert.match(content, /\/PfGS1 gs\n1 0 0 RG\n1 w\n1 J\n1 j\n200 200 m\n210 220 l\n220 200 l\n230 230 m\n230 230 l\nS/);
});

test('/CA sets the opacity of strokes and fills', async () => {
  const { content, res } = await flatten([
    '<< /Type /Annot /Subtype /Square /F 4 /Rect [20 50 120 100] /CA 0.3 >>',
  ]);
  assert.match(content, /\/PfGS1 gs/);
  const gs = res.ExtGState.value.PfGS1.value;
  assert.equal(gs.CA, 0.3);
  assert.equal(gs.ca, 0.3);
});

test('the page\'s own graphics states are kept beside ours', async () => {
  const { res } = await flatten([
    '<< /Type /Annot /Subtype /Highlight /F 4 /Rect [10 10 110 40] /QuadPoints [10 40 110 40 10 28 110 28] >>',
  ], { pageRes: '/Resources << /ExtGState << /Mine << /CA 0.7 >> >> >>' });
  assert.equal(res.ExtGState.value.Mine.value.CA, 0.7);
  assert.ok(res.ExtGState.value.PfGS1);
});

test('free text wraps /Contents in the box in the /DA font, with /C fill and a border in the /DA colour', async () => {
  const { content } = await flatten([
    '<< /Type /Annot /Subtype /FreeText /F 4 /Rect [100 100 200 160] /C [1 1 0.8] /Border [0 0 1] /DA (/Helv 10 Tf 0 0 1 rg) /Q 2 /Contents (Hello there world) >>',
  ]);
  assert.match(content, /1 1 0\.8 rg\n100 100 100 60 re\nf/);
  assert.match(content, /0 0 1 RG\n1 w\n100\.5 100\.5 99 59 re\nS/);
  assert.match(content, /1 0 0 1 101 101 cm/);
  // right-aligned (Q 2), blue, Helvetica 10pt
  assert.match(content, /0 0 1 rg\nBT\n\/F_H 10 Tf/);
  assert.match(content, /\(Hello there world\) Tj/);
});

test('free text: /DS colour and size win over /DA; a callout draws its /CL line', async () => {
  const { content } = await flatten([
    '<< /Type /Annot /Subtype /FreeText /F 4 /Rect [100 100 200 160] /Border [0 0 0] /DA (/Helv 10 Tf 0 g) /DS (font: Helvetica 14pt; color:#FF0000) /IT /FreeTextCallout /CL [20 20 60 60 100 130] /LE [/OpenArrow] /Contents (Hi) >>',
  ]);
  assert.match(content, /0 0 0 RG\n1 w\n20 20 m\n60 60 l\n100 130 l\nS/);
  assert.match(content, /1 0 0 rg\nBT\n\/F_H 14 Tf/);
});

test('a note without an appearance prints an icon; attachments without one print nothing', async () => {
  const { content, log } = await flatten([
    '<< /Type /Annot /Subtype /Text /F 4 /Rect [50 250 50 250] /Name /Comment >>',
    '<< /Type /Annot /Subtype /FileAttachment /F 4 /Rect [50 50 70 70] /Name /PushPin >>',
    '<< /Type /Annot /Subtype /Text /Rect [80 250 100 270] >>', // no Print flag
  ]);
  // a 20pt icon hanging from the rectangle's top-left, yellow
  assert.match(content, /1 1 0 rg\n1 j\n52 231 m\n52 249 l/);
  assert.doesNotMatch(content, /82 /);
  assert.equal(log.byCode('ACRO_ANNOT_NO_APPEARANCE').length, 1);
});

test('a stamp without an appearance is Reader\'s placeholder: its rectangle crossed, in black', async () => {
  const { content } = await flatten([
    '<< /Type /Annot /Subtype /Stamp /F 4 /Rect [50 50 250 100] /Name /NotApproved /C [1 0 0] >>',
  ]);
  assert.match(content, /0 0 0 RG\n1 w\n50\.5 50\.5 199 49 re\n50\.5 50\.5 m\n249\.5 99\.5 l\n50\.5 99\.5 m\n249\.5 50\.5 l\nS/);
  assert.doesNotMatch(content, /Tj|1 0 0 RG/);
});

const curves = cs => cs.toString().split('\n').filter(o => o.endsWith(' c')).map(o => o.split(' ').slice(0, 6).map(Number));

test('a cloudy rectangle: Acrobat\'s curls, radius 4 × intensity + half the line width, 2·cos 34° radii apart', async () => {
  const { cloudyRect } = await import('../../src/core/cloudy.js');
  const cs = new ContentStream();
  cloudyRect(cs, 0, 0, 100, 50, 1, 1);
  const ops = cs.toString().split('\n');
  assert.match(ops[0], / m$/);
  assert.equal(ops.at(-1), 'h');
  // every curve point within a radius (4.5) of the rectangle, outside it
  const r = 4.5;
  const out = ([x, y]) => Math.max(-x, x - 100, -y, y - 50);
  const ends = curves(cs).map(c => c.slice(4, 6));
  assert.ok(ends.every(p => out(p) <= r + 0.01 && out(p) >= -r));
  assert.ok(ends.some(p => out(p) > r - 0.1));
  // the bottom edge's curl tops (the points furthest out) every 2·cos 34°·r
  const tops = ends.filter(([x, y]) => y < -r + 0.01 && x > 10 && x < 90).map(p => p[0]).sort((a, b) => a - b);
  const gaps = tops.slice(1).map((x, i) => x - tops[i]);
  assert.ok(gaps.length >= 8 && gaps.every(g => Math.abs(g - 2 * Math.cos(34 * Math.PI / 180) * r) < 0.01));
  // intensity 0: the plain rectangle
  const plain = new ContentStream();
  cloudyRect(plain, 0, 0, 100, 50, 0, 1);
  assert.equal(plain.toString(), '0 0 100 50 re');
});

test('a cloudy polygon: the closing edge straight and no curl at the first vertex, as Reader prints /Vertices', async () => {
  const { cloudyPolygon } = await import('../../src/core/cloudy.js');
  const cs = new ContentStream();
  cloudyPolygon(cs, [[0, 0], [100, 0], [100, 50], [0, 50]], 1, 1);
  const ops = cs.toString().split('\n');
  assert.equal(ops.at(-1), 'h');
  // the path starts on the first edge's first intermediate curl, not round (0, 0)
  const [x0, y0] = ops[0].split(' ').map(Number);
  assert.ok(x0 > 1 && y0 < 0 && y0 > -4.5);
  // the last curl hangs round the last vertex (0, 50): the path ends left of it
  const last = curves(cs).at(-1).slice(4, 6);
  assert.ok(last[0] < 0 && last[0] > -4.6 && last[1] < 50);
  // nothing curls along the closing edge x = 0, y 0 to 50
  assert.ok(curves(cs).every(c => !(c[4] < -0.5 && c[5] > 5 && c[5] < 45)));
});

test('a cloudy square in a flattened page: curls, no straight rectangle', async () => {
  const { content } = await flatten([
    '<< /Type /Annot /Subtype /Square /F 4 /Rect [20 50 120 100] /C [1 0 0] /BE << /S /C /I 2 >> /RD [10 10 10 10] >>',
  ]);
  assert.doesNotMatch(content, / re\n/);
  assert.match(content, /1 0 0 RG/);
});

test('annotations: false leaves generated annotations out too', async () => {
  const { content } = await flatten([
    '<< /Type /Annot /Subtype /Square /F 4 /Rect [20 50 120 100] /C [0 0 1] >>',
  ], { opts: { annotations: false } });
  assert.doesNotMatch(content, /0 0 1 RG/);
});

test('drawn in the page box\'s frame: a CropBox origin is taken off', async () => {
  const { content } = await flatten([
    '<< /Type /Annot /Subtype /Line /F 4 /Rect [0 0 300 300] /L [120 120 160 120] >>',
  ], { pageRes: '/CropBox [100 100 300 300]' });
  assert.match(content, /1 0 0 1 -100 -100 cm\n0 0 0 RG\n1 w\n120 120 m\n160 120 l/);
});

test('line endings: each shape at the end, sized from the line width', () => {
  const ops = kind => { const cs = new ContentStream(); lineEnding(cs, kind, 0, 0, 10, 0, 1, [1, 0, 0]); return cs.toString(); };
  assert.equal(ops('None'), '');
  assert.equal(ops('OpenArrow'), '4 3.464 m\n10 0 l\n4 -3.464 l\nS');
  assert.equal(ops('ROpenArrow'), '16 3.464 m\n10 0 l\n16 -3.464 l\nS');
  assert.equal(ops('Square'), '7 -3 m\n13 -3 l\n13 3 l\n7 3 l\nh\n1 0 0 rg\nB');
  assert.equal(ops('Diamond'), '7 0 m\n10 3 l\n13 0 l\n10 -3 l\nh\n1 0 0 rg\nB');
  assert.equal(ops('Butt'), '10 3 m\n10 -3 l\nS');
  assert.match(ops('Circle'), /^13 0 m\n13 1\.657 /);
  assert.match(ops('Slash'), /^8\.5 2\.598 m\n11\.5 -2\.598 l\nS$/);
});

test('an annotation written into /Annots itself, not referenced, is drawn too', async () => {
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Annots [<< /Type /Annot /Subtype /Square /F 4 /Rect [10 10 110 40] /C [1 0 0] >>] >>',
    5: { dict: '<< >>', stream: '' },
  });
  const out = await flattenXfa(pdf, { fonts: null });
  const doc = await parsePdf(out.pdf.buffer.slice(out.pdf.byteOffset, out.pdf.byteOffset + out.pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const page = (await doc.getObject((await doc.getObject(cat.Pages.num)).value.value.Kids.value[0].num)).value.value;
  let content = '';
  for (const r of page.Contents.value) content += latin1((await doc.getObject(r.num)).streamBytes) + '\n';
  assert.match(content, /1 0 0 RG/);
});
