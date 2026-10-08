/**
 * Purefield / core / parser.js
 *
 * Parses the raw bytes of a PDF file into a usable object model.
 *
 * A PDF file is structured as:
 *   - A header (%PDF-1.x)
 *   - A sequence of objects (n 0 obj ... endobj)
 *   - A cross-reference table (xref) or xref stream
 *   - A trailer dictionary pointing to the root catalog
 *
 * Objects can be:
 *   - Booleans, numbers, strings, names, arrays, dictionaries
 *   - Streams (a dictionary followed by raw bytes)
 *   - References to other objects (n 0 R)
 *
 * This parser handles:
 *   - Traditional xref tables
 *   - Compressed xref streams (PDF 1.5+)
 *   - FlateDecode (zlib) compressed streams
 *   - Linearized and non-linearized PDFs
 *   - Encrypted PDFs with no user password (reading unencrypted streams)
 */

// ---------------------------------------------------------------------------
// PNG predictor decoding (Predictor 10-15 in PDF = PNG filters)
// PDF xref streams commonly use Predictor 12 = PNG Up filter.
// Each row is prefixed with a filter byte:
//   0 = None, 1 = Sub, 2 = Up, 3 = Average, 4 = Paeth
// ---------------------------------------------------------------------------
function decodePngPredictor(bytes, columns) {
  const rowSize = columns + 1; // +1 for the filter byte
  const numRows = Math.floor(bytes.length / rowSize);
  const out = new Uint8Array(numRows * columns);
  const prev = new Uint8Array(columns); // previous row, starts as zeros

  for (let row = 0; row < numRows; row++) {
    const filterByte = bytes[row * rowSize];
    const inRow = bytes.subarray(row * rowSize + 1, row * rowSize + 1 + columns);
    const outRow = out.subarray(row * columns, row * columns + columns);

    if (filterByte === 0) {
      // None
      outRow.set(inRow);
    } else if (filterByte === 1) {
      // Sub
      for (let i = 0; i < columns; i++) {
        outRow[i] = (inRow[i] + (i >= 1 ? outRow[i - 1] : 0)) & 0xff;
      }
    } else if (filterByte === 2) {
      // Up (most common in xref streams)
      for (let i = 0; i < columns; i++) {
        outRow[i] = (inRow[i] + prev[i]) & 0xff;
      }
    } else if (filterByte === 3) {
      // Average
      for (let i = 0; i < columns; i++) {
        const a = i >= 1 ? outRow[i - 1] : 0;
        const b = prev[i];
        outRow[i] = (inRow[i] + Math.floor((a + b) / 2)) & 0xff;
      }
    } else if (filterByte === 4) {
      // Paeth
      for (let i = 0; i < columns; i++) {
        const a = i >= 1 ? outRow[i - 1] : 0;
        const b = prev[i];
        const c = i >= 1 ? prev[i - 1] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        outRow[i] = (inRow[i] + pr) & 0xff;
      }
    }

    prev.set(outRow);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Inflate (decompress) a FlateDecode stream using the browser's
// DecompressionStream API (available in all modern browsers).
//
// PDF FlateDecode streams can be either:
//   - zlib-wrapped deflate: starts with 0x78 (CMF byte), most common
//   - raw deflate: no header, less common
//
// DecompressionStream('deflate') handles zlib-wrapped streams.
// DecompressionStream('deflate-raw') handles raw deflate streams.
// We detect which one by looking at the first byte.
// ---------------------------------------------------------------------------
async function inflate(bytes) {
  // 0x78 = zlib CMF byte indicating deflate with zlib wrapper
  const hasZlibHeader = bytes[0] === 0x78;
  const format = hasZlibHeader ? 'deflate' : 'deflate-raw';

  async function tryInflate(fmt) {
    const ds = new DecompressionStream(fmt);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    // Write and close must be fire-and-forget — errors surface on the reader
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});

    const chunks = [];
    // Collect all chunks; any decompression error throws here on read().
    // Bytes after the end of the deflate data (a stray EOL counted in
    // /Length, a truncated checksum) also raise an error: keep what was
    // decoded before it.
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch (e) {
      if (chunks.length === 0) throw e;
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  // Try the most likely format first, fall back to the other; a stream
  // that is not deflate data at all comes back empty rather than throwing
  try {
    return await tryInflate(format);
  } catch (e) {
    const fallback = hasZlibHeader ? 'deflate-raw' : 'deflate';
    try {
      return await tryInflate(fallback);
    } catch {
      return new Uint8Array(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Low-level byte reader
// ---------------------------------------------------------------------------
class ByteReader {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.pos = 0;
  }

  get length() { return this.bytes.length; }
  get eof() { return this.pos >= this.bytes.length; }

  peek() { return this.bytes[this.pos]; }
  read() { return this.bytes[this.pos++]; }

  // Read a single byte as a character
  readChar() { return String.fromCharCode(this.read()); }

  // Read n raw bytes
  readBytes(n) {
    const slice = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  // Skip whitespace (space, tab, CR, LF, FF, null)
  skipWhitespace() {
    while (!this.eof && isWhitespace(this.bytes[this.pos])) this.pos++;
  }

  // Skip whitespace and PDF comments (% to end of line)
  skipWS() {
    while (!this.eof) {
      this.skipWhitespace();
      if (!this.eof && this.bytes[this.pos] === 0x25) { // '%'
        while (!this.eof && this.bytes[this.pos] !== 0x0A && this.bytes[this.pos] !== 0x0D) {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  // Read until a delimiter or whitespace
  readToken() {
    this.skipWS();
    let token = '';
    while (!this.eof && !isWhitespace(this.bytes[this.pos]) && !isDelimiter(this.bytes[this.pos])) {
      token += String.fromCharCode(this.read());
    }
    return token;
  }

  // Peek ahead at the next n bytes as a string (without advancing)
  peekString(n) {
    return String.fromCharCode(...this.bytes.slice(this.pos, this.pos + n));
  }

  // Search backward from a position for a string, return its offset or -1
  searchBackward(str, fromPos = this.bytes.length) {
    const needle = str.split('').map(c => c.charCodeAt(0));
    for (let i = fromPos - needle.length; i >= 0; i--) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (this.bytes[i + j] !== needle[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  // Find a string forward from current position, return offset or -1
  searchForward(str, fromPos = this.pos) {
    const needle = str.split('').map(c => c.charCodeAt(0));
    for (let i = fromPos; i <= this.bytes.length - needle.length; i++) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (this.bytes[i + j] !== needle[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  // Read a slice of bytes as a latin1 string
  readStringAt(offset, length) {
    return String.fromCharCode(...this.bytes.slice(offset, offset + length));
  }
}

function isWhitespace(b) {
  return b === 0x00 || b === 0x09 || b === 0x0A || b === 0x0C || b === 0x0D || b === 0x20;
}

function isDelimiter(b) {
  return b === 0x28 || b === 0x29 || // ( )
         b === 0x3C || b === 0x3E || // < >
         b === 0x5B || b === 0x5D || // [ ]
         b === 0x7B || b === 0x7D || // { }
         b === 0x2F ||               // /
         b === 0x25;                 // %
}

// ---------------------------------------------------------------------------
// PDF Object parser
// ---------------------------------------------------------------------------
class PdfParser {
  constructor(reader) {
    this.r = reader;
    // Map of "objNum_0" -> { dict, streamOffset, streamLength }
    this.objects = new Map();
    this.xref = new Map();     // objNum -> byte offset
    this.trailer = null;
  }

  // Parse a PDF value starting at current position
  parseValue() {
    this.r.skipWS();
    if (this.r.eof) return null;

    const b = this.r.peek();
    const ch = String.fromCharCode(b);

    // Dictionary or hex string
    if (ch === '<') {
      this.r.pos++;
      if (this.r.peek() === 0x3C) { // <<
        this.r.pos++;
        return this.parseDict();
      } else {
        return this.parseHexString();
      }
    }

    // Array
    if (ch === '[') {
      this.r.pos++;
      return this.parseArray();
    }

    // Literal string
    if (ch === '(') {
      this.r.pos++;
      return this.parseLiteralString();
    }

    // Name
    if (ch === '/') {
      this.r.pos++;
      return { type: 'name', value: this.parseName() };
    }

    // Number, reference, boolean, null, keyword
    const token = this.r.readToken();
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;

    // Could be a number (a sign, digits and a point, as in +20, .5, 5.,
    // -.002) or the start of an indirect reference (n g R)
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      const num = parseFloat(token);
      if (!/^\d+$/.test(token)) return num;
      // Peek ahead for indirect reference pattern: "n g R"
      const savedPos = this.r.pos;
      this.r.skipWS();
      const next = this.r.readToken();
      if (/^\d+$/.test(next)) {
        this.r.skipWS();
        const rToken = this.r.readToken();
        if (rToken === 'R') {
          return { type: 'ref', num: parseInt(token), gen: parseInt(next) };
        }
      }
      this.r.pos = savedPos;
      return num;
    }

    return token; // keyword or unknown
  }

  parseDict() {
    const dict = {};
    while (true) {
      this.r.skipWS();
      if (this.r.eof) break;
      if (this.r.peek() === 0x3E) { // >
        this.r.pos++;
        if (this.r.peek() === 0x3E) { this.r.pos++; break; }
      }
      if (this.r.peek() !== 0x2F) break; // not a name — malformed
      this.r.pos++; // skip /
      const key = this.parseName();
      const value = this.parseValue();
      dict[key] = value;
    }
    return { type: 'dict', value: dict };
  }

  parseName() {
    let name = '';
    while (!this.r.eof && !isWhitespace(this.r.peek()) && !isDelimiter(this.r.peek())) {
      const b = this.r.read();
      if (b === 0x23) { // # — hex escape
        const hex = String.fromCharCode(this.r.read(), this.r.read());
        name += String.fromCharCode(parseInt(hex, 16));
      } else {
        name += String.fromCharCode(b);
      }
    }
    return name;
  }

  parseArray() {
    const arr = [];
    while (true) {
      this.r.skipWS();
      if (this.r.eof) break;
      if (this.r.peek() === 0x5D) { this.r.pos++; break; } // ]
      arr.push(this.parseValue());
    }
    return { type: 'array', value: arr };
  }

  parseLiteralString() {
    let str = '';
    let depth = 1;
    while (!this.r.eof && depth > 0) {
      const b = this.r.read();
      if (b === 0x5C) { // backslash escape
        const next = this.r.read();
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (next >= 0x30 && next <= 0x37) {
          // \ddd octal, up to three digits
          let oct = String.fromCharCode(next);
          while (oct.length < 3 && this.r.peek() >= 0x30 && this.r.peek() <= 0x37) oct += String.fromCharCode(this.r.read());
          str += String.fromCharCode(parseInt(oct, 8) & 0xFF);
        } else if (next === 0x0D || next === 0x0A) {
          // backslash-EOL is a line continuation
          if (next === 0x0D && this.r.peek() === 0x0A) this.r.pos++;
        } else {
          str += escapes[String.fromCharCode(next)] || String.fromCharCode(next);
        }
      } else if (b === 0x28) { depth++; str += '('; }
        else if (b === 0x29) { depth--; if (depth > 0) str += ')'; }
        else { str += String.fromCharCode(b); }
    }
    return { type: 'string', value: str };
  }

  parseHexString() {
    let hex = '';
    while (!this.r.eof && this.r.peek() !== 0x3E) {
      const b = this.r.read();
      if (!isWhitespace(b)) hex += String.fromCharCode(b);
    }
    if (!this.r.eof) this.r.pos++; // skip >
    if (hex.length % 2 !== 0) hex += '0';
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return { type: 'string', value: str };
  }

  // ---------------------------------------------------------------------------
  // xref parsing
  // ---------------------------------------------------------------------------

  // Find and parse the xref table/stream, populate this.xref and this.trailer
  async parseXref() {
    // Find startxref near end of file
    const startxrefPos = this.r.searchBackward('startxref');
    if (startxrefPos === -1) throw new Error('No startxref found');

    this.r.pos = startxrefPos + 9; // skip 'startxref'
    this.r.skipWS();
    const xrefOffset = parseInt(this.r.readToken());

    try {
      await this._parseXrefAt(xrefOffset);
      if (!this.trailer?.Root) throw new Error('No /Root in trailer');
    } catch (e) {
      // Damaged or mis-pointed cross-reference: rebuild it by scanning
      this._rebuildXref();
      if (!this.trailer?.Root) throw new Error(`Cannot read PDF structure (${e.message})`);
    }
  }

  async _parseXrefAt(offset) {
    this._seenXref ??= new Set();
    if (!Number.isFinite(offset) || this._seenXref.has(offset)) return;
    this._seenXref.add(offset);
    this.r.pos = offset;
    this.r.skipWS();

    // Is this a traditional xref table or a compressed xref stream?
    if (this.r.peekString(4) === 'xref') {
      await this._parseTraditionalXref();
    } else {
      // It's a compressed xref stream
      await this._parseXrefStream();
    }
  }

  // Scan the whole file for "n g obj" headers and the last trailer / XRef
  // stream dictionary. Later definitions of an object win.
  _rebuildXref() {
    const bytes = this.r.bytes;
    const text = new TextDecoder('latin1').decode(bytes);
    this.xref = new Map();
    const objRe = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = objRe.exec(text))) {
      const start = m.index + (m[0].length - m[0].trimStart().length);
      this.xref.set(parseInt(m[1]), start);
    }
    let trailer = null;
    const tIdx = text.lastIndexOf('trailer');
    if (tIdx !== -1) {
      this.r.pos = tIdx + 7;
      this.r.skipWS();
      if (this.r.peekString(2) === '<<') {
        this.r.pos += 2;
        trailer = this.parseDict().value;
      }
    }
    if (!trailer?.Root) {
      // xref-stream files: take /Root from the last dictionary that has one
      const rootRe = /\/Root\s+(\d+)\s+(\d+)\s+R/g;
      let last = null;
      while ((m = rootRe.exec(text))) last = m;
      if (last) trailer = { ...(trailer ?? {}), Root: { type: 'ref', num: parseInt(last[1]), gen: parseInt(last[2]) } };
      const encRe = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/g;
      let enc = null;
      while ((m = encRe.exec(text))) enc = m;
      if (enc && !trailer?.Encrypt) trailer.Encrypt = { type: 'ref', num: parseInt(enc[1]), gen: parseInt(enc[2]) };
      const idRe = /\/ID\s*\[\s*<([0-9a-fA-F]+)>/;
      const id = idRe.exec(text);
      if (id && !trailer?.ID) trailer.ID = { type: 'array', value: [hexString(id[1]), hexString(id[1])] };
    }
    // objects inside object streams are found through their ObjStm headers,
    // on first miss (decryption is only set up after this)
    this._indexObjectStreams = true;
    this.trailer = trailer;
  }

  async _indexObjStms() {
    this._indexObjectStreams = false;
    for (const [num, entry] of [...this.xref.entries()]) {
      if (typeof entry !== 'number') continue;
      let obj;
      try { obj = await this.readObjectAt(entry); } catch { continue; }
      if (obj?.dict?.Type?.value !== 'ObjStm' || !obj.streamBytes) continue;
      const n = resolveNumber(obj.dict.N);
      const first = resolveNumber(obj.dict.First);
      const head = new TextDecoder().decode(obj.streamBytes.slice(0, first)).trim().split(/\s+/);
      for (let i = 0; i < n; i++) {
        const id = parseInt(head[i * 2]);
        if (Number.isFinite(id) && !this.xref.has(id)) this.xref.set(id, { compressed: true, streamObj: num, index: i });
      }
    }
  }

  async _parseTraditionalXref() {
    this.r.pos += 4; // skip 'xref'
    this.r.skipWS();

    while (!this.r.eof) {
      const token = this.r.readToken();
      if (token === 'trailer') break;

      const firstObj = parseInt(token);
      this.r.skipWS();
      const count = parseInt(this.r.readToken());
      this.r.skipWS();

      for (let i = 0; i < count; i++) {
        const offsetStr = this.r.readToken();
        this.r.skipWS();
        const genStr = this.r.readToken();
        this.r.skipWS();
        const status = this.r.readToken();
        this.r.skipWS();

        const objNum = firstObj + i;
        // newest section is read first: never let an older one override it
        if (!this.xref.has(objNum)) this.xref.set(objNum, status === 'n' ? parseInt(offsetStr) : null);
      }
    }

    // Parse trailer dict
    this.r.skipWS();
    if (this.r.peek() === 0x3C) {
      this.r.pos += 2; // <<
      const dict = this.parseDict();
      if (!this.trailer) this.trailer = dict.value;

      // Hybrid files: the xref stream named by /XRefStm comes before /Prev
      if (typeof dict.value.XRefStm === 'number') await this._parseXrefAt(dict.value.XRefStm);
      // Follow /Prev for incremental updates (table or stream)
      if (typeof dict.value.Prev === 'number') await this._parseXrefAt(dict.value.Prev);
    }
  }

  // Skip spaces and tabs only — NOT newlines.
  // Used before the 'stream' keyword where the PDF spec only allows
  // horizontal whitespace, not line breaks.
  _skipSpaces() {
    while (!this.r.eof) {
      const b = this.r.peek();
      if (b === 0x20 || b === 0x09) { // space or tab
        this.r.pos++;
      } else {
        break;
      }
    }
  }

  async _parseXrefStream() {
    // Parse object header: "n 0 obj"
    const objNum = parseInt(this.r.readToken());
    this.r.skipWS();
    this.r.readToken(); // gen
    this.r.skipWS();
    this.r.readToken(); // 'obj'
    this.r.skipWS();

    // Parse stream dict
    if (this.r.peek() !== 0x3C) throw new Error('Expected dict in xref stream');
    this.r.pos += 2;
    const dictObj = this.parseDict();
    const dict = dictObj.value;

    if (!this.trailer) this.trailer = dict;

    // Read stream bytes ("stream" may sit on the next line)
    this.r.skipWS();
    if (this.r.peekString(6) !== 'stream') throw new Error('Expected stream');
    this.r.pos += 6;
    if (this.r.peek() === 0x0D) this.r.pos++; // CR
    if (this.r.peek() === 0x0A) this.r.pos++; // LF

    const length = resolveNumber(dict.Length);
    let streamBytes = this.r.readBytes(length);

    // Decompress if needed
    const filter = dict.Filter;
    const filterName = filter?.type === 'name' ? filter.value :
                       filter?.type === 'array' ? filter.value[0]?.value : null;
    if (filterName === 'FlateDecode') {
      streamBytes = await inflate(streamBytes);
    }

    // Apply PNG predictor if specified (Predictor >= 10 means PNG filters)
    const decodeParms = dict.DecodeParms;
    const parmsDict = decodeParms?.type === 'dict' ? decodeParms.value : null;
    if (parmsDict) {
      const predictor = resolveNumber(parmsDict.Predictor);
      const columns   = resolveNumber(parmsDict.Columns) || 1;
      if (predictor >= 10) {
        streamBytes = decodePngPredictor(streamBytes, columns);
      }
    }

    // Parse xref stream entries
    const w = dict.W?.value?.map(resolveNumber) || [1, 2, 1];
    const index = dict.Index?.value?.map(resolveNumber) || [0, resolveNumber(dict.Size)];
    const entrySize = w.reduce((a, b) => a + b, 0);

    let bytePos = 0;
    for (let seg = 0; seg < index.length; seg += 2) {
      let objId = index[seg];
      const count = index[seg + 1];

      for (let i = 0; i < count; i++) {
        const fields = w.map(width => {
          let val = 0;
          for (let b = 0; b < width; b++) {
            val = (val << 8) | (streamBytes[bytePos++] || 0);
          }
          return val;
        });

        const type = w[0] === 0 ? 1 : fields[0]; // default type is 1
        // newest section is read first: never let an older one override it
        if (!this.xref.has(objId)) {
          if (type === 1) {
            // Regular object: field[1] = offset
            this.xref.set(objId, fields[1]);
          } else if (type === 2) {
            // Compressed object: field[1] = stream obj num, field[2] = index within
            this.xref.set(objId, { compressed: true, streamObj: fields[1], index: fields[2] });
          } else {
            this.xref.set(objId, null); // free
          }
        }

        objId++;
      }
    }

    // Follow /Prev
    if (dict.Prev) {
      const prevOffset = resolveNumber(dict.Prev);
      if (prevOffset) {
        const savedPos = this.r.pos;
        await this._parseXrefAt(prevOffset);
        this.r.pos = savedPos;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Object reading
  // ---------------------------------------------------------------------------

  // Read the object at the given byte offset, return { dict, streamBytes }
  async readObjectAt(offset) {
    this.r.pos = offset;
    this.r.skipWS();

    const objNum = parseInt(this.r.readToken());
    this.r.skipWS();
    const genNum = parseInt(this.r.readToken()) || 0; // object keys use it
    this.r.skipWS();
    const keyword = this.r.readToken(); // 'obj'
    if (keyword !== 'obj') throw new Error(`Expected 'obj' at offset ${offset}, got '${keyword}'`);
    this.r.skipWS();

    const value = this.parseValue();

    // Check for stream — must skip only whitespace that isn't a newline,
    // then consume exactly one EOL sequence (CR, LF, or CRLF).
    // PDF spec says only spaces/tabs are allowed between >> and stream,
    // and exactly one EOL follows the stream keyword.
    // The stream keyword may follow the dictionary on the same line or the
    // next one ("<<…>>\nstream" is the common form)
    const afterValue = this.r.pos;
    this.r.skipWS();
    if (this.r.peekString(6) !== 'stream') this.r.pos = afterValue;
    if (this.r.peekString(6) === 'stream') {
      this.r.pos += 6;
      // Consume exactly one EOL: CRLF counts as one
      if (this.r.peek() === 0x0D) this.r.pos++; // CR
      if (this.r.peek() === 0x0A) this.r.pos++; // LF (or LF after CR)

      const dict = value?.type === 'dict' ? value.value : {};
      const length = await this._resolveLength(dict.Length);
      const start = this.r.pos;
      const bytes = this.r.bytes;
      // "endstream" at p, after an optional EOL
      const endsAt = p => {
        if (bytes[p] === 0x0D) p++;
        if (bytes[p] === 0x0A) p++;
        return String.fromCharCode(...bytes.subarray(p, p + 9)) === 'endstream';
      };
      // Some PDF generators write Length without counting the final \n before
      // endstream (tolerated: one byte more); when Length is missing or
      // wrong otherwise, the data runs up to the next "endstream"
      let end = start + length;
      if (!endsAt(end)) {
        if (endsAt(end + 1)) end++;
        else {
          const at = findBytes(bytes, 'endstream', start);
          if (at >= 0) {
            end = at;
            if (bytes[end - 1] === 0x0A) end--;
            if (bytes[end - 1] === 0x0D) end--;
          }
        }
      }
      let rawBytes = bytes.slice(start, Math.min(end, bytes.length));
      this.r.pos = start + rawBytes.length;

      // Decrypt before decompressing if PDF is encrypted
      // (Encrypt dict itself and XRef streams are never encrypted)
      const isXref    = dict.Type?.value === 'XRef';
      // a metadata stream left plain (/EncryptMetadata false), or a stream
      // whose own /Crypt filter is Identity, is not decrypted
      const plain = (dict.Type?.value === 'Metadata' && this.decryptor?.encryptMetadata === false) || identityCrypt(dict);
      const needsCrypt = this.decryptor && !isXref && !plain;
      if (needsCrypt) {
        rawBytes = await this.decryptor.decryptStream(objNum, genNum, rawBytes);
      }

      const { data: streamBytes, decoded: decodedFilters } = await this._decodeStream(dict, rawBytes);

      // Decrypt strings in the dict
      if (this.decryptor && !isXref && objNum !== this.encryptObjNum) {
        await this._decryptStringsInValue({ type: 'dict', value: dict }, objNum, genNum);
      }

      return { objNum, dict, streamBytes, decodedFilters };
    }

    // Decrypt strings in non-stream objects
    // Never decrypt strings in the Encrypt dict itself (O, U are raw hash bytes)
    if (this.decryptor && objNum !== this.encryptObjNum) {
      await this._decryptStringsInValue(value, objNum, genNum);
    }

    return { objNum, value };
  }

  // Recursively decrypt all string values within a parsed PDF value tree.
  // Strings in the Encrypt dict itself are never encrypted.
  async _decryptStringsInValue(val, objNum, genNum = 0) {
    if (!val) return;

    if (val.type === 'string') {
      // Decrypt in place
      const bytes = await this.decryptor.decryptString(objNum, genNum, val);
      // Convert decrypted bytes back to a JS string (latin1)
      val.value = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
      val._decrypted = true;
      return;
    }

    if (val.type === 'dict') {
      for (const key of Object.keys(val.value)) {
        await this._decryptStringsInValue(val.value[key], objNum, genNum);
      }
      return;
    }

    if (val.type === 'array') {
      for (const item of val.value) {
        await this._decryptStringsInValue(item, objNum, genNum);
      }
      return;
    }
  }

  async _resolveLength(lengthVal) {
    if (typeof lengthVal === 'number') return lengthVal;
    if (lengthVal?.type === 'ref') {
      // reading the length object moves the reader: come back afterwards
      const saved = this.r.pos;
      const obj = await this.getObject(lengthVal.num);
      this.r.pos = saved;
      const v = obj?.value;
      return typeof v === 'number' ? v : 0;
    }
    return 0;
  }

  // Undo the stream's filters in order, as far as they are understood:
  // ASCII85, ASCIIHex, RunLength, LZW and Flate (and Crypt, already done).
  // Decoding stops at the first other filter (DCT, JPX, CCITT, JBIG2: image
  // data left as it is) and after a Flate or LZW filter with a predictor
  // (its DecodeParms still describe the bytes). Returns the bytes and how
  // many leading filters were undone (decodedFilters).
  async _decodeStream(dict, bytes) {
    const filters = filterList(dict.Filter);
    const parms = filterList(dict.DecodeParms);
    let data = bytes, n = 0;
    for (; n < filters.length; n++) {
      const f = FILTER_ALIASES[filters[n]] ?? filters[n];
      const p = parms[n]?.type === 'dict' ? parms[n].value : null;
      if (f === 'FlateDecode') data = await inflate(data);
      else if (f === 'LZWDecode') data = lzwDecode(data, p?.EarlyChange === undefined || resolveNumber(p.EarlyChange) !== 0);
      else if (f === 'ASCII85Decode') data = ascii85Decode(data);
      else if (f === 'ASCIIHexDecode') data = asciiHexDecode(data);
      else if (f === 'RunLengthDecode') data = runLengthDecode(data);
      else if (f !== 'Crypt') break;
      if ((f === 'FlateDecode' || f === 'LZWDecode') && resolveNumber(p?.Predictor) > 1) { n++; break; }
    }
    return { data, decoded: n };
  }

  // Get an object by number, using the xref table
  async getObject(num) {
    let entry = this.xref.get(num);
    if (entry === undefined && this._indexObjectStreams) {
      await this._indexObjStms();
      entry = this.xref.get(num);
    }
    if (entry === undefined || entry === null) return null;

    if (typeof entry === 'number') {
      return this.readObjectAt(entry);
    }

    if (entry?.compressed) {
      return this._getCompressedObject(entry.streamObj, entry.index);
    }

    return null;
  }

  async _getCompressedObject(streamObjNum, index) {
    const streamObj = await this.getObject(streamObjNum);
    if (!streamObj?.streamBytes) return null;

    // Object stream: contains N objects packed together
    const dict = streamObj.dict;
    const n = resolveNumber(dict.N);
    const first = resolveNumber(dict.First);

    // Parse the index (pairs of objNum, offset)
    const text = new TextDecoder().decode(streamObj.streamBytes.slice(0, first));
    const tokens = text.trim().split(/\s+/);
    const offsets = [];
    for (let i = 0; i < n * 2; i += 2) {
      offsets.push({ num: parseInt(tokens[i]), offset: parseInt(tokens[i + 1]) });
    }

    const entry = offsets[index];
    if (!entry) return null;

    const objBytes = streamObj.streamBytes.slice(first + entry.offset);
    const r = new ByteReader(objBytes);
    const parser = new PdfParser(r);
    const value = parser.parseValue();
    return { objNum: entry.num, value };
  }

  // Resolve a reference chain to a concrete value
  async resolve(val) {
    if (val?.type === 'ref') {
      const obj = await this.getObject(val.num);
      return obj?.value ?? obj;
    }
    return val;
  }
}

function hexString(hex) {
  let str = '';
  for (let i = 0; i + 1 < hex.length; i += 2) str += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return { type: 'string', value: str };
}

// the first index of an ASCII string in bytes at or after from, or -1
function findBytes(bytes, str, from) {
  const first = str.charCodeAt(0);
  outer: for (let i = bytes.indexOf(first, from); i >= 0; i = bytes.indexOf(first, i + 1)) {
    for (let k = 1; k < str.length; k++) if (bytes[i + k] !== str.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

// /Filter or /DecodeParms as a list (a single entry, an array, or none)
function filterList(v) {
  if (!v) return [];
  const items = v.type === 'array' ? v.value : [v];
  return items.map(x => (x?.type === 'name' ? x.value : x));
}

// the abbreviations inline images use, sometimes found on streams too
const FILTER_ALIASES = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode' };

function ascii85Decode(bytes) {
  const out = [];
  let tuple = 0, count = 0;
  let i = 0;
  // an optional "<~" prefix
  while (i < bytes.length && isWhitespace(bytes[i])) i++;
  if (bytes[i] === 0x3C && bytes[i + 1] === 0x7E) i += 2;
  for (; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x7E) break; // "~>"
    if (isWhitespace(c)) continue;
    if (c === 0x7A && count === 0) { out.push(0, 0, 0, 0); continue; } // "z"
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0; count = 0;
    }
  }
  if (count > 1) {
    // a final partial group: pad with "u", keep count - 1 bytes
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    const last = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...last.slice(0, count - 1));
  }
  return new Uint8Array(out);
}

function asciiHexDecode(bytes) {
  const out = [];
  let hi = -1;
  for (const c of bytes) {
    if (c === 0x3E) break; // ">"
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16); // an odd final digit is followed by 0
  return new Uint8Array(out);
}

function runLengthDecode(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    const len = bytes[i++];
    if (len === 128) break;
    if (len < 128) { for (let k = 0; k <= len && i < bytes.length; k++) out.push(bytes[i++]); }
    else { const b = bytes[i++]; for (let k = 0; k < 257 - len; k++) out.push(b); }
  }
  return new Uint8Array(out);
}

// PDF LZW: MSB-first codes of 9-12 bits, 256 clear, 257 end of data;
// with EarlyChange (the default) the code width grows one code early
function lzwDecode(bytes, earlyChange) {
  const out = [];
  let dict = [], width = 9, prev = null;
  const reset = () => { dict = []; for (let k = 0; k < 256; k++) dict.push([k]); dict.push(null, null); width = 9; prev = null; };
  reset();
  let buf = 0, bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i]; bits += 8;
    while (bits >= width) {
      const code = (buf >>> (bits - width)) & ((1 << width) - 1);
      bits -= width; buf &= (1 << bits) - 1;
      if (code === 256) { reset(); continue; }
      if (code === 257) return new Uint8Array(out);
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev && code === dict.length) entry = [...prev, prev[0]];
      else return new Uint8Array(out); // damaged data: keep what was decoded
      out.push(...entry);
      if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
      prev = entry;
      const next = dict.length + (earlyChange ? 1 : 0);
      if (next >= (1 << width) && width < 12) width++;
    }
  }
  return new Uint8Array(out);
}

// Helper: get a number from various forms it might appear in
// A stream whose /Filter starts with /Crypt and names no crypt filter, or
// /Identity, in its /DecodeParms: stored without the document's encryption
function identityCrypt(dict) {
  const f = dict.Filter;
  const first = f?.type === 'array' ? f.value[0] : f;
  if ((first?.value ?? first) !== 'Crypt') return false;
  const p = dict.DecodeParms;
  const parms = p?.type === 'array' ? p.value[0] : p;
  const name = parms?.type === 'dict' ? parms.value.Name?.value : undefined;
  return name === undefined || name === 'Identity';
}

function resolveNumber(val) {
  if (typeof val === 'number') return val;
  if (val?.type === 'ref') return 0; // can't resolve synchronously
  return parseInt(val) || 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

import { buildDecryptor, extractFileId } from './crypto.js';

/**
 * Parse a PDF from an ArrayBuffer (e.g. from FileReader or fetch).
 * Returns a PdfDocument object you can use to read objects.
 */
export async function parsePdf(arrayBuffer, { password = '' } = {}) {
  const bytes = new Uint8Array(arrayBuffer);
  // The header may be preceded by junk, but must appear in the first 1KB
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw new Error('Not a PDF file (no %PDF- header)');
  const reader = new ByteReader(bytes);
  const parser = new PdfParser(reader);

  await parser.parseXref();

  const doc = new PdfDocument(parser);

  // Set up decryption if the PDF is encrypted
  await doc._initDecryption(password);

  return doc;
}

export class PdfDocument {
  constructor(parser) {
    this._parser    = parser;
    this.trailer    = parser.trailer;
    this._decryptor = null;
  }

  async _initDecryption(password = '') {
    const encryptRef = this.trailer?.Encrypt;
    if (!encryptRef) return; // not encrypted

    // The Encrypt dict itself is never encrypted, so read it raw
    const encryptObj = await this._parser.getObject(
      encryptRef?.num ?? encryptRef
    );
    const encryptDict = encryptObj?.value?.value ?? encryptObj?.value ?? {};

    const fileId = extractFileId(this.trailer);
    this._decryptor = await buildDecryptor(encryptDict, fileId, password);

    if (this._decryptor) {
      this._parser.decryptor = this._decryptor;
      // Record the encrypt dict object number so we never decrypt its strings
      this._parser.encryptObjNum = encryptRef?.num ?? null;
    }
  }

  /** Get the root catalog object */
  async catalog() {
    const rootRef = this.trailer?.Root;
    if (!rootRef) throw new Error('No Root in trailer');
    return this._parser.getObject(rootRef.num);
  }

  /** Get a specific object by number */
  async getObject(num) {
    return this._parser.getObject(num);
  }

  /** Resolve a reference to its value */
  async resolve(val) {
    return this._parser.resolve(val);
  }

  /** True if this PDF is encrypted */
  get isEncrypted() {
    return this._decryptor !== null;
  }

  /** Get the raw bytes of the original file */
  get rawBytes() {
    return this._parser.r.bytes;
  }
}
