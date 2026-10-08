import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PdfWriter } from '../../src/core/writer.js';
import { parsePdf } from '../../src/core/parser.js';
import { importPages } from '../../src/core/importer.js';
import { buildPdf } from './pdfbuild.js';

const latin1 = u8 => new TextDecoder('latin1').decode(u8);
const bytesOf = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

function ascii85(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = [...bytes.subarray(i, i + 4)];
    const n = chunk.length;
    while (chunk.length < 4) chunk.push(0);
    let v = ((chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3]) >>> 0;
    if (v === 0 && n === 4) { s += 'z'; continue; }
    const d = [];
    for (let k = 0; k < 5; k++) { d.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
    s += d.slice(0, n + 1).join('');
  }
  return s + '~>';
}

const CONTENT = 'BT /F1 12 Tf 72 700 Td (Hello filters) Tj ET';
const hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

function source() {
  return buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R
         /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> /XObject << /Im 5 0 R >> >> >>`,
    4: { dict: '<< /Filter [/ASCII85Decode /FlateDecode] >>', stream: ascii85(deflateSync(Buffer.from(CONTENT))) },
    5: { dict: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter [/AHx /DCTDecode] >>', stream: hex('JPEGDATA') + '>' },
  });
}

// like pdfbuild.js, for stream data that is not text
function binaryPdf(objects) {
  const parts = [Buffer.from('%PDF-1.7\n')];
  let pos = parts[0].length;
  const offsets = [];
  for (const [n, o] of Object.entries(objects)) {
    offsets[n] = pos;
    const data = typeof o === 'string' ? null : Buffer.from(o.stream, typeof o.stream === 'string' ? 'latin1' : undefined);
    const bytes = data
      ? Buffer.concat([Buffer.from(`${n} 0 obj\n${o.dict.replace(/>>\s*$/, '')} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n')])
      : Buffer.from(`${n} 0 obj\n${o}\nendobj\n`);
    parts.push(bytes);
    pos += bytes.length;
  }
  const size = offsets.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

test('parser undoes ASCII85, ASCIIHex, LZW and RunLength filters, and stops at image filters', async () => {
  const doc = await parsePdf(bytesOf(binaryPdf({
    1: '<< /Type /Catalog >>',
    2: { dict: '<< /Filter [/ASCII85Decode /FlateDecode] >>', stream: ascii85(deflateSync(Buffer.from(CONTENT))) },
    3: { dict: '<< /Filter /ASCIIHexDecode >>', stream: '48 65 6c\n6C6f7>' },
    4: { dict: '<< /Filter /RunLengthDecode >>', stream: '\x02abc\xFDz\x80' },
    5: { dict: '<< /Filter [/A85 /DCTDecode] >>', stream: ascii85(Buffer.from('JPEGDATA')) },
    6: { dict: '<< /Filter /LZWDecode >>', stream: Buffer.from('800B6050220C0C8501', 'hex') }, // the PDF reference's example
  })));
  const get = n => doc.getObject(n);
  assert.equal(latin1((await get(2)).streamBytes), CONTENT);
  assert.equal((await get(2)).decodedFilters, 2);
  assert.equal(latin1((await get(3)).streamBytes), 'Hellop');
  assert.equal(latin1((await get(4)).streamBytes), 'abczzzz');
  assert.equal(latin1((await get(5)).streamBytes), 'JPEGDATA');
  assert.equal((await get(5)).decodedFilters, 1);
  assert.equal(latin1((await get(6)).streamBytes), '-----A---B');
});

test('imported streams are written with the filters left after decoding', async () => {
  const imported = await importPages(await parsePdf(bytesOf(source())));
  const out = new PdfWriter().build(imported.pages.map(base => ({ width: base.width, height: base.height, content: '', base })), {}, { imported });
  const doc = await parsePdf(bytesOf(out));
  const cat = (await doc.catalog()).value.value;
  const page = (await doc.getObject((await doc.getObject(cat.Pages.num)).value.value.Kids.value[0].num)).value.value;
  const refs = page.Contents.type === 'array' ? page.Contents.value : [page.Contents];
  let text = '';
  for (const r of refs) {
    const o = await doc.getObject(r.num);
    if (o.dict.Filter) assert.equal(o.dict.Filter.value, 'FlateDecode');
    text += latin1(o.streamBytes);
  }
  assert.ok(text.includes(CONTENT));

  const res = page.Resources.type === 'ref' ? (await doc.getObject(page.Resources.num)).value.value : page.Resources.value;
  const xo = res.XObject.type === 'ref' ? (await doc.getObject(res.XObject.num)).value.value : res.XObject.value;
  const img = await doc.getObject(xo.Im.num);
  assert.deepEqual(img.dict.Filter.value.map(f => f.value), ['FlateDecode', 'DCTDecode']);
  assert.equal(latin1(img.streamBytes), 'JPEGDATA');
});

test('parser reads a stream whose /Length is missing or wrong up to endstream', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< >>\nstream\nBT (missing) Tj ET\nendstream\nendobj\n2 0 obj\n<< /Length 3 >>\nstream\nBT (short) Tj ET\r\nendstream\nendobj\n');
  const at = n => new TextDecoder().decode(pdf).indexOf(`${n} 0 obj`);
  const xref = `xref\n0 3\n0000000000 65535 f \n${String(at(1)).padStart(10, '0')} 00000 n \n${String(at(2)).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
  const doc = await parsePdf(bytesOf(new Uint8Array([...pdf, ...new TextEncoder().encode(xref)])));
  assert.equal(latin1((await doc.getObject(1)).streamBytes), 'BT (missing) Tj ET');
  assert.equal(latin1((await doc.getObject(2)).streamBytes), 'BT (short) Tj ET');
});
