import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplateModel } from '../../src/xfa/model.js';
import { bindData } from '../../src/xfa/bind.js';
import { formatValues } from '../../src/xfa/format.js';
import { layoutForm } from '../../src/xfa/flow.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg ?? ''} ${a} != ${b}`);

function layout(body, pageSet = PAGESET) {
  const xml = new DOMParser().parseFromString(
    `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb">${pageSet}${body}</subform></template>`,
    'application/xml');
  const { root } = bindData(parseTemplateModel(xml), null);
  formatValues(root);
  return layoutForm(root).pages;
}
const PAGESET = `<pageSet><pageArea name="P"><contentArea x="0" y="0" w="100pt" h="100pt"/><medium short="100pt" long="100pt"/></pageArea></pageSet>`;
const item = (pages, name, p = 0) => pages[p].items.find(i => i.node.name === name);

test('position: x/y and anchorType inside the parent content box', () => {
  const pages = layout(`<subform name="box" w="100pt" h="50pt"><margin leftInset="5pt" topInset="5pt"/>
    <draw name="a" x="10pt" y="10pt" w="20pt" h="10pt"/>
    <draw name="b" x="90pt" y="40pt" w="20pt" h="10pt" anchorType="bottomRight"/></subform>`);
  const a = item(pages, 'a'), b = item(pages, 'b');
  assert.deepEqual([a.x, a.y], [15, 15]);
  assert.deepEqual([b.x, b.y], [75, 35]);
});

test('tb ignores x/y and stacks; omitted widths fill', () => {
  const pages = layout(`<draw name="a" x="50pt" y="50pt" h="10pt"/><draw name="b" h="20pt"/>`);
  const a = item(pages, 'a'), b = item(pages, 'b');
  assert.deepEqual([a.x, a.y, a.w], [0, 0, 100]);
  assert.deepEqual([b.y, b.w], [10, 100]);
});

test('lr-tb wraps when the next child does not fit', () => {
  const pages = layout(`<subform name="row" layout="lr-tb" w="100pt">
    <draw name="a" w="60pt" h="10pt"/><draw name="b" w="30pt" h="15pt"/><draw name="c" w="20pt" h="5pt"/></subform>`);
  assert.deepEqual(['a', 'b', 'c'].map(n => [item(pages, n).x, item(pages, n).y]), [[0, 0], [60, 0], [0, 15]]);
});

test('table: -1 columns take the widest cell; rows stretch to the tallest cell', () => {
  const pages = layout(`<subform name="t" layout="table" columnWidths="30pt -1">
    <subform name="r1" layout="row"><draw name="a" h="10pt"/><draw name="b" w="40pt" h="20pt"/></subform>
    <subform name="r2" layout="row"><draw name="c" h="5pt"/><draw name="d" w="25pt" h="5pt"/></subform></subform>`);
  const a = item(pages, 'a'), b = item(pages, 'b'), d = item(pages, 'd');
  assert.deepEqual([a.w, a.h, b.x, b.w], [30, 20, 30, 40]);
  assert.deepEqual([d.x, d.y, d.w], [30, 20, 40]);
});

test('table: with no w and every column width given, the table is as wide as its columns', () => {
  const pages = layout(`<subform name="t" layout="table" columnWidths="30pt 20pt"><subform name="r" layout="row"><draw name="a" h="10pt"/><draw name="b" h="10pt"/></subform></subform>
    <subform name="u" layout="table" columnWidths="30pt -1"><subform name="s" layout="row"><draw name="c" h="10pt"/><draw name="d" w="10pt" h="10pt"/></subform></subform>`);
  assert.equal(item(pages, 't').w, 50);
  assert.equal(item(pages, 'u').w, 100); // a column sized by its cells: the table fills
});

test('presence: hidden takes no space; invisible and -print take space without paint', () => {
  const pages = layout(`<draw name="h" h="10pt" presence="hidden"/><draw name="i" h="10pt" presence="invisible"/>
    <draw name="p" h="10pt" relevant="-print"/><subform name="s" layout="tb" relevant="+screen"><draw name="c" h="5pt"/></subform>
    <draw name="v" h="10pt"/>`);
  assert.equal(item(pages, 'h'), undefined);
  assert.equal(item(pages, 'i').paint, false);
  assert.equal(item(pages, 'p').paint, false);
  assert.equal(item(pages, 'c').paint, false, 'inside a screen-only subform');
  assert.equal(item(pages, 'v').y, 25);
});

test('pagination: tb content spills to new pages; breakBefore forces one', () => {
  const pages = layout(`<draw name="a" h="60pt"/><draw name="b" h="60pt"/>
    <subform name="s" layout="tb"><breakBefore targetType="pageArea"/><draw name="c" h="10pt"/></subform>`);
  assert.equal(pages.length, 3);
  assert.equal(item(pages, 'b', 1).y, 0);
  assert.equal(item(pages, 'c', 2).y, 0);
});

test('a flowed subform splits across pages, emitting one fragment per page', () => {
  const pages = layout(`<subform name="s" layout="tb"><draw name="a" h="70pt"/><draw name="b" h="70pt"/></subform>`);
  assert.equal(pages.length, 2);
  const frags = pages.map(p => p.items.find(i => i.node.name === 's'));
  assert.ok(frags.every(f => f && f.fragment));
  close(frags[0].h, 70); close(frags[1].h, 70);
});

test('keep intact moves a subform that fits on a fresh page', () => {
  const pages = layout(`<draw name="a" h="60pt"/><subform name="k" layout="tb"><keep intact="contentArea"/><draw name="b" h="30pt"/><draw name="c" h="30pt"/></subform>`);
  assert.equal(item(pages, 'b', 1).y, 0);
});

test('field: caption reserve splits the box; omitted h sizes from lines', () => {
  const pages = layout(`<field name="f" w="100pt"><font typeface="Helvetica" size="10pt"/>
    <caption placement="left" reserve="40pt"><value><text>Name</text></value></caption></field>`);
  const f = item(pages, 'f').node;
  assert.deepEqual([f.parts.caption.w, f.parts.value.x, f.parts.value.w], [40, 40, 60]);
  close(f.lh, 10); // one line: the font size, without the line gap
});

test('text height: the first line takes the font size, each further line the line height', () => {
  const pages = layout(`<draw name="d" w="30pt"><value><text>aa bb cc</text></value><font typeface="Arial" size="10pt"/></draw>`);
  const d = item(pages, 'd');
  close(d.h, 10 + (d.node.parts.lines.length - 1) * 12);
  assert.ok(d.node.parts.lines.length > 1);
});

test('pagination: a split subform repeats its top margin on each continuation', () => {
  const pages = layout(`<subform name="s" layout="tb"><margin topInset="10pt"/>
    <draw name="a" h="50pt"/><draw name="b" h="50pt"/></subform>`);
  assert.equal(item(pages, 'a').y, 10);
  assert.equal(item(pages, 'b', 1).y, 10);
});

test('pageArea boilerplate repeats on every page', () => {
  const ps = `<pageSet><pageArea name="P"><contentArea x="0" y="0" w="100pt" h="80pt"/><medium short="100pt" long="100pt"/>
    <draw name="foot" x="0" y="85pt" w="100pt" h="10pt"><value><text>f</text></value></draw></pageArea></pageSet>`;
  const pages = layout(`<draw name="a" h="60pt"/><draw name="b" h="60pt"/>`, ps);
  assert.equal(pages.length, 2);
  assert.ok(pages.every(p => p.items.some(i => i.node.name === 'foot' && i.y === 85)));
});

test('rich text: runs keep their own style and inherit the rest', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">
    <p style="text-align:center">Last   Name <span style="color:#ff0000">*</span></p>
    <p><span style="font-weight:normal">plain</span> <i>it</i><br/>next <span style="xfa-spacerun:yes">  </span><span xfa:embed="#pg"/></p></body>`, 'application/xml').documentElement;
  const paras = parseRich(body);
  assert.equal(paras.length, 2);
  assert.equal(paras[0].align, 'center');
  assert.deepEqual(paras[0].runs.map(r => r.text), ['Last Name ', '*']);
  assert.deepEqual(paras[0].runs[1].style.color, [255, 0, 0]);
  const base = resolveFont({ typeface: 'Arial', size: 10, weight: 'bold' }, null);
  const lines = layoutRich(paras, base, null, 500);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].segments[0].font.bold, true);            // inherited from the draw font
  assert.equal(lines[1].segments[0].font.bold, false);           // span overrides
  assert.equal(lines[1].segments.find(s => s.text === 'it').font.italic, true);
  assert.ok(lines[2].segments.some(s => s.embed === 'pg'));
  assert.ok(lines[2].segments.some(s => /\u00a0 /.test(s.text ?? '')));  // spacerun kept: no-break space, then a breakable one
});

test('rich text: a length vertical-align on a paragraph makes its lines taller, the room above the text', async () => {
  // dclUnica: <p style="vertical-align:3pt"> lines are 17.4pt apart in Reader
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p style="vertical-align:3pt">one</p><p style="vertical-align:3pt">two</p><p>three</p><p style="vertical-align:super">four</p></body>`, 'application/xml').documentElement;
  const lines = layoutRich(parseRich(body), resolveFont({ typeface: 'Arial', size: 12 }, null), null, 500);
  close(lines[0].height, 1.2 * 12 + 3);
  close(lines[1].height, 1.2 * 12 + 3);
  close(lines[2].height, 1.2 * 12);
  close(lines[3].height, 1.2 * 12);   // super on a block stays inline-only
  close(lines[0].ascent - lines[2].ascent, 3);   // the room is above the text
  assert.ok(!lines[0].segments[0].font.baselineShift);
});

test('rich text: a trailing <br> opens no line; a <br>-only block is one empty line', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <div>One</div><div><span style="xfa-spacerun:yes"> </span><br/></div><div><br/></div><div>Two<br/></div><div>Three<br/><br/></div></body>`, 'application/xml').documentElement;
  const base = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const lines = layoutRich(parseRich(body), base, null, 500);
  assert.deepEqual(lines.map(l => l.segments.map(s => s.text).join('')), ['One', '', '', 'Two', 'Three', '']);
});

test('rich text: xfa-spacerun spaces stay break opportunities', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p>aaa<span style="xfa-spacerun:yes"> bbb ccc ddd eee</span></p></body>`, 'application/xml').documentElement;
  const base = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const lines = layoutRich(parseRich(body), base, null, 40);
  assert.ok(lines.length > 1);
});

test('rich text: xfa-tab-count advances to CSS tab-stops', async () => {
  const { parseRich, layoutRich, parseTabStops } = await import('../../src/xfa/rich.js');
  const { resolveFont, textWidth } = await import('../../src/xfa/text.js');
  assert.deepEqual(parseTabStops('left 1in left 2in'), [{ align: 'left', pos: 72 }, { align: 'left', pos: 144 }]);
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p style="tab-stops: left 1in left 2in">A<span style="xfa-tab-count:1"/>B<span style="xfa-tab-count:1"/>C</p>
    <p style="tab-stops: left 1in left 2in">A<span style="xfa-tab-count:2"/>C</p></body>`, 'application/xml').documentElement;
  const base = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const [l1, l2] = layoutRich(parseRich(body), base, null, 500);
  const startOf = (line, t) => { let x = 0; for (const s of line.segments) { if (s.text === t) return x; x += s.w; } return null; };
  assert.ok(Math.abs(startOf(l1, 'B') - 72) < 1e-6);
  assert.ok(Math.abs(startOf(l1, 'C') - 144) < 1e-6);
  assert.ok(Math.abs(startOf(l2, 'C') - 144) < 1e-6);
  assert.ok(Math.abs(l1.width - (144 + textWidth(base, 'C'))) < 1e-6);
});

test('Times-class typefaces measure with Core 14 Times widths', async () => {
  const { resolveFont, textWidth, emBox } = await import('../../src/xfa/text.js');
  const times = resolveFont({ typeface: 'Times New Roman', size: 10 }, null);
  assert.equal(times.face, 'Times-Roman');
  close(textWidth(times, 'Hello World'), 50.27);            // AFM: 5027 / 1000 × 10
  close(textWidth(resolveFont({ typeface: 'Minion Pro', size: 10, weight: 'bold' }, null), 'A'), 7.22);
  close(emBox(times).ascent, 6.83);
});

test('rotate turns a box counterclockwise about its anchor', () => {
  const pages = layout(`<subform name="box" w="100pt" h="100pt">
    <draw name="r" x="10pt" y="80pt" w="50pt" h="10pt" rotate="90"><value><text>up</text></value></draw></subform>`);
  const r = item(pages, 'r');
  assert.deepEqual([r.x, r.y, r.w, r.h], [10, 80, 50, 10]);          // laid out upright at the anchor
  assert.deepEqual(r.rots, [{ angle: 90, ox: 10, oy: 80 }]);          // turned about (x, y)
});

test('paint: the first baseline sits one ascent below the top, the last one descent above the bottom', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <draw name="t" x="0" y="0" w="100pt" h="40pt"><value><text>Top</text></value><font typeface="Arial" size="10pt"/></draw>
    <draw name="b" x="0" y="50pt" w="100pt" h="40pt"><value><text>Bottom</text></value><font typeface="Arial" size="10pt"/><para vAlign="bottom"/></draw></subform>`);
  const [p] = await paintPages(pages);
  const ys = [...p.content.matchAll(/([\d.]+) ([\d.]+) Td/g)].map(m => +m[2]);
  // page height 100; Arial (Liberation) ascent 0.728, descent 0.210
  close(ys[0], 100 - 7.28, 'top');
  close(ys[1], 100 - (90 - 2.1), 'bottom');
});

test('paint: justify spreads every line but the paragraph\'s last to the full width', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <field name="j" x="0" y="0" w="60pt" h="60pt"><ui><textEdit multiLine="1"/></ui>
      <value><text>aa bb cc dd ee ff gg hh</text></value><font typeface="Arial" size="10pt"/><para hAlign="justify"/></field></subform>`);
  const [p] = await paintPages(pages);
  const runs = [...p.content.matchAll(/([\d.]+) ([\d.]+) Td\n(?:<[0-9a-f]+>|\(([^)]*)\)) Tj/g)].map(m => ({ x: +m[1], y: +m[2] }));
  const lines = new Map();
  for (const r of runs) lines.set(r.y, [...(lines.get(r.y) ?? []), r.x]);
  const rows = [...lines.values()];
  assert.ok(rows.length >= 2);
  // first line: its last word ends at the right edge (60pt); last line stays ragged
  const { resolveFont, textWidth } = await import('../../src/xfa/text.js');
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const first = rows[0];
  close(first.at(-1) + textWidth(font, 'dd'), 60, 'right edge');
  assert.equal(rows.at(-1).length, 1, 'last line drawn as one run');
});

test('fields and draws honour minH in flowed layouts; subforms do not', () => {
  const pages = layout(`<subform name="row" layout="lr-tb" w="100pt">
    <field name="f" w="80pt" minH="40pt"><ui><textEdit multiLine="1"/></ui><font typeface="Arial" size="10pt"/></field>
    <subform name="s" layout="tb" w="80pt" minH="40pt"><draw name="d" h="10pt"/></subform></subform>`);
  assert.equal(item(pages, 'f').h, 40);
  assert.equal(item(pages, 's').h, 10);
  // nor inside a position parent
  const pos = layout(`<subform name="p" w="100pt"><subform name="s" minH="40pt"><draw name="d" w="10pt" h="10pt"/></subform></subform>`);
  assert.equal(item(pos, 's').h, 10);
});

test('a button caption without a reserve covers the whole button', () => {
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <field name="b" x="0" y="0" w="60pt" h="20pt"><ui><button/></ui><font typeface="Arial" size="9pt"/>
      <caption><value><text>Go</text></value><para hAlign="center" vAlign="middle"/></caption></field></subform>`);
  const { caption, content } = item(pages, 'b').node.parts;
  assert.deepEqual(caption, content);
});

test('paint: lowered and raised edges draw inside the box with a bevel', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <draw name="r" x="10pt" y="10pt" w="50pt" h="20pt"><value><rectangle><edge stroke="lowered" thickness="1pt"/></rectangle></value></draw></subform>`);
  const [p] = await paintPages(pages);
  // outer band stroked half a thickness inside the box
  assert.match(p.content, /10\.5 70\.5 49 19 re/);
  // two bevel polygons: grey 128 top-left, (212,208,200) bottom-right
  assert.match(p.content, /0\.502 0\.502 0\.502 rg/);
  assert.match(p.content, /0\.831 0\.816 0\.784 rg/);
});

test('pagination: a split subform whose first row does not fit starts on the next page with its top margin', () => {
  const pages = layout(`<draw name="a" h="85pt"/>
    <subform name="s" layout="lr-tb" w="100pt"><margin topInset="10pt"/><draw name="b" w="100pt" h="40pt"/><draw name="c" w="100pt" h="40pt"/></subform>`);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].items.some(i => i.node.name === 's'), false, 'no margin-only fragment');
  assert.equal(item(pages, 'b', 1).y, 10);
});

test('pagination: the last row needs room for the bottom margins it closes', () => {
  // c fits on page 1 only if s's bottom margin is allowed to overflow
  const pages = layout(`<draw name="a" h="50pt"/>
    <subform name="s" layout="tb"><margin bottomInset="10pt"/><draw name="b" h="20pt"/><draw name="c" h="25pt"/></subform>`);
  assert.equal(item(pages, 'b').y, 50);
  assert.equal(item(pages, 'c', 1).y, 0);
});

test('pagination: rows inside split containers leave room for every open container\'s bottom margin', () => {
  // anaf-d017: c fits under b only if the bottom margins of s and t (12pt),
  // which close the pieces left on page 1, may overflow; it is not s's last row
  const pages = layout(`<draw name="a" h="40pt"/>
    <subform name="t" layout="tb"><margin bottomInset="6pt"/>
      <subform name="s" layout="tb"><margin bottomInset="6pt"/><draw name="b" h="20pt"/><draw name="c" h="30pt"/><draw name="d" h="30pt"/></subform>
      <draw name="e" h="10pt"/></subform>`);
  assert.equal(item(pages, 'b').y, 40);
  assert.equal(item(pages, 'c', 1).y, 0);
});

test('pagination: an empty growable field in a table row is cut where the area ends, past its middle line', () => {
  // ro-pos-cce-application: an empty multi-line box (vAlign middle) is cut
  // when the room left holds its middle line, else moves on whole
  const box = (top, name) => `<draw name="a" h="${top}pt"/>
    <subform name="t" layout="table" columnWidths="100pt"><subform name="r" layout="row"><keep intact="none"/>
      <field name="${name}" minH="60pt"><ui><textEdit multiLine="1"/></ui><font size="10pt"/><para vAlign="middle"/></field></subform></subform>`;
  const cut = layout(box(50, 'f'));
  const first = cut[0].items.find(i => i.node.name === 'f'), rest = cut[1].items.find(i => i.node.name === 'f');
  assert.ok(first && rest, 'a piece on each page');
  close(first.y, 50); close(first.node.lh, 50); close(rest.y, 0); close(rest.node.lh, 10);
  const whole = layout(box(75, 'g'));
  assert.equal(whole[0].items.some(i => i.node.name === 'g'), false);
  close(item(whole, 'g', 1).node.lh, 60);
});

test('pagination: keep next moves a heading to the next page with what follows it', () => {
  const pages = layout(`<draw name="a" h="70pt"/><draw name="head" h="10pt"><keep next="contentArea"/></draw>
    <subform name="body" layout="tb"><draw name="b" h="30pt"/></subform>`);
  assert.equal(item(pages, 'head', 1).y, 0);
  assert.equal(item(pages, 'b', 1).y, 10);
  // keep previous on the follower has the same effect
  const again = layout(`<draw name="a" h="70pt"/><draw name="head" h="10pt"/>
    <draw name="b" h="30pt"><keep previous="pageArea"/></draw>`);
  assert.equal(item(again, 'head', 1).y, 0);
});

test('tb: a field with no w keeps its natural width (clamped by minW); a draw fills', () => {
  const pages = layout(`<field name="btn" h="10pt" minW="40pt"><ui><button/></ui>
    <caption><value><text>Go</text></value><font typeface="Arial" size="8pt"/></caption></field>
    <draw name="d" h="10pt"><value><text>x</text></value></draw>`);
  assert.equal(item(pages, 'btn').w, 40);
  assert.equal(item(pages, 'd').w, 100);
});

test('presence: an invisible subform hides its children too, and still takes space', () => {
  const pages = layout(`<subform name="s" layout="tb" presence="invisible"><draw name="a" h="10pt"/></subform><draw name="b" h="10pt"/>`);
  assert.equal(item(pages, 's').paint, false);
  assert.equal(item(pages, 'a').paint, false);
  assert.equal(item(pages, 'b').y, 10);
});

test('rich text: words break only at spaces, across style runs; spacerun spaces break; trailing spaces hang', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont, textWidth } = await import('../../src/xfa/text.js');
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const rich = html => parseRich(new DOMParser().parseFromString(
    `<body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">${html}</body>`, 'application/xml').documentElement);
  const text = l => l.segments.map(s => s.text).join('');
  // "Act" and "." are one word: the line breaks before it, not between them
  const w = textWidth(font, 'the Privacy Act');
  let lines = layoutRich(rich('<p>the Privacy <i>Act</i>. More</p>'), font, null, w);
  assert.equal(text(lines[0]), 'the Privacy');
  assert.match(text(lines[1]), /^Act\./);
  // a no-break space inside a spacerun span is a break opportunity
  lines = layoutRich(rich('<p>and the<span style="xfa-spacerun:yes"> </span><i>Access</i></p>'), font, null, textWidth(font, 'and the '));
  assert.deepEqual(lines.map(text), ['and the', 'Access']);
  // a trailing no-break space does not push its word to the next line
  lines = layoutRich(rich('<p>LABEL I.1.1 </p>'), font, null, textWidth(font, 'LABEL I.1.1'));
  assert.equal(lines.length, 1);
  // a negative text-indent does not outdent the first line: it starts at
  // margin-left, and the lines after it are indented instead
  lines = layoutRich(rich('<p style="margin-left:13.5pt;text-indent:-18pt">· item one two three four five six</p>'), font, null, 100);
  assert.equal(lines[0].indent, 0);
  assert.equal(lines[0].marginLeft, 13.5);
  assert.equal(lines[1].indent, 18);
});

test('rich text: a link is blue and underlined unless its CSS says otherwise', async () => {
  const { parseRich } = await import('../../src/xfa/rich.js');
  const paras = parseRich(new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p>see <a href="https://example.org/">this</a> and <a href="https://example.org/" style="text-decoration:none;color:#ff0000">that</a></p></body>`,
  'application/xml').documentElement);
  const run = t => paras[0].runs.find(r => r.text === t).style;
  assert.deepEqual([run('this').color, run('this').underline], [[0, 0, 255], 1]);
  assert.deepEqual([run('that').color, run('that').underline], [[255, 0, 0], 0]);
});

test('rich text: tabs past the edge wrap, and a wrapped line drops its leading whitespace', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const paras = parseRich(new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p>Issued: agency<span style="xfa-tab-count:5"> </span><span style="xfa-spacerun:yes">    </span><span style="xfa-tab-count:5"> </span>Licensed: yes</p>
    <p>Other: boxes<span style="xfa-tab-count:7"> </span></p></body>`, 'application/xml').documentElement);
  const lines = layoutRich(paras, font, null, 150);
  const text = l => l.segments.map(s => s.text).join('');
  assert.deepEqual(lines.map(text), ['Issued: agency', 'Licensed: yes', 'Other: boxes']);
  assert.equal(lines[1].segments[0].tab, undefined);
});

test('rich text: vertical-align takes a length on inline content and is ignored on blocks', async () => {
  const { parseRich } = await import('../../src/xfa/rich.js');
  const paras = parseRich(new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p style="vertical-align:3pt">m<span style="vertical-align:2pt">2</span></p></body>`, 'application/xml').documentElement);
  assert.equal(paras[0].runs[0].style.shift ?? null, null);
  assert.equal(paras[0].runs[1].style.shift, 2);
});

test('table: a cell stretched to its row keeps its vAlign in the full height', () => {
  const pages = layout(`<subform name="t" layout="table" columnWidths="30pt 30pt">
    <subform name="r" layout="row"><draw name="a"><value><text>x</text></value><font typeface="Arial" size="10pt"/><para vAlign="middle"/></draw>
    <draw name="b" h="40pt"/></subform></subform>`);
  const a = item(pages, 'a');
  assert.equal(a.h, 40);
  assert.equal(a.node.parts.value.h, 40);
});

test('empty text holds one line of the font size; a draw with no value too', () => {
  const pages = layout(`<draw name="d"><font typeface="Arial" size="10pt"/><margin topInset="1pt" bottomInset="1pt"/></draw>
    <field name="f"><ui><textEdit/></ui><font typeface="Arial" size="8pt"/></field>`);
  assert.equal(item(pages, 'd').h, 12);
  assert.equal(item(pages, 'f').h, 8);
});

test('caption: para margins narrow the caption lines', () => {
  const words = 'aa bb cc dd ee ff gg hh';
  const field = pm => `<field name="f${pm}" w="100pt"><ui><checkButton/></ui>
    <caption reserve="60pt"><para marginLeft="${pm}pt"/><font typeface="Arial" size="10pt"/><value><text>${words}</text></value></caption></field>`;
  const pages = layout(field(0) + field(20));
  const n = name => item(pages, name).node.parts.captionLines.length;
  assert.ok(n('f20') > n('f0'), `${n('f20')} lines with a 20pt margin, ${n('f0')} without`);
});

test('pagination: a positioned container breaks at a line no child crosses', () => {
  const pages = layout(`<draw name="a" h="60pt"/>
    <area name="g"><draw name="b" y="0" w="50pt" h="20pt"/><draw name="c" y="20pt" w="50pt" h="30pt"/></area>`);
  assert.equal(item(pages, 'b').y, 60);
  assert.equal(item(pages, 'c', 1).y, 0);
  // a child across every possible line keeps the container whole
  const whole = layout(`<draw name="a" h="60pt"/>
    <area name="g"><draw name="b" y="0" w="50pt" h="35pt"/><draw name="c" y="20pt" w="50pt" h="30pt"/></area>`);
  assert.equal(item(whole, 'b', 1).y, 0);
});

test('static overlay: a comb field over a shell comb widget gets its box and cell dividers', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const comb = `<field name="c" w="60pt" h="20pt"><ui><textEdit><border><edge/></border><comb numberOfCells="3"/></textEdit></ui></field>`;
  // the shell page's comb widget covers the field (PDF user space, page 100pt tall)
  const shells = [{ combs: [{ rect: [0, 80, 60, 100], cells: 3 }] }];
  const [p] = await paintPages(layout(comb), { overlay: true, shells });
  // two dividers of the comb, drawn as line segments
  assert.equal((p.content.match(/ l\b/g) ?? []).length, 2);
  // no widget there: nothing is drawn (the template may not match the shell)
  const [none] = await paintPages(layout(comb), { overlay: true, shells: [{ combs: [] }] });
  assert.equal(none.content.trim(), '');
  // the plain field's box is not repainted (the shell page has it)
  const [plain] = await paintPages(layout(`<field name="t" w="60pt" h="20pt"><ui><textEdit><border><edge/></border></textEdit></ui></field>`), { overlay: true });
  assert.equal(plain.content.trim(), '');
});

test('caption: an automatic side reserve wraps inside the field', () => {
  const pages = layout(`<field name="b" w="80pt" minH="10pt"><ui><button/></ui>
    <caption><value><text>aaaa bbbb cccc dddd eeee ffff</text></value><font typeface="Arial" size="10pt"/></caption></field>`);
  const b = item(pages, 'b');
  assert.equal(b.w, 80);
  assert.ok(b.node.parts.captionLines.length > 1);
  assert.ok(b.h > 20);
});

test('wrapping: a line may overrun by up to 0.05em', async () => {
  const { resolveFont, textWidth, wrapText } = await import('../../src/xfa/text.js');
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const w = textWidth(font, 'aa bb cc');
  assert.equal(wrapText(font, 'aa bb cc', w - 0.02).length, 1);
  assert.equal(wrapText(font, 'aa bb cc', w - 0.4).length, 1);   // on-11075e: 0.4pt over in 9pt fits
  assert.equal(wrapText(font, 'aa bb cc', w - 0.6).length, 2);
  const small = resolveFont({ typeface: 'Arial', size: 8 }, null);
  const w8 = textWidth(small, 'aa bb cc');
  assert.equal(wrapText(small, 'aa bb cc', w8 - 0.46).length, 2); // imm5707e: 0.46pt over in 8pt breaks
});

test('floating fields measure as the page number they will show', () => {
  const ps = `<pageSet><pageArea name="P"><contentArea x="0" y="0" w="100pt" h="100pt"/><medium short="100pt" long="100pt"/>
    <draw name="pg" x="0" y="0" w="46pt" h="10pt"><font typeface="Arial" size="7pt"/><value><exData contentType="text/html">
      <body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><p>PAGE <span xfa:embed="#n"/> OF <span xfa:embed="#c"/></p></body></exData></value></draw>
    <field name="n" id="n" presence="hidden"><calculate><script>this.rawValue = xfa.layout.page(this)</script></calculate></field>
    <field name="c" id="c" presence="hidden"><calculate><script>this.rawValue = xfa.layout.pageCount()</script></calculate></field>
  </pageArea></pageSet>`;
  const pages = layout(`<draw name="a" h="10pt"/>`, ps);
  // 'PAGE 0 OF 0' (42.8pt at 7pt Arial) fits 46pt; 'PAGE 00 OF 00' (50.6pt) would not
  assert.equal(item(pages, 'pg').node.parts.richLines.length, 1);
});

test('pagination: a split subform continues on the page area its overflow names', () => {
  const ps = `<pageSet>
    <pageArea name="First"><contentArea x="0" y="0" w="100pt" h="100pt"/><medium short="100pt" long="100pt"/></pageArea>
    <pageArea name="Rest"><contentArea x="0" y="0" w="100pt" h="100pt"/><medium short="100pt" long="100pt"/></pageArea></pageSet>`;
  const pages = layout(`<subform name="body" layout="tb"><overflow target="Rest"/>
    <draw name="a" h="60pt"/><draw name="b" h="60pt"/><draw name="c" h="60pt"/></subform>`, ps);
  assert.deepEqual(pages.map(p => p.pageArea.name), ['First', 'Rest', 'Rest']);
});

test('rich text height: the first line takes the font size, later lines 1.2 x size', async () => {
  const { parseRich, layoutRich, richHeight } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const paras = parseRich(new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml"><p>one</p><p>two</p></body>`, 'application/xml').documentElement);
  close(richHeight(layoutRich(paras, font, null, 500)), 10 + 12);
});

test('plain text: a negative textIndent indents the wrapped lines, not the first', async () => {
  const { resolveFont, wrapText, lineIndent } = await import('../../src/xfa/text.js');
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const lines = wrapText(font, 'aa bb cc dd ee ff gg hh', 50, { textIndent: -20 });
  assert.ok(lines.length > 2);
  assert.deepEqual([lineIndent(-20, true), lineIndent(-20, false), lineIndent(5, true), lineIndent(5, false)], [0, 20, 5, 0]);
});

test('wrapping: a word may break after a slash, not before a digit or another slash', async () => {
  const { resolveFont, textWidth, wrapText, breakPieces } = await import('../../src/xfa/text.js');
  assert.deepEqual(breakPieces('(https://www.example.com/en-CA/).'), ['(https://', 'www.example.com/', 'en-CA/', ').']);
  assert.deepEqual(breakPieces('1/2'), ['1/2']);
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const w = textWidth(font, 'see he/');
  assert.deepEqual([...wrapText(font, 'see he/she', w + 1)], ['see he/', 'she']);
});

test('rich text: sized without the first line gap, painted at the full pitch', async () => {
  const { parseRich, layoutRich, richHeight, paintedHeight } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const font = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const lines = layoutRich(parseRich(new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml"><p>a</p><p>b</p></body>`, 'application/xml').documentElement), font, null, 500);
  close(paintedHeight(lines), 24);
  close(richHeight(lines), 22);
});

test('pageArea breaks: a named target the page already uses needs startNew to start a page', () => {
  const ps = `<pageSet><pageArea name="P"><contentArea x="0" y="0" w="100pt" h="100pt"/><medium short="100pt" long="100pt"/></pageArea></pageSet>`;
  const pages = layout(`<draw name="a" h="20pt"/>
    <subform name="s" layout="tb"><breakBefore targetType="pageArea" target="P"/><draw name="b" h="20pt"/></subform>
    <subform name="t" layout="tb"><breakBefore targetType="pageArea" target="P" startNew="1"/><draw name="c" h="20pt"/></subform>`, ps);
  assert.equal(pages.length, 2);
  assert.equal(item(pages, 'b').y, 20);
  assert.equal(item(pages, 'c', 1).y, 0);
});

test('contentArea breaks go to the named area; startNew and used areas start a new page', () => {
  // banner, menu and main areas filled in that order by targeted breaks
  const ps = `<pageSet><pageArea name="P"><medium short="200pt" long="200pt"/>
    <contentArea name="Main" x="60pt" y="20pt" w="140pt" h="180pt"/>
    <contentArea name="Menu" x="0" y="20pt" w="50pt" h="180pt"/>
    <contentArea name="Banner" x="0" y="0" w="200pt" h="20pt"/></pageArea></pageSet>`;
  const pages = layout(`
    <subform name="banner" w="200pt" h="20pt"><breakBefore targetType="contentArea" target="P.Banner"/></subform>
    <subform name="menu" w="50pt" h="40pt"><breakBefore targetType="contentArea" target="P.Menu"/></subform>
    <subform name="main" w="140pt" h="30pt"><breakBefore targetType="contentArea" target="#Main"/></subform>
    <subform name="more" w="140pt" h="30pt"><breakBefore targetType="contentArea" target="P.Main"/></subform>
    <subform name="fresh" w="140pt" h="30pt"><breakBefore targetType="contentArea" target="P.Main" startNew="1"/></subform>`, ps);
  assert.equal(pages.length, 2);
  assert.deepEqual([item(pages, 'banner').x, item(pages, 'banner').y], [0, 0]);
  assert.deepEqual([item(pages, 'menu').x, item(pages, 'menu').y], [0, 20]);
  assert.deepEqual([item(pages, 'main').x, item(pages, 'main').y], [60, 20]);
  // already in Main: stays and stacks
  assert.deepEqual([item(pages, 'more').x, item(pages, 'more').y], [60, 50]);
  // startNew: Main again, on a new page
  assert.deepEqual([item(pages, 'fresh', 1).x, item(pages, 'fresh', 1).y], [60, 20]);
});

test('a contentArea break to an area of another page area starts a page of that page area', () => {
  const ps = `<pageSet>
    <pageArea name="P1"><occur max="1"/><medium short="100pt" long="100pt"/><contentArea name="C1" w="100pt" h="100pt"/></pageArea>
    <pageArea name="P2"><medium short="100pt" long="100pt"/><contentArea name="C2" w="100pt" h="100pt"/><draw name="cont" w="10pt" h="5pt"/></pageArea>
    <pageArea name="P3"><medium short="100pt" long="100pt"/><contentArea name="C3" y="10pt" w="100pt" h="90pt"/></pageArea></pageSet>`;
  const pages = layout(`<subform name="a" w="100pt" h="20pt"/>
    <subform name="b" w="100pt" h="20pt"><breakBefore targetType="contentArea" target="P3.C3"/></subform>`, ps);
  assert.equal(pages.length, 2);
  assert.equal(pages[1].pageArea.name, 'P3');
  assert.equal(item(pages, 'b', 1).y, 10);
});

test('nothing of zero height starts a new page, even after content that overran the area', () => {
  const pages = layout(`<subform name="big" w="100pt" h="110pt"/>
    <subform name="empty" w="100pt" layout="tb"><draw name="gone" presence="hidden" w="10pt" h="10pt"/></subform>`);
  assert.equal(pages.length, 1);
});

test('a table row of positioned cells that allow page breaks splits at a line no child crosses', () => {
  const pages = layout(`<draw name="top" w="100pt" h="40pt"/>
    <subform name="t" layout="table" columnWidths="100pt">
      <subform name="r" layout="row"><keep intact="none"/>
        <subform name="cell" h="90pt"><keep intact="none"/>
          <draw name="a" y="0" w="50pt" h="20pt"/><draw name="b" y="30pt" w="50pt" h="20pt"/>
          <draw name="c" y="70pt" w="50pt" h="20pt"/></subform></subform></subform>`);
  assert.equal(pages.length, 2);
  // a and b fit under "top" on page 1; c continues at the top of page 2
  assert.equal(item(pages, 'a').y, 40);
  assert.equal(item(pages, 'b').y, 70);
  assert.equal(item(pages, 'c', 1).y, 0);
});

test('with a set line height the first line counts as that height or the face\'s own, whichever is less', () => {
  const rich = lh => `<exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml"><p>one</p><p>two</p></body></exData>`;
  const pages = layout(`
    <draw name="tall" w="100pt"><font typeface="Arial" size="10pt"/><para lineHeight="18pt"/><value>${rich()}</value></draw>
    <draw name="tight" w="100pt"><font typeface="Arial" size="14pt"/><para lineHeight="14pt"/><value>${rich()}</value></draw>
    <draw name="plain" w="100pt"><font typeface="Arial" size="10pt"/><para lineHeight="18pt"/><value><text>one\ntwo</text></value></draw>`,
    `<pageSet><pageArea name="P"><contentArea w="200pt" h="300pt"/><medium short="200pt" long="300pt"/></pageArea></pageSet>`);
  // Arial's own line height is 1.149em: 11.49pt + 18pt
  close(item(pages, 'tall').h, 11.49 + 18, 'tall');
  // 14pt is less than 16.09pt: 14 + 14
  close(item(pages, 'tight').h, 28, 'tight');
  close(item(pages, 'plain').h, 11.49 + 18, 'plain');
});

test('a break inside a container that fits still breaks the page', () => {
  const pages = layout(`<draw name="top" w="100pt" h="20pt"/>
    <subform name="s" w="100pt" layout="tb"><draw name="a" w="100pt" h="10pt"/>
      <subform name="b" w="100pt" h="10pt"><breakBefore targetType="contentArea"/></subform></subform>`);
  assert.equal(pages.length, 2);
  assert.equal(item(pages, 'b', 1).y, 0);
});

test('pagination: text that does not fit is split between lines, in tb and lr-tb rows', () => {
  const text = `<value><text>1\n2\n3\n4\n5\n6\n7\n8</text></value>`;
  for (const layoutKind of ['tb', 'lr-tb']) {
    const pages = layout(`<draw name="top" w="100pt" h="60pt"/>
      <subform name="s" w="100pt" layout="${layoutKind}">
        <draw name="t" w="100pt"><font typeface="Arial" size="10pt"/>${text}</draw></subform>`);
    assert.equal(pages.length, 2, layoutKind);
    // three lines fit under "top" (10 + 2 × 12pt, no font files here); five continue
    assert.equal(item(pages, 't').node.parts.lines.length, 3);
    close(item(pages, 't').h, 10 + 2 * 12);
    // the rest keeps what is left of the box (94pt in all)
    close(item(pages, 't', 1).h, 94 - 34);
    assert.deepEqual([...item(pages, 't', 1).node.parts.lines], ['4', '5', '6', '7', '8']);
    assert.equal(item(pages, 't', 1).y, 0);
  }
  // a fixed height taller than a page runs on over as many pages as it needs
  const lines = Array.from({ length: 20 }, (_, i) => i + 1).join('\n');
  const pages = layout(`<draw name="t" w="100pt" h="300pt"><font typeface="Arial" size="10pt"/><value><text>${lines}</text></value></draw>`);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(p => item(pages, 't', pages.indexOf(p)).node.parts.lines.length), [8, 8, 4]);
});

test('pagination: a text cut leaves room for its first line at the full pitch', () => {
  // anaf-d1000: three 10pt lines measure 10 + 2 × 12 = 34pt but print at
  // 36pt; with 35pt left only two stay
  const pages = layout(`<draw name="top" w="100pt" h="65pt"/>
    <draw name="t" w="100pt"><font typeface="Arial" size="10pt"/><value><text>1\n2\n3\n4\n5</text></value></draw>`);
  assert.equal(item(pages, 't').node.parts.lines.length, 2);
  assert.deepEqual([...item(pages, 't', 1).node.parts.lines], ['3', '4', '5']);
});

test('pagination: an empty multi-line field box is cut at the area bottom, its caption on top', () => {
  const pages = layout(`<draw name="top" w="100pt" h="70pt"/>
    <field name="f" w="100pt" minH="60pt"><ui><textEdit multiLine="1"/></ui><font size="10pt"/>
      <caption placement="top" reserve="20pt"><value><text>Explain:</text></value></caption></field>`);
  assert.equal(pages.length, 2);
  // the caption and 10pt of the box fill page 1; the other 30pt carry on
  close(item(pages, 'f').h, 30);
  assert.ok(item(pages, 'f').node.parts.caption);
  assert.equal(item(pages, 'f', 1).node.parts.caption, null);
  close(item(pages, 'f', 1).h, 30);
});

test('pagination: keep next chains across lr-tb rows', () => {
  // h1 is kept with h2, h2 with the box: all three move to page 2
  const pages = layout(`<draw name="top" w="100pt" h="50pt"/>
    <subform name="s" w="100pt" layout="lr-tb">
      <draw name="h1" w="100pt" h="10pt"><keep next="contentArea"/></draw>
      <draw name="h2" w="100pt" h="10pt"><keep next="contentArea"/></draw>
      <field name="box" w="100pt" h="40pt"><keep intact="contentArea"/></field></subform>`);
  assert.equal(pages.length, 2);
  assert.equal(item(pages, 'h1', 1).y, 0);
  assert.equal(item(pages, 'box', 1).y, 20);
});

test('a text value\'s natural width holds its para margins', () => {
  const pages = layout(`<subform name="s" w="100pt" layout="lr-tb">
    <draw name="t"><font size="10pt"/><para marginLeft="1pt"/><value><text>Heading text</text></value></draw></subform>`,
  `<pageSet><pageArea name="P"><contentArea w="200pt" h="300pt"/><medium short="200pt" long="300pt"/></pageArea></pageSet>`);
  assert.equal(item(pages, 't').node.parts.lines.length, 1);
});

test('rich text: list items hang a marker in a 36pt indent; para spacing parts paragraphs without margins', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p>I agree that:</p><ul><li>one</li><li>two</li></ul><ol style="list-style-type:lower-roman"><li>a</li><li>b</li></ol>
    <p style="margin-bottom:0pt">tight</p><p>end</p></body>`, 'application/xml').documentElement;
  const paras = parseRich(body);
  assert.deepEqual(paras.map(p => p.marker?.text ?? null), [null, '•', '•', 'i.', 'ii.', null, null]);
  assert.deepEqual(paras.map(p => p.listIndent ?? 0), [0, 36, 36, 36, 36, 0, 0]);
  const base = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const lines = layoutRich(paras, base, { spaceAbove: 1, spaceBelow: 3 }, 500);
  assert.equal(lines[1].marker.text, '•');
  // 3pt after each paragraph but the last and the one with its own margin;
  // 1pt before each but the first
  assert.deepEqual(lines.map(l => l.spaceAfter), [3, 3, 3, 3, 3, 0, 0]);
  assert.deepEqual(lines.map(l => l.spaceBefore), [0, 1, 1, 1, 1, 1, 1]);
});

test('a hidden field with a fixed h stretches its positioned container; growable fields and draws do not', () => {
  const pages = layout(`<subform name="a" w="100pt"><draw name="v" w="10pt" h="10pt"/>
      <field name="fixed" y="5pt" w="10pt" h="12pt" presence="hidden"/></subform>
    <subform name="b" w="100pt"><draw name="v2" w="10pt" h="10pt"/>
      <field name="grow" y="5pt" w="10pt" minH="12pt" presence="hidden"/>
      <draw name="line" y="5pt" w="10pt" h="12pt" presence="hidden"/></subform>`);
  close(item(pages, 'a').h, 17);
  close(item(pages, 'b').h, 10);
  assert.equal(item(pages, 'fixed'), undefined);
});

test('plain text with tabs advances to the tab stops (every 0.5in by default)', () => {
  const pages = layout(`<draw name="t" w="100pt"><font typeface="Arial" size="10pt"/><value><text>a\tb</text></value></draw>`);
  const lines = item(pages, 't').node.parts.richLines;
  assert.equal(lines.length, 1);
  const startOf = t => { let x = 0; for (const s of lines[0].segments) { if (s.text === t) return x; x += s.w; } return null; };
  close(startOf('b'), 36);
});

test('paint: a filled arc closes with the chord between its ends, not through the centre', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <draw name="a" w="20pt" h="20pt"><value><arc sweepAngle="90"><fill><color value="0,0,0"/></fill></arc></value></draw></subform>`);
  const [p] = await paintPages(pages);
  // the fill starts at the arc's first end (20, 90), never at the centre (10, 90)
  assert.match(p.content, /20 90 m/);
  assert.doesNotMatch(p.content, /10 90 [ml]/);
});

test('rich text: a baselineShift makes each line taller by the shift; vertical-align:baseline sets it back', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p style="font-size:10pt">one</p><p style="font-size:10pt"><span style="xfa-spacerun:yes"> </span></p>
    <p style="vertical-align:baseline;font-size:10pt">two</p></body>`, 'application/xml').documentElement;
  const base = resolveFont({ typeface: 'Arial', size: 14, baselineShift: 7 }, null);
  const lines = layoutRich(parseRich(body), base, null, 500);
  assert.deepEqual(lines.map(l => Math.round(l.height * 10) / 10), [19, 19, 12]);
});

test('paint: a linear fill is an axial shading from the fill colour to the gradient colour', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const { PdfWriter } = await import('../../src/core/writer.js');
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <draw name="r" w="50pt" h="20pt"><value><rectangle><edge presence="hidden"/>
      <fill><linear type="toLeft"><color value="192,192,192"/></linear></fill></rectangle></value></draw></subform>`);
  const [p] = await paintPages(pages);
  assert.match(p.content, /W n\n\/Sh1 sh/);
  // toLeft: from white at the right edge (x 50) to grey at the left (x 0)
  assert.deepEqual(p.shadings[0], { name: 'Sh1', type: 2, coords: [50, 90, 0, 90], c0: [255, 255, 255], c1: [192, 192, 192] });
  const pdf = new TextDecoder('latin1').decode(new PdfWriter().build([p]));
  assert.match(pdf, /\/ShadingType 2 \/ColorSpace \/DeviceRGB \/Coords \[50 90 0 90\] \/Function << \/FunctionType 2 \/Domain \[0 1\] \/C0 \[1 1 1\] \/C1 \[0\.753 0\.753 0\.753\] \/N 1 >>/);
  assert.match(pdf, /\/Shading << \/Sh1 \d+ 0 R >>/);
});

test('paint: a checked square box with the default mark shows a cross', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<field name="c" w="10pt" h="10pt"><ui><checkButton size="10pt"/></ui><value><integer>1</integer></value></field>`);
  const [p] = await paintPages(pages);
  // two strokes corner to corner, 15% in: (1.5, 98.5) to (8.5, 91.5) and back
  assert.match(p.content, /1\.5 98\.5 m\n8\.5 91\.5 l\n8\.5 98\.5 m\n1\.5 91\.5 l\nS/);
});

test('rich text: a paragraph margin replaces the para margin; a raised run makes its line taller', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p style="margin-left:20pt">a</p><p>b</p><p>CIF<span style="vertical-align:3pt;font-size:8pt">2</span></p></body>`, 'application/xml').documentElement;
  const base = resolveFont({ typeface: 'Arial', size: 9 }, null);
  const lines = layoutRich(parseRich(body), base, { marginLeft: 20 }, 500);
  assert.deepEqual(lines.map(l => l.marginLeft), [20, 20, 20]);
  // 3pt rise + the 8pt run's ascent reach above the 9pt text's ascent
  const e9 = lines[1].ascent, e8 = e9 * 8 / 9;
  close(lines[2].height - lines[1].height, 3 + e8 - e9);
  close(lines[2].ascent - lines[1].ascent, 3 + e8 - e9);
});

test('rich text: the outer paragraph margins collapse with the para spaceAbove/spaceBelow', async () => {
  const { parseRich, layoutRich } = await import('../../src/xfa/rich.js');
  const { resolveFont } = await import('../../src/xfa/text.js');
  const body = new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">
    <p style="margin-top:4pt">a</p><p style="margin-bottom:10pt">b</p></body>`, 'application/xml').documentElement;
  const base = resolveFont({ typeface: 'Arial', size: 10 }, null);
  const lines = layoutRich(parseRich(body), base, { spaceAbove: 3, spaceBelow: 10 }, 500);
  assert.equal(lines[0].spaceBefore, 1);  // 4pt margin, 3pt of it already above the box text
  assert.equal(lines[1].spaceAfter, 0);   // 10pt margin inside the 10pt spaceBelow
});

test('paint: a middle-aligned caption centres down to the field\'s outer bottom, past its bottom inset', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<field name="f" w="100pt" h="30pt"><font typeface="Arial" size="10pt"/><margin topInset="5pt" bottomInset="5pt"/>
    <caption reserve="40pt"><para vAlign="middle"/><value><text>Name</text></value></caption></field>`);
  const [p] = await paintPages(pages);
  // caption box 5..30 (25pt tall), block 0.938em: baseline 5 + (25 - 9.38)/2 + 7.28 = 20.09 → y 79.91
  assert.match(p.content, /79\.91 Td/);
});

// --- overflow leaders and trailers ---

// a table of a 15pt header row and rows of 20pt in 100pt pages
const tableRows = (n, extra = '') => Array.from({ length: n }, (_, i) =>
  `<subform layout="row" name="r${i}"><draw name="c${i}" w="50pt" h="20pt"/>${extra}</subform>`).join('');
const header = '<subform layout="row" name="HeaderRow"><draw name="hc" w="50pt" h="15pt"/></subform>';
const at = (pages, p, name) => pages[p].items.filter(i => i.node.name === name);

test('overflow leader: the header row repeats at the top of each continuation', () => {
  const pages = layout(`<subform name="t" layout="table" columnWidths="50pt"><margin topInset="3pt"/><overflow leader="HeaderRow"/>
    ${header}${tableRows(10)}</subform>`);
  assert.equal(pages.length, 3); // four rows a page under the header
  assert.equal(at(pages, 0, 'HeaderRow').length, 1); // once on page 1: the row itself
  for (const p of [1, 2]) {
    const h = at(pages, p, 'HeaderRow');
    assert.equal(h.length, 1);
    close(h[0].y, 3, 'after the top inset'); // the continuation re-applies the margin, then the header
    const first = pages[p].items.filter(i => /^r\d$/.test(i.node.name))[0];
    close(first.y, 18, 'the first row under the header');
  }
  // the header's cell repeats with it
  assert.equal(at(pages, 1, 'hc').length, 1);
});

test('overflow leader: by #id; none without a leader; an unresolved one is logged', () => {
  const byId = layout(`<subform name="t" layout="table" columnWidths="50pt"><overflow leader="#hdr"/>
    <subform layout="row" name="Top" id="hdr"><draw w="50pt" h="15pt"/></subform>${tableRows(6)}</subform>`);
  assert.equal(at(byId, 1, 'Top').length, 1);
  const none = layout(`<subform name="t" layout="table" columnWidths="50pt"><overflow target="P"/>${header}${tableRows(6)}</subform>`);
  assert.equal(at(none, 1, 'HeaderRow').length, 0);
  const xml = new DOMParser().parseFromString(`<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb">${PAGESET}
    <subform name="t" layout="table" columnWidths="50pt"><overflow leader="Nope"/>${header}${tableRows(6)}</subform></subform></template>`, 'application/xml');
  const { root } = bindData(parseTemplateModel(xml), null);
  formatValues(root);
  const { log } = layoutForm(root);
  assert.ok(log.entries.some(e => e.code === 'XFA_OVERFLOW_UNRESOLVED'));
});

test('overflow leader: an inner container whose overflow names no leader repeats nothing', () => {
  // ro-pos-cce-application: the budget table's rows sit in subform sets that
  // overflow to the page area without a leader; Reader repeats no header
  const pages = layout(`<subform name="t" layout="table" columnWidths="50pt"><overflow leader="HeaderRow"/>${header}
    <subformSet name="sect"><overflow target="P"/>${tableRows(6)}</subformSet></subform>`);
  assert.ok(pages.length > 1);
  assert.equal(at(pages, 1, 'HeaderRow').length, 0);
  // the leader of an explicit page break is not an overflow
  const broken = layout(`<subform name="t" layout="table" columnWidths="50pt"><overflow leader="HeaderRow"/>${header}
    ${tableRows(1)}<subform layout="row" name="late"><breakBefore targetType="pageArea"/><draw w="50pt" h="20pt"/></subform></subform>`);
  assert.equal(broken.length, 2);
  assert.equal(at(broken, 1, 'HeaderRow').length, 0);
});

test('overflow trailer: kept free at the bottom of each area the table leaves, not after its last piece', () => {
  const footer = '<subform layout="row" name="FooterRow"><draw w="50pt" h="10pt"/></subform>';
  const pages = layout(`<subform name="t" layout="table" columnWidths="50pt"><overflow leader="HeaderRow" trailer="FooterRow"/>
    ${header}${tableRows(6)}${footer}</subform>`);
  // page 1: header 15 + rows of 20; 15 + 4×20 = 95 would fit 100 but not with the 10pt trailer
  const rows1 = pages[0].items.filter(i => /^r\d$/.test(i.node.name));
  assert.equal(rows1.length, 3);
  const t1 = at(pages, 0, 'FooterRow');
  assert.equal(t1.length, 1);
  close(t1[0].y, 90, 'at the bottom of the area');
  // the last page: the footer once, in the flow, right after the last row
  const last = pages.at(-1);
  const t2 = last.items.filter(i => i.node.name === 'FooterRow');
  assert.equal(t2.length, 1);
  const lastRow = last.items.filter(i => /^r\d$/.test(i.node.name)).at(-1);
  close(t2[0].y, lastRow.y + 20, 'packed after the last row');
});

test('overflow leader taller than the area is left out, without looping', () => {
  const pages = layout(`<subform name="t" layout="table" columnWidths="50pt"><overflow leader="HeaderRow"/>
    <subform layout="row" name="HeaderRow"><draw w="50pt" h="120pt"/></subform>${tableRows(3)}</subform>`);
  assert.ok(pages.length <= 3);
  assert.equal(pages.flatMap(p => p.items).filter(i => i.node.name === 'HeaderRow').length, 1);
});

test('paint: a check box\'s middle-aligned caption is centred between both insets', async () => {
  // declaratieUnica's i13: topInset 1mm, bottomInset 5mm; Reader prints its
  // caption 6pt above the row's label, centred in what the insets leave
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<field name="f" w="100pt" h="30pt"><ui><checkButton/></ui><font typeface="Arial" size="10pt"/><margin topInset="5pt" bottomInset="15pt"/>
    <caption reserve="60pt"><para vAlign="middle"/><value><text>Name</text></value></caption></field>`);
  const [p] = await paintPages(pages);
  // caption box 5..15 (10pt tall), block 0.938em: baseline 5 + (10 - 9.38)/2 + 7.28 = 12.59 → y 87.41
  assert.match(p.content, /87\.41 Td/);
});

test('a duplexPaginated page set picks page areas by position and parity; the last page takes its last area', () => {
  const area = (name, pos, odd, y = 0) => `<pageArea name="${name}" pagePosition="${pos}" oddOrEven="${odd}">
    <contentArea x="0" y="${y}pt" w="200pt" h="200pt"/><medium short="200pt" long="300pt"/>
    <draw name="mark_${name}" x="0" y="0" w="50pt" h="10pt"><value><text>${name}</text></value></draw></pageArea>`;
  const pageSet = `<pageSet relation="duplexPaginated">${area('First', 'first', 'any')}${area('Odd', 'rest', 'odd')}${area('Even', 'rest', 'even')}${area('Last', 'last', 'any', 50)}</pageSet>`;
  const rows = Array.from({ length: 7 }, (_, i) => `<field name="r${i}" w="100pt" h="90pt"><ui><textEdit/></ui></field>`).join('');
  const pages = layout(`<subform name="body" layout="tb">${rows}</subform>`, pageSet);
  // 7 rows of 90pt, two to a 200pt area: four pages
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map(p => p.pageArea.name), ['First', 'Even', 'Odd', 'Last']);
  // the last page's content moved down with its content area (y 50pt)
  const last = pages[3].items.find(i => i.node.name === 'r6');
  close(last.y, 50);
});

test('a paginated set whose page areas do not qualify keeps document order', () => {
  const pageSet = `<pageSet relation="simplexPaginated"><pageArea name="A"><contentArea x="0" y="0" w="200pt" h="100pt"/><medium short="200pt" long="300pt"/></pageArea>
    <pageArea name="B"><contentArea x="0" y="0" w="200pt" h="100pt"/><medium short="200pt" long="300pt"/></pageArea></pageSet>`;
  const rows = Array.from({ length: 3 }, (_, i) => `<field name="r${i}" w="100pt" h="90pt"><ui><textEdit/></ui></field>`).join('');
  const pages = layout(`<subform name="body" layout="tb">${rows}</subform>`, pageSet);
  assert.deepEqual(pages.map(p => p.pageArea.name), ['A', 'A', 'A']);
});

test('bookends: the leader opens the container flow and the trailer closes it, once', () => {
  const pages = layout(`<subform name="body" layout="tb"><bookend leader="head" trailer="#tail"/>
    <field name="tailF" id="tail" w="50pt" h="10pt"><ui><textEdit/></ui></field>
    <field name="a" w="50pt" h="10pt"><ui><textEdit/></ui></field>
    <field name="head" w="50pt" h="10pt"><ui><textEdit/></ui></field></subform>`);
  close(item(pages, 'head').y, 0);
  close(item(pages, 'a').y, 10);
  close(item(pages, 'tailF').y, 20);
});

test('paint: a pattern fill draws its lines over the fill colour; a stipple blends its colour at its rate', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <draw name="h" w="20pt" h="8pt"><value><rectangle><edge presence="hidden"/>
      <fill><color value="255,255,0"/><pattern type="horizontal"><color value="0,0,255"/></pattern></fill></rectangle></value></draw>
    <draw name="st" y="50pt" w="20pt" h="8pt"><value><rectangle><edge presence="hidden"/>
      <fill><color value="255,255,255"/><stipple rate="25"/></fill></rectangle></value></draw></subform>`);
  const [p] = await paintPages(pages);
  // yellow ground, then blue 1pt lines every 4pt (y 2 and 6 from the bottom of the 8pt box at y 92)
  assert.match(p.content, /1 1 0 rg\n0 92 20 8 re\nf/);
  assert.match(p.content, /0 92 20 8 re\nW n\n0 0 1 RG\n1 w\n0 94 m\n20 94 l\n0 98 m\n20 98 l\nS/);
  // 25% black into white
  assert.match(p.content, /0\.75 0\.75 0\.75 rg\n0 42 20 8 re\nf/);
});

test('paint: an etched edge is a groove of two bands, grey then white at the top left', async () => {
  const { paintPages } = await import('../../src/xfa/paint.js');
  const pages = layout(`<subform name="s" w="100pt" h="100pt">
    <draw name="g" w="20pt" h="10pt"><value><rectangle><edge stroke="etched" thickness="2pt"/></rectangle></value></draw></subform>`);
  const [p] = await paintPages(pages);
  assert.match(p.content, /0\.502 0\.502 0\.502 rg\n0 100 m\n20 100 l\n19 99 l/);
  assert.match(p.content, /1 1 1 rg\n1 99 m\n19 99 l\n18 98 l/);
});
