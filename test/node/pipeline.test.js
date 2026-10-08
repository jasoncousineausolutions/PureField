import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenXfa } from '../../src/index.js';
import { parsePdf } from '../../src/core/parser.js';

const FIXTURE = new URL('../../samples/xfa/on-a-103e.pdf', import.meta.url);

test('fixture flattens to a 9-page PDF without XFA (standard fonts)', async () => {
  const { pdf, pageCount, dynamic, log } = await flattenXfa(readFileSync(FIXTURE), { fonts: null });
  assert.equal(dynamic, true);
  assert.equal(pageCount, 9); // matches the Reader print of this form
  assert.equal(log.byCode('XFA_IMAGE_UNSUPPORTED').length, 0);
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-'));
  assert.ok(!text.includes('/XFA'));
  assert.ok(text.includes('(Application for Review) Tj'));
  assert.ok(text.includes('(Disponible en fran'));
  // floating page-number fields resolve per page
  const pageRuns = [...text.matchAll(/\(Page \) Tj[\s\S]*?\((\d)\) Tj[\s\S]*?\( of \) Tj[\s\S]*?\((\d)\) Tj/g)].map(m => `${m[1]}/${m[2]}`);
  assert.deepEqual(pageRuns, Array.from({ length: 9 }, (_, i) => `${i + 1}/9`));
  const doc = await parsePdf(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
  assert.ok(await doc.catalog());
});

test('default output embeds subset Liberation Sans as Identity-H with ToUnicode', async () => {
  const { pdf, log } = await flattenXfa(readFileSync(FIXTURE));
  assert.equal(log.byCode('XFA_FONT_UNAVAILABLE').length, 0);
  const text = new TextDecoder('latin1').decode(pdf);
  assert.match(text, /\/Subtype \/CIDFontType2/);
  assert.match(text, /\/BaseFont \/[A-Z]{6}\+LiberationSans/);
  assert.match(text, /\/Encoding \/Identity-H/);
  assert.match(text, /\/ToUnicode \d+ 0 R/);
  assert.match(text, /\/JU_R \d+ Tf/);
  assert.ok(pdf.length < 700000, `subset fonts keep the file small (${pdf.length} bytes)`);
});

test('Myriad Pro text is drawn at Myriad Pro widths with the best-fitting bundled glyphs', async () => {
  const { loadBundledFonts } = await import('../../src/fonts.js');
  const { prepareFaces } = await import('../../src/core/faces.js');
  const { resolveFont, textWidth, embeddedFace } = await import('../../src/xfa/text.js');
  const ttf = prepareFaces(await loadBundledFonts());
  const parent = { ttf };
  const myriad = resolveFont({ typeface: 'Myriad Pro', size: 10 }, parent);
  const arial = resolveFont({ typeface: 'Arial', size: 10 }, parent);
  // Source Sans Pro is closer in proportion to Myriad than Liberation Sans
  assert.equal(embeddedFace(myriad, 'x').glyphsFrom, 'sourcesans');
  assert.equal(embeddedFace(arial, 'x'), ttf.regular);
  const s = 'How many bee yard locations do you currently operate?';
  const ratio = textWidth(myriad, s) / textWidth(arial, s);
  assert.ok(ratio > 0.85 && ratio < 0.95, `Myriad/Arial width ratio ${ratio}`);
  // bold and italic pick real bold and italic glyphs, no synthesis
  const bi = resolveFont({ typeface: 'Myriad Pro', size: 10, weight: 'bold', posture: 'italic' }, parent);
  const f = embeddedFace(bi, 'x');
  assert.ok(f.glyphBold && f.glyphItalic);
  // italic Myriad is measured with Myriad Pro Italic widths (narrower)
  const it = resolveFont({ typeface: 'Myriad Pro', size: 10, posture: 'italic' }, parent);
  const cap = 'A.4.Cod de identificare fiscală';
  assert.ok(textWidth(it, cap) < 0.97 * textWidth(myriad, cap));
  // letters with a cedilla or comma below are as wide as their base letter
  // in Myriad Pro (pdf.js's tables give them Helvetica's widths)
  for (const [acc, base] of [['ş', 's'], ['ș', 's'], ['ţ', 't'], ['Ş', 'S'], ['Ţ', 'T'], ['ņ', 'n']]) assert.equal(textWidth(myriad, acc), textWidth(myriad, base), acc);
  // a character Source Sans Pro lacks falls back to Liberation Sans glyphs
  assert.equal(embeddedFace(myriad, 'x\u0531').glyphsFrom, 'liberation');
});

test('a caption font that names only a typeface is 10pt and black', async () => {
  const { parseTemplateModel } = await import('../../src/xfa/model.js');
  const xml = new DOMParser().parseFromString(`<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f">
    <field name="a"><font typeface="Arial" size="11pt"><fill><color value="0,0,255"/></fill></font>
      <caption><font typeface="Arial"/><value><text>A</text></value></caption></field></subform></template>`, 'application/xml');
  const a = parseTemplateModel(xml).root.children[0];
  assert.equal(a.caption.font.size, 10);
  assert.deepEqual(a.caption.font.color, [0, 0, 0]); // not the field's blue
  assert.equal(a.caption.font.weight, 'normal');
  // a node with no <font> at all still inherits the colour
  const { resolveFont } = await import('../../src/xfa/text.js');
  assert.deepEqual(resolveFont(undefined, resolveFont(a.font, null)).color, [0, 0, 255]);
});

test('substitute glyphs are centred in the advances of the face they stand in for', async () => {
  const { loadBundledFonts } = await import('../../src/fonts.js');
  const { prepareFaces } = await import('../../src/core/faces.js');
  const faces = prepareFaces(await loadBundledFonts());
  const f = faces.forMyriad(true, false, 'MJ');
  const gid = ch => f.glyphFor(ch.codePointAt(0));
  // Myriad Pro Bold M is wider than Source Sans Pro Bold's, J narrower
  assert.ok(f.centreOffset(gid('M'), 0x4D) > 30);
  assert.ok(f.centreOffset(gid('J'), 0x4A) < -30);
  // Liberation Sans at Arial widths needs no offset
  assert.equal(faces.regular.centreOffset, undefined);
});
