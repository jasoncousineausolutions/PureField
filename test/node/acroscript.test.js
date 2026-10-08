// AcroForm JavaScript: format, calculate, open and print actions, as Acrobat runs them
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';
import { printf, printx, printd, scand } from '../../src/acroscript.js';
import { buildPdf } from './pdfbuild.js';

const latin1 = u8 => new TextDecoder('latin1').decode(u8);
async function content(pdf) {
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const kids = (await doc.getObject(cat.Pages.num)).value.value.Kids.value;
  const page = (await doc.getObject(kids[0].num)).value.value;
  const refs = page.Contents.type === 'array' ? page.Contents.value : [page.Contents];
  let s = '';
  for (const r of refs) s += latin1((await doc.getObject(r.num)).streamBytes) + '\n';
  return s;
}

// text fields 10.. without appearances; extra objects and catalog entries given
function form(fields, { catalog = '', extra = {}, co = '' } = {}) {
  const objs = {};
  const refs = [];
  fields.forEach((f, i) => {
    const n = 10 + i;
    refs.push(`${n} 0 R`);
    objs[n] = `<< /Type /Annot /Subtype /Widget /FT /${f.ft ?? 'Tx'} /T (${f.name}) /F ${f.flags ?? 4} /Rect [10 ${200 - i * 30} 150 ${220 - i * 30}]
      /DA (/Helv 10 Tf 0 g) ${f.v !== undefined ? `/V ${f.v}` : ''} ${f.aa ? `/AA << ${f.aa} >>` : ''} ${f.more ?? ''} /P 3 0 R >>`;
  });
  return buildPdf({
    1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${refs.join(' ')}] ${co ? `/CO [${co}]` : ''} >> ${catalog} >>`,
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Annots [${refs.join(' ')}] >>`,
    ...objs,
    ...extra,
  });
}
const js = s => `<< /S /JavaScript /JS (${s.replace(/\\/g, '\\\\')}) >>`;
const fmt = s => `/F ${js(s)}`;

test('util.printf, printx, printd and scand as Acrobat formats', () => {
  assert.equal(printf('%,0.2f', 1234.5), '1,234.50');
  assert.equal(printf('%,2.2f', 1234567.891), '1.234.567,89');
  assert.equal(printf('%,1.0f', 1234.5), '1235');
  assert.equal(printf('%,4.1f', -9876.54), "-9'876.5");
  assert.equal(printf('%05d|%x|%s', 42, 255, 'a'), '00042|FF|a');
  assert.equal(printx('(999) 999-9999', '5551234567'), '(555) 123-4567');
  assert.equal(printx('>AAA', 'abc'), 'ABC');
  const d = new Date(2024, 2, 5, 14, 7, 9);
  assert.equal(printd('mmm d, yyyy', d), 'Mar 5, 2024');
  assert.equal(printd('yyyy-mm-dd HH:MM:ss', d), '2024-03-05 14:07:09');
  assert.equal(printd('h:MM tt', d), '2:07 pm');
  assert.equal(scand('mm/dd/yyyy', '03/05/2024').getTime(), new Date(2024, 2, 5).getTime());
  assert.equal(scand('d-mmm-yy', '5-Mar-24').getMonth(), 2);
  assert.equal(scand('mm/dd/yyyy', 'nonsense'), null);
});

test('format actions: a generated appearance shows the formatted value', async () => {
  const pdf = form([
    { name: 'money', v: '(1234.5)', aa: fmt('AFNumber_Format(2, 0, 0, 0, "$", true);') },
    { name: 'neg', v: '(-12)', aa: fmt('AFNumber_Format(1, 0, 3, 0, "", false);') },
    { name: 'pct', v: '(0.256)', aa: fmt('AFPercent_Format(1, 0);') },
    { name: 'date', v: '(3/5/2024)', aa: fmt('AFDate_FormatEx("mmm d, yyyy");') },
    { name: 'phone', v: '(5551234567)', aa: fmt('AFSpecial_Format(2);') },
    { name: 'own', v: '(abc)', aa: fmt('event.value = event.value.toUpperCase() + "!";') },
  ]);
  const { pdf: out, log } = await flattenXfa(pdf, { fonts: null });
  const c = await content(out);
  for (const s of ['($1,234.50)', '(\\(12.0\\))', '(25.6%)', '(Mar 5, 2024)', '(\\(555\\) 123-4567)', '(ABC!)']) assert.ok(c.includes(s), `${s} in ${c}`);
  // red negatives (negStyle 3)
  assert.match(c, /1 0 0 rg[^]*\(\\\(12\.0\\\)\)/);
  assert.ok(log.entries.some(e => e.code === 'ACRO_SCRIPTS'));
});

test('open actions change values, a change runs the calculations in /CO order, then formats', async () => {
  const pdf = form([
    { name: 'a', v: '(1)' },
    { name: 'b', v: '(2)' },
    { name: 'total', v: '(3)', aa: `/C ${js('AFSimple_Calculate("SUM", "a, b");')} ${fmt('AFNumber_Format(2, 0, 0, 0, "", false);')}` },
    { name: 'twice', aa: `/C ${js('event.value = this.getField("total").value * 2;')}` },
  ], { catalog: `/OpenAction ${js('this.getField("a").value = 10;')}`, co: '12 0 R 13 0 R' });
  const c = await content((await flattenXfa(pdf, { fonts: null })).pdf);
  assert.ok(c.includes('(10)'));
  assert.ok(c.includes('(12.00)'), c);  // total recalculated, then formatted
  assert.ok(c.includes('(24)'));        // after total, in /CO order
});

test('document scripts, display and will-print: what prints follows the scripts', async () => {
  const pdf = form([
    { name: 'shown', v: '(was hidden)', flags: 2 },
    { name: 'gone', v: '(was visible)' },
    { name: 'screen', v: '(screen only)' },
    { name: 'stamp' },
  ], {
    catalog: `/Names << /JavaScript << /Names [(init) ${js('function hide(n) { getField(n).display = display.hidden; }')}] >> >>
      /OpenAction ${js('getField("shown").display = display.visible; hide("gone"); this.getField("screen").display = display.noPrint;')}
      /AA << /WP ${js('getField("stamp").value = "PRINTED " + util.printd("yyyy", new Date(2020, 0, 1));')} >>`,
  });
  const c = await content((await flattenXfa(pdf, { fonts: null })).pdf);
  assert.ok(c.includes('(was hidden)'));
  assert.ok(!c.includes('(was visible)'));
  assert.ok(!c.includes('(screen only)'));
  assert.ok(c.includes('(PRINTED 2020)'));
});

test('a check box a script ticks prints its on appearance; script errors are logged', async () => {
  const pdf = form([
    { name: 'cb', ft: 'Btn', v: '/Off', more: '/AS /Off /AP << /N << /Yes 30 0 R /Off 31 0 R >> >>' },
  ], {
    catalog: `/OpenAction ${js('this.getField("cb").checkThisBox(0, true); nosuch.call();')}`,
    extra: {
      30: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 140 20] >>', stream: '0 0 1 rg 0 0 140 20 re f' },
      31: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 140 20] >>', stream: '' },
    },
  });
  const { pdf: out, log } = await flattenXfa(pdf, { fonts: null });
  const doc = await parsePdf(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  let found = false;
  for (let i = 1; i < 20; i++) { const o = await doc.getObject(i).catch(() => null); if (o?.streamBytes && latin1(o.streamBytes).includes('0 0 1 rg 0 0 140 20 re f')) found = true; }
  assert.ok(found, 'the Yes appearance was copied');
  assert.ok(log.entries.some(e => e.code === 'ACRO_SCRIPT_FAILED' && /nosuch/.test(e.message)));
  // scripts: false leaves the form as it is
  const { log: log2 } = await flattenXfa(pdf, { fonts: null, scripts: false });
  assert.ok(!log2.entries.some(e => e.code === 'ACRO_SCRIPTS'));
});
