// AcroForm (non-XFA) flattening: widget appearances stamped onto the pages
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { buildPdf } from './pdfbuild.js';

const latin1 = u8 => new TextDecoder('latin1').decode(u8);

// One or two pages; widgets and annotations given as object source
function form({ annots = '', annots2 = null, fields = '', extra = {}, acro = '' }) {
  return buildPdf({
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${fields}] ${acro} >> >>`,
    2: `<< /Type /Pages /Kids [3 0 R${annots2 !== null ? ' 4 0 R' : ''}] /Count ${annots2 !== null ? 2 : 1} >>`,
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Annots [${annots}] >>`,
    ...(annots2 !== null ? { 4: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Annots [${annots2}] >>` } : {}),
    5: { dict: '<< >>', stream: '0 0 1 rg 10 10 20 20 re f' },
    ...extra,
  });
}

async function pageInfo(pdf, index = 0) {
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const kids = (await doc.getObject(cat.Pages.num)).value.value.Kids.value;
  const page = (await doc.getObject(kids[index].num)).value.value;
  const refs = page.Contents.type === 'array' ? page.Contents.value : [page.Contents];
  let content = '';
  for (const r of refs) content += latin1((await doc.getObject(r.num)).streamBytes) + '\n';
  return { cat, page, content, doc };
}

const AP = (bbox = '0 0 100 20', more = '') => ({ dict: `<< /Type /XObject /Subtype /Form /BBox [${bbox}] ${more} >>`, stream: '1 0 0 rg 0 0 100 20 re f' });

test('a widget\'s normal appearance is stamped onto its rectangle; the AcroForm goes', async () => {
  const pdf = form({
    fields: '10 0 R', annots: '10 0 R',
    extra: {
      10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Ann) /F 4 /Rect [50 200 150 220] /AP << /N 11 0 R >> /P 3 0 R >>',
      11: AP(),
    },
  });
  const { pdf: out, acroForm, pageCount } = await flattenXfa(pdf, { fonts: null });
  assert.equal(acroForm, true);
  assert.equal(pageCount, 1);
  const { cat, page, content } = await pageInfo(out);
  assert.equal(cat.AcroForm, undefined);
  assert.equal(page.Annots, undefined);
  // the page's own content first, then the appearance at the rectangle
  assert.ok(content.indexOf('10 10 20 20 re') < content.indexOf('/JcsAP1 Do'));
  assert.match(content, /q 1 0 0 1 50 200 cm \/JcsAP1 Do Q/);
  assert.match(latin1(out), /\/JcsAP1 \d+ 0 R/);
});

test('the appearance BBox, through its Matrix, is fitted to the rectangle', async () => {
  // a 90° rotated appearance: BBox 0 0 20 100 turned onto a 100 × 20 rectangle
  const pdf = form({
    fields: '10 0 R', annots: '10 0 R',
    extra: {
      10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (r) /F 4 /Rect [50 200 150 220] /AP << /N 11 0 R >> >>',
      11: AP('0 0 20 100', '/Matrix [0 1 -1 0 0 0]'),
    },
  });
  const { content } = await pageInfo((await flattenXfa(pdf, { fonts: null })).pdf);
  // the transformed BBox spans x -100..0, y 0..20: moved right by 150
  assert.match(content, /q 1 0 0 1 150 200 cm \/JcsAP1 Do Q/);
});

test('only printable, visible widgets print; a check box shows its /AS state', async () => {
  const pdf = form({
    fields: '10 0 R 12 0 R 13 0 R', annots: '10 0 R 12 0 R 13 0 R',
    extra: {
      10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (noprint) /F 0 /Rect [0 0 100 20] /AP << /N 11 0 R >> >>',
      12: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (hidden) /F 6 /Rect [0 0 100 20] /AP << /N 11 0 R >> >>',
      13: '<< /Type /Annot /Subtype /Widget /FT /Btn /T (cb) /V /Yes /AS /Yes /F 4 /Rect [10 10 30 30] /AP << /N << /Yes 14 0 R /Off 11 0 R >> >> >>',
      11: AP(),
      14: { dict: '<< /Subtype /Form /BBox [0 0 20 20] >>', stream: '0 g 2 2 16 16 re f' },
    },
  });
  const { content } = await pageInfo((await flattenXfa(pdf, { fonts: null })).pdf);
  assert.equal((content.match(/ Do Q/g) ?? []).length, 1);
  assert.match(content, /q 1 0 0 1 10 10 cm \/JcsAP1 Do Q/);
});

test('a widget prints on the page its /P names; a page-only widget and a markup annotation print too', async () => {
  const pdf = form({
    fields: '10 0 R', annots: '', annots2: '10 0 R 12 0 R 13 0 R 15 0 R',
    extra: {
      10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (onP) /F 4 /Rect [0 0 100 20] /AP << /N 11 0 R >> /P 3 0 R >>',
      11: AP(),
      12: '<< /Type /Annot /Subtype /Widget /Parent 16 0 R /F 4 /Rect [0 50 100 70] /AP << /N 11 0 R >> >>',
      16: '<< /FT /Tx /T (orphan) >>',
      13: '<< /Type /Annot /Subtype /Square /F 4 /Rect [0 100 100 120] /AP << /N 11 0 R >> /Popup 15 0 R >>',
      15: '<< /Type /Annot /Subtype /Popup /F 4 /Rect [0 150 100 170] /Parent 13 0 R >>',
    },
  });
  const out = (await flattenXfa(pdf, { fonts: null })).pdf;
  const p1 = (await pageInfo(out, 0)).content, p2 = (await pageInfo(out, 1)).content;
  assert.match(p1, /cm \/JcsAP1 Do Q/);
  assert.equal((p2.match(/ Do Q/g) ?? []).length, 2); // the orphan widget and the square; no popup
});

test('a PDF without any form is copied as it is', async () => {
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R >>',
    5: { dict: '<< >>', stream: '0 0 1 rg 10 10 20 20 re f' },
  });
  const { pdf: out, pageCount } = await flattenXfa(pdf, { fonts: null });
  assert.equal(pageCount, 1);
  assert.match((await pageInfo(out)).content, /10 10 20 20 re f/);
});

// --- generated appearances --------------------------------------------------

const one = (widget, { acro = '', extra = {} } = {}) => form({
  fields: '10 0 R', annots: '10 0 R',
  acro: `/DR << /Font << /Helv 20 0 R /TiRo 21 0 R >> >> ${acro}`,
  extra: {
    10: `<< /Type /Annot /Subtype /Widget /F 4 /T (f) ${widget} >>`,
    20: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    21: '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    ...extra,
  },
});
const gen = async (widget, opts) => (await pageInfo((await flattenXfa(one(widget, opts), { fonts: null })).pdf)).content;

test('a text field without an appearance shows its value in the /DA font, size and colour', async () => {
  const c = await gen('/FT /Tx /V (Hello) /DA (/TiRo 10 Tf 0 0 1 rg) /Q 1 /Rect [100 100 200 120] /MK << /BC [1 0 0] /BG [1 1 0] >>');
  assert.match(c, /q 1 0 0 1 100 100 cm/);
  assert.match(c, /1 1 0 rg\n0 0 100 20 re\nf/);           // background
  assert.match(c, /1 0 0 RG\n1 w\n0\.5 0\.5 99 19 re\nS/);  // border
  assert.match(c, /0 0 1 rg\nBT\n\/F_T 10 Tf/);              // Times, 10pt, blue
  // centred: (100 - width of "Hello" in Times 10pt (22.22)) / 2
  assert.match(c, /38\.89 [\d.]+ Td\n\(Hello\) Tj/);
});

test('size 0 fits one line to its box; comb, multiline and password fields', async () => {
  const auto = await gen('/FT /Tx /V (Hi) /DA (/Helv 0 Tf 0 g) /Rect [0 0 100 14]');
  const size = Number(/\/F_H ([\d.]+) Tf/.exec(auto)[1]);
  assert.ok(size >= 9 && size <= 12, `auto size ${size}`);
  const comb = await gen('/FT /Tx /Ff 16777216 /MaxLen 4 /V (1234) /DA (/Helv 10 Tf 0 g) /Rect [0 0 80 20]');
  assert.equal((comb.match(/\) Tj/g) ?? []).length, 4);
  assert.match(comb, /7\.22 [\d.]+ Td\n\(1\) Tj/);          // centred in the first 20pt cell
  const multi = await gen('/FT /Tx /Ff 4096 /V (one two three four five six seven) /DA (/Helv 10 Tf 0 g) /Rect [0 0 60 60]');
  assert.ok((multi.match(/\) Tj/g) ?? []).length >= 3);
  const pw = await gen('/FT /Tx /Ff 8192 /V (secret) /DA (/Helv 10 Tf 0 g) /Rect [0 0 100 20]');
  assert.match(pw, /\(\*\*\*\*\*\*\) Tj/);
});

test('check boxes and radio buttons show their /MK /CA mark when on; a push button needs a caption', async () => {
  const cross = await gen('/FT /Btn /V /Yes /AS /Yes /DA (/ZaDb 0 Tf 1 0 0 rg) /MK << /CA (8) /BC [0 0 0] >> /Rect [0 0 20 20]');
  assert.match(cross, /1 0 0 RG\n[\d.]+ w\n[\d.]+ [\d.]+ m\n[\d.]+ [\d.]+ l\n[\d.]+ [\d.]+ m\n[\d.]+ [\d.]+ l\nS/);
  const off = await gen('/FT /Btn /V /Off /AS /Off /DA (/ZaDb 0 Tf 0 g) /MK << /CA (8) /BC [0 0 0] >> /Rect [0 0 20 20]');
  assert.doesNotMatch(off, / l\nS/);
  const radio = await gen('/FT /Btn /Ff 32768 /V /a /AS /a /DA (/ZaDb 0 Tf 0 g) /MK << /BC [0 0 0] >> /Rect [0 0 20 20]');
  assert.match(radio, / c\n.* c\n.* c\n.* c\nh\nf/s);        // the dot
  assert.doesNotMatch(await gen('/FT /Btn /Ff 65536 /DA (/Helv 10 Tf 0 g) /Rect [0 0 60 20]'), / cm/);
  assert.match(await gen('/FT /Btn /Ff 65536 /DA (/Helv 10 Tf 0 g) /MK << /CA (Go) >> /Rect [0 0 60 20]'), /\(Go\) Tj/);
});

test('a push button with no caption still prints its border; with no /DA anywhere a text field prints no value', async () => {
  assert.match(await gen('/FT /Btn /Ff 65536 /MK << /BC [1 0 0] >> /Rect [0 0 60 20]'), /1 0 0 RG\n1 w\n0\.5 0\.5 59 19 re\nS/);
  const bare = await gen('/FT /Tx /V (5) /MK << /BC [0 0 0] >> /Rect [0 0 60 20]');
  assert.match(bare, / re\nS/);
  assert.doesNotMatch(bare, /Tj/);
});

test('/NeedAppearances: a button with no appearance for its state gets one; a check-style radio is square', async () => {
  const on = { 11: { dict: '<< /Subtype /Form /BBox [0 0 20 20] >>', stream: '0 0 1 rg 0 0 20 20 re f' } };
  const radio = '/FT /Btn /Ff 32768 /AS /Off /DA (/ZaDb 9 Tf 0 g) /MK << /BC [0 0 0] /CA (4) >> /Rect [0 0 20 20] /AP << /N << /Male 11 0 R >> >>';
  assert.match(await gen(radio, { acro: '/NeedAppearances true', extra: on }), /0 0 0 RG\n1 w\n0\.5 0\.5 19 19 re\nS/);
  assert.doesNotMatch(await gen(radio, { extra: on }), / re\nS/);
});

test('a combo box shows the label of its value; a list box highlights its selection', async () => {
  const combo = await gen('/FT /Ch /Ff 131072 /V (fr) /Opt [[(de) (Deutsch)] [(fr) (Fran\\347ais)]] /DA (/Helv 10 Tf 0 g) /Rect [0 0 100 20]');
  assert.match(combo, /\(Fran\\347ais\) Tj|\(Français\) Tj/);
  const list = await gen('/FT /Ch /V (b) /Opt [(a) (b) (c)] /DA (/Helv 10 Tf 0 g) /Rect [0 0 100 60]');
  assert.match(list, /0\.6 0\.757 0\.855 rg/);
  assert.equal((list.match(/\) Tj/g) ?? []).length, 3);
});

test('/NeedAppearances regenerates text appearances; buttons keep theirs', async () => {
  const stale = { 11: { dict: '<< /Subtype /Form /BBox [0 0 100 20] >>', stream: 'BT /Helv 10 Tf (Old) Tj ET' } };
  const c = await gen('/FT /Tx /V (New) /DA (/Helv 10 Tf 0 g) /Rect [0 0 100 20] /AP << /N 11 0 R >>', { acro: '/NeedAppearances true', extra: stale });
  assert.match(c, /\(New\) Tj/);
  assert.doesNotMatch(c, /Do Q/);
  const kept = await gen('/FT /Tx /V (New) /DA (/Helv 10 Tf 0 g) /Rect [0 0 100 20] /AP << /N 11 0 R >>', { extra: stale });
  assert.match(kept, /\/JcsAP1 Do Q/);
});

test('/DA strings and PostScript font names', async () => {
  const { parseDa, familyOf } = await import('../../src/appearance.js');
  assert.deepEqual(parseDa('/Helv 12 Tf 0 0 1 rg'), { font: 'Helv', size: 12, color: [0, 0, 1] });
  assert.deepEqual(parseDa('0.5 g /TiRo 0 Tf'), { font: 'TiRo', size: 0, color: [0.5, 0.5, 0.5] });
  assert.deepEqual(parseDa('/F1 9 Tf 0 0 0 1 k').color, [0, 0, 0]);
  assert.deepEqual(familyOf('Arial-BoldItalicMT'), { typeface: 'Arial', bold: true, italic: true });
  assert.deepEqual(familyOf('TimesNewRomanPSMT'), { typeface: 'Times New Roman', bold: false, italic: false });
  assert.deepEqual(familyOf('ABCDEF+MyriadPro-Regular'), { typeface: 'Myriad Pro', bold: false, italic: false });
  assert.deepEqual(familyOf('Times-Bold'), { typeface: 'Times New Roman', bold: true, italic: false });
});

// --- static XFA: the saved widget wins where it disagrees with the template ---

function staticXfa(widget, extra = {}) {
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="position">
    <pageSet><pageArea name="P1"><contentArea x="0" y="0" w="300pt" h="300pt"/><medium short="300pt" long="300pt"/></pageArea></pageSet>
    <subform name="page1" w="300pt" h="300pt"><field name="f" x="10pt" y="10pt" w="100pt" h="20pt"><ui><textEdit/></ui>
      <font typeface="Helvetica" size="10pt"/><value><text>Moved</text></value></field></subform></subform></template>`;
  return buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R] /XFA [(template) 6 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Annots [10 0 R] >>',
    5: { dict: '<< >>', stream: '0 g 0 0 300 1 re f' },
    6: { dict: '<< >>', stream: template },
    10: `<< /Type /Annot /Subtype /Widget /FT /Tx /T (form1[0].page1[0].f[0]) /F 4 ${widget} >>`,
    ...extra,
  });
}

test('static XFA: a value goes into its widget\'s rectangle when that disagrees with the template', async () => {
  const at = async rect => {
    const { pdf, static: kept } = await flattenXfa(staticXfa(`/Rect [${rect}]`), { fonts: null });
    assert.equal(kept, true);
    return (await pageInfo(pdf)).content;
  };
  // the template puts the value at x 10, top 10 (PDF y 270–290)
  assert.match(await at('10 270 110 290'), /\n10 2[78][\d.]* Td\n\(Moved\) Tj/);
  assert.match(await at('150 100 250 120'), /\n150 11[\d.]+ Td\n\(Moved\) Tj/);
});

test('static XFA: a disagreeing widget with an appearance is stamped instead', async () => {
  const pdf = staticXfa('/Rect [150 100 250 120] /AP << /N 11 0 R >>', { 11: AP() });
  const { content } = await pageInfo((await flattenXfa(pdf, { fonts: null })).pdf);
  assert.doesNotMatch(content, /\(Moved\) Tj/);
  assert.match(content, /q 1 0 0 1 150 100 cm \/JcsAP1 Do Q/);
});

// --- options: annotations left out; fields labelled with their names ---

test('annotations: false leaves out markup annotations; widgets still print', async () => {
  const pdf = form({
    fields: '10 0 R', annots: '10 0 R 12 0 R',
    extra: {
      10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /F 4 /Rect [50 200 150 220] /AP << /N 11 0 R >> >>',
      11: AP(),
      12: '<< /Type /Annot /Subtype /Highlight /F 4 /Rect [10 10 60 30] /AP << /N 13 0 R >> >>',
      13: { dict: '<< /Subtype /Form /BBox [0 0 50 20] >>', stream: '1 1 0 rg 0 0 50 20 re f' },
    },
  });
  const all = (await pageInfo((await flattenXfa(pdf, { fonts: null })).pdf)).content;
  assert.match(all, /\/JcsAP2 Do/);
  const { content } = await pageInfo((await flattenXfa(pdf, { fonts: null, annotations: false })).pdf);
  assert.match(content, /q 1 0 0 1 50 200 cm \/JcsAP1 Do Q/);
  assert.doesNotMatch(content, /JcsAP2/);
});

const labelled = async (opts, extra = {}) => {
  const pdf = form({
    fields: '17 0 R 12 0 R 13 0 R 14 0 R', annots: '10 0 R 12 0 R 13 0 R 15 0 R 16 0 R',
    extra: {
      // a field with an appearance, printable or not, is replaced by its name
      10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (city) /V (Paris) /F 0 /Rect [50 200 150 220] /AP << /N 11 0 R >> /Parent 17 0 R >>',
      11: AP(),
      12: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (secret) /F 6 /Rect [50 100 150 120] >>',
      // a name too long for its box at the smallest size
      13: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (a_very_long_field_name_indeed) /F 4 /Rect [200 10 230 30] >>',
      // radio buttons sharing one name
      14: '<< /FT /Btn /Ff 49152 /T (choice) /Kids [15 0 R 16 0 R] >>',
      15: '<< /Type /Annot /Subtype /Widget /Parent 14 0 R /F 4 /Rect [10 50 30 70] /AP << /N << /yes 11 0 R /Off 11 0 R >> >> >>',
      16: '<< /Type /Annot /Subtype /Widget /Parent 14 0 R /F 4 /Rect [40 50 60 70] /AP << /N << /no 11 0 R /Off 11 0 R >> >> >>',
      17: '<< /T (addr) /Kids [10 0 R] >>',
      ...extra,
    },
  });
  return (await pageInfo((await flattenXfa(pdf, { fonts: null, labelFields: opts })).pdf)).content;
};

test('labelFields: each field is replaced by its full name in red, sized to fit', async () => {
  const content = await labelled(true);
  assert.doesNotMatch(content, /Do Q/); // no widget appearance
  assert.doesNotMatch(content, /Paris|secret/); // no value; the hidden widget is left out
  assert.match(content, /1 0 0 rg/);
  // 20pt high, 100pt wide: the 12pt cap
  assert.match(content, /\/F\w+ 12 Tf[^]*?\(addr\.city\) Tj/);
  // radio buttons: the name and each button's on state
  assert.match(content, /\(choice=yes\) Tj/);
  assert.match(content, /\(choice=no\) Tj/);
  // too long for 30pt at 5pt: drawn at 5pt and clipped to the box's sides
  assert.match(content, /\/F\w+ 5 Tf[^]*?\(a_very_long_field_name_indeed\) Tj/);
  assert.match(content, /q 1 0 0 1 200 10 cm \nq\n0 0 30 20 re\nW n/);
});

test('labelFields: colour, sizes and short names', async () => {
  const content = await labelled({ color: '#0000ff', maxSize: 8, name: 'short' }, {
    10: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (city[0]) /F 4 /Rect [50 200 150 220] /Parent 17 0 R >>',
  });
  assert.match(content, /0 0 1 rg\nBT\n/);
  assert.doesNotMatch(content, /1 0 0 rg/);
  assert.match(content, /\/F\w+ 8 Tf[^]*?\(city\) Tj/);
  assert.match(await labelled({ color: [0, 128, 0] }), /0 0\.50\d* 0 rg/);
  await assert.rejects(labelled({ color: 'red' }), /labelFields\.color/);
  await assert.rejects(labelled({ name: 'partial' }), /labelFields\.name/);
});

test('labelFields on XFA: the name goes where the value would, on static and dynamic forms', async () => {
  // static: the shell page is kept and the name painted in the value's place
  const { pdf: st, static: kept } = await flattenXfa(staticXfa('/Rect [10 270 110 290]'), { fonts: null, labelFields: true });
  assert.equal(kept, true);
  const c1 = (await pageInfo(st)).content;
  assert.doesNotMatch(c1, /\(Moved\) Tj/);
  assert.match(c1, /\n12 2[78][\d.]* Td\n\(form1\[0\]\.page1\[0\]\.f\[0\]\) Tj/);
  // dynamic: the caption stays, the value box goes
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb">
    <pageSet><pageArea name="P1"><contentArea x="0" y="0" w="300pt" h="300pt"/><medium short="300pt" long="300pt"/></pageArea></pageSet>
    <subform layout="tb"><field name="f" w="200pt" h="20pt"><ui><textEdit><border><edge/></border></textEdit></ui>
      <caption reserve="50pt"><value><text>Caption</text></value></caption>
      <font typeface="Helvetica" size="10pt"/><value><text>Value</text></value></field></subform></subform></template>`;
  const dyn = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm << /Fields [] /XFA [(template) 6 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>',
    6: { dict: '<< >>', stream: template },
  });
  const { pdf, dynamic } = await flattenXfa(dyn, { fonts: null, labelFields: { name: 'short' } });
  assert.equal(dynamic, true);
  const c2 = (await pageInfo(pdf)).content;
  assert.match(c2, /\(Caption\) Tj/);
  assert.doesNotMatch(c2, /\(Value\) Tj/);
  assert.doesNotMatch(c2, / re\nS/); // no value box border
  assert.match(c2, /\n52 [\d.]+ Td\n\(f\) Tj/);
});

test('a rich text field draws its plain /V in the /DA font, as Reader does: /RV and /DS are not used', async () => {
  const rv = '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>Plain <span style="font-weight:bold">bold</span> <span style="color:#FF0000">red</span></p></body>';
  const c = await gen(`/FT /Tx /Ff ${1 << 25} /V (Plain bold red) /RV (${rv}) /DS (font: 10pt Helvetica; color:#0000FF) /DA (/Helv 12 Tf 0 g) /Rect [0 0 200 20]`);
  assert.match(c, /\/F_H 12 Tf[\s\S]*\(Plain bold red\) Tj/);
  assert.doesNotMatch(c, /F_HB|(1 0 0|0 0 1) rg\nBT/);
});

test('a push button\'s icon is fitted to its box, its caption placed by /TP', async () => {
  const icon = { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 10 20] >>', stream: '0 0 1 rg 0 0 10 20 re f' };
  // icon only (TP 1), scaled proportionally into the 40 by 40 box and centred
  const c = await gen('/FT /Btn /Ff 65536 /DA (/Helv 0 Tf 0 g) /Rect [0 0 40 40] /MK << /I 30 0 R /TP 1 >>', { extra: { 30: icon } });
  assert.match(c, /q 2 0 0 2 10 0 cm \/JcsIcon1 Do Q/);
  // caption below the icon (TP 2), the icon in the space above; never scaled (SW N), left-aligned
  const below = await gen('/FT /Btn /Ff 65536 /DA (/Helv 10 Tf 0 g) /Rect [0 0 100 60] /MK << /I 30 0 R /TP 2 /CA (Go) /IF << /SW /N /A [0 0.5] >> >>', { extra: { 30: icon } });
  const m = /q 1 0 0 1 0 ([\d.]+) cm \/JcsIcon1 Do Q/.exec(below);
  assert.ok(m && Number(m[1]) > 10);
  assert.match(below, /\(Go\) Tj/);
  // an icon with TP 0 is not drawn; the caption is
  const caption = await gen('/FT /Btn /Ff 65536 /DA (/Helv 10 Tf 0 g) /Rect [0 0 100 60] /MK << /I 30 0 R /CA (Go) >>', { extra: { 30: icon } });
  assert.doesNotMatch(caption, /JcsIcon/);
});

test('an unsigned signature field prints its background and border', async () => {
  const c = await gen('/FT /Sig /Rect [0 0 100 30] /MK << /BG [0.9 0.9 1] /BC [0 0 0] >>');
  assert.match(c, /0\.9 0\.9 1 rg\n0 0 100 30 re\nf/);
  assert.match(c, /0 0 0 RG\n1 w\n0\.5 0\.5 99 29 re\nS/);
});
