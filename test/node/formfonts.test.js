import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePdf } from '../../src/core/parser.js';
import { readFormFonts, findFormFace, familyKey } from '../../src/core/formfonts.js';
import { resolveFont, textWidth } from '../../src/xfa/text.js';

const sample = name => {
  const u8 = readFileSync(new URL(`../../samples/xfa/${name}`, import.meta.url));
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
};

test('form fonts: AcroForm /DR widths by family, weight and italic angle', async () => {
  const fonts = await readFormFonts(await parsePdf(sample('CIE-XFA-work.pdf')));
  const ssp = fonts.get(familyKey('Source Sans Pro'));
  assert.ok(ssp.regular && ssp.bold && ssp.italic);
  assert.equal(ssp.regular.width1000(32), 200);
  assert.ok(ssp.bold.width1000(0x61) > ssp.regular.width1000(0x61));
  // typeface names with a style suffix find the family
  assert.equal(findFormFace(fonts, 'SourceSansPro-Bold', true, false), ssp.bold);
  assert.equal(findFormFace(fonts, 'Unknown Face', false, false), null);
});

test('form fonts: a declared sans face measures with its own widths', async () => {
  const formFonts = await readFormFonts(await parsePdf(sample('CIE-XFA-work.pdf')));
  const face = formFonts.get('sourcesanspro').regular;
  const ttf = { formFonts, forForm: f => ({ width1000: cp => f.width1000(cp) ?? 500 }), regular: {} };
  const font = resolveFont({ typeface: 'Source Sans Pro', size: 10 }, { ttf });
  assert.equal(font.form, face);
  const expect = [...'Objet'].reduce((w, c) => w + face.width1000(c.codePointAt(0)) / 100, 0);
  assert.ok(Math.abs(textWidth(font, 'Objet') - expect) < 1e-9);
  // Arial keeps the Liberation metrics
  assert.equal(resolveFont({ typeface: 'Arial', size: 10 }, { ttf }).form, null);
});

test('form fonts: a TrueType program the form embeds draws its text (symbolic cmap)', async () => {
  const { flattenXfa } = await import('../../src/index.js');
  const { pdf } = await flattenXfa(sample('adobe-master-pages-test.pdf'));
  const text = new TextDecoder('latin1').decode(pdf);
  assert.match(text, /\/BaseFont \/[A-Z]{6}\+Wingdings3/);
});


test('form fonts: declared widths pick the bundled glyphs whose proportions fit them best', async () => {
  const { loadBundledFonts } = await import('../../src/fonts.js');
  const { prepareFaces } = await import('../../src/core/faces.js');
  const faces = prepareFaces(await loadBundledFonts());
  const formFonts = await readFormFonts(await parsePdf(sample('CIE-XFA-work.pdf')));
  const ssp = formFonts.get('sourcesanspro');
  // Source Sans Pro declared, not embedded: Source Sans glyphs, unsqueezed
  const regular = faces.forForm(ssp.regular, false, 'Coordonnées du promoteur');
  assert.equal(regular.glyphsFrom, 'sourcesans');
  assert.equal(regular.squeeze, 1);
  assert.equal(regular.width1000(32), 200);
  assert.ok(faces.forForm(ssp.bold, true, 'x').glyphBold);
  // Arial Narrow widths are Liberation Sans scaled: Liberation glyphs, squeezed
  const narrow = { width1000: cp => Math.round(faces.regular.width1000(cp) * 0.82) };
  const f = faces.forForm(narrow, false, 'Narrow');
  assert.equal(f.glyphsFrom, 'liberation');
  assert.ok(Math.abs(f.squeeze - 0.82) < 0.01);
});

test('form fonts: a declared serif face measures at its widths; Times is scaled to them', async () => {
  const formFonts = await readFormFonts(await parsePdf(sample('Attestation_d.occupation.pdf')));
  const minion = formFonts.get('minionpro').regular;
  const ttf = { formFonts, forForm: f => ({ width1000: cp => f.width1000(cp) }), regular: {} };
  const font = resolveFont({ typeface: 'Minion Pro', size: 10 }, { ttf });
  assert.equal(font.face, 'Times-Roman');
  assert.equal(font.form, minion);
  const s = "Attestation d'occupation";
  const expect = [...s].reduce((w, c) => w + minion.width1000(c.codePointAt(0)) / 100, 0);
  assert.ok(Math.abs(textWidth(font, s) - expect) < 1e-9);
  const { timesScale } = await import('../../src/xfa/text.js');
  assert.ok(timesScale(font, s) > 1, 'Minion Pro is wider than Times');
});
