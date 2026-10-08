import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFont, symbolText, embeddedFace } from '../../src/xfa/text.js';
import { buildEmbeddedFonts } from '../../src/core/embed.js';
import { loadBundledFonts } from '../../src/fonts.js';
import { prepareFaces } from '../../src/core/faces.js';

const faces = prepareFaces(await loadBundledFonts());
const font = typeface => resolveFont({ typeface, size: 10 }, { ttf: faces });

test('symbol faces draw the characters their codes stand for', () => {
  // Wingdings: private-use (U+F0FC) and plain (ü = 0xFC) codes are a check mark
  assert.equal(symbolText(font('Wingdings-Regular'), ''), '✓ ');
  assert.equal(symbolText(font('Wingdings'), 'üo'), '✓□');
  // Symbol: Greek letters and operators
  assert.equal(symbolText(font('Symbol'), 'abg'), 'αβγ≥');
  // other faces are left alone
  assert.equal(symbolText(font('Arial'), 'ü'), 'ü');
});

test('a character Liberation Sans lacks is drawn with Source Sans when it has it', () => {
  const f = font('Arial');
  assert.equal(embeddedFace(f, 'abc').resName, faces.regular.resName);
  assert.equal(embeddedFace(f, '✓').resName, faces.sans.regular.resName);
});

test('a face that drew only .notdef is still embedded (no undefined font resource)', async () => {
  const fonts = await buildEmbeddedFonts(new Map([[faces.regular, new Map()]]));
  assert.equal(fonts.length, 1);
  assert.equal(fonts[0].resName, faces.regular.resName);
});

test('a tab in plain text wraps and draws as a space', async () => {
  const { wrapText } = await import('../../src/xfa/text.js');
  assert.deepEqual([...wrapText(font('Arial'), 'a\tb\t')], ['a b ']);
});

test('plain text keeps its leading spaces on the first line', async () => {
  const { wrapText } = await import('../../src/xfa/text.js');
  assert.deepEqual([...wrapText(font('Arial'), '   a b', 1000)], ['   a b']);
  assert.deepEqual([...wrapText(font('Arial'), 'a  b', 1000)], ['a  b']);
});

test('Times draws Latin Extended-A letters through a /Differences encoding', async () => {
  const { encodeStandard } = await import('../../src/core/writer.js');
  const { textWidth } = await import('../../src/xfa/text.js');
  const times = resolveFont({ typeface: 'Times New Roman', size: 10 }, { ttf: faces });
  // the standard face draws it (no fallback to an embedded sans), ă as wide as a
  assert.equal(embeddedFace(times, 'completează'), null);
  assert.equal(textWidth(times, 'ă'), textWidth(times, 'a'));
  const extra = new Map();
  assert.equal(encodeStandard('aăţă', extra), 'a\x01\x02\x01');
  assert.deepEqual([...extra], [[0x103, 1], [0x163, 2]]);
  const { PdfWriter } = await import('../../src/core/writer.js');
  const pdf = new PdfWriter().build([{ width: 100, height: 100, content: '', images: [] }], {}, { extraGlyphs: extra });
  assert.match(new TextDecoder('latin1').decode(pdf), /\/BaseFont \/Times-Roman \/Encoding << \/Type \/Encoding \/BaseEncoding \/WinAnsiEncoding \/Differences \[1 \/abreve 2 \/tcommaaccent\] >>/);
});
