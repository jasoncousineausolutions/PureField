import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplateModel } from '../../src/xfa/model.js';
import { bindData } from '../../src/xfa/bind.js';
import { runScripts } from '../../src/xfa/script/run.js';
import { formatValues } from '../../src/xfa/format.js';
import { XfaLog } from '../../src/xfa/log.js';

const T = body => new DOMParser().parseFromString(
  `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">${body}</template>`, 'application/xml');
const D = body => {
  const doc = new DOMParser().parseFromString(
    `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>${body}</xfa:data></xfa:datasets>`, 'application/xml');
  const data = doc.documentElement.getElementsByTagName('xfa:data')[0];
  for (let n = data.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return n;
  return null;
};

// bind, run the scripts, format; → { root, log, find(som) }
function run(tpl, data = null, opts = {}) {
  const log = new XfaLog();
  const record = data === null ? null : D(data);
  const { root } = bindData(parseTemplateModel(T(tpl), { log }), record, { log });
  runScripts(root, { record, log, ...opts });
  formatValues(root, { log, locales: opts.locales ?? {} });
  const find = som => {
    const walk = n => {
      if (n.som === som) return n;
      for (const c of n.children ?? []) { const f = walk(c); if (f) return f; }
      for (const ps of n.pageSets ?? []) for (const pa of ps.pageAreas) for (const c of pa.children) { const f = walk(c); if (f) return f; }
      return null;
    };
    return walk(root);
  };
  return { root, log, find };
}

const fc = text => `<script>${text}</script>`;
const js = text => `<script contentType="application/x-javascript">${text}</script>`;
const ev = (activity, script, ref) => `<event activity="${activity}"${ref ? ` ref="${ref}"` : ''}>${script}</event>`;

test('FormCalc: if/else sets presence from a data value (Attestation logo)', () => {
  const tpl = `<subform name="f">
    <subform name="Logo">${ev('initialize', fc(`if ($.logo.rawValue == "1") then
  $.presence = "visible"
else
  $.presence = "hidden"
endif`))}
      <field name="logo"><bind match="dataRef" ref="$.logo"/></field>
    </subform>
  </subform>`;
  assert.equal(run(tpl, '<f><logo/></f>').find('f.Logo').presence, 'hidden');
  assert.equal(run(tpl, '<f><Logo><logo>1</logo></Logo></f>').find('f.Logo').presence, 'visible');
});

test('FormCalc: Exists() and data attributes ($record.a.b.presence.value)', () => {
  const tpl = `<subform name="f">
    <field name="a">${ev('docReady', fc(`if (Exists($record.B.w1.presence)) then
  $.presence = $record.B.w1.presence.value
else
  $.presence = "visible"
endif`), '$host')}</field>
    <field name="b">${ev('initialize', fc('if (Exists($record.B.nothing)) then $.presence = "hidden" endif'))}</field>
  </subform>`;
  const { find } = run(tpl, '<f><B><w1 presence="invisible"/></B></f>');
  assert.equal(find('f.a').presence, 'invisible');
  assert.equal(find('f.b').presence ?? 'visible', 'visible');
});

test('FormCalc: unqualified names resolve by SOM scoping, through nameless subforms', () => {
  const tpl = `<subform name="f">
    <subform><field name="btnvis"><value><integer>0</integer></value></field></subform>
    <subform name="S"><subform name="Row">
      <field name="chk">${ev('ready', fc('if (btnvis.rawValue == "0") then $.parent.presence = "hidden" endif'), '$form')}</field>
    </subform></subform>
  </subform>`;
  assert.equal(run(tpl).find('f.S.Row').presence, 'hidden');
});

test('FormCalc: Num2Date(Date(), …) formats today in the field\'s locale', () => {
  const locales = { fr_BE: { months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'], monthsAbbr: [], days: [], daysAbbr: [] } };
  const tpl = `<subform name="f" locale="fr_BE">
    <field name="d">${ev('ready', fc(`if ($.editValue == "") then
  $.formattedValue = Num2Date(Date(), "D MMMM YYYY")
endif`), '$form')}</field>
  </subform>`;
  const { find } = run(tpl, null, { now: new Date(2026, 9, 2), locales });
  assert.equal(find('f.d').display, '2 octobre 2026');
});

test('FormCalc: calculate scripts, Sum over [*], and null arithmetic', () => {
  const tpl = `<subform name="f">
    <subform name="row"><occur min="2" max="-1"/>
      <field name="q"/><field name="p"/>
      <field name="amt"><calculate>${fc('q * p')}</calculate></field>
    </subform>
    <field name="total"><calculate>${fc('Sum(row[*].amt)')}</calculate></field>
    <field name="s"><calculate>${fc('Concat("a", Str(2.5, 4, 1), Upper("x"))')}</calculate></field>
  </subform>`;
  const { find } = run(tpl, '<f><row><q>2</q><p>3</p></row><row/></f>');
  assert.equal(find('f.row.amt').raw, '6');
  // an empty quantity times an empty price stays empty (Purchase.Order)
  assert.equal(find('f.row[1].amt').raw, null);
  assert.equal(find('f.total').raw, '6');
  assert.equal(find('f.s').raw, 'a 2.5X');
});

test('JavaScript: presence toggles, script objects and execEvent', () => {
  const tpl = `<subform name="f">
    <variables>${js('var Debug; var unit = 3; function times(x) { return x * unit; }').replace('<script', '<script name="lib"')}</variables>
    <subform name="dbg">${ev('initialize', js('if (lib.Debug) { this.presence = "visible"; } else { this.presence = "hidden"; }'))}</subform>
    <field name="n">${ev('initialize', js('this.rawValue = lib.times(14)'))}</field>
    <exclGroup name="Interest">
      ${ev('initialize', js('this.execEvent("change");'))}
      ${ev('change', js('if (this.rawValue == "1") { IfYes.presence = "visible" } else { IfYes.presence = "hidden" }'))}
      <field name="yes"><items><text>1</text></items></field>
    </exclGroup>
    <subform name="IfYes"/>
  </subform>`;
  const { find } = run(tpl);
  assert.equal(find('f.dbg').presence, 'hidden');
  assert.equal(find('f.n').raw, '42');
  assert.equal(find('f.IfYes').presence, 'hidden');
});

test('JavaScript: form code cannot reach the host (constructor, prototypes) and cannot loop forever', () => {
  const tpl = `<subform name="f">
    <field name="a">${ev('initialize', js('this.rawValue = typeof ({}).constructor + "," + typeof "".constructor + "," + typeof (function(){}).constructor + "," + typeof [].__proto__'))}</field>
    <field name="b">${ev('initialize', js('this.rawValue = "start"; while (true) {}'))}</field>
    <field name="c">${ev('initialize', js('function r() { return r(); } r();'))}</field>
    <field name="d">${ev('initialize', js('this.rawValue = "after";'))}</field>
  </subform>`;
  const { find, log } = run(tpl);
  assert.equal(find('f.a').raw, 'undefined,undefined,undefined,undefined');
  // a runaway script keeps what it did before it was stopped; the next runs
  assert.equal(find('f.b').raw, 'start');
  assert.equal(find('f.d').raw, 'after');
  const failures = log.byCode('XFA_SCRIPT_FAILED').map(e => e.message).join('\n');
  assert.match(failures, /ran too long/);
  assert.match(failures, /recursed too deeply/);
});

test('JavaScript: ASI, closures, try/catch, regular expressions, Date from the injected now', () => {
  const tpl = `<subform name="f">
    <field name="a">${ev('initialize', js(`var parts = "a_b_c".split("_")
var out = []
for (var i = 0; i &lt; parts.length; i++) out.push(parts[i].toUpperCase())
try { null.x } catch (e) { out.push(e.name) }
var d = new Date()
this.rawValue = out.join("-") + "|" + "x1y2".replace(/\\d/g, "#") + "|" + d.getFullYear()`))}</field>
  </subform>`;
  assert.equal(run(tpl, null, { now: new Date(2026, 0, 5) }).find('f.a').raw, 'A-B-C-TypeError|x#y#|2026');
});

test('scripts changing captions, draw text and font colour reach the instance', () => {
  const tpl = `<subform name="f">
    <field name="a"><caption><value><text>Old</text></value></caption>
      ${ev('initialize', js('this.caption.value.text.value = "New"; this.font.fill.color.value = "150,150,150";'))}</field>
    <draw name="t"><value><text>x</text></value>${ev('initialize', fc('$.value.#text = "drawn"'))}</draw>
  </subform>`;
  const { find } = run(tpl);
  assert.equal(find('f.a').caption.value.text, 'New');
  assert.deepEqual(find('f.a').font.color, [150, 150, 150]);
  assert.equal(find('f.t').value.text, 'drawn');
});

test('page-area subforms with a dataRef bind move their children\'s data node', () => {
  const tpl = `<subform name="f">
    <pageSet><pageArea name="P"><contentArea w="8in" h="10in"/>
      <subform name="Btns"><bind match="dataRef" ref="$.Btns"/>
        <field name="btnvis"><bind match="dataRef" ref="$.btnvis"/><value><text>0</text></value></field>
      </subform>
      <subform name="Footer">${ev('ready', fc('if (Btns.btnvis.rawValue == "1") then Footer.presence = "invisible" endif'), '$layout')}</subform>
    </pageArea></pageSet>
  </subform>`;
  const { root, find } = run(tpl, '<f><Btns><btnvis>1</btnvis></Btns></f>');
  assert.equal(find('f.Btns.btnvis').raw, '1');
  const footer = root.pageSets[0].pageAreas[0].children.find(c => c.name === 'Footer');
  assert.equal(footer.presence, 'invisible');
});

test('a failing script is logged and later scripts still run; user events never fire', () => {
  const tpl = `<subform name="f">
    <field name="a">${ev('initialize', fc('NoSuchThing.rawValue = 1'))}${ev('click', fc('$.rawValue = "clicked"'))}</field>
    <field name="b">${ev('initialize', fc('$.rawValue = "ok"'))}</field>
  </subform>`;
  const { find, log } = run(tpl);
  assert.equal(find('f.a').raw, '');
  assert.equal(find('f.b').raw, 'ok');
  assert.equal(log.byCode('XFA_SCRIPT_FAILED').length, 1);
});

test('JavaScript: classic inheritance, fn.arguments, expandos and this in plain calls', () => {
  const lib = `function extend(sub, sup) { var F = function() {}; F.prototype = sup.prototype; sub.prototype = new F();
  sub.prototype.constructor = sub; sub.superclass = sup.prototype;
  if (sup.prototype.constructor == Object.prototype.constructor) { sup.prototype.constructor = sup; } }
function Base(v) { this.v = v; } Base.prototype.get = function() { return "v" + this.v; };
function Sub(v) { Sub.superclass.constructor.call(this, v); } extend(Sub, Base);
function count() { return count.arguments.length; }`;
  const tpl = `<subform name="f">
    <variables><script name="Lib" contentType="application/x-javascript">${lib}</script></variables>
    <field name="a">${ev('initialize', js('var s = new Lib.Sub(7); this.rawValue = s.get() + "," + (s instanceof Lib.Base) + "," + Lib.count(1, 2, 3);'))}</field>
    <field name="b">${ev('initialize', js('f.helper = function (x) { return x + 1; }; function self() { return this.name; } this.rawValue = f.helper(1) + self();'))}</field>
  </subform>`;
  const { find } = run(tpl);
  assert.equal(find('f.a').raw, 'v7,true,3');
  assert.equal(find('f.b').raw, '2b');
});

test('initialize fires for a container before its children', () => {
  const tpl = `<subform name="f">${ev('initialize', js('f.order = "f";'))}
    <field name="a">${ev('initialize', js('this.rawValue = f.order + ">a";'))}</field>
  </subform>`;
  assert.equal(run(tpl).find('f.a').raw, 'f>a');
});

test('script objects answer node methods for their subform; #items, access, ui.oneOfChild, border edges', () => {
  const tpl = `<subform name="f">
    <variables><script name="Obj" contentType="application/x-javascript">function target() { return this.resolveNode("S.c").name; }</script></variables>
    <subform name="S"><border><edge stroke="dashed"/><corner/></border>
      ${ev('initialize', js('this.border.edge.presence = "hidden";'))}
      <field name="c" access="readOnly"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items></field>
    </subform>
    <field name="out">${ev('initialize', js(`var c = S.c;
this.rawValue = [Obj.target(), c.access, c.ui.oneOfChild.className, c.resolveNodes("#items").item(0).nodes.item(1).value].join(",");`))}</field>
  </subform>`;
  const { find } = run(tpl);
  assert.equal(find('f.out').raw, 'c,readOnly,checkButton,0');
  // one edge given: hiding edge[0] hides every side
  assert.deepEqual(find('f.S').border.edges.map(e => e.presence), ['hidden', 'hidden', 'hidden', 'hidden']);
});

test('xfa.resolveNodes resolves an unqualified name from the running script\'s object', () => {
  const tpl = `<subform name="f">${ev('initialize', js('var p = xfa.resolveNodes("Page[*]"); for (var i = 0; i < p.length; i++) p.item(i).presence = "hidden";'))}
    <subform name="Page"><occur min="3" max="3"/></subform>
  </subform>`;
  const { root } = run(tpl);
  assert.deepEqual(root.children.map(c => c.presence), ['hidden', 'hidden', 'hidden']);
});

test('only a value assigned from a layout query is a page number; a script that merely tests one is not', () => {
  const tpl = `<subform name="f">
    <field name="num">${ev('ready', js('this.rawValue = xfa.layout.page(this)'), '$layout')}</field>
    <field name="title">${ev('initialize', js('this.rawValue = "Title"; if (xfa.layout.sheet(this) > 0) this.presence = "hidden";'))}</field>
  </subform>`;
  const { find } = run(tpl);
  assert.equal(find('f.num').pageRole, 'page');
  assert.equal(find('f.title').pageRole, undefined);
  assert.equal(find('f.title').raw, 'Title');
});

test('fillColor reads and sets the border fill, creating a fill-only border', () => {
  const tpl = `<subform name="f">
    <subform name="s" w="10pt" h="10pt">${ev('docReady', js('if (this.fillColor == "255,255,255") this.fillColor = "0,0,255";'), '$host')}</subform>
  </subform>`;
  const s = run(tpl).find('f.s');
  assert.deepEqual(s.border.fill.color, [0, 0, 255]);
  assert.equal(s.border.edges.length, 0);
});

test('"this" in SOM strings, text nodes assigned directly, border fill presence', () => {
  const tpl = `<subform name="f">
    <field name="b"><caption><value><text>Edit</text></value></caption><border><fill><color value="0,255,0"/></fill></border>
      ${ev('docReady', js('this.caption.value.text = "Done"; this.execEvent("click");'), '$host')}
      ${ev('click', js('if (xfa.resolveNode("this.caption.value.#text").value === "Edit") { this.caption.value.text = "Done"; } else { this.border.fill.presence = "invisible"; this.caption.value.text = "Edit"; }'))}</field>
  </subform>`;
  const b = run(tpl).find('f.b');
  assert.equal(b.caption.value.text, 'Edit');
  assert.equal(b.border.fill.presence, 'invisible');
});

test('prePrint: a table row it hides keeps its height (invisible); other containers are hidden', () => {
  const pre = ev('prePrint', js('this.presence = "hidden";'), '$host');
  const tpl = `<subform name="f" layout="tb">
    <subform name="t" layout="table" columnWidths="50pt">
      <subform name="r" layout="row"><draw name="c" h="10pt"/>${pre}</subform></subform>
    <subform name="s" layout="tb"><draw name="d" h="10pt"/>${pre}</subform>
    <subform name="u" layout="row"><draw name="e" h="10pt"/>
      ${ev('initialize', js('this.presence = "hidden";'))}</subform>
  </subform>`;
  const { find } = run(tpl);
  assert.equal(find('f.t.r').presence, 'invisible');
  assert.equal(find('f.s').presence, 'hidden');
  assert.equal(find('f.u').presence, 'hidden');
});

test('scripts set keep.intact/next/previous', () => {
  const tpl = `<subform name="f"><subform name="s" layout="tb">${ev('prePrint', js('this.keep.intact = "contentArea"; this.keep.next = "pageArea";'), '$host')}</subform></subform>`;
  const s = run(tpl).find('f.s');
  assert.equal(s.keep.intact, 'contentArea');
  assert.equal(s.keep.next, 'pageArea');
  assert.equal(s.keep.previous, 'none');
});

test('a boilerplate layout:ready script asking for its page runs once per page after layout', () => {
  const tpl = `<subform name="f"><pageSet><pageArea name="P"><contentArea w="100pt" h="100pt"/>
    <subform name="footer"><draw name="d" w="10pt" h="10pt"/>
      ${ev('ready', js('this.presence = xfa.layout.page(this) == 1 ? "visible" : "hidden";'), '$layout')}</subform>
    </pageArea></pageSet></subform>`;
  const log = new XfaLog();
  const { root } = bindData(parseTemplateModel(T(tpl), { log }), null, { log });
  const stats = runScripts(root, { log });
  const footer = root.pageSets[0].pageAreas[0].children[0];
  assert.equal(stats.pagePresence(1, 2).get(footer), 'visible');
  assert.equal(stats.pagePresence(2, 2).get(footer), 'hidden');
  // the object itself keeps its presence for layout
  assert.equal(footer.presence ?? 'visible', 'visible');
  assert.equal(log.byCode('XFA_SCRIPT_FAILED').length, 0);
});

test('a paper forms barcode: prePrint joins a manifest\'s data nodes, the barcode recalculates from it', () => {
  const tpl = `<subform name="form1"><subform name="page1">
    <field name="Name"><ui><textEdit/></ui><value><text>Ann</text></value></field>
    <subform name="A.1"><field name="City"><ui><textEdit/></ui></field></subform>
    <exclGroup name="Sex"><field name="m"><ui><checkButton/></ui><value><text>Off</text></value><items><text>M</text></items></field></exclGroup>
    <field name="BarcodeData" presence="hidden"><ui><textEdit/></ui></field>
    <field name="bc"><ui><barcode type="pdf417"/></ui>
      <calculate>${js('this.rawValue = BarcodeData.rawValue;')}</calculate>
      ${ev('prePrint', js(`var nodes = Coll.evaluate(); var v = [];
        for (var i = 0; i &lt; nodes.length; ++i) v.push(nodes.item(i).value == null ? "" : nodes.item(i).value);
        BarcodeData.rawValue = v.join("|") + "|" + xfa.datasets.data.className + "|" + nodes.item(0).somExpression;`), '$host')}
    </field></subform>
    <variables><manifest name="Coll">
      <ref>xfa[0].form[0].form1[0].page1[0].Name[0].dataNode</ref>
      <ref>xfa[0].form[0].form1[0].page1[0].A\\.1[0].City[0].dataNode</ref>
      <ref>xfa[0].form[0].form1[0].page1[0].Sex[0].dataNode</ref>
    </manifest></variables></subform>`;
  const { find, log } = run(tpl);
  assert.ok(!log.entries.some(e => e.code === 'XFA_SCRIPT_FAILED'), JSON.stringify(log.entries));
  // an empty field and an unselected radio group give empty values; a form
  // without data still has a data root
  assert.equal(find('form1.page1.bc').raw, 'Ann|||dataGroup|xfa[0].datasets[0].data[0].form1[0].page1[0].Name[0]');
});

// --- instances added and removed by scripts ---

const rowTpl = (occur, init = '', extra = '') => `<subform name="f"><subform name="t">
  <subform name="Row"><occur ${occur}/><field name="v"><ui><textEdit/></ui></field>${extra}</subform>
  ${init}</subform>
  <field name="total"><ui><numericEdit/></ui><calculate>${js('var s = 0; for (var i = 0; i < t._Row.count; i++) s += Number(t.resolveNode("Row[" + i + "]").v.rawValue); s;'.replace(/</g, '&lt;'))}</calculate></field></subform>`;
const rows = (find, n) => Array.from({ length: n }, (_, i) => find(`f.t.Row${i ? `[${i}]` : ''}`));

test('addInstance from initialize: the row exists before layout, runs its own scripts, and totals see it', () => {
  const tpl = rowTpl('min="1" max="-1"',
    `<field name="go"><ui><textEdit/></ui>${ev('initialize', js('var r = _Row.addInstance(1); r.v.rawValue = "5"; _Row.addInstance(0).v.rawValue = "7";'))}</field>`,
    `<field name="seen"><ui><textEdit/></ui>${ev('initialize', js('this.rawValue = "init " + this.parent.index;'))}</field>`);
  const { find, log } = run(tpl);
  assert.ok(!log.entries.some(e => e.code === 'XFA_SCRIPT_FAILED'), JSON.stringify(log.entries));
  const [r0, r1, r2] = rows(find, 3);
  assert.ok(r0 && r1 && r2);
  assert.equal(r1.index, 1);
  assert.equal(find('f.t.Row[1].v').raw, '5');
  assert.equal(find('f.t.Row[2].seen').raw, 'init 2'); // the new row's own initialize ran
  assert.equal(find('f.total').raw, '12');             // a calculate over the table sees them
  // in document order, before the button that added them
  const kids = find('f.t').children.map(c => c.som);
  assert.deepEqual(kids, ['f.t.Row', 'f.t.Row[1]', 'f.t.Row[2]', 'f.t.go']);
});

test('addInstance merges the next data row, else adds an empty one', () => {
  const tpl = `<subform name="f"><subform name="Row"><occur min="0" max="-1"/><field name="v"><ui><textEdit/></ui></field></subform>
    <field name="go"><ui><textEdit/></ui>${ev('initialize', js('_Row.setInstances(3);'))}</field></subform>`;
  const { find } = run(tpl, '<f><Row><v>a</v></Row><Row><v>b</v></Row></f>');
  assert.equal(find('f.Row.v').raw, 'a');
  assert.equal(find('f.Row[1].v').raw, 'b');
  assert.ok(find('f.Row[2]'));
  assert.equal(find('f.Row[3]'), null);
});

test('occur limits: count to the current count, max and min clamp without throwing', () => {
  const tpl = rowTpl('min="1" max="2"', `<field name="go"><ui><textEdit/></ui>${ev('initialize', js(`
    _Row.count = _Row.count;
    var a = _Row.addInstance(1); var b = _Row.addInstance(1);
    this.rawValue = (b.index) + "/" + _Row.count + "/" + _Row.max;
    _Row.setInstances(0);`))}</field>`);
  const { find, log } = run(tpl);
  assert.ok(!log.entries.some(e => e.code === 'XFA_SCRIPT_FAILED'), JSON.stringify(log.entries));
  assert.equal(find('f.t.go').raw, '1/2/2'); // the third add returns the second instance
  assert.ok(find('f.t.Row'));                  // setInstances(0) stops at min 1
  assert.equal(find('f.t.Row[1]'), null);
});

test('removeInstance(0) renumbers: Row[1] is then the old third row', () => {
  const tpl = `<subform name="f"><subform name="Row"><occur min="0" max="-1" initial="3"/><field name="v"><ui><textEdit/></ui></field></subform>
    <field name="go"><ui><textEdit/></ui>${ev('initialize', js(`
      Row.v.rawValue = "a"; Row.instanceManager.addInstance(0); 
      var all = xfa.resolveNodes("f.Row[*]"); all.item(1).v.rawValue = "b"; all.item(2).v.rawValue = "c";
      _Row.removeInstance(0);
      this.rawValue = _Row.count + ":" + xfa.resolveNode("f.Row[1]").v.rawValue + ":" + xfa.resolveNode("f.Row[1]").index;`))}</field></subform>`;
  const { find, log } = run(tpl);
  assert.ok(!log.entries.some(e => e.code === 'XFA_SCRIPT_FAILED'), JSON.stringify(log.entries));
  assert.match(find('f.go').raw, /^3:c:1$/);
  assert.equal(find('f.Row[1].v').raw, 'c');
  assert.equal(find('f.Row[1].v').som, 'f.Row[1].v');
});

test('insertInstance puts a row at a position, moveInstance reorders: both renumber, data follows', () => {
  const tpl = `<subform name="f"><subform name="Row"><occur min="0" max="-1"/><field name="v"><ui><textEdit/></ui></field></subform>
    <field name="go"><ui><textEdit/></ui>${ev('initialize', js(`
      var r = _Row.insertInstance(1, 0); r.v.rawValue = "new";
      var s = "";
      for (var i = 0; i < _Row.count; i++) s += xfa.resolveNode("f.Row[" + i + "]").v.rawValue + ",";
      _Row.moveInstance(0, 2);
      for (var i = 0; i < _Row.count; i++) s += xfa.resolveNode("f.Row[" + i + "]").v.rawValue + ",";
      this.rawValue = s;`))}</field></subform>`;
  const { find, log } = run(tpl, '<f><Row><v>a</v></Row><Row><v>b</v></Row></f>');
  assert.ok(!log.entries.some(e => e.code === 'XFA_SCRIPT_FAILED'), JSON.stringify(log.entries));
  assert.equal(find('f.go').raw, 'a,new,b,new,b,a,');
  assert.equal(find('f.Row[2].v').raw, 'a');
  assert.equal(find('f.Row[2].v').som, 'f.Row[2].v');
  assert.equal(find('f.Row').index, 0);
});
