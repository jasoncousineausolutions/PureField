import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePdf } from '../../src/core/parser.js';
import { extractXfa } from '../../src/xfa/extractor.js';
import { parseTemplateModel } from '../../src/xfa/model.js';
import { bindData } from '../../src/xfa/bind.js';

const T = body => new DOMParser().parseFromString(
  `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">${body}</template>`, 'application/xml');
const D = body => {
  const doc = new DOMParser().parseFromString(
    `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>${body}</xfa:data></xfa:datasets>`, 'application/xml');
  const data = doc.documentElement.getElementsByTagName('xfa:data')[0];
  for (let n = data.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return n;
  return null;
};
const bind = (tpl, data) => bindData(parseTemplateModel(T(tpl)), data === null ? null : D(data));

function find(inst, som) {
  if (inst.som === som) return inst;
  for (const c of inst.children) { const f = find(c, som); if (f) return f; }
  return null;
}
const leaves = inst => inst.children.length ? inst.children.flatMap(leaves) : [inst];

// The worked example from spec §5
const SPEC_TPL = `
<subform name="form1">
  <subform name="header">
    <field name="firstName"><bind match="dataRef" ref="header.firstName"/></field>
    <field name="issued"><bind match="once"/></field>
  </subform>
  <subform name="line">
    <occur min="1" max="-1"/>
    <field name="sku"/>
    <field name="note"><bind match="none"/><value><text>n/a</text></value></field>
  </subform>
  <field name="office"><bind match="global"/></field>
</subform>`;
const SPEC_DATA = `
<form1>
  <header><firstName>Ada</firstName><issued>2024-11-02</issued></header>
  <line><sku>A-14</sku><qty>2</qty></line>
  <line><sku>B-02</sku><qty>1</qty></line>
  <office>Springfield</office>
</form1>`;

test('spec §5 example', () => {
  const { root, grew } = bind(SPEC_TPL, SPEC_DATA);
  // unqualified ref climbs from the header data node to form1, then finds header.firstName
  assert.equal(find(root, 'form1.header.firstName').raw, 'Ada');
  assert.equal(find(root, 'form1.header.issued').raw, '2024-11-02');
  assert.equal(find(root, 'form1.line.sku').raw, 'A-14');
  assert.equal(find(root, 'form1.line[1].sku').raw, 'B-02');
  assert.equal(find(root, 'form1.line[1].sku').dataPath, 'form1.line[1].sku');
  assert.equal(find(root, 'form1.line.note').raw, 'n/a');
  assert.equal(find(root, 'form1.line.note').bound, false);
  assert.equal(find(root, 'form1.office').raw, 'Springfield');
  assert.equal(grew, true);
});

test('dataRef: relative, $record, $data, attribute, dangling', () => {
  const { root, log } = bind(`
<subform name="form1">
  <subform name="header">
    <field name="a"><bind match="dataRef" ref="$.firstName"/></field>
    <field name="b"><bind match="dataRef" ref="$record.office"/></field>
    <field name="c"><bind match="dataRef" ref="$data.form1.line[1].sku"/></field>
    <field name="d"><bind match="dataRef" ref="xfa.datasets.data.form1.header.@kind"/></field>
    <field name="e"><bind match="dataRef" ref="$.nope"/><value><text>dflt</text></value></field>
  </subform>
</subform>`, SPEC_DATA.replace('<header>', '<header kind="main">'));
  assert.equal(find(root, 'form1.header.a').raw, 'Ada');
  assert.equal(find(root, 'form1.header.b').raw, 'Springfield');
  assert.equal(find(root, 'form1.header.c').raw, 'B-02');
  assert.equal(find(root, 'form1.header.d').raw, 'main');
  assert.equal(find(root, 'form1.header.e').raw, 'dflt');
  assert.equal(log.byCode('XFA_BIND_DANGLING').length, 1);
});

test('dataRef [*] drives repeated subforms', () => {
  const { root } = bind(`
<subform name="form1">
  <subform name="row"><occur min="0" max="-1"/><bind match="dataRef" ref="$.line[*]"/>
    <field name="sku"/>
  </subform>
</subform>`, SPEC_DATA);
  assert.deepEqual(root.children.map(c => c.som), ['form1.row', 'form1.row[1]']);
  assert.deepEqual(root.children.map(c => c.children[0].raw), ['A-14', 'B-02']);
});

test('occur: min pads with empty instances, max caps, min 0 drops', () => {
  const { root } = bind(`
<subform name="form1">
  <subform name="line"><occur min="3" max="-1"/><field name="sku"/></subform>
  <subform name="cap"><occur min="0" max="1"/><bind match="dataRef" ref="$.line[*]"/></subform>
  <subform name="absent"><occur min="0" max="-1"/><field name="x"/></subform>
</subform>`, SPEC_DATA);
  const lines = root.children.filter(c => c.name === 'line');
  assert.deepEqual(lines.map(l => l.children[0].raw), ['A-14', 'B-02', '']);
  assert.equal(lines[2].children[0].bound, false);
  assert.equal(root.children.filter(c => c.name === 'cap').length, 1);
  assert.equal(root.children.filter(c => c.name === 'absent').length, 0);
});

test('no data at all: initial governs, fields take template defaults', () => {
  const { root } = bind(`
<subform name="form1">
  <subform name="line"><occur min="0" max="-1" initial="2"/><field name="sku"><value><text>?</text></value></field></subform>
</subform>`, null);
  assert.equal(root.children.length, 2);
  assert.deepEqual(leaves(root).map(l => l.raw), ['?', '?']);
});

test('field value rules: direct text, empty element, nil, failed match', () => {
  const { root } = bind(`
<subform name="form1">
  <field name="mixed"/>
  <field name="empty"><value><text>dflt</text></value></field>
  <field name="nil"><value><text>dflt</text></value></field>
  <field name="missing"><value><text>dflt</text></value></field>
</subform>`, `<form1 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><mixed>a<b>ignored</b>c</mixed><empty/><nil xsi:nil="true"/></form1>`);
  assert.equal(find(root, 'form1.mixed').raw, 'ac');
  assert.equal(find(root, 'form1.empty').raw, '');
  assert.equal(find(root, 'form1.empty').bound, true);
  assert.equal(find(root, 'form1.nil').raw, null);
  assert.equal(find(root, 'form1.missing').raw, 'dflt');
  assert.equal(find(root, 'form1.missing').bound, false);
});

test('once consumes: two same-named fields take successive data nodes', () => {
  const { root } = bind(`<subform name="form1"><field name="v"/><field name="v"/><field name="v"/></subform>`,
    `<form1><v>1</v><v>2</v></form1>`);
  assert.deepEqual(root.children.map(c => [c.som, c.raw]), [['form1.v', '1'], ['form1.v[1]', '2'], ['form1.v[2]', '']]);
});

test('match none / nameless subforms and areas are transparent', () => {
  const { root } = bind(`
<subform name="form1">
  <subform><field name="a"/></subform>
  <subform name="wrap"><bind match="none"/><field name="b"/></subform>
  <area name="ar"><field name="c"/></area>
</subform>`, `<form1><a>1</a><b>2</b><c>3</c></form1>`);
  assert.deepEqual(leaves(root).map(l => l.raw), ['1', '2', '3']);
});

test('exclGroup binds once; members share the group value', () => {
  const { root } = bind(`
<subform name="form1">
  <exclGroup name="color">
    <field name="red"><ui><checkButton/></ui><items><text>r</text></items></field>
    <field name="blue"><ui><checkButton/></ui><items><text>b</text></items></field>
  </exclGroup>
</subform>`, `<form1><color>b</color><red>should-not-bind</red></form1>`);
  const g = root.children[0];
  assert.equal(g.raw, 'b');
  assert.deepEqual(g.children.map(c => c.raw), ['b', 'b']);
});

test('script-only values log XFA_BIND_SCRIPT_SKIPPED', () => {
  const { log } = bind(`<subform name="form1"><field name="total"><calculate><script>a+b</script></calculate></field></subform>`, `<form1/>`);
  assert.equal(log.byCode('XFA_BIND_SCRIPT_SKIPPED').length, 1);
});

test('fixture: form data binds into the instance tree', async () => {
  const buf = readFileSync(new URL('../../samples/xfa/on-a-103e.pdf', import.meta.url));
  const xfa = await extractXfa(await parsePdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
  const { root } = bindData(parseTemplateModel(xfa), xfa.dataRoot);
  const fields = [];
  const walk = n => { if (n.type === 'field') fields.push(n); n.children.forEach(walk); };
  walk(root);
  const byName = n => fields.filter(f => f.name === n).map(f => f.raw);
  assert.ok(byName('ReviewerEmail').includes('OLRBIntake@ontario.ca'));
  assert.ok(fields.filter(f => f.bound).length > 20);
});

test('dataRef record.a.b reads as $record.a.b when nothing named record is in scope', () => {
  const { root, log } = bind(`
<subform name="form1">
  <subform name="header"><field name="b"><bind match="dataRef" ref="record.office"/></field></subform>
</subform>`, SPEC_DATA);
  assert.equal(find(root, 'form1.header.b').raw, 'Springfield');
  assert.equal(log.byCode('XFA_BIND_DANGLING').length, 0);
});

test('form state: geometry a script changed (h) replaces the template value', async () => {
  const { parseTemplateModel } = await import('../../src/xfa/model.js');
  const { bindData } = await import('../../src/xfa/bind.js');
  const { applyFormState } = await import('../../src/xfa/formstate.js');
  const tpl = new DOMParser().parseFromString(`<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
    <subform name="form1" layout="tb"><subform name="box" w="100pt" h="20pt"><draw name="t" h="20pt"/></subform></subform></template>`, 'application/xml');
  const { root } = bindData(parseTemplateModel(tpl), null);
  const form = new DOMParser().parseFromString(`<form xmlns="http://www.xfa.org/schema/xfa-form/2.8/">
    <subform name="form1"><subform name="box" h="1in"><draw name="t" h="1in"/></subform></subform></form>`, 'application/xml');
  const stats = applyFormState(root, form);
  const box = root.children.find(c => c.name === 'box');
  assert.equal(box.h, 72);
  assert.equal(box.children[0].h, 72);
  assert.equal(stats.geometry, 2);
});
