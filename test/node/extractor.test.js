import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePdf } from '../../src/core/parser.js';
import { extractXfa, normalizePacketName, parseXmlText, xmlLineEnds } from '../../src/xfa/extractor.js';

const FIXTURE = new URL('../../samples/xfa/on-a-103e.pdf', import.meta.url);

async function loadFixture() {
  const buf = readFileSync(FIXTURE);
  return parsePdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

test('packet names normalise', () => {
  assert.equal(normalizePacketName('dataSets'), 'datasets');
  assert.equal(normalizePacketName('data'), 'datasets');
  assert.equal(normalizePacketName('localeset'), 'localeSet');
  assert.equal(normalizePacketName('xfa:datasets'), 'datasets');
  assert.equal(normalizePacketName('template'), 'template');
});

test('fixture: keeps template/datasets/form/localeSet/config, discards the rest', async () => {
  const xfa = await extractXfa(await loadFixture());
  assert.deepEqual(xfa.names.sort(), ['config', 'datasets', 'form', 'localeSet', 'template']);
  assert.deepEqual(xfa.discarded.sort(), ['connectionSet', 'schema', 'schema', 'xmpmeta']);
  assert.equal(xfa.log.byCode('XFA_PACKET_DISCARDED').length, 1);
});

test('fixture: dynamic, data root found, config read', async () => {
  const xfa = await extractXfa(await loadFixture());
  assert.equal(xfa.needsRendering, true);
  assert.equal(xfa.isDynamic, true);
  const root = xfa.dataRoot;
  assert.ok(root, 'data root');
  assert.notEqual(root.localName, 'data');
  assert.ok(xfa.template.documentElement);
  assert.equal(typeof xfa.config.dynamicRender === 'string' || xfa.config.dynamicRender === null, true);
});

test('single-stream XDP is split into packets', async () => {
  const xdp = `<?xml version="1.0"?>
<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">
  <config xmlns="http://www.xfa.org/schema/xci/3.0/"><present><pdf><version>1.7</version></pdf></present><acrobat><acrobat7><dynamicRender>required</dynamicRender></acrobat7></acrobat></config>
  <template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"/></template>
  <xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><a>1</a></form1></xfa:data></xfa:datasets>
  <xmpmeta/>
</xdp:xdp>`;
  const bytes = new TextEncoder().encode(xdp);
  const doc = fakeDoc({ type: 'ref', num: 9 }, { 9: { streamBytes: bytes } });
  const xfa = await extractXfa(doc);
  assert.deepEqual(xfa.names.sort(), ['config', 'datasets', 'template']);
  assert.deepEqual(xfa.discarded, ['xmpmeta']);
  assert.equal(xfa.config.dynamicRender, 'required');
  assert.equal(xfa.config.pdfVersion, '1.7');
  assert.equal(xfa.isDynamic, true);
  assert.equal(xfa.dataRoot.localName, 'form1');
});

test('odd-length /XFA array is rejected; missing template aborts', async () => {
  const odd = fakeDoc({ type: 'array', value: [{ type: 'string', value: 'template' }] }, {});
  await assert.rejects(extractXfa(odd), /odd length/);

  const noTemplate = fakeDoc({ type: 'array', value: [{ type: 'string', value: 'datasets' }, { type: 'ref', num: 3 }] },
    { 3: { streamBytes: new TextEncoder().encode('<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"/>') } });
  await assert.rejects(extractXfa(noTemplate), /no template/);
});

test('XML line ends normalise as XML 1.1 does, whatever the DOMParser', () => {
  assert.equal(xmlLineEnds('a\r\nb\rc\u0085d\r\u0085e\u2028f\u2029g'), 'a\nb\nc\nd\ne\nf\ng');
  // a browser's DOMParser parses as XML 1.0 and keeps U+2029: the text it is
  // given has the line ends normalised already
  const real = globalThis.DOMParser;
  let seen = null;
  globalThis.DOMParser = class { parseFromString(text) { seen = text; return null; } };
  try { parseXmlText('\uFEFF\n<text>HRB 14567\u2029Gesch\u00e4ftsf\u00fchrer</text>'); } finally { globalThis.DOMParser = real; }
  assert.equal(seen, '<text>HRB 14567\nGesch\u00e4ftsf\u00fchrer</text>');
});

test('a stray & is text: a document a strict parser rejects is parsed again with it escaped', () => {
  const real = globalThis.DOMParser;
  const seen = [];
  // a strict parser, as browsers have: a bare & is a parse error
  globalThis.DOMParser = class {
    parseFromString(text) {
      seen.push(text);
      const bad = /&(?!amp;|lt;|#\d+;)/.test(text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''));
      return { getElementsByTagName: n => (n === 'parsererror' && bad ? [{}] : []) };
    }
  };
  try {
    parseXmlText('<d><c>Ts&Cs &amp; H & C &#38;</c><s><![CDATA[a && b]]></s></d>');
    parseXmlText('<d>fine &amp; well</d>');
  } finally { globalThis.DOMParser = real; }
  assert.deepEqual(seen, [
    '<d><c>Ts&Cs &amp; H & C &#38;</c><s><![CDATA[a && b]]></s></d>',
    '<d><c>Ts&amp;Cs &amp; H &amp; C &#38;</c><s><![CDATA[a && b]]></s></d>',
    '<d>fine &amp; well</d>',
  ]);
});

// Minimal stand-in for PdfDocument: catalog → AcroForm (obj 2) → /XFA
function fakeDoc(xfaVal, objects) {
  return {
    async catalog() { return { value: { type: 'dict', value: { AcroForm: { type: 'ref', num: 2 } } } }; },
    async getObject(num) {
      if (num === 2) return { value: { type: 'dict', value: { XFA: xfaVal } } };
      return objects[num] ?? null;
    },
  };
}
