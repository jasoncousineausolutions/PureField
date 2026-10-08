// Encrypted PDFs: RC4, AES-128 and AES-256, user and owner passwords
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parsePdf } from '../../src/core/parser.js';
import { PasswordError, UnsupportedEncryptionError } from '../../src/core/crypto.js';
import { buildPdf } from './pdfbuild.js';

const here = new URL('.', import.meta.url).pathname;
const corpus = `${here}../../samples/nonxfa/`;
const fixtures = `${here}../fixtures/crypto/`;
const open = (path, password) => {
  const b = readFileSync(path);
  return parsePdf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), password === undefined ? {} : { password });
};
// the text of every content stream in objects 1..n
async function streams(doc, n = 40) {
  let out = '';
  for (let i = 1; i <= n; i++) {
    const o = await doc.getObject(i).catch(() => null);
    if (o?.streamBytes) out += new TextDecoder('latin1').decode(o.streamBytes);
  }
  return out;
}

// PDFium's hello-world files: user password "hôtel", owner password "âge"
const hello = name => (existsSync(`${corpus}${name}`) ? `${corpus}${name}` : `${fixtures}${name}`);

for (const r of [5, 6]) {
  test(`AES-256 revision ${r}: user and owner passwords; a wrong or missing one throws`, async () => {
    const path = hello(`pdfium-encrypted_hello_world_r${r}.pdf`);
    if (!existsSync(path)) return;
    for (const pw of ['hôtel', 'âge']) assert.match(await streams(await open(path, pw)), /Hello, world!/);
    await assert.rejects(open(path, 'wrong'), PasswordError);
    await assert.rejects(open(path), /needs a password/);
  });
}

for (const r of [2, 3]) {
  test(`RC4 revision ${r}: user and owner passwords`, async () => {
    const path = `${fixtures}encrypted_hello_world_r${r}.pdf`;
    for (const pw of ['hôtel', 'âge']) assert.match(await streams(await open(path, pw)), /Hello, world!/);
    await assert.rejects(open(path, 'wrong'), PasswordError);
    await assert.rejects(open(path), /needs a password/);
  });
}

test('AES-128 revision 4: a missing password throws instead of decrypting to garbage', async () => {
  // pdf.js's bug1782186: user password "Hello"
  const path = `${corpus}pdfjs-bug1782186.pdf`;
  if (!existsSync(path)) return;
  await assert.rejects(open(path), /needs a password/);
  assert.equal((await open(path, 'Hello')).isEncrypted, true);
});

test('AES-256 revision 6: Algorithm 2.B runs until E\'s last byte is at most rounds done − 32', async () => {
  // pdf.js's pr6531_2 needs the round after the one an off-by-one stops at
  const path = `${corpus}pdfjs-pr6531_2.pdf`;
  if (!existsSync(path)) return;
  assert.match(await streams(await open(path)), /\/Helv 12/);
  const info = (await (await open(path)).getObject(1)).value.value;
  assert.equal(info.CreationDate.value, "D:20151009101242-07'00'");
});

test('SASLprep: R6 passwords are normalised (soft hyphen dropped, ª as a)', async () => {
  const path = `${corpus}pdfjs-saslprep-r6.pdf`;
  if (!existsSync(path)) return;
  assert.match(await streams(await open(path, 'SªSL­prep')), /Hello/);
});

test('only embedded files encrypted (EFOpen): the document opens without a password', async () => {
  const path = `${corpus}pdfjs-auth-event-ef-open.pdf`;
  if (!existsSync(path)) return;
  const doc = await open(path);
  assert.equal(doc.isEncrypted, false);
});

test('strings and streams use their own crypt filters; plain metadata and /Crypt Identity streams are not decrypted', async () => {
  // AES-128, /EncryptMetadata false; object 2 is a /Crypt stream stored plain
  const doc = await open(`${fixtures}aes128_plain_metadata.pdf`, 'user');
  assert.match(await streams(doc, 8), /Hello, world!/);
  assert.match(await streams(doc, 8), /dc:format/);
  assert.match(new TextDecoder().decode((await doc.getObject(2)).streamBytes), /^plain stream, stored unencrypted/);
  // pdf.js's bug1782186: streams AES-128, strings /Identity (its layer name is plain)
  const path = `${corpus}pdfjs-bug1782186.pdf`;
  if (!existsSync(path)) return;
  const layer = (await (await open(path, 'Hello')).getObject(16)).value.value;
  assert.equal(layer.Name.value, 'Layer1');
});

test('certificate security and other handlers are refused, not read as plain', async () => {
  const pdf = buildPdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [] /Count 0 >>',
    3: '<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /Recipients [<00>] >>',
  });
  const latin1 = new TextDecoder('latin1').decode(pdf).replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 3 0 R /ID [<00> <00>]');
  const bytes = Uint8Array.from(latin1, c => c.charCodeAt(0));
  await assert.rejects(parsePdf(bytes.buffer), UnsupportedEncryptionError);
  await assert.rejects(parsePdf(bytes.buffer), /certificates/);
});
