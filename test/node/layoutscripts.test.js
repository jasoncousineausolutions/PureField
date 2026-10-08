// Scripts that need the finished layout: a second layout pass answers them
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenXfa } from '../../src/index.js';
import { buildPdf } from './pdfbuild.js';

const js = s => `<script contentType="application/x-javascript">${s}</script>`;
function form(pageSetExtra, body) {
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f" layout="tb">
    <pageSet><pageArea name="P"><contentArea x="0" y="40pt" w="200pt" h="150pt"/><medium short="200pt" long="200pt"/>${pageSetExtra}</pageArea></pageSet>
    ${body}</subform></template>`;
  return buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm << /Fields [] /XFA [(template) 6 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    6: { dict: '<< >>', stream: template },
  });
}
const text = async pdf => {
  const { parsePdf } = await import('../../src/core/parser.js');
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  const cat = (await doc.catalog()).value.value;
  const out = [];
  for (const k of (await doc.getObject(cat.Pages.num)).value.value.Kids.value) {
    const p = (await doc.getObject(k.num)).value.value;
    let c = '';
    for (const r of p.Contents.type === 'array' ? p.Contents.value : [p.Contents]) c += new TextDecoder('latin1').decode((await doc.getObject(r.num)).streamBytes);
    out.push([...c.matchAll(/\((.*?)\) Tj/g)].map(m => m[1]).join('|'));
  }
  return out;
};

test('layout queries get the answers of a first layout: a summary shows the page its target lands on', async () => {
  const rows = Array.from({ length: 4 }, (_, i) => `<field name="r${i}" w="100pt" h="100pt"><ui><textEdit/></ui><value><text>row${i}</text></value></field>`).join('');
  const body = `<field name="toc" w="150pt" h="20pt"><ui><textEdit/></ui>
      <event activity="ready" ref="$layout">${js('this.rawValue = "r3 on " + xfa.layout.page(xfa.resolveNode("f.r3")) + " of " + xfa.layout.pageCount() + ", abs " + xfa.layout.absPage(xfa.resolveNode("f.r3")) + ", h " + xfa.layout.h(xfa.resolveNode("f.r3"), "pt");')}</event></field>${rows}`;
  const { pdf, log } = await flattenXfa(form('', body), { fonts: null });
  assert.ok(log.entries.some(e => e.code === 'XFA_RELAYOUT'));
  assert.ok(!log.entries.some(e => e.code === 'XFA_SCRIPT_FAILED'), JSON.stringify(log.entries));
  const pages = await text(pdf);
  // 20pt + 4 × 100pt rows in 150pt areas: r3 is alone on page 4
  assert.equal(pages.length, 4);
  assert.match(pages[0], /r3 on 4 of 4, abs 3, h 100/);
});

test('a page-area field a ready:$layout script fills prints its own value on each page', async () => {
  const footer = `<field name="pg" x="0" y="0" w="150pt" h="20pt"><ui><textEdit/></ui><value><text>#page</text></value>
    <event activity="ready" ref="$layout">${js('this.rawValue = "Page " + xfa.layout.page(this) + " / " + xfa.layout.pageCount();')}</event></field>`;
  const rows = Array.from({ length: 3 }, (_, i) => `<field name="r${i}" w="100pt" h="100pt"><ui><textEdit/></ui></field>`).join('');
  const { pdf } = await flattenXfa(form(footer, rows), { fonts: null });
  const pages = await text(pdf);
  assert.deepEqual(pages, ['Page 1 / 3', 'Page 2 / 3', 'Page 3 / 3']);
});

test('an external image href is loaded through options.images; a data: URI carries its own bytes', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
  const draw = href => `<draw name="logo" w="20pt" h="20pt"><value><image href="${href}" contentType="image/png"/></value></draw>`;
  const asked = [];
  const { pdf, log } = await flattenXfa(form('', draw('logo.png') + draw(`data:image/png;base64,${png}`)), {
    fonts: null, images: async href => { asked.push(href); return bytes; },
  });
  assert.deepEqual(asked, ['logo.png']);
  assert.ok(!log.entries.some(e => e.code === 'XFA_IMAGE_EXTERNAL'));
  assert.equal((new TextDecoder('latin1').decode(pdf).match(/\/Subtype \/Image/g) ?? []).length, 2);
  const none = await flattenXfa(form('', draw('logo.png')), { fonts: null });
  assert.ok(none.log.entries.some(e => e.code === 'XFA_IMAGE_EXTERNAL'));
});

test('a dynamic form prints a signed signature from its widget appearance, in the field laid out', async () => {
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f" layout="tb">
    <pageSet><pageArea name="P"><contentArea x="0" y="0" w="200pt" h="200pt"/><medium short="200pt" long="200pt"/></pageArea></pageSet>
    <field name="top" w="100pt" h="30pt"><ui><textEdit/></ui></field>
    <field name="sig" w="100pt" h="40pt"><ui><signature/></ui></field></subform></template>`;
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /AcroForm << /Fields [10 0 R] /XFA [(template) 6 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [10 0 R] >>',
    6: { dict: '<< >>', stream: template },
    10: '<< /Type /Annot /Subtype /Widget /FT /Sig /T (f[0].sig[0]) /V 12 0 R /F 4 /Rect [0 0 50 20] /AP << /N 11 0 R >> /P 3 0 R >>',
    11: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 50 20] >>', stream: '0 0 1 rg 0 0 50 20 re f' },
    12: '<< /Type /Sig /Filter /Adobe.PPKLite >>',
  });
  const { pdf: out, log } = await flattenXfa(pdf, { fonts: null });
  assert.ok(log.entries.some(e => e.code === 'XFA_SIGNATURES'));
  const s = new TextDecoder('latin1').decode(out);
  // the 50 × 20 appearance scaled into the field: 100 × 40 at y 200 − 30 − 40
  assert.match(s, /q 2 0 0 2 0 130 cm \/JcsSig1 Do Q/);
  assert.match(s, /\/XObject << \/JcsSig1 \d+ 0 R >>/);
});
