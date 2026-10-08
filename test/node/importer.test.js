import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PdfWriter, ContentStream } from '../../src/core/writer.js';
import { parsePdf } from '../../src/core/parser.js';
import { importPages } from '../../src/core/importer.js';
import { flattenXfa } from '../../src/index.js';

const bytesOf = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

async function contentText(pdf, pageIndex = 0) {
  const doc = await parsePdf(bytesOf(pdf));
  const cat = (await doc.catalog()).value.value;
  const kids = (await doc.getObject(cat.Pages.num)).value.value.Kids.value;
  const page = (await doc.getObject(kids[pageIndex].num)).value.value;
  const refs = page.Contents.type === 'array' ? page.Contents.value : [page.Contents];
  let txt = '';
  for (const r of refs) txt += new TextDecoder('latin1').decode((await doc.getObject(r.num)).streamBytes) + '\n';
  return { txt, page, kids };
}

test('importPages copies page content and resources; overlay is appended', async () => {
  const cs = new ContentStream().text(72, 700, 'F_H', 12, [0, 0, 0], 'Original (shell) text');
  const src = new PdfWriter().build([
    { width: 612, height: 792, content: cs.toString() },
    { width: 612, height: 792, content: new ContentStream().text(72, 700, 'F_T', 12, [0, 0, 0], 'Second').toString() },
  ]);
  const imported = await importPages(await parsePdf(bytesOf(src)));
  assert.equal(imported.pages.length, 2);
  assert.ok(imported.pages.every(p => p.hasContent));
  assert.deepEqual(imported.pages[0].mediaBox, [0, 0, 612, 792]);
  assert.match(imported.pages[0].resources.font, /\/F_H /);

  const overlay = new ContentStream().text(72, 650, 'F_C', 10, [0, 0, 1], 'Value').toString();
  const out = new PdfWriter().build(imported.pages.map((base, i) => ({
    width: base.width, height: base.height, content: i === 0 ? overlay : '', base,
  })), {}, { imported });

  const { txt, kids } = await contentText(out, 0);
  assert.equal(kids.length, 2);
  assert.ok(txt.includes('Original \\(shell\\) text'));
  assert.ok(txt.indexOf('Original') < txt.indexOf('(Value) Tj'));
  assert.match(txt, /^q\n/);
  assert.ok((await contentText(out, 1)).txt.includes('(Second) Tj'));
});

const IMM = new URL('../../samples/xfa/imm5645e.pdf', import.meta.url);
test('static XFA form keeps its shell pages (local sample)', { skip: !existsSync(IMM) && 'samples/xfa/imm5645e.pdf not present' }, async () => {
  const { pdf, static: isStatic, pageCount } = await flattenXfa(readFileSync(IMM));
  assert.equal(isStatic, true);
  assert.equal(pageCount, 2);
  const { txt, page } = await contentText(pdf, 0);
  assert.ok(txt.length > 1000);
  assert.equal(page.Annots, undefined);
});

test('ttf: cmap, widths and a valid subset', async () => {
  const { parseTtf } = await import('../../src/core/ttf.js');
  const ttf = parseTtf(new Uint8Array(readFileSync(new URL('../../fonts/LiberationSans-Regular.ttf', import.meta.url))));
  assert.equal(ttf.unitsPerEm, 2048);
  assert.equal(ttf.width1000(0x41), 667);              // 'A' as in the Helvetica/Arial metrics
  assert.ok(ttf.glyphFor(0x0219) > 0);                 // ș
  const sub = parseTtf(ttf.subset([ttf.glyphFor(0x41), ttf.glyphFor(0x0219)]));
  assert.equal(sub.numGlyphs, ttf.numGlyphs);          // numbering kept for CIDToGIDMap /Identity
  assert.equal(sub.glyphFor(0x41), ttf.glyphFor(0x41));
});

test('parser: damaged startxref is recovered by scanning (encrypted fixture)', async () => {
  const good = readFileSync(new URL('../../samples/xfa/on-a-103e.pdf', import.meta.url));
  const text = new TextDecoder('latin1').decode(good);
  const at = text.lastIndexOf('startxref');
  const bad = new Uint8Array(good);
  const digits = text.slice(at + 9).match(/\s*(\d+)/);
  const start = at + 9 + digits[0].indexOf(digits[1]);
  for (let i = 0; i < digits[1].length; i++) bad[start + i] = 0x31; // 1111…
  const { pageCount } = await flattenXfa(bad, { fonts: null });
  assert.equal(pageCount, 9);
});

test('parser: an incremental update overrides the older object', async () => {
  const base = new PdfWriter().build([{ width: 612, height: 792, content: new ContentStream().text(72, 700, 'F_H', 12, [0, 0, 0], 'Old').toString() }]);
  const text = new TextDecoder('latin1').decode(base);
  const prev = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split(/\s+/)[0]);
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const root = /\/Root (\d+) 0 R/.exec(text)[1];
  // find the content stream object of page 1 and redefine it
  const doc0 = await parsePdf(bytesOf(base));
  const cat = (await doc0.catalog()).value.value;
  const kid = (await doc0.getObject(cat.Pages.num)).value.value.Kids.value[0];
  const contentNum = (await doc0.getObject(kid.num)).value.value.Contents.num;
  const body = 'BT /F_H 12 Tf 72 700 Td (New) Tj ET';
  const upd = `\n${contentNum} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`;
  const xrefAt = base.length + upd.length;
  const tail = `xref\n${contentNum} 1\n${String(base.length + 1).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root ${root} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const all = new Uint8Array([...base, ...new TextEncoder().encode(upd + tail)]);
  const { txt } = await contentText(all, 0);
  assert.ok(txt.includes('(New) Tj'));
});

test('BMP with a zero pixel-data offset reads pixels after the palette', async () => {
  const { encodeImage } = await import('../../src/core/images.js');
  // 2×1, 8-bit, two palette entries (red, blue); row padded to 4 bytes; bfOffBits = 0
  const b = new Uint8Array(14 + 40 + 8 + 4);
  const dv = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4D;
  dv.setUint32(2, b.length, true);
  dv.setUint32(10, 0, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, 2, true); dv.setInt32(22, 1, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 8, true); dv.setUint32(46, 2, true);
  b.set([0, 0, 255, 0, 255, 0, 0, 0], 54);  // BGRA: red, blue
  b.set([1, 0, 0, 0], 62);                    // pixels: blue, red
  const img = await encodeImage(b, 'image/bmp');
  const rgb = new Uint8Array(await new Response(new Blob([img.data]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  assert.deepEqual([...rgb], [0, 0, 255, 255, 0, 0]);
});

test('TIFF (LZW, RGB) decodes to RGB with its resolution', async () => {
  const { encodeImage, base64ToBytes } = await import('../../src/core/images.js');
  const tif = base64ToBytes('SUkqABoAAACAP8AQOBQQFBQPCgZDwjFAtQENAAABAwABAAAAAwAAAAEBAwABAAAAAgAAAAIBAwADAAAAzAAAAAMBAwABAAAABQAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABUBAwABAAAAAwAAABYBAwABAAAAAgAAABcBBAABAAAAEgAAABoBBQABAAAAvAAAABsBBQABAAAAxAAAABwBAwABAAAAAQAAACgBAwABAAAAAgAAAAAAAACQAAAAAQAAAJAAAAABAAAACAAIAAgA');
  const img = await encodeImage(tif, 'image/tif');
  assert.deepEqual([img.width, img.height, img.dpi], [3, 2, 144]);
  const rgb = new Uint8Array(await new Response(new Blob([img.data]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  assert.deepEqual([...rgb], [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
});

test('TIFF: CMYK and 16-bit samples decode to RGB; fax data passes through as CCITTFaxDecode', async () => {
  const { encodeImage, base64ToBytes } = await import('../../src/core/images.js');
  const rgbOf = async img => [...new Uint8Array(await new Response(new Blob([img.data]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())];
  // CMYK: full cyan, then half black
  const cmyk = await encodeImage(base64ToBytes('SUkqAAgAAAAKAAABBAABAAAAAgAAAAEBBAABAAAAAQAAAAIBAwAEAAAAhgAAAAMBAwABAAAAAQAAAAYBAwABAAAABQAAABEBBAABAAAAjgAAABUBAwABAAAABAAAABYBBAABAAAAAQAAABcBBAABAAAACAAAABwBAwABAAAAAQAAAAAAAAAIAAgACAAIAP8AAAAAAACA'));
  assert.deepEqual(await rgbOf(cmyk), [0, 255, 255, 127, 127, 127]);
  // 16-bit gray: 0 and 65535
  const g16 = await encodeImage(base64ToBytes('SUkqAAgAAAAJAAABBAABAAAAAgAAAAEBBAABAAAAAQAAAAIBAwABAAAAEAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAegAAABYBBAABAAAAAQAAABcBBAABAAAABAAAABwBAwABAAAAAQAAAAAAAAAAAP//'));
  assert.deepEqual(await rgbOf(g16), [0, 0, 0, 255, 255, 255]);
  // Group 4 fax, black is one (PhotometricInterpretation 1)
  const g4 = await encodeImage(base64ToBytes('SUkqAA4AAAA28AEAEAAJAAABAwABAAAACAAAAAEBAwABAAAAAgAAAAIBAwABAAAAAQAAAAMBAwABAAAABAAAAAYBAwABAAAAAQAAABEBBAABAAAACAAAABYBAwABAAAAAgAAABcBBAABAAAABQAAABwBAwABAAAAAQAAAAAAAAA='));
  assert.equal(g4.filter, 'CCITTFaxDecode');
  assert.equal(g4.decodeParms, '<< /K -1 /Columns 8 /Rows 2 /BlackIs1 true >>');
  assert.deepEqual([g4.colorSpace, g4.bitsPerComponent, g4.data.length], ['/DeviceGray', 1, 5]);
});
