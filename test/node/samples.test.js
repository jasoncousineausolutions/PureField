import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parsePdf } from '../../src/core/parser.js';
import { flattenXfa } from '../../src/index.js';

// Each sample must flatten to as many pages as Adobe Reader printed
const dir = new URL('../../samples/xfa/', import.meta.url);
const refs = existsSync(new URL('acrobat/', dir)) ? readdirSync(new URL('acrobat/', dir)).filter(f => f.endsWith('.pdf')) : [];

async function pageCount(bytes) {
  const doc = await parsePdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const cat = (await doc.catalog()).value.value;
  return (await doc.getObject(cat.Pages.num)).value.value.Count;
}

for (const f of refs) {
  test(`sample ${f}: page count matches Adobe Reader`, async () => {
    const expected = await pageCount(readFileSync(new URL(`acrobat/${f}`, dir)));
    const { pageCount: got } = await flattenXfa(readFileSync(new URL(f, dir)), { fonts: null });
    assert.equal(got, expected);
  });
}
