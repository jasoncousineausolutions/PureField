import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePdf } from '../../src/core/parser.js';
import { extractXfa } from '../../src/xfa/extractor.js';
import { parseTemplateModel, isPrintRelevant, parseRelevant } from '../../src/xfa/model.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} != ${b}`);

function model(templateBody) {
  const xml = new DOMParser().parseFromString(
    `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">${templateBody}</template>`, 'application/xml');
  return parseTemplateModel(xml);
}

const SAMPLE = `
<subform name="form1" layout="tb">
  <pageSet>
    <pageArea name="P1" id="P1">
      <contentArea x="0.25in" y="0.25in" w="8in" h="10.5in"/>
      <medium stock="letter" short="8.5in" long="11in"/>
      <draw name="footer" x="0.25in" y="10.6in" w="3in" h="0.2in">
        <value><text>Footer</text></value>
      </draw>
    </pageArea>
  </pageSet>
  <subform name="line" layout="table" columnWidths="20mm -1 30mm">
    <occur min="0" max="-1"/>
    <keep intact="contentArea"/>
    <breakBefore targetType="pageArea" target="#P1"/>
  </subform>
  <subform name="opt"><occur max="3"/></subform>
  <subform name="fixed"><occur min="2"/></subform>
  <subform name="optional"><occur min="0" initial="1"/></subform>
  <field name="sku" w="40mm" h="9mm" relevant="-print">
    <ui><textEdit multiLine="1"><border><edge thickness="1pt"/><corner radius="1mm"/><fill><color value="200,200,200"/></fill></border><comb numberOfCells="8"/></textEdit></ui>
    <caption placement="top" reserve="5mm"><value><text>SKU</text></value><font typeface="Arial" size="8pt" weight="bold"/></caption>
    <font typeface="Myriad Pro" size="10pt" fontHorizontalScale="90"><fill><color value="0,0,255"/></fill></font>
    <para hAlign="center" vAlign="middle"/>
    <margin topInset="1mm" leftInset="2mm"/>
    <format><picture>date{YYYY-MM-DD}</picture></format>
    <bind match="dataRef" ref="$.header.sku"/>
  </field>
  <field name="agree">
    <ui><checkButton size="12pt" mark="cross"/></ui>
    <items><integer>1</integer><integer>0</integer></items>
    <calculate><script>1</script></calculate>
  </field>
  <field name="state">
    <ui><choiceList/></ui>
    <items><text>Ontario</text><text>Quebec</text></items>
    <items save="1" presence="hidden"><text>ON</text><text>QC</text></items>
  </field>
  <draw name="rule" w="190mm" h="0.5pt"><value><line slope="/"><edge thickness="2pt"/></line></value></draw>
  <draw name="box"><value><rectangle><edge/><corner/></rectangle></value></draw>
  <draw name="logo"><value><image contentType="image/png" aspect="actual">iVBO
  Rw0K</image></value></draw>
  <draw name="rich"><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml"><p>One <b>two</b></p><p>three</p></body></exData></value></draw>
</subform>`;

test('root, pageSet, pageArea, contentArea, medium', () => {
  const { root } = model(SAMPLE);
  assert.equal(root.type, 'subform');
  assert.equal(root.layout, 'tb');
  assert.deepEqual(root.occur, { min: 1, max: 1, initial: 1 });
  const pa = root.pageSets[0].pageAreas[0];
  assert.deepEqual(pa.size, { width: 612, height: 792 });
  assert.deepEqual(pa.contentAreas[0], { name: '', id: null, x: 18, y: 18, w: 576, h: 756 });
  assert.equal(pa.children[0].name, 'footer');
  assert.deepEqual(pa.occur, { min: 0, max: -1, initial: 0 });
});

test('occur defaults follow pdf.js', () => {
  const { root } = model(SAMPLE);
  const by = n => root.children.find(c => c.name === n);
  assert.deepEqual(by('line').occur, { min: 0, max: -1, initial: 0 });
  assert.deepEqual(by('opt').occur, { min: 1, max: 3, initial: 1 });
  assert.deepEqual(by('fixed').occur, { min: 2, max: 2, initial: 2 });
  assert.deepEqual(by('optional').occur, { min: 0, max: 1, initial: 1 });
});

test('table, keep, breaks', () => {
  const line = model(SAMPLE).root.children.find(c => c.name === 'line');
  assert.equal(line.layout, 'table');
  close(line.columnWidths[0], 56.693);
  assert.equal(line.columnWidths[1], -1);
  assert.equal(line.keep.intact, 'contentArea');
  assert.deepEqual(line.breakBefore, [{ targetType: 'pageArea', target: '#P1', startNew: false }]);
});

test('field: geometry, ui, caption, font, para, margin, picture, bind, relevant', () => {
  const sku = model(SAMPLE).root.children.find(c => c.name === 'sku');
  close(sku.w, 113.386); close(sku.h, 25.512);
  assert.equal(sku.x, 0);
  assert.equal(sku.ui.kind, 'textEdit');
  assert.equal(sku.ui.multiLine, true);
  assert.equal(sku.ui.comb, 8);
  assert.equal(sku.ui.border.edges.length, 4);
  assert.equal(sku.ui.border.edges[3].thickness, 1);
  close(sku.ui.border.corners[0].radius, 2.8346);
  assert.deepEqual(sku.ui.border.fill.color, [200, 200, 200]);
  assert.equal(sku.caption.placement, 'top');
  close(sku.caption.reserve, 14.173);
  assert.equal(sku.caption.value.text, 'SKU');
  assert.equal(sku.caption.font.weight, 'bold');
  assert.equal(sku.font.typeface, 'Myriad Pro');
  assert.equal(sku.font.size, 10);
  assert.equal(sku.font.hScale, 90);
  assert.deepEqual(sku.font.color, [0, 0, 255]);
  assert.equal(sku.para.hAlign, 'center');
  close(sku.margin.top, 2.8346); assert.equal(sku.margin.right, 0);
  assert.equal(sku.picture, 'date{YYYY-MM-DD}');
  assert.deepEqual(sku.bind, { match: 'dataRef', ref: '$.header.sku', picture: null });
  assert.equal(isPrintRelevant(sku.relevant), false);
});

test('checkButton, items, choiceList save list, scripted flag', () => {
  const { root } = model(SAMPLE);
  const agree = root.children.find(c => c.name === 'agree');
  assert.deepEqual([agree.ui.kind, agree.ui.size, agree.ui.mark], ['checkButton', 12, 'cross']);
  assert.deepEqual(agree.items[0].values, ['1', '0']);
  assert.deepEqual(agree.bind, { match: 'once', ref: null });
  assert.equal(agree.scripted.calculate, true);
  const state = root.children.find(c => c.name === 'state');
  assert.equal(state.items.length, 2);
  assert.equal(state.items[1].save, true);
  assert.deepEqual(state.items[1].values, ['ON', 'QC']);
});

test('draw values: line, rectangle, image, rich text', () => {
  const { root } = model(SAMPLE);
  const by = n => root.children.find(c => c.name === n).value;
  assert.deepEqual([by('rule').kind, by('rule').slope, by('rule').edge.thickness], ['line', '/', 2]);
  const box = by('box');
  assert.equal(box.kind, 'rectangle');
  assert.equal(box.edges[0].thickness, 0.5);
  assert.deepEqual(box.edges[0].color, [0, 0, 0]);
  assert.deepEqual([by('logo').kind, by('logo').aspect, by('logo').data], ['image', 'actual', 'iVBORw0K']);
  assert.equal(by('rich').kind, 'rich');
  assert.equal(by('rich').text, 'One two\nthree');
});

test('defaults: no border, null w/h, checkButton size 10pt, caption reserve auto', () => {
  const { root } = model(`<subform name="f"><field name="a"><ui><checkButton/></ui><caption><value><text>A</text></value></caption></field></subform>`);
  const a = root.children[0];
  assert.equal(a.border, undefined);
  assert.equal(a.w, null);
  assert.equal(a.h, null);
  assert.equal(a.ui.size, 10);
  assert.equal(a.caption.placement, 'left');
  assert.equal(a.caption.reserve, null);
});

test('relevant', () => {
  assert.equal(isPrintRelevant(parseRelevant('-print')), false);
  assert.equal(isPrintRelevant(parseRelevant('+print')), true);
  assert.equal(isPrintRelevant(parseRelevant('+screen')), false);
  assert.equal(isPrintRelevant(parseRelevant('-screen')), true);
  assert.equal(isPrintRelevant([]), true);
});

test('fixture: footer lives on the pageArea; buttons are -print', async () => {
  const buf = readFileSync(new URL('../../samples/xfa/on-a-103e.pdf', import.meta.url));
  const xfa = await extractXfa(await parsePdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
  const { root } = parseTemplateModel(xfa);
  const pa = root.pageSets[0].pageAreas[0];
  assert.ok(pa.children.some(n => n.value?.text?.includes("King's Printer for Ontario")));
  const nonPrint = [];
  const walk = n => { if (!isPrintRelevant(n.relevant)) nonPrint.push(n); n.children.forEach(walk); };
  walk(root);
  assert.ok(nonPrint.length >= 5);
});

test('numericEdit reads its comb', () => {
  const m = model(`<subform name="f"><field name="n"><ui><numericEdit><comb numberOfCells="10"/></numericEdit></ui></field></subform>`);
  const find = n => (n.name === 'n' ? n : (n.children ?? []).map(find).find(Boolean));
  assert.equal(find(m.root ?? m).ui.comb, 10);
});

test('a property given twice keeps the first (a stale second <value> is ignored)', () => {
  const xml = new DOMParser().parseFromString(`<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f">
    <draw name="d"><value><text>B. first</text></value><font typeface="Arial" weight="bold"/><value><text>III. stale</text></value><font typeface="Courier"/></draw>
  </subform></template>`, 'application/xml');
  const { root } = parseTemplateModel(xml);
  const d = root.children[0];
  assert.equal(d.value.text, 'B. first');
  assert.equal(d.font.typeface, 'Arial');
});

test('prototypes: use/usehref inherit attributes, properties and list children; own values win', () => {
  const xml = new DOMParser().parseFromString(`<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f">
    <proto><subform name="designer__stylesheet">
      <field name="a_Field" w="95mm" h="7mm"><font typeface="Calibri" size="11pt"/><para vAlign="middle" marginLeft="2pt"/>
        <border><edge><color value="153,153,153"/></edge><corner/></border></field>
      <draw name="byId" id="P1" h="20pt"><font typeface="Arial" size="9pt"/></draw>
    </subform></proto>
    <field name="x" usehref=".#som($template.#subform.designer__stylesheet.a_Field)" h="9mm"><para hAlign="right"/></field>
    <draw name="y" use="#P1"><value><text>t</text></value></draw>
  </subform></template>`, 'application/xml');
  const { root } = parseTemplateModel(xml);
  const x = root.children.find(c => c.name === 'x');
  assert.equal(x.font.typeface, 'Calibri');
  assert.equal(x.font.size, 11);
  assert.ok(Math.abs(x.w - 95 * 72 / 25.4) < 0.01);
  assert.ok(Math.abs(x.h - 9 * 72 / 25.4) < 0.01); // its own h wins
  assert.equal(x.para.hAlign, 'right');            // own property, merged
  assert.equal(x.para.vAlign, 'middle');           // ... with the prototype's
  assert.deepEqual(x.border.edges[0].color, [153, 153, 153]);
  const y = root.children.find(c => c.name === 'y');
  assert.equal(y.h, 20);
  assert.equal(y.font.typeface, 'Arial');
  assert.equal(y.value.text, 't');
});
