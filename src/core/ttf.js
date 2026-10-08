/**
 * Purefield / core / ttf.js
 *
 * Minimal TrueType reader and subsetter for embedding a Unicode font as a
 * CIDFontType2 (Identity-H) in PdfWriter.
 *
 *   const font = parseTtf(bytes)
 *   font.glyphFor(codePoint) → glyph id (0 = .notdef)
 *   font.advance(gid)        → advance width in font units
 *   font.subset(gids)        → TTF bytes keeping only those glyphs
 *
 * The subset keeps glyph numbering (unused glyphs become empty), so the PDF
 * can use CIDToGIDMap /Identity with CID = GID.
 */

export function parseTtf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    tables[tag] = { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
  }
  const need = t => { if (!tables[t]) throw new Error(`TrueType font has no ${t} table`); return tables[t].offset; };

  const head = need('head');
  const unitsPerEm = dv.getUint16(head + 18);
  const bbox = [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)];
  const indexToLocFormat = dv.getInt16(head + 50);
  const numGlyphs = dv.getUint16(need('maxp') + 4);
  const hhea = need('hhea');
  const ascent = dv.getInt16(hhea + 4);
  const descent = dv.getInt16(hhea + 6);
  const numberOfHMetrics = dv.getUint16(hhea + 34);
  const hmtx = need('hmtx');
  const post = tables.post ? tables.post.offset : null;
  const italicAngle = post !== null ? dv.getInt32(post + 4) / 65536 : 0;
  const os2 = tables['OS/2'] ? tables['OS/2'].offset : null;
  const capHeight = os2 !== null && tables['OS/2'].length >= 90 ? dv.getInt16(os2 + 88) : Math.round(ascent * 0.7);

  // cmap: prefer (3,10) format 12, else (3,1)/(0,x) format 4
  const cmapOff = need('cmap');
  const nSub = dv.getUint16(cmapOff + 2);
  let best = null;
  for (let i = 0; i < nSub; i++) {
    const pid = dv.getUint16(cmapOff + 4 + i * 8);
    const eid = dv.getUint16(cmapOff + 6 + i * 8);
    const off = cmapOff + dv.getUint32(cmapOff + 8 + i * 8);
    const format = dv.getUint16(off);
    // (3,0) symbol and (1,0) Mac byte tables only serve fonts embedded in a
    // PDF, whose glyphs are addressed by their simple-font code
    const score = format === 12 ? 3
      : (format === 4 && (pid === 3 || pid === 0)) ? (eid === 1 || pid === 0 ? 2 : 1)
      : (format === 0 && pid === 1 && eid === 0) ? 0.5 : 0;
    if (score && (!best || score > best.score)) best = { off, format, score, symbol: pid === 3 && eid === 0, mac: pid === 1 };
  }
  if (!best) throw new Error('TrueType font has no Unicode cmap');
  const cmap = new Map();
  if (best.format === 0) {
    for (let c = 0; c < 256; c++) { const g = bytes[best.off + 6 + c]; if (g) cmap.set(c, g); }
  } else if (best.format === 4) {
    const o = best.off;
    const segX2 = dv.getUint16(o + 6);
    const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2; s += 2) {
      const end = dv.getUint16(ends + s), start = dv.getUint16(starts + s);
      const delta = dv.getInt16(deltas + s), rangeOff = dv.getUint16(ranges + s);
      for (let c = start; c <= end && c !== 0xFFFF; c++) {
        let g;
        if (rangeOff === 0) g = (c + delta) & 0xFFFF;
        else {
          const gi = ranges + s + rangeOff + (c - start) * 2;
          g = dv.getUint16(gi);
          if (g !== 0) g = (g + delta) & 0xFFFF;
        }
        if (g) cmap.set(c, g);
      }
    }
  } else {
    const o = best.off;
    const nGroups = dv.getUint32(o + 12);
    for (let i = 0; i < nGroups; i++) {
      const start = dv.getUint32(o + 16 + i * 12), end = dv.getUint32(o + 20 + i * 12), g0 = dv.getUint32(o + 24 + i * 12);
      for (let c = start; c <= end; c++) cmap.set(c, g0 + (c - start));
    }
  }

  const locaOff = need('loca');
  const glyfOff = need('glyf');
  const loca = gid => indexToLocFormat === 0 ? dv.getUint16(locaOff + gid * 2) * 2 : dv.getUint32(locaOff + gid * 4);

  const font = {
    unitsPerEm, bbox, ascent, descent, capHeight, italicAngle, numGlyphs,
    // the raw tables, for fonts rebuilt glyph by glyph (core/outline.js)
    bytes, dv, tables,
    glyphData: gid => (gid < numGlyphs && loca(gid + 1) > loca(gid) ? bytes.subarray(glyfOff + loca(gid), glyfOff + loca(gid + 1)) : null),
    /** The code points each glyph is mapped from (first one) */
    unicodeOf: gid => {
      if (!font._reverse) { font._reverse = new Map(); for (const [c, g] of cmap) if (!font._reverse.has(g)) font._reverse.set(g, c); }
      return font._reverse.get(gid) ?? null;
    },
    /** 'unicode', or 'symbol' / 'mac' for code-addressed tables */
    cmapKind: best.symbol ? 'symbol' : best.mac ? 'mac' : 'unicode',
    glyphFor: cp => cmap.get(cp) ?? 0,
    advance: gid => dv.getUint16(hmtx + 4 * Math.min(gid, numberOfHMetrics - 1)),
    /** Width of a code point in 1000-unit em space */
    width1000: cp => Math.round(font.advance(cmap.get(cp) ?? 0) * 1000 / unitsPerEm),
    subset: gids => subset(bytes, dv, tables, { numGlyphs, loca, glyfOff, indexToLocFormat }, gids),
  };
  return font;
}

// ---------------------------------------------------------------------------
// Subsetting: keep glyph numbering; unused glyphs become empty
// ---------------------------------------------------------------------------

const KEEP = ['head', 'hhea', 'maxp', 'hmtx', 'cvt ', 'fpgm', 'prep', 'OS/2', 'post', 'name', 'cmap'];

function subset(bytes, dv, tables, { numGlyphs, loca, glyfOff }, gids) {
  const keep = new Set([0, ...gids]);
  // pull in components of composite glyphs
  const queue = [...keep];
  while (queue.length) {
    const g = queue.pop();
    const start = loca(g), end = loca(g + 1);
    if (end <= start) continue;
    const o = glyfOff + start;
    if (dv.getInt16(o) >= 0) continue; // simple glyph
    let p = o + 10;
    for (;;) {
      const flags = dv.getUint16(p);
      const comp = dv.getUint16(p + 2);
      if (!keep.has(comp)) { keep.add(comp); queue.push(comp); }
      p += 4 + (flags & 1 ? 4 : 2);
      if (flags & 8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
      if (!(flags & 0x20)) break;
    }
  }

  // new glyf + loca (long format)
  const parts = [];
  const offsets = new Uint32Array(numGlyphs + 1);
  let pos = 0;
  for (let g = 0; g < numGlyphs; g++) {
    offsets[g] = pos;
    if (!keep.has(g)) continue;
    const start = loca(g), end = loca(g + 1);
    if (end <= start) continue;
    const glyph = bytes.subarray(glyfOff + start, glyfOff + end);
    parts.push(glyph);
    pos += glyph.length;
    const pad = (4 - (glyph.length % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); pos += pad; }
  }
  offsets[numGlyphs] = pos;
  const glyf = concat(parts);
  const locaBytes = new Uint8Array((numGlyphs + 1) * 4);
  const ldv = new DataView(locaBytes.buffer);
  offsets.forEach((v, i) => ldv.setUint32(i * 4, v));

  const out = { glyf, loca: locaBytes };
  for (const t of KEEP) {
    if (tables[t]) out[t] = bytes.slice(tables[t].offset, tables[t].offset + tables[t].length);
  }
  // post format 3: no glyph names (they are most of the table)
  if (out.post) {
    out.post = out.post.slice(0, 32);
    new DataView(out.post.buffer).setUint32(0, 0x00030000);
  }
  // head.indexToLocFormat = 1 (long), checkSumAdjustment recomputed below
  const headDv = new DataView(out.head.buffer);
  headDv.setInt16(50, 1);
  headDv.setUint32(8, 0);
  return writeFont(out);
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
  let offset = headerLen;
  let headOffset = 0;
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
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
