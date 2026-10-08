/**
 * Purefield / core / outline.js
 *
 * TrueType outlines read and written whole, for fonts built glyph by glyph
 * (core/substitute.js): a glyph's contours (composite glyphs flattened
 * through their transforms), and a font program assembled from transformed
 * contours. The new program has no hinting (no instructions, no fpgm, prep
 * or cvt): its glyphs are scaled copies and the old hints would not fit.
 * It is named PurefieldSubstitute, not after the font its glyphs come from.
 *
 *   glyphContours(ttf, gid) → [[{ x, y, on }]]
 *   buildTtf(base, glyphs, { codes }) → TrueType bytes
 *     glyphs: [{ contours, advance }] in base font units, glyph 0 first
 *     codes: Map(code → glyph) for a simple font's (1,0) and (3,0) cmaps
 */

// The 258 standard Macintosh glyph names a post table (format 2) indexes
export const MAC_NAMES = ('.notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle '
  + 'parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon '
  + 'semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash '
  + 'bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright '
  + 'asciitilde Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring '
  + 'ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex '
  + 'odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls '
  + 'registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu '
  + 'partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot '
  + 'radical florin approxequal Delta guillemotleft guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe '
  + 'endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency '
  + 'guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex '
  + 'Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute '
  + 'Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash '
  + 'lslash Scaron scaron Zcaron zcaron brokenbar Eth eth Yacute yacute Thorn thorn minus multiply onesuperior twosuperior '
  + 'threesuperior onehalf onequarter threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron '
  + 'ccaron dcroat').split(' ');

/** Glyph names of a font's post table (format 2), name → glyph id */
export function postNames(ttf) {
  const t = ttf.tables.post;
  const out = new Map();
  if (!t) return out;
  const dv = ttf.dv;
  if (dv.getUint32(t.offset) !== 0x00020000) return out;
  const n = dv.getUint16(t.offset + 32);
  const index = [];
  for (let g = 0; g < n; g++) index.push(dv.getUint16(t.offset + 34 + 2 * g));
  const extra = [];
  let p = t.offset + 34 + 2 * n;
  const end = t.offset + t.length;
  while (p < end) {
    const len = ttf.bytes[p];
    extra.push(String.fromCharCode(...ttf.bytes.subarray(p + 1, p + 1 + len)));
    p += 1 + len;
  }
  index.forEach((i, g) => {
    const name = i < 258 ? MAC_NAMES[i] : extra[i - 258];
    if (name && !out.has(name)) out.set(name, g);
  });
  return out;
}

/**
 * A glyph's contours in font units, composite glyphs flattened.
 * @returns {{ x: number, y: number, on: boolean }[][]}
 */
export function glyphContours(ttf, gid, depth = 0) {
  const data = ttf.glyphData(gid);
  if (!data || data.length < 10 || depth > 8) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = dv.getInt16(0);
  if (n >= 0) return simpleContours(data, dv, n);
  const out = [];
  let p = 10;
  for (;;) {
    const flags = dv.getUint16(p), comp = dv.getUint16(p + 2);
    p += 4;
    let e, f;
    if (flags & 1) { e = flags & 2 ? dv.getInt16(p) : dv.getUint16(p); f = flags & 2 ? dv.getInt16(p + 2) : dv.getUint16(p + 2); p += 4; }
    else { e = flags & 2 ? dv.getInt8(p) : dv.getUint8(p); f = flags & 2 ? dv.getInt8(p + 1) : dv.getUint8(p + 1); p += 2; }
    if (!(flags & 2)) { e = 0; f = 0; } // point matching: not supported, placed at the origin
    let a = 1, b = 0, c = 0, d = 1;
    const f2 = o => dv.getInt16(o) / 16384;
    if (flags & 8) { a = d = f2(p); p += 2; }
    else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
    else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
    for (const contour of glyphContours(ttf, comp, depth + 1)) {
      out.push(contour.map(pt => ({ x: a * pt.x + c * pt.y + e, y: b * pt.x + d * pt.y + f, on: pt.on })));
    }
    if (!(flags & 0x20)) break;
  }
  return out;
}

function simpleContours(data, dv, n) {
  const ends = [];
  for (let i = 0; i < n; i++) ends.push(dv.getUint16(10 + 2 * i));
  const count = n ? ends[n - 1] + 1 : 0;
  let p = 10 + 2 * n;
  p += 2 + dv.getUint16(p);
  const flags = [];
  while (flags.length < count) {
    const fl = data[p++];
    flags.push(fl);
    if (fl & 8) { let r = data[p++]; while (r-- > 0 && flags.length < count) flags.push(fl); }
  }
  const coords = (short, same) => {
    const out = [];
    let v = 0;
    for (const fl of flags) {
      if (fl & short) { const d = data[p++]; v += fl & same ? d : -d; }
      else if (!(fl & same)) { v += dv.getInt16(p); p += 2; }
      out.push(v);
    }
    return out;
  };
  const xs = coords(2, 16), ys = coords(4, 32);
  const contours = [];
  let start = 0;
  for (const end of ends) {
    const c = [];
    for (let i = start; i <= end; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
    contours.push(c);
    start = end + 1;
  }
  return contours;
}

/** Contours scaled horizontally by sx and moved right by dx */
export function scaleContours(contours, sx, dx = 0) {
  return contours.map(c => c.map(p => ({ x: p.x * sx + dx, y: p.y, on: p.on })));
}

/**
 * A TrueType program of the given glyphs (glyph 0 is .notdef), with the
 * base font's metrics and names.
 * @param {object} base - a parsed font (core/ttf.js)
 * @param {{ contours: object[][], advance: number }[]} glyphs
 * @param {{ codes?: Map<number, number> }} [opts]
 */
export function buildTtf(base, glyphs, { codes = new Map() } = {}) {
  const n = glyphs.length;
  const glyfParts = [];
  const loca = new Uint8Array((n + 1) * 4);
  const ldv = new DataView(loca.buffer);
  const hmtx = new Uint8Array(n * 4);
  const hdv = new DataView(hmtx.buffer);
  let pos = 0, maxPoints = 0, maxContours = 0, advMax = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  glyphs.forEach((g, i) => {
    ldv.setUint32(i * 4, pos);
    const adv = Math.max(0, Math.round(g.advance));
    advMax = Math.max(advMax, adv);
    const contours = g.contours.filter(c => c.length);
    let xMin = 0;
    if (contours.length) {
      const enc = encodeGlyph(contours);
      xMin = enc.bbox[0];
      [bx0, by0] = [Math.min(bx0, enc.bbox[0]), Math.min(by0, enc.bbox[1])];
      [bx1, by1] = [Math.max(bx1, enc.bbox[2]), Math.max(by1, enc.bbox[3])];
      maxPoints = Math.max(maxPoints, enc.points);
      maxContours = Math.max(maxContours, contours.length);
      glyfParts.push(enc.bytes);
      pos += enc.bytes.length;
    }
    hdv.setUint16(i * 4, Math.min(0xFFFF, adv));
    hdv.setInt16(i * 4 + 2, xMin);
  });
  ldv.setUint32(n * 4, pos);
  if (!Number.isFinite(bx0)) [bx0, by0, bx1, by1] = [0, 0, 0, 0];

  const copy = tag => {
    const t = base.tables[tag];
    return t ? base.bytes.slice(t.offset, t.offset + t.length) : null;
  };
  const head = copy('head');
  const hd = new DataView(head.buffer);
  hd.setUint32(8, 0);
  hd.setInt16(36, bx0); hd.setInt16(38, by0); hd.setInt16(40, bx1); hd.setInt16(42, by1);
  hd.setInt16(50, 1); // long loca
  const hhea = copy('hhea');
  const hh = new DataView(hhea.buffer);
  hh.setUint16(10, Math.min(0xFFFF, advMax));
  hh.setUint16(34, n);
  const maxp = new Uint8Array(32);
  const mp = new DataView(maxp.buffer);
  mp.setUint32(0, 0x00010000);
  mp.setUint16(4, n);
  mp.setUint16(6, maxPoints);
  mp.setUint16(8, maxContours);
  mp.setUint16(14, 1); // maxZones
  const post = new Uint8Array(32);
  const pd = new DataView(post.buffer);
  pd.setUint32(0, 0x00030000);
  pd.setInt32(4, Math.round(base.italicAngle * 65536));
  const tables = { head, hhea, maxp, hmtx, loca, glyf: concat(glyfParts), cmap: cmapTable(codes), post };
  // a name of its own: the glyphs are modified, and the bundled faces'
  // licence reserves their names
  tables.name = nameTable('PurefieldSubstitute');
  const os2 = copy('OS/2');
  if (os2) tables['OS/2'] = os2;
  return writeFont(tables);
}

// A name table (format 0): family, subfamily, full and PostScript names,
// Windows Unicode English
function nameTable(family) {
  const records = [[1, family], [2, 'Regular'], [4, family], [6, family]];
  const strings = records.map(([, s]) => Uint8Array.from([...s].flatMap(ch => [0, ch.charCodeAt(0) & 0x7F])));
  const header = 6 + 12 * records.length;
  const out = new Uint8Array(header + strings.reduce((n, s) => n + s.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0); dv.setUint16(2, records.length); dv.setUint16(4, header);
  let off = 0;
  records.forEach(([id], i) => {
    const r = 6 + 12 * i;
    dv.setUint16(r, 3); dv.setUint16(r + 2, 1); dv.setUint16(r + 4, 0x409); dv.setUint16(r + 6, id);
    dv.setUint16(r + 8, strings[i].length); dv.setUint16(r + 10, off);
    out.set(strings[i], header + off);
    off += strings[i].length;
  });
  return out;
}

// A simple glyph: every point with 16-bit deltas, no instructions
function encodeGlyph(contours) {
  const pts = contours.flat().map(p => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on }));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const nc = contours.length, np = pts.length;
  const size = 10 + 2 * nc + 2 + np + 4 * np;
  const bytes = new Uint8Array(size + ((4 - (size % 4)) % 4));
  const dv = new DataView(bytes.buffer);
  dv.setInt16(0, nc);
  bbox.forEach((v, i) => dv.setInt16(2 + 2 * i, v));
  let p = 10, end = -1;
  for (const c of contours) { end += c.length; dv.setUint16(p, end); p += 2; }
  dv.setUint16(p, 0); p += 2;
  for (const pt of pts) bytes[p++] = pt.on ? 1 : 0;
  let last = 0;
  for (const pt of pts) { dv.setInt16(p, pt.x - last); last = pt.x; p += 2; }
  last = 0;
  for (const pt of pts) { dv.setInt16(p, pt.y - last); last = pt.y; p += 2; }
  return { bytes, bbox, points: np };
}

// cmap: (1,0) format 0 and (3,0) format 4 at 0xF000 + code, as a symbolic
// simple font is addressed (PDF 32000 §9.6.6.4); empty for CID fonts
function cmapTable(codes) {
  const entries = [...codes].filter(([c]) => c >= 0 && c < 256).sort((a, b) => a[0] - b[0]);
  const f0 = new Uint8Array(262);
  const d0 = new DataView(f0.buffer);
  d0.setUint16(0, 0); d0.setUint16(2, 262); d0.setUint16(4, 0);
  for (const [c, g] of entries) if (g < 256) f0[6 + c] = g;
  // format 4: one segment per code, then the closing 0xFFFF segment
  const segs = entries.map(([c, g]) => ({ start: 0xF000 + c, end: 0xF000 + c, delta: (g - (0xF000 + c)) & 0xFFFF }));
  segs.push({ start: 0xFFFF, end: 0xFFFF, delta: 1 });
  const sc = segs.length;
  const len4 = 16 + 8 * sc;
  const f4 = new Uint8Array(len4);
  const d4 = new DataView(f4.buffer);
  let es = 0; // floor(log2(segments))
  while ((2 << es) <= sc) es++;
  d4.setUint16(0, 4); d4.setUint16(2, len4); d4.setUint16(4, 0);
  d4.setUint16(6, sc * 2); d4.setUint16(8, 2 << es); d4.setUint16(10, es); d4.setUint16(12, 2 * sc - (2 << es));
  segs.forEach((s, i) => {
    d4.setUint16(14 + 2 * i, s.end);
    d4.setUint16(16 + 2 * sc + 2 * i, s.start);
    d4.setUint16(16 + 4 * sc + 2 * i, s.delta);
    d4.setUint16(16 + 6 * sc + 2 * i, 0);
  });
  const head = new Uint8Array(4 + 2 * 8);
  const hd = new DataView(head.buffer);
  hd.setUint16(0, 0); hd.setUint16(2, 2);
  hd.setUint16(4, 1); hd.setUint16(6, 0); hd.setUint32(8, head.length);
  hd.setUint16(12, 3); hd.setUint16(14, 0); hd.setUint32(16, head.length + f0.length);
  return concat([head, f0, f4]);
}

function writeFont(tables) {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= n) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  const headerLen = 12 + n * 16;
  let size = headerLen;
  for (const t of tags) size += (tables[t].length + 3) & ~3;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, n);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, n * 16 - searchRange);
  let offset = headerLen, headOffset = 0;
  tags.forEach((t, i) => {
    const data = tables[t];
    const e = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[e + k] = t.charCodeAt(k);
    dv.setUint32(e + 4, checksum(data));
    dv.setUint32(e + 8, offset);
    dv.setUint32(e + 12, data.length);
    out.set(data, offset);
    if (t === 'head') headOffset = offset;
    offset += (data.length + 3) & ~3;
  });
  dv.setUint32(headOffset + 8, (0xB1B0AFBA - checksum(out)) >>> 0);
  return out;
}

function checksum(data) {
  let sum = 0;
  const padded = data.length % 4 ? concat([data, new Uint8Array(4 - (data.length % 4))]) : data;
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
