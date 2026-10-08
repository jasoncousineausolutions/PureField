/**
 * Purefield / core / crypto.js
 *
 * PDF Standard Security Handler decryption.
 *
 * Standard security handler (/Filter /Standard):
 *   - Revisions 2–4: RC4 (40–128 bit) or AES-128 (AESV2), keys from MD5
 *   - Revisions 5 and 6: AES-256 (AESV3), the file key unwrapped from /UE or
 *     /OE with SHA-256 (R5) or the iterated SHA-2 hash of ISO 32000-2
 *     Algorithm 2.B (R6, Acrobat X and later)
 *   - The user password (empty by default, as most files that open without
 *     a prompt use), else the same password tried as the owner password;
 *     a password neither confirms throws PasswordError
 *
 * This covers the vast majority of "locked" government and corporate PDFs
 * that open without a password in Adobe Reader but show garbled content
 * in other readers that skip decryption.
 *
 * Algorithm references: PDF 1.7 spec, section 3.5
 */

// ---------------------------------------------------------------------------
// Standard 32-byte padding string (PDF spec section 3.5.2)
// ---------------------------------------------------------------------------
const PADDING = new Uint8Array([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
  0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveNum(val) {
  if (typeof val === 'number') return val;
  return parseInt(val) || 0;
}

function nameVal(val) {
  return val?.type === 'name' ? val.value : (typeof val === 'string' ? val : null);
}

function stringBytes(val) {
  // Convert a parsed PDF string value to a Uint8Array of raw bytes
  const s = val?.type === 'string' ? val.value : (typeof val === 'string' ? val : '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

function int32LE(n) {
  // Return n as a 4-byte little-endian Uint8Array (handles negative via sign extension)
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, n, true);
  return new Uint8Array(buf);
}

function int24LE(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
}

function int16LE(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

async function md5(data) {
  // Web Crypto doesn't support MD5, so we implement it ourselves.
  // MD5 is only needed for key derivation (not security-critical here —
  // we're deriving a key from a known empty password, not verifying secrets).
  return md5Impl(data);
}

// Exported for testing only
export { md5 as _md5, deriveObjectKey as _deriveObjectKey };

// ---------------------------------------------------------------------------
// MD5 implementation (needed for key derivation — Web Crypto dropped MD5)
// ---------------------------------------------------------------------------
function md5Impl(input) {
  // Ensure input is Uint8Array
  if (!(input instanceof Uint8Array)) input = new Uint8Array(input);

  const T = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    T[i] = (Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  }

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  // Pre-processing: padding
  const msgLen = input.length;
  const bitLen = msgLen * 8;
  const padLen = ((msgLen % 64) < 56 ? 56 - (msgLen % 64) : 120 - (msgLen % 64));
  const padded = new Uint8Array(msgLen + padLen + 8);
  padded.set(input);
  padded[msgLen] = 0x80;
  // Append bit length as 64-bit LE
  const dv = new DataView(padded.buffer);
  dv.setUint32(msgLen + padLen,     bitLen & 0xffffffff, true);
  dv.setUint32(msgLen + padLen + 4, Math.floor(bitLen / 2**32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = dv.getUint32(i + j * 4, true);
    }

    let a = a0, b = b0, c = c0, d = d0;

    for (let j = 0; j < 64; j++) {
      let F, g;
      if      (j < 16) { F = (b & c) | (~b & d);       g = j; }
      else if (j < 32) { F = (d & b) | (~d & c);       g = (5 * j + 1) % 16; }
      else if (j < 48) { F = b ^ c ^ d;                 g = (3 * j + 5) % 16; }
      else             { F = c ^ (b | ~d);              g = (7 * j) % 16; }

      F = (F + a + T[j] + M[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((F << S[j]) | (F >>> (32 - S[j])))) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const result = new Uint8Array(16);
  const rv = new DataView(result.buffer);
  rv.setUint32(0,  a0, true);
  rv.setUint32(4,  b0, true);
  rv.setUint32(8,  c0, true);
  rv.setUint32(12, d0, true);
  return result;
}

// ---------------------------------------------------------------------------
// Key derivation — Algorithm 3.2 (PDF spec)
// Derives the file encryption key from the empty user password.
// ---------------------------------------------------------------------------
// The password padded to 32 bytes with the standard padding (Algorithm 2 step a)
function padPassword(pw) {
  const out = new Uint8Array(32);
  const n = Math.min(32, pw.length);
  out.set(pw.subarray(0, n));
  out.set(PADDING.subarray(0, 32 - n), n);
  return out;
}

// The file key for a user password (padded), or null when U rejects it
async function deriveFileKey(encryptDict, fileId, password = new Uint8Array(0)) {
  const R       = resolveNum(encryptDict.R);
  const P       = resolveNum(encryptDict.P);
  const keyBits = resolveNum(encryptDict.Length) || 40;
  // revision 2 keys are 40 bits whatever /Length says
  const keyBytes = R === 2 ? 5 : Math.min(keyBits, 128) >> 3;
  const O       = stringBytes(encryptDict.O);
  const U       = stringBytes(encryptDict.U);

  const pass = padPassword(password);
  const base = concatBytes(pass, O, int32LE(P), fileId);

  // PDF spec says: if R>=4 and EncryptMetadata=true, append 0xFFFFFFFF.
  // However some generators set EncryptMetadata=true in the dict but do NOT
  // include the 0xFFFFFFFF in the actual key derivation. We try both and
  // verify against the U value to pick the correct one.
  const candidates = [];

  // Candidate 1: without 0xFFFFFFFF (the buggy-but-common case)
  candidates.push(base);

  // Candidate 2: with 0xFFFFFFFF (the spec-correct case for R>=4)
  if (R >= 4) {
    candidates.push(concatBytes(base, new Uint8Array([0xff, 0xff, 0xff, 0xff])));
  }

  for (const data of candidates) {
    let key = await md5(data);
    if (R >= 3) {
      for (let i = 0; i < 50; i++) {
        key = await md5(key.slice(0, keyBytes));
      }
    }
    const fileKey = key.slice(0, keyBytes);

    // Verify against U (Algorithm 3.6 for R>=3):
    // MD5(padding + fileId), then encrypt result with RC4 using fileKey,
    // then 19 more RC4 rounds with modified key. Compare first 16 bytes of U.
    if (await verifyUserPassword(fileKey, U, fileId, R)) {
      return fileKey;
    }
  }
  return null;
}

// Verify user password against U entry (Algorithm 3.6, R>=3)
async function verifyUserPassword(fileKey, U, fileId, R) {
  // revision 2 (Algorithm 4): U is the padding encrypted with the key
  if (R < 3) return decryptRC4(fileKey, PADDING).every((b, i) => b === U[i]);

  // Compute expected U: MD5(padding + fileId) encrypted with RC4
  const hashInput = concatBytes(PADDING, fileId);
  const hashResult = await md5(hashInput);

  // Encrypt with RC4 using fileKey
  let encrypted = decryptRC4(fileKey, hashResult);

  // 19 more rounds with modified key
  for (let i = 1; i < 20; i++) {
    const modKey = fileKey.map(b => b ^ i);
    encrypted = decryptRC4(modKey, encrypted);
  }

  // Compare first 16 bytes of computed vs stored U
  for (let i = 0; i < 16; i++) {
    if (encrypted[i] !== U[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-object key — Algorithm 3.1 (PDF spec)
// Derives the decryption key for a specific object.
// ---------------------------------------------------------------------------
async function deriveObjectKey(fileKey, objNum, genNum, isAes) {
  const extra = concatBytes(fileKey, int24LE(objNum), int16LE(genNum));
  const salt  = isAes ? concatBytes(extra, new Uint8Array([0x73, 0x41, 0x6C, 0x54])) : extra;
  const hash  = await md5(salt);
  // Key length is min(fileKey.length + 5, 16) bytes
  const keyLen = Math.min(fileKey.length + 5, 16);
  return hash.slice(0, keyLen);
}

// ---------------------------------------------------------------------------
// AES-128-CBC decryption (AESV2)
// The first 16 bytes of the ciphertext are the IV.
// ---------------------------------------------------------------------------
async function decryptAES(key, ciphertext) {
  if (ciphertext.length < 16) return ciphertext; // too short to decrypt

  const iv   = ciphertext.slice(0, 16);
  const data = ciphertext.slice(16);

  if (data.length === 0) return new Uint8Array(0);

  // Trim to block boundary if needed (malformed PDFs)
  const trimmed = data.length % 16 !== 0
    ? data.slice(0, data.length - (data.length % 16))
    : data;

  // decrypted without WebCrypto's padding check (a malformed pad would make it
  // throw: pdf.js's pr6531_2), then the PKCS7 padding stripped when valid
  const decrypted = await aesDecryptNoPad(key, iv, trimmed);
  return stripPkcs7(decrypted);
}

function stripPkcs7(data) {
  if (data.length === 0) return data;
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16) return data; // invalid padding, return as-is
  // Verify all padding bytes
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) return data; // invalid, return as-is
  }
  return data.slice(0, data.length - pad);
}

// ---------------------------------------------------------------------------
// RC4 decryption (for R2/R3 and U-string verification)
// ---------------------------------------------------------------------------
function decryptRC4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }

  const out = new Uint8Array(data.length);
  let x = 0, y = 0;
  for (let i = 0; i < data.length; i++) {
    x = (x + 1) & 0xff;
    y = (y + S[x]) & 0xff;
    [S[x], S[y]] = [S[y], S[x]];
    out[i] = data[i] ^ S[(S[x] + S[y]) & 0xff];
  }
  return out;
}

// ---------------------------------------------------------------------------
// PdfDecryptor — the main class
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Owner password, revisions 2–4 (Algorithm 7): the user password it unlocks
// ---------------------------------------------------------------------------
async function userPasswordFromOwner(encryptDict, password) {
  const R = resolveNum(encryptDict.R);
  const keyBytes = R === 2 ? 5 : Math.min(resolveNum(encryptDict.Length) || 40, 128) >> 3;
  let key = await md5(padPassword(password));
  if (R >= 3) for (let i = 0; i < 50; i++) key = await md5(key);
  key = key.slice(0, keyBytes);
  let out = stringBytes(encryptDict.O).slice(0, 32);
  if (R === 2) return decryptRC4(key, out);
  for (let i = 19; i >= 0; i--) out = decryptRC4(key.map(b => b ^ i), out);
  return out;
}

// ---------------------------------------------------------------------------
// AES-256, revisions 5 and 6 (ISO 32000-2 §7.6.4.3.3–4)
// ---------------------------------------------------------------------------

async function sha(bits, data) {
  return new Uint8Array(await crypto.subtle.digest(`SHA-${bits}`, data));
}

// AES-CBC encryption without padding: WebCrypto pads, the padding block goes
async function aesEncryptNoPad(key, iv, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
  return out.subarray(0, data.length);
}

// AES-CBC decryption without padding: a block that decrypts to a full
// padding block is appended, so WebCrypto's padding check passes
async function aesDecryptNoPad(key, iv, data) {
  const last = data.subarray(data.length - 16);
  const pad = new Uint8Array(16).fill(16);
  const extra = await aesEncryptNoPad(key, last, pad);
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, concatBytes(data, extra)));
}

// Algorithm 2.B (R6), or plain SHA-256 (R5)
async function hash2B(password, salt, udata, R) {
  let K = await sha(256, concatBytes(password, salt, udata));
  if (R < 6) return K;
  for (let round = 0; ; round++) {
    const K1 = concatBytes(password, K, udata);
    const rep = new Uint8Array(K1.length * 64);
    for (let i = 0; i < 64; i++) rep.set(K1, i * K1.length);
    const E = await aesEncryptNoPad(K.subarray(0, 16), K.subarray(16, 32), rep);
    let mod = 0;
    for (let i = 0; i < 16; i++) mod += E[i];
    K = await sha([256, 384, 512][mod % 3], E);
    // at least 64 rounds, then until E's last byte is at most rounds done − 32
    if (round + 1 >= 64 && E[E.length - 1] <= round + 1 - 32) break;
  }
  return K.subarray(0, 32);
}

// SASLprep, as far as passwords need it: compatibility normalisation, the
// characters mapped to nothing dropped, other spaces made plain spaces
function saslprep(s) {
  return s.normalize('NFKC')
    .replace(/[\u00AD\u034F\u1806\u180B-\u180D\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]/g, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

async function deriveFileKeyV5(encryptDict, password) {
  const R = resolveNum(encryptDict.R);
  const pw = new TextEncoder().encode(R >= 6 ? saslprep(password) : password).subarray(0, 127);
  const U = stringBytes(encryptDict.U), O = stringBytes(encryptDict.O);
  const UE = stringBytes(encryptDict.UE), OE = stringBytes(encryptDict.OE);
  const eq = (a, b) => a.length >= 32 && b.length >= 32 && a.subarray(0, 32).every((v, i) => v === b[i]);
  const zero = new Uint8Array(16);
  // user password: U = hash | validation salt | key salt
  if (eq(await hash2B(pw, U.subarray(32, 40), new Uint8Array(0), R), U)) {
    const k = await hash2B(pw, U.subarray(40, 48), new Uint8Array(0), R);
    return aesDecryptNoPad(k, zero, UE.subarray(0, 32));
  }
  // owner password: the same with O's salts and U as extra input
  const u48 = U.subarray(0, 48);
  if (eq(await hash2B(pw, O.subarray(32, 40), u48, R), O)) {
    const k = await hash2B(pw, O.subarray(40, 48), u48, R);
    return aesDecryptNoPad(k, zero, OE.subarray(0, 32));
  }
  return null;
}

export class PdfDecryptor {
  /**
   * @param {Uint8Array} fileKey
   * @param {'V2'|'AESV2'|'AESV3'|'Identity'} cfm - streams' cipher (V2 is RC4)
   * @param {'V2'|'AESV2'|'AESV3'|'Identity'} strCfm - strings' cipher
   * @param {boolean} encryptMetadata - false: metadata streams are plain
   */
  constructor(fileKey, cfm, strCfm = cfm, encryptMetadata = true) {
    this._fileKey = fileKey;
    this._cfm = cfm;
    this._strCfm = strCfm;
    this.encryptMetadata = encryptMetadata;
  }

  async _decrypt(cfm, objNum, genNum, bytes) {
    if (cfm === 'Identity') return bytes;
    const aes = cfm === 'AESV2' || cfm === 'AESV3';
    // AES-256 uses the file key itself for every object
    const objKey = cfm === 'AESV3' ? this._fileKey : await deriveObjectKey(this._fileKey, objNum, genNum, aes);
    return aes ? decryptAES(objKey, bytes) : decryptRC4(objKey, bytes);
  }

  /** Decrypt a stream's raw bytes for the given object */
  decryptStream(objNum, genNum, ciphertext) {
    return this._decrypt(this._cfm, objNum, genNum, ciphertext);
  }

  /** Decrypt a PDF string value for the given object; its bytes */
  decryptString(objNum, genNum, encryptedStr) {
    return this._decrypt(this._strCfm, objNum, genNum, stringBytes(encryptedStr));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a PdfDecryptor from a parsed PDF document's encrypt dictionary.
 * Returns null if the PDF is not encrypted.
 *
 * @param {object} encryptDict  - the parsed /Encrypt dictionary value object
 * @param {Uint8Array} fileId   - the first element of the /ID array (raw bytes)
 */
export async function buildDecryptor(encryptDict, fileId, password = '') {
  if (!encryptDict) return null;

  const filter = nameVal(encryptDict.Filter);
  if (filter !== 'Standard') {
    // certificate security (Adobe.PubSec) and third-party handlers: the
    // file cannot be read without them, and reading it plain gives garbage
    throw new UnsupportedEncryptionError(filter === 'Adobe.PubSec'
      ? 'Purefield: the PDF is secured with certificates (Adobe.PubSec), which is not supported'
      : `Purefield: the PDF is encrypted with an unsupported security handler (${filter ?? 'none named'})`);
  }

  const V   = resolveNum(encryptDict.V);
  const R   = resolveNum(encryptDict.R);

  // The ciphers: one for streams (/StmF) and one for strings (/StrF), each
  // a crypt filter of /CF or Identity (left plain); RC4 before V4
  let cfm = 'V2', strCfm = 'V2';
  if (V === 4 || V === 5) {
    const cfDict = encryptDict.CF?.type === 'dict' ? encryptDict.CF.value : {};
    const method = name => {
      if (name === 'Identity') return 'Identity';
      const cf = cfDict[name]?.type === 'dict' ? cfDict[name].value : {};
      const m = nameVal(cf.CFM) || (V === 5 ? 'AESV3' : 'V2');
      if (m === 'None') return 'Identity';
      if (m !== 'V2' && m !== 'AESV2' && m !== 'AESV3') throw new UnsupportedEncryptionError(`Purefield: unsupported crypt filter method ${m}`);
      return m;
    };
    cfm = method(nameVal(encryptDict.StmF) || 'StdCF');
    strCfm = method(nameVal(encryptDict.StrF) || 'StdCF');
  }
  const encryptMetadata = encryptDict.EncryptMetadata !== false && encryptDict.EncryptMetadata?.value !== false;

  // only embedded files encrypted (AuthEvent EFOpen): the document is plain
  // and opens without a password, as in Reader (pdf.js's auth-event-ef-open)
  if (V >= 4 && nameVal(encryptDict.StmF) === 'Identity' && (nameVal(encryptDict.StrF) ?? 'Identity') === 'Identity') return null;

  if (R >= 5) {
    const fileKey = await deriveFileKeyV5(encryptDict, password);
    if (!fileKey) throw new PasswordError(password ? 'Purefield: wrong password' : 'Purefield: the PDF needs a password (options.password)');
    return new PdfDecryptor(fileKey, cfm, strCfm, encryptMetadata);
  }
  // revisions 2–4: the password (empty when none is given) as the user
  // password, then as the owner's; a key /U does not confirm would only
  // decrypt to garbage
  const pw = new Uint8Array([...password].map(c => c.charCodeAt(0) & 0xff));
  let fileKey = await deriveFileKey(encryptDict, fileId, pw);
  if (!fileKey) fileKey = await deriveFileKey(encryptDict, fileId, await userPasswordFromOwner(encryptDict, pw));
  if (!fileKey) throw new PasswordError(password ? 'Purefield: wrong password' : 'Purefield: the PDF needs a password (options.password)');
  return new PdfDecryptor(fileKey, cfm, strCfm, encryptMetadata);
}

/** Thrown when the password does not open the file */
export class PasswordError extends Error {}

/** Thrown for a security handler or cipher Purefield cannot decrypt */
export class UnsupportedEncryptionError extends Error {}

/**
 * Extract the raw bytes of the first /ID array element from a trailer dict.
 */
export function extractFileId(trailer) {
  const idArray = trailer?.ID;
  if (!idArray || idArray.type !== 'array') return new Uint8Array(16); // fallback
  const first = idArray.value[0];
  return stringBytes(first);
}
