// What IRCC (Canadian immigration) forms need to print as Reader prints them:
// IMM 0008 and IMM 5257 Schedule 1 fill their drop-downs from a list in
// xfa.datasets (bindItems), name each dependant's section in a validate
// script, bind month cells through num{99} and cut long table text at
// maxChars.
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplateModel } from '../../src/xfa/model.js';
import { bindData, refreshBoundItems } from '../../src/xfa/bind.js';
import { runScripts } from '../../src/xfa/script/run.js';
import { formatValues, applyBindPictures, clipToMaxChars } from '../../src/xfa/format.js';
import { parsePicture } from '../../src/xfa/picture.js';
import { layoutForm } from '../../src/xfa/flow.js';
import { wrapText, resolveFont } from '../../src/xfa/text.js';
import { XfaLog } from '../../src/xfa/log.js';
import { loadBundledFonts } from '../../src/fonts.js';
import { prepareFaces } from '../../src/core/faces.js';

const T = body => new DOMParser().parseFromString(
  `<template xmlns="http://www.xfa.org/schema/xfa-template/2.8/">${body}</template>`, 'application/xml');
// xfa:datasets holding the record and, beside xfa:data, other datasets
const D = (record, beside = '') => {
  const doc = new DOMParser().parseFromString(
    `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">${beside}<xfa:data>${record}</xfa:data></xfa:datasets>`, 'application/xml');
  const data = doc.documentElement.getElementsByTagName('xfa:data')[0];
  for (let n = data.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return n;
  return null;
};

// as index.js builds a form: bind, bind pictures, scripts, items, format
function run(tpl, record = null, beside = '', { scripts = true } = {}) {
  const log = new XfaLog();
  const rec = record === null ? null : D(record, beside);
  const { root } = bindData(parseTemplateModel(T(tpl), { log }), rec, { log });
  applyBindPictures(root);
  const stats = scripts ? runScripts(root, { record: rec, log }) : null;
  if (stats) refreshBoundItems(root);
  formatValues(root, { log });
  const find = som => {
    const walk = n => {
      if (n.som === som) return n;
      for (const c of n.children ?? []) { const f = walk(c); if (f) return f; }
      return null;
    };
    return walk(root);
  };
  return { root, log, find, stats };
}

const js = text => `<script contentType="application/x-javascript">${text}</script>`;
const ev = (activity, script) => `<event activity="${activity}">${script}</event>`;

const LOV = `<LOVFile><LOV>
  <CountryList><Country lic=""/><Country lic="205">India</Country><Country lic="511">Canada</Country></CountryList>
  <SexList><Sex lic="M">M Male</Sex><Sex lic="F">F Female</Sex></SexList>
</LOV></LOVFile>`;

const choice = (name, list, ref) => `<field name="${name}"><ui><choiceList/></ui>
  <items/><items presence="hidden" save="1"/>
  <bindItems ref="xfa.datasets.LOVFile.LOV.${list}[*]" labelRef="$" valueRef="lic"/>
  <bind match="dataRef" ref="$.${ref}"/></field>`;

test('bindItems: drop-downs print the label of their code, in every repeated instance', () => {
  const tpl = `<subform name="form1">
    ${choice('Country', 'CountryList.Country', 'Country')}
    <subform name="dep"><occur min="0" max="4"/>
      ${choice('Country', 'CountryList.Country', 'Country')}
      ${choice('Sex', 'SexList.Sex', 'Sex')}
    </subform>
  </subform>`;
  const data = `<form1><Country>511</Country>
    <dep><Country>205</Country><Sex>M</Sex></dep>
    <dep><Country>205</Country><Sex>F</Sex></dep>
    <dep><Country>999</Country></dep></form1>`;
  const { find } = run(tpl, data, LOV, { scripts: false });
  assert.equal(find('form1.Country').display, 'Canada');
  assert.equal(find('form1.dep.Country').display, 'India');
  assert.equal(find('form1.dep.Sex').display, 'M Male');
  assert.equal(find('form1.dep[1].Country').display, 'India');
  assert.equal(find('form1.dep[1].Sex').display, 'F Female');
  // a code the list lacks prints as it is
  assert.equal(find('form1.dep[2].Country').display, '999');
  // the items are the list's, labels and save values
  assert.deepEqual(find('form1.dep[1].Sex').items.map(l => l.values), [['M Male', 'F Female'], ['M', 'F']]);
});

test('bindItems: a list a script loads into xfa.datasets fills the items after the scripts', () => {
  const tpl = `<subform name="form1">
    <variables><script name="LOV" contentType="application/x-javascript">&lt;LOV&gt;&lt;SexList&gt;&lt;Sex lic="F"&gt;F Female&lt;/Sex&gt;&lt;/SexList&gt;&lt;/LOV&gt;</script></variables>
    ${ev('initialize', js(`var o = xfa.datasets.resolveNode("LOVFile");
      o.loadXML(xfa.form.nodes.item(0).LOV.value, 0, 1);`))}
    ${choice('Sex', 'SexList.Sex', 'Sex')}
  </subform>`;
  const { find, stats } = run(tpl, '<form1><Sex>F</Sex></form1>', '<LOVFile/>');
  assert.equal(stats.failed, 0);
  assert.equal(find('form1.Sex').display, 'F Female');
});

test('scripts reach the other datasets: xfa.datasets.LOVFile, nodes, xfa.log', () => {
  const tpl = `<subform name="form1">
    <field name="n">${ev('initialize', js(`xfa.log.message(0, "hi");
      var l = xfa.resolveNodes("xfa.datasets.LOVFile.LOV.CountryList.Country[*]");
      this.rawValue = l.length + ":" + l.item(1).lic.value + ":" + l.item(1).value + ":" + xfa.datasets.nodes.length;`))}</field>
  </subform>`;
  const { find, stats } = run(tpl, '<form1/>', LOV);
  assert.equal(stats.failed, 0);
  assert.equal(find('form1.n').raw, '3:205:India:2');
});

test('validate scripts run on opening, after the calculations (IMM 0008 dependant headings)', () => {
  const tpl = `<subform name="form1">
    <subform name="dependants"><occur min="0" max="4"/>
      <subform name="depID"><draw name="title"><value><text/></value></draw></subform>
      <subform name="q1">
        <field name="FamilyName"><validate>${js(`var g = GivenName.isNull ? "" : GivenName.rawValue + "." + this.rawValue.substr(0, 1);
          this.parent.parent.depID.title.value.text.value = g; true;`)}</validate></field>
        <field name="GivenName"><calculate>${js('this.rawValue == null ? null : this.rawValue.toUpperCase()')}</calculate></field>
      </subform>
    </subform>
  </subform>`;
  const data = `<form1><dependants><q1><FamilyName>Sharma</FamilyName><GivenName>Aarav</GivenName></q1></dependants>
    <dependants><q1><FamilyName>Menon</FamilyName><GivenName>Rohan</GivenName></q1></dependants></form1>`;
  const { find } = run(tpl, data);
  // the calculation ran first: the heading sees its result
  assert.equal(find('form1.dependants.depID.title').value.text, 'AARAV.S');
  assert.equal(find('form1.dependants[1].depID.title').value.text, 'ROHAN.M');
});

test('execValidate runs the validate scripts of a subtree', () => {
  const tpl = `<subform name="form1">
    <field name="a"><validate>${js('b.rawValue = (b.isNull ? 0 : Number(b.rawValue)) + 1; true;')}</validate></field>
    <field name="b"/>
    <field name="c">${ev('docReady', js('this.rawValue = String(a.execValidate()) + b.rawValue;'))}</field>
  </subform>`;
  const { find } = run(tpl, '<form1/>');
  assert.equal(find('form1.c').raw, 'true2');
});

test('a manifest lists its refs as nodes (IMM 0008 paper forms barcodes encode each ref)', () => {
  const tpl = `<subform name="form1">
    <field name="a"><bind match="dataRef" ref="$.A"/></field>
    <field name="b"><bind match="dataRef" ref="$.B"/></field>
    <variables><manifest name="bc"><ref>xfa[0].form[0].form1[0].a[0].dataNode</ref><ref>xfa[0].form[0].form1[0].b[0].dataNode</ref></manifest></variables>
    <field name="code">${ev('prePrint', js(`var out = [];
      for (var i = 0; i < bc.nodes.length; i++) { var n = xfa.resolveNode(bc.nodes.item(i).value); out.push(n == null ? "" : n.value); }
      this.rawValue = out.join("|") + "|";`))}</field>
  </subform>`;
  const { find, stats } = run(tpl, '<form1><A>04</A><B>Sharma</B></form1>');
  assert.equal(stats.failed, 0);
  assert.equal(find('form1.code').raw, '04|Sharma|');
});

test("a script object named util hides Acrobat's util (IRCC forms call util.trim)", () => {
  const tpl = `<subform name="form1">
    <variables>${js('function trim(s) { return s.replace(/^\\s+|\\s+$/g, ""); }').replace('<script', '<script name="util"')}</variables>
    <field name="a">${ev('initialize', js('this.rawValue = "[" + util.trim("  x  ") + "]";'))}</field>
  </subform>`;
  assert.equal(run(tpl, '<form1/>').find('form1.a').raw, '[x]');
  // without one, util is Acrobat's
  const plain = `<subform name="form1"><field name="a">${ev('initialize', js('this.rawValue = util.printf("%d", 4.5);'))}</field></subform>`;
  assert.equal(run(plain, '<form1/>').find('form1.a').raw, '4');
});

test('a radio button holds its on value only when selected (accompanyPAIndicator.Yes.isNull)', () => {
  const tpl = `<subform name="form1">
    <exclGroup name="acc"><bind match="dataRef" ref="$.acc"/>
      <field name="Yes"><ui><checkButton shape="round"/></ui><items><text>Y</text></items></field>
      <field name="No"><ui><checkButton shape="round"/></ui><items><text>N</text></items></field>
    </exclGroup>
    <field name="r">${ev('initialize', js('this.rawValue = [acc.Yes.isNull, acc.No.isNull, acc.No.rawValue, acc.rawValue].join(",");'))}</field>
    <field name="s">${ev('docReady', js('acc.Yes.rawValue = "Y"; this.rawValue = [acc.rawValue, acc.No.isNull].join(",");'))}</field>
  </subform>`;
  const { find } = run(tpl, '<form1><acc>N</acc></form1>');
  assert.equal(find('form1.r').raw, 'true,false,N,N');
  assert.equal(find('form1.s').raw, 'Y,true');
  assert.equal(find('form1.acc').raw, 'Y');
});

test("scripts grey out a field through its widget's border (ui.oneOfChild.border.fill)", () => {
  const tpl = `<subform name="form1">
    <field name="a"><ui><choiceList><border presence="hidden"/></choiceList></ui>
      ${ev('initialize', js(`var b = this.ui.oneOfChild.border; b.presence = "visible";
        for (var i = 0; i < 4; i++) { var e = b.getElement("edge", i); e.color.value = "255,255,255"; e.thickness = "1pt"; }
        b.fill.color.value = "233, 233, 233";`))}</field>
    <field name="b"><ui><textEdit><border presence="hidden"/></textEdit></ui>
      ${ev('initialize', js(`this.ui.resolveNode("#textEdit").border.fill.color.value = "230,230,230";
        var o = this.ui.oneOfChild.border; o.parent.nodes.remove(o);`))}</field>
    <field name="c">${ev('initialize', js('var r = new RegExp(); r.compile("^[0-9]+$"); this.rawValue = r.test("123") + "," + r.test("12a");'))}</field>
  </subform>`;
  const { find, stats } = run(tpl, '<form1/>');
  assert.equal(stats.failed, 0);
  const a = find('form1.a').ui.border;
  assert.equal(a.presence, 'visible');
  assert.deepEqual(a.fill.color, [233, 233, 233]);
  assert.deepEqual(a.edges.map(e => [e.thickness, e.color.join()]), Array(4).fill([1, '255,255,255']));
  // a removed border is no border at all
  assert.equal(find('form1.b').ui.border, undefined);
  assert.equal(find('form1.c').raw, 'true,false');
});

test('maxChars: a longer value from data prints cut at maxChars (IMM 5257 Schedule 1 table cells)', () => {
  const long = 'Fictional text entry used to check how long text wraps inside a fixed-height table cell. It is deliberately long.';
  const tpl = `<subform name="form1"><field name="loc"><ui><textEdit multiLine="1"/></ui><value><text maxChars="100"/></value></field>
    <field name="free"><value><text/></value></field></subform>`;
  const { find } = run(tpl, `<form1><loc>${long}</loc><free>${long}</free></form1>`, '', { scripts: false });
  assert.equal(find('form1.loc').display, long.slice(0, 100));
  assert.ok(find('form1.loc').display.endsWith('It is delib'));
  // the raw value scripts see is the whole value
  assert.equal(find('form1.loc').raw, long);
  assert.equal(find('form1.free').display, long);
  assert.equal(clipToMaxChars('a😀bc', 2), 'a😀');
});

test('bind pictures: "05" bound through num{99} is 5 to scripts and prints "05" (IMM 5257 header date)', () => {
  const tpl = `<subform name="form1">
    <field name="M"><ui><textEdit><picture>num{99}</picture></textEdit></ui><bind match="dataRef" ref="$.M"><picture>num{99}</picture></bind>
      <format><picture>num{99}</picture></format><value><text maxChars="2"/></value></field>
    <field name="D"><bind match="dataRef" ref="$.D"><picture>num{99}</picture></bind><format><picture>num{99}</picture></format></field>
    <field name="Y"><bind match="dataRef" ref="$.Y"/></field>
    <field name="hdr">${ev('initialize', js('this.rawValue = Y.rawValue + "/" + M.rawValue + "/" + D.rawValue + (M.rawValue < 10 ? " lt" : "");'))}</field>
    <field name="odd"><bind match="dataRef" ref="$.odd"><picture>num{99}</picture></bind></field>
  </subform>`;
  const { find } = run(tpl, '<form1><Y>1991</Y><M>04</M><D>17</D><odd>abc</odd></form1>');
  assert.equal(find('form1.M').raw, '4');
  assert.equal(find('form1.M').display, '04');
  assert.equal(find('form1.hdr').raw, '1991/4/17 lt');
  // a value the picture does not accept stays as it is
  assert.equal(find('form1.odd').raw, 'abc');
});

test('parsePicture: dates, numbers and text masks back to canonical values', () => {
  assert.equal(parsePicture('num{99}', '05'), '5');
  assert.equal(parsePicture('num{99}', '123'), null);
  assert.equal(parsePicture('num{zzz,zz9.99}', '1,234.50'), '1234.50');
  assert.equal(parsePicture('num{zzz,zz9.99}', '-12.5'), '-12.5');
  assert.equal(parsePicture('date{YYYY-MM-DD}', '2022-01-18'), '2022-01-18');
  assert.equal(parsePicture('date{YYYY-MM-DD}|date{YYYYMMDD}', '20220118'), '2022-01-18');
  assert.equal(parsePicture('date{YYYY-MM-DD}', '2022-02-30'), null);
  assert.equal(parsePicture('date{MMM D, YYYY}', 'Jan 5, 2020'), '2020-01-05');
  assert.equal(parsePicture('date{DD/MM/YY}', '05/01/20'), '2020-01-05');
  assert.equal(parsePicture('time{HH:MM}', '09:30'), '09:30:00');
  assert.equal(parsePicture('time{h:MM A}', '1:05 PM'), '13:05:00');
  assert.equal(parsePicture('text{99999-9999}|text{99999}', '12345-6789'), '123456789');
  assert.equal(parsePicture('text{A9A 9A9}', 'T2N 3R7'), 'T2N3R7');
  assert.equal(parsePicture('text{A9A 9A9}', 'T2N3R7'), null);
  // a French-Canadian number: comma decimal, space grouping
  const fr = { fr_CA: { decimal: ',', grouping: ' ', minus: '-', currency: '$', percent: '%', months: [], monthsAbbr: [], days: [], daysAbbr: [], meridiem: ['AM', 'PM'], datePatterns: {}, timePatterns: {}, numberPatterns: {} } };
  // (the pattern's , and . are the grouping and decimal symbols whatever the locale)
  assert.equal(parsePicture('num{z,zz9.99}', '1 234,50', { locale: 'fr_CA', locales: fr }), '1234.50');
});

const faces = prepareFaces(await loadBundledFonts());
const courier = resolveFont({ typeface: 'Courier New', size: 8 }, { ttf: faces });

test('wrapping: in a field value, a word wider than the line breaks between characters ("Washingto" / "n")', () => {
  // Courier 8pt: 4.8pt a character; 43.26pt holds 9
  const fieldWrap = (t, w) => [...wrapText(courier, t, w, { breakWords: true })];
  assert.deepEqual(fieldWrap('Washington', 43.26), ['Washingto', 'n']);
  assert.deepEqual(fieldWrap('Seattle, Washington', 43.26), ['Seattle,', 'Washingto', 'n']);
  assert.deepEqual(fieldWrap('abcdefghijklmnopqrstuvwxyz', 48), ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
  // no width: no breaking
  assert.deepEqual(fieldWrap('Washington', Infinity), ['Washington']);
  // captions and draws keep the word whole (hmrc-c1800-chief's "No")
  assert.deepEqual([...wrapText(courier, 'Washington', 43.26)], ['Washington']);
});

test('wrapping: spaces at the end of a line never break it ("* Yes " caption)', () => {
  const w = 5 * 4.8 + 0.1;
  assert.deepEqual([...wrapText(courier, '* Yes ', w)], ['* Yes ']);
  assert.deepEqual([...wrapText(courier, '* Yes   ', w)], ['* Yes   ']);
  assert.deepEqual([...wrapText(courier, '* Yes no', w)], ['* Yes', 'no']);
});

function layout(body, ctx = {}) {
  const xml = T(`<subform name="form1" layout="tb"><pageSet><pageArea name="P"><contentArea x="0" y="0" w="200pt" h="100pt"/><medium short="200pt" long="100pt"/></pageArea></pageSet>${body}</subform>`);
  const { root } = bindData(parseTemplateModel(xml), null);
  formatValues(root);
  return layoutForm(root, { fonts: faces, ...ctx }).pages;
}
const items = (pages, name) => pages.flatMap((p, i) => p.items.filter(it => it.node.name === name).map(it => ({ ...it, page: i })));

test('an empty caption keeps the room it reserves', () => {
  const pages = layout(`<field name="f" w="60pt" minH="10pt"><ui><textEdit multiLine="1"/></ui><font typeface="Courier New" size="8pt"/>
    <caption reserve="10pt"/><value><text>abcdefghijkl</text></value></field>
    <field name="g" w="60pt" minH="10pt"><ui><textEdit multiLine="1"/></ui><font typeface="Courier New" size="8pt"/>
    <caption/><value><text>abcdefghijkl</text></value></field>`);
  // 60pt of text room: 12 characters of 4.8pt fit, one line; with the
  // reserve 50pt is left: 10 and 2
  const f = items(pages, 'f')[0], g = items(pages, 'g')[0];
  assert.ok(f.h > g.h, `${f.h} > ${g.h}`);
});

test('a positioned subform does not break where a child reaches past the cut, by a thousandth of a mm', () => {
  // two rows; the right cell of the first ends 0.001mm below the second's top
  const q = h => `<subform name="q" w="200pt">
    <field name="a" y="0mm" w="100pt" h="12.7mm"/>
    <subform name="b" x="100pt" y="0mm" w="100pt"><field name="bb" w="100pt" h="${h}"/></subform>
    <field name="c" y="12.7mm" w="100pt" h="12.7mm"/></subform>`;
  const spacer = '<draw name="s" w="200pt" h="40pt"/>';
  // the subform's rows fit only in part: it moves whole when b crosses
  const crossing = layout(spacer + q('12.701mm'));
  assert.deepEqual([...new Set(['a', 'bb', 'c'].map(n => items(crossing, n)[0].page))], [1]);
  // flush rows: the second row continues on the next page
  const flush = layout(spacer + q('12.7mm'));
  assert.deepEqual(['a', 'bb', 'c'].map(n => items(flush, n)[0].page), [0, 0, 1]);
});
