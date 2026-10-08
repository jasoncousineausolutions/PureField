/**
 * Purefield / core / writer.js
 *
 * Builds a valid PDF file from scratch.
 *
 * Fonts: every page gets the twelve standard Type 1 faces (Helvetica,
 * Times, Courier × regular/bold/italic/bold-italic) as /F_H, /F_HB, /F_HI,
 * /F_HBI, /F_T…, /F_C…, WinAnsi-encoded, not embedded — the substitutes the
 * reduced XFA spec maps typefaces to. The legacy /Helvetica and /HelveticaB
 * names remain (optionally embedded Liberation Sans).
 *
 * Images: either raw RGB pixels { name, pixels, width, height } or an
 * already-encoded stream { name, width, height, data, filter, colorSpace,
 * bitsPerComponent, decodeParms } (JPEG/PNG passthrough, see images.js).
 */

/** Standard font resource names → BaseFont */
export const STANDARD_FONTS = {
  F_H: 'Helvetica', F_HB: 'Helvetica-Bold', F_HI: 'Helvetica-Oblique', F_HBI: 'Helvetica-BoldOblique',
  F_T: 'Times-Roman', F_TB: 'Times-Bold', F_TI: 'Times-Italic', F_TBI: 'Times-BoldItalic',
  F_C: 'Courier', F_CB: 'Courier-Bold', F_CI: 'Courier-Oblique', F_CBI: 'Courier-BoldOblique',
};

/** Resource name for a substituted face + style */
export function standardFontName(face, bold, italic) {
  const base = face === 'Times-Roman' ? 'F_T' : face === 'Courier' ? 'F_C' : 'F_H';
  return base + (bold ? 'B' : '') + (italic ? 'I' : '');
}

export class PdfWriter {
  /**
   * @param {Array<{width, height, content, images}>} pages
   *   images: array of {name, pixels, width, height} for image XObjects
   */
  /**
   * @param {object[]} pages - may carry `base`: an ImportedPage from
   *   importer.js; its original content is drawn first (wrapped in q/Q) and
   *   this page's content is overlaid, with resources merged
   * @param {object} [info]
   * @param {{ imported?: import('./importer.js').ImportedDoc, embeddedFonts?: object[] }} [opts]
   *   embeddedFonts: Type 0 fonts from embed.js, added to every page's resources
   */
  build(pages, info = {}, { imported = null, embeddedFonts = [], extraGlyphs = null, catalog = '' } = {}) {
    // We'll collect all objects and their byte offsets
    const objects = [];
    let nextId = 1;

    const alloc = () => nextId++;

    // Allocate IDs up front
    const catalogId  = alloc();
    const pagesId    = alloc();
    const fontHelv   = alloc();
    const fontHelvB  = alloc();
    const fontRes    = alloc();

    const pageData = pages.map(() => ({
      contentId: alloc(),
      pageId:    alloc(),
    }));

    // Build object strings
    const addObj    = (id, body)        => objects.push({ id, body: `${id} 0 obj\n${body}\nendobj` });
    const addObjBin = (id, head, bytes) => objects.push({ id, head, bytes });

    // Imported objects: local numbers shift past everything allocated so far
    const importBase = nextId - 1;
    const fixRefs = str => str.replace(/\u0000R(\d+)\u0000/g, (_, n) => `${importBase + Number(n)} 0 R`);
    if (imported) {
      nextId += imported.objects.length + 1;
      for (const o of imported.objects) {
        const id = importBase + o.local;
        if (o.bytes) addObjBin(id, `${id} 0 obj\n${fixRefs(o.head)}\nstream`, o.bytes);
        else addObj(id, fixRefs(o.body));
      }
    }
    // one shared "q" stream to open every imported page
    const qStreamId = imported ? alloc() : null;
    if (qStreamId) addObj(qStreamId, `<< /Length 1 >>\nstream\nq\nendstream`);

    // Font embedding
    // pages[0].fonts contains optional TrueType font data {regular, bold}
    // If provided, embed Liberation Sans; otherwise fall back to Type1 Helvetica
    const fontData = (pages[0] && pages[0].fonts) || null;

    let fontResStr;
    if (fontData) {
      // Embed TrueType fonts
      const regId  = buildTTFont(fontData.regular, fontHelv,  'LiberationSans',      objects, alloc, addObj, addObjBin);
      const boldId = buildTTFont(fontData.bold,    fontHelvB, 'LiberationSans-Bold',  objects, alloc, addObj, addObjBin);
      fontResStr = `<< /Helvetica ${regId} 0 R /HelveticaB ${boldId} 0 R >>`;
    } else {
      // Fall back to standard Type1 fonts (always available, no embedding needed)
      addObj(fontHelv,  `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
      addObj(fontHelvB, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
      fontResStr = `<< /Helvetica ${fontHelv} 0 R /HelveticaB ${fontHelvB} 0 R >>`;
    }

    // The standard 14 subset used by the XFA painter
    const stdEntries = [];
    // Latin Extended-A letters drawn with them: WinAnsi plus /Differences
    const diffs = extraGlyphs?.size
      ? [...extraGlyphs].sort((a, b) => a[1] - b[1]).map(([cp, code]) => `${code} /${EXTRA_GLYPHS.get(cp).name}`).join(' ')
      : '';
    const stdEncoding = diffs ? `<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${diffs}] >>` : '/WinAnsiEncoding';
    for (const [res, base] of Object.entries(STANDARD_FONTS)) {
      const id = alloc();
      addObj(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding ${stdEncoding} >>`);
      stdEntries.push(`/${res} ${id} 0 R`);
    }
    fontResStr = fontResStr.replace(/>>$/, ` ${stdEntries.join(' ')} >>`);

    // Embedded Unicode faces: Type0 → CIDFontType2 (Identity-H, CID = GID)
    for (const ef of embeddedFonts) {
      if (ef.cjk) {
        // a standard CJK font, not embedded: viewers carry it or a stand-in
        const descId = alloc(), cidId = alloc(), type0Id = alloc();
        addObj(descId, `<< /Type /FontDescriptor /FontName /${ef.baseFont} /Flags 4 /FontBBox [-200 -300 1200 1100] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 760 /StemV 80 >>`);
        addObj(cidId, `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${ef.baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ef.ordering}) /Supplement ${ef.supplement} >> /FontDescriptor ${descId} 0 R /DW 1000 >>`);
        addObj(type0Id, `<< /Type /Font /Subtype /Type0 /BaseFont /${ef.baseFont}-${ef.cmap} /Encoding /${ef.cmap} /DescendantFonts [${cidId} 0 R] >>`);
        fontResStr = fontResStr.replace(/>>$/, ` /${ef.resName} ${type0Id} 0 R >>`);
        continue;
      }
      const fileId = alloc(), descId = alloc(), cidId = alloc(), touId = alloc(), type0Id = alloc();
      addObjBin(fileId, `${fileId} 0 obj\n<< /Length ${ef.fontFile.length} /Length1 ${ef.fontFileLength1} /Filter /FlateDecode >>\nstream`, ef.fontFile);
      addObj(descId, `<< /Type /FontDescriptor /FontName /${ef.baseFont} /Flags 32 /FontBBox [${ef.bbox.join(' ')}] /ItalicAngle ${ef.italicAngle} /Ascent ${ef.ascent} /Descent ${ef.descent} /CapHeight ${ef.capHeight} /StemV 80 /FontFile2 ${fileId} 0 R >>`);
      addObj(cidId, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${ef.baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /DW 1000 /W ${ef.widths} /CIDToGIDMap /Identity >>`);
      addObjBin(touId, `${touId} 0 obj\n<< /Length ${ef.toUnicode.length} /Filter /FlateDecode >>\nstream`, ef.toUnicode);
      addObj(type0Id, `<< /Type /Font /Subtype /Type0 /BaseFont /${ef.baseFont} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${touId} 0 R >>`);
      fontResStr = fontResStr.replace(/>>$/, ` /${ef.resName} ${type0Id} 0 R >>`);
    }

    // Image XObjects (shared across pages)
    // Collect all unique images from all pages
    const allImages = new Map(); // name -> {id, pixels, width, height}
    for (const page of pages) {
      for (const img of (page.images || [])) {
        if (!allImages.has(img.name)) {
          const imgId = alloc();
          allImages.set(img.name, { id: imgId, ...img });
        }
      }
    }

    // Emit image XObject streams (binary)
    for (const [name, img] of allImages) {
      if (img.data) {
        const encHeader = [
          `${img.id} 0 obj`,
          `<<`,
          `/Type /XObject`,
          `/Subtype /Image`,
          `/Width ${img.width}`,
          `/Height ${img.height}`,
          `/ColorSpace ${img.colorSpace}`,
          `/BitsPerComponent ${img.bitsPerComponent}`,
          img.filter ? `/Filter /${img.filter}` : '',
          img.decodeParms ? `/DecodeParms ${img.decodeParms}` : '',
          `/Length ${img.data.length}`,
          `>>`,
          `stream`,
        ].filter(Boolean).join('\n');
        addObjBin(img.id, encHeader, img.data);
        continue;
      }
      const header = [
        `${img.id} 0 obj`,
        `<<`,
        `/Type /XObject`,
        `/Subtype /Image`,
        `/Width ${img.width}`,
        `/Height ${img.height}`,
        `/ColorSpace /DeviceRGB`,
        `/BitsPerComponent 8`,
        `/Length ${img.pixels.length}`,
        `>>`,
        `stream`,
      ].join('\n');
      addObjBin(img.id, header, img.pixels);
    }

    // Font resource dict
    addObj(fontRes, fontResStr);

    // Build XObject resource dict string
    const xobjEntries = [...allImages.entries()]
      .map(([name, img]) => `/${name} ${img.id} 0 R`)
      .join('\n');
    const xobjDict = allImages.size > 0 ? `<< ${xobjEntries} >>` : null;

    // Gradient fills: one shading object each, named in its page's resources
    const shadingDicts = pages.map(page => (page.shadings ?? []).map(sh => {
      const id = alloc();
      const c = v => v.map(n => f(n / 255)).join(' ');
      addObj(id, `<< /ShadingType ${sh.type} /ColorSpace /DeviceRGB /Coords [${sh.coords.map(f).join(' ')}] `
        + `/Function << /FunctionType 2 /Domain [0 1] /C0 [${c(sh.c0)}] /C1 [${c(sh.c1)}] /N 1 >> /Extend [true true] >>`);
      return `/${sh.name} ${id} 0 R`;
    }).join(' '));

    // Page content streams
    for (let i = 0; i < pages.length; i++) {
      const { contentId } = pageData[i];
      let content = pages[i].content;
      const base = pages[i].base;
      if (base) {
        // close the original page's graphics state, then overlay in our frame
        const [x0, y0] = base.mediaBox;
        const u = base.userUnit ?? 1;
        content = 'Q\n' + (u !== 1 ? `${f(u)} 0 0 ${f(u)} 0 0 cm\n` : '') + (x0 || y0 ? `1 0 0 1 ${x0} ${y0} cm\n` : '') + content;
      }
      // Length must be in bytes. Content is latin1 so one byte per char.
      const byteLen = content.length;
      addObj(contentId, `<< /Length ${byteLen} >>\nstream\n${content}\nendstream`);
    }

    // Page objects
    for (let i = 0; i < pages.length; i++) {
      const { contentId, pageId } = pageData[i];
      const { width, height, base } = pages[i];
      if (base) {
        const r = base.resources;
        const ourFonts = fontResStr.replace(/^<<|>>$/g, '');
        // our shadings join the shell page's own /Shading dictionary, if any
        let other = r.other;
        // (shell pages carry only field values, so this is a safeguard)
        if (shadingDicts[i] && /\/Shading\s*<</.test(other)) other = other.replace(/\/Shading\s*<</, `/Shading << ${shadingDicts[i]}`);
        else if (shadingDicts[i] && !/\/Shading\b/.test(other)) other = `${other} /Shading << ${shadingDicts[i]} >>`;
        // graphics states: the page's own, and ours (annotation opacity)
        const gs = `${r.extgstate ?? ''} ${pages[i].extGStates ?? ''}`.trim();
        const resources = fixRefs(`<< ${other} /Font << ${r.font} ${ourFonts} >> /XObject << ${r.xobject} ${xobjEntries} >>${gs ? ` /ExtGState << ${gs} >>` : ''} >>`);
        // a page in larger units (/UserUnit) is scaled to points, so every
        // viewer prints it at its size, not only those that read UserUnit
        const u = base.userUnit ?? 1;
        let open = qStreamId;
        if (u !== 1) {
          open = alloc();
          const s = `q\n${f(u)} 0 0 ${f(u)} 0 0 cm`;
          addObj(open, `<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
        }
        const contents = [open, ...base.contents.map(n => importBase + n), contentId].map(id => `${id} 0 R`).join(' ');
        addObj(pageId, [
          '<<',
          '/Type /Page',
          `/Parent ${pagesId} 0 R`,
          `/MediaBox [${base.mediaBox.map(v => f(v * u)).join(' ')}]`,
          base.rotate ? `/Rotate ${base.rotate}` : '',
          `/Contents [${contents}]`,
          `/Resources ${resources}`,
          '>>',
        ].filter(Boolean).join('\n'));
        continue;
      }
      // copied form XObjects (signature appearances) join the images
      const xobjects = `${xobjEntries} ${pages[i].xobjects ?? ''}`.trim();
      const resources = [
        `<< /Font ${fontRes} 0 R`,
        xobjects ? `/XObject << ${fixRefs(xobjects)} >>` : '',
        shadingDicts[i] ? `/Shading << ${shadingDicts[i]} >>` : '',
        pages[i].extGStates ? `/ExtGState << ${pages[i].extGStates} >>` : '',
        `>>`,
      ].filter(Boolean).join('\n');
      addObj(pageId, [
        '<<',
        '/Type /Page',
        `/Parent ${pagesId} 0 R`,
        `/MediaBox [0 0 ${width} ${height}]`,
        `/Contents ${contentId} 0 R`,
        `/Resources ${resources}`,
        '>>',
      ].join('\n'));
    }

    // Pages object
    const kidRefs = pageData.map(p => `${p.pageId} 0 R`).join(' ');
    addObj(pagesId, `<< /Type /Pages /Kids [${kidRefs}] /Count ${pages.length} >>`);

    // Catalog
    // catalog entries carried over (the print preferences)
    addObj(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R${catalog ? ` ${catalog}` : ''} >>`);

    // Optional info
    let infoId = null;
    if (Object.keys(info).length > 0) {
      infoId = alloc();
      const entries = Object.entries(info).map(([k, v]) => `/${k} ${pdfStr(v)}`).join('\n');
      addObj(infoId, `<<\n${entries}\n>>`);
    }

    // ---------------------------------------------------------------------------
    // Assemble bytes
    // ---------------------------------------------------------------------------
    // We build a Uint8Array directly to handle binary image data cleanly.
    const header = latin1Encode('%PDF-1.7\n%\xFF\xFF\xFF\xFF\n');
    const chunks = [header];
    let byteOffset = header.length;
    const offsets = new Map();

    // Sort objects by id for a clean file
    objects.sort((a, b) => a.id - b.id);

    for (const obj of objects) {
      offsets.set(obj.id, byteOffset);
      if (obj.bytes) {
        // Binary object (image XObject)
        const headBytes  = latin1Encode(obj.head + '\n');
        const endBytes   = latin1Encode('\nendstream\nendobj\n\n');
        chunks.push(headBytes, obj.bytes, endBytes);
        byteOffset += headBytes.length + obj.bytes.length + endBytes.length;
      } else {
        const encoded = latin1Encode(obj.body + '\n\n');
        chunks.push(encoded);
        byteOffset += encoded.length;
      }
    }

    // xref
    const xrefOffset = byteOffset;
    const maxId = Math.max(...objects.map(o => o.id), infoId ?? 0);
    const xrefLines = [`xref\n0 ${maxId + 1}`];
    xrefLines.push('0000000000 65535 f ');
    for (let i = 1; i <= maxId; i++) {
      const off = offsets.get(i);
      xrefLines.push(off !== undefined
        ? `${String(off).padStart(10, '0')} 00000 n `
        : '0000000000 65535 f ');
    }
    const xrefStr = xrefLines.join('\n') + '\n';

    // Trailer
    const trailerParts = [`<< /Size ${maxId + 1} /Root ${catalogId} 0 R`];
    if (infoId) trailerParts.push(` /Info ${infoId} 0 R`);
    trailerParts.push(' >>');
    const trailerStr = `trailer\n${trailerParts.join('')}\nstartxref\n${xrefOffset}\n%%EOF\n`;

    chunks.push(latin1Encode(xrefStr + trailerStr));

    // Concatenate all chunks into a single Uint8Array
    const totalLen = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }
}

// Encode a JS string to Uint8Array using latin1 (ISO-8859-1).
// Characters above 0xFF are clamped to their low byte.
function latin1Encode(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xFF;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// TrueType font embedding
// Builds the three objects needed for a TrueType font in PDF:
//   1. FontDescriptor — metrics
//   2. FontFile2 stream — the raw TTF bytes
//   3. Font dictionary — ties it together with widths
// Returns the font dictionary object id.
// ---------------------------------------------------------------------------
function buildTTFont(fontInfo, fontDictId, baseName, objects, alloc, addObj, addObjBin) {
  const { widths, ascender, descender, capHeight, italicAngle, fontBBox, bytes } = fontInfo;

  // Font file stream
  const fileId = alloc();
  const fileHeader = [
    `${fileId} 0 obj`,
    `<<`,
    `/Length ${bytes.length}`,
    `/Length1 ${bytes.length}`,
    `/Subtype /TrueType`,
    `>>`,
    `stream`,
  ].join('\n');
  objects.push({ id: fileId, head: fileHeader, bytes });

  // Font descriptor
  const descId = alloc();
  const flags = 32; // Nonsymbolic
  addObj(descId, [
    '<<',
    '/Type /FontDescriptor',
    `/FontName /${baseName}`,
    `/Flags ${flags}`,
    `/FontBBox [${fontBBox.join(' ')}]`,
    `/ItalicAngle ${italicAngle}`,
    `/Ascent ${ascender}`,
    `/Descent ${descender}`,
    `/CapHeight ${capHeight}`,
    `/StemV 80`,
    `/FontFile2 ${fileId} 0 R`,
    '>>',
  ].join('\n'));

  // Widths array — for chars 32-255
  const widthsStr = widths.join(' ');

  // Font dictionary
  addObj(fontDictId, [
    '<<',
    '/Type /Font',
    '/Subtype /TrueType',
    `/BaseFont /${baseName}`,
    '/FirstChar 32',
    '/LastChar 255',
    `/Widths [${widthsStr}]`,
    `/FontDescriptor ${descId} 0 R`,
    '/Encoding /WinAnsiEncoding',
    '>>',
  ].join('\n'));

  return fontDictId;
}

function pdfStr(s) {
  return '(' + String(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)') + ')';
}

// ---------------------------------------------------------------------------
// Content stream builder
// ---------------------------------------------------------------------------
export class ContentStream {
  constructor() { this._ops = []; }

  save()    { this._ops.push('q'); return this; }
  restore() { this._ops.push('Q'); return this; }

  // Colors — MUST be outside BT/ET
  fillColor(r, g, b)   { this._ops.push(`${f(r)} ${f(g)} ${f(b)} rg`); return this; }
  strokeColor(r, g, b) { this._ops.push(`${f(r)} ${f(g)} ${f(b)} RG`); return this; }
  lineWidth(w)         { this._ops.push(`${f(w)} w`);                   return this; }

  // Graphics
  rect(x, y, w, h) { this._ops.push(`${f(x)} ${f(y)} ${f(w)} ${f(h)} re`); return this; }
  fill()            { this._ops.push('f');  return this; }
  stroke()          { this._ops.push('S');  return this; }
  moveTo(x, y)      { this._ops.push(`${f(x)} ${f(y)} m`); return this; }
  lineTo(x, y)      { this._ops.push(`${f(x)} ${f(y)} l`); return this; }
  curveTo(x1, y1, x2, y2, x3, y3) {
    this._ops.push(`${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x3)} ${f(y3)} c`); return this;
  }
  closePath()       { this._ops.push('h');  return this; }
  fillStroke()      { this._ops.push('B');  return this; }
  clip()            { this._ops.push('W n'); return this; }
  dash(array, phase = 0) { this._ops.push(`[${array.map(f).join(' ')}] ${f(phase)} d`); return this; }
  lineCap(c)        { this._ops.push(`${c} J`); return this; }
  lineJoin(j)       { this._ops.push(`${j} j`); return this; }
  /** Graphics state `name` from the page's /ExtGState resources */
  gs(name)          { this._ops.push(`/${name} gs`); return this; }
  fillEvenOdd()     { this._ops.push('f*'); return this; }
  /** Paint image XObject `name` into the rectangle x, y, w, h (PDF space) */
  image(name, x, y, w, h) {
    this._ops.push('q', `${f(w)} 0 0 ${f(h)} ${f(x)} ${f(y)} cm`, `/${name} Do`, 'Q'); return this;
  }

  /**
   * Text run with the full text state (spec §4): horizontal scale (Tz),
   * character spacing (Tc), rise (Ts) and vertical scale via the text matrix.
   * x, y is the baseline origin in PDF space.
   */
  text(x, y, fontName, size, [r, g, b], str, { hScale = 1, vScale = 1, charSpacing = 0, rise = 0, hex = null, tj = null, skew = 0, fakeBold = false, encoded = false } = {}) {
    if (!str && !hex && !tj) return this;
    const ops = [`${f(r)} ${f(g)} ${f(b)} rg`];
    if (fakeBold) ops.push(`${f(r)} ${f(g)} ${f(b)} RG`, `${f(size * 0.03)} w`, '2 Tr');
    ops.push('BT', `/${fontName} ${f(size)} Tf`);
    if (hScale !== 1) ops.push(`${f(hScale * 100)} Tz`);
    if (charSpacing) ops.push(`${f(charSpacing)} Tc`);
    if (rise) ops.push(`${f(rise)} Ts`);
    ops.push(vScale !== 1 || skew ? `1 0 ${f(skew)} ${f(vScale)} ${f(x)} ${f(y)} Tm` : `${f(x)} ${f(y)} Td`);
    // hex: pre-encoded glyph ids for an Identity-H font; tj: a TJ array of
    // hex strings and position adjustments (thousandths of an em)
    if (tj) ops.push(`[${tj.map(e => typeof e === 'number' ? f(e) : `<${e}>`).join(' ')}] TJ`, 'ET');
    else ops.push(hex !== null ? `<${hex}> Tj` : `(${encoded ? escapeBytes(str) : escapeText(str)}) Tj`, 'ET');
    // Tz, Tc, Ts and Tr persist in the graphics state: scope them
    const scoped = hScale !== 1 || charSpacing || rise || fakeBold;
    this._ops.push(...(scoped ? ['q', ...ops, 'Q'] : ops));
    return this;
  }

  toString() { return this._ops.join('\n'); }
}

function f(n) {
  if (n === 0 || n === undefined || n === null) return '0';
  return Number(n).toFixed(3).replace(/\.?0+$/, '');
}

// Unicode → WinAnsiEncoding (cp1252) code for the characters outside Latin-1
const CP1252 = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
  0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};
/** WinAnsiEncoding byte for a code point, or -1 */
export function winAnsiCode(cp) {
  if ((cp >= 0x20 && cp < 0x7F) || (cp >= 0xA0 && cp <= 0xFF)) return cp;
  return CP1252[cp] ?? -1;
}

/** True if every character of the string has a WinAnsiEncoding code */
export function isWinAnsi(s) {
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (!((c >= 0x20 && c < 0x7F) || (c >= 0xA0 && c <= 0xFF) || CP1252[c] || c === 0x09 || c === 0x0A || c === 0x0D)) return false;
  }
  return true;
}

// Latin Extended-A letters the standard 14 Times and Courier faces carry
// (Core 14 AFM glyph names), with the letter whose width they take. They
// are reached through a /Differences encoding: anaf-d104's Times New Roman
// "Se completează" keeps its serif, and its ă, in Reader.
export const EXTRA_GLYPHS = new Map(Object.entries({
  0x0100: 'Amacron A', 0x0101: 'amacron a', 0x0102: 'Abreve A', 0x0103: 'abreve a', 0x0104: 'Aogonek A', 0x0105: 'aogonek a',
  0x0106: 'Cacute C', 0x0107: 'cacute c', 0x010C: 'Ccaron C', 0x010D: 'ccaron c', 0x010E: 'Dcaron D', 0x010F: 'dcaron d',
  0x0110: 'Dcroat D', 0x0111: 'dcroat d', 0x0112: 'Emacron E', 0x0113: 'emacron e', 0x0116: 'Edotaccent E', 0x0117: 'edotaccent e',
  0x0118: 'Eogonek E', 0x0119: 'eogonek e', 0x011A: 'Ecaron E', 0x011B: 'ecaron e', 0x011E: 'Gbreve G', 0x011F: 'gbreve g',
  0x0122: 'Gcommaaccent G', 0x0123: 'gcommaaccent g', 0x012A: 'Imacron I', 0x012B: 'imacron i', 0x012E: 'Iogonek I', 0x012F: 'iogonek i',
  0x0130: 'Idotaccent I', 0x0131: 'dotlessi i', 0x0136: 'Kcommaaccent K', 0x0137: 'kcommaaccent k', 0x0139: 'Lacute L', 0x013A: 'lacute l',
  0x013B: 'Lcommaaccent L', 0x013C: 'lcommaaccent l', 0x013D: 'Lcaron L', 0x013E: 'lcaron l', 0x0141: 'Lslash L', 0x0142: 'lslash l',
  0x0143: 'Nacute N', 0x0144: 'nacute n', 0x0145: 'Ncommaaccent N', 0x0146: 'ncommaaccent n', 0x0147: 'Ncaron N', 0x0148: 'ncaron n',
  0x014C: 'Omacron O', 0x014D: 'omacron o', 0x0150: 'Ohungarumlaut O', 0x0151: 'ohungarumlaut o', 0x0154: 'Racute R', 0x0155: 'racute r',
  0x0156: 'Rcommaaccent R', 0x0157: 'rcommaaccent r', 0x0158: 'Rcaron R', 0x0159: 'rcaron r', 0x015A: 'Sacute S', 0x015B: 'sacute s',
  0x015E: 'Scedilla S', 0x015F: 'scedilla s', 0x0162: 'Tcommaaccent T', 0x0163: 'tcommaaccent t', 0x0164: 'Tcaron T', 0x0165: 'tcaron t',
  0x016A: 'Umacron U', 0x016B: 'umacron u', 0x016E: 'Uring U', 0x016F: 'uring u', 0x0170: 'Uhungarumlaut U', 0x0171: 'uhungarumlaut u',
  0x0172: 'Uogonek U', 0x0173: 'uogonek u', 0x0179: 'Zacute Z', 0x017A: 'zacute z', 0x017B: 'Zdotaccent Z', 0x017C: 'zdotaccent z',
  0x0218: 'Scommaaccent S', 0x0219: 'scommaaccent s', 0x021A: 'Tcommaaccent T', 0x021B: 'tcommaaccent t',
}).map(([cp, v]) => { const [name, base] = v.split(' '); return [Number(cp), { name, base }]; }));
// codes WinAnsiEncoding leaves empty, given to those letters as drawn
const EXTRA_CODES = [...Array.from({ length: 31 }, (_, i) => i + 1), 0x7F, 0x81, 0x8D, 0x8F, 0x90, 0x9D];

/** True if the standard Times and Courier faces can draw every character */
export function standardCovers(s) {
  for (const ch of String(s)) if (!isWinAnsi(ch) && !EXTRA_GLYPHS.has(ch.codePointAt(0))) return false;
  return true;
}

/**
 * Bytes for a standard font: WinAnsi codes, and for a Latin Extended-A
 * letter the code `extra` (Map code point → code, shared by the document)
 * gives it, allocated on first use while codes last.
 */
export function encodeStandard(s, extra) {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (extra && EXTRA_GLYPHS.has(cp)) {
      let code = extra.get(cp);
      if (code === undefined && extra.size < EXTRA_CODES.length) extra.set(cp, code = EXTRA_CODES[extra.size]);
      if (code !== undefined) { out += String.fromCharCode(code); continue; }
    }
    out += toWinAnsi(ch);
  }
  return out;
}

const FALLBACK = { 0x2212: '-', 0x2010: '-', 0x2011: '-', 0x2043: '-', 0x25CF: '\x95', 0x25AA: '\x95' };

/**
 * Map a JS string to WinAnsi byte-characters. Characters outside WinAnsi
 * lose their diacritic when the base letter fits (ș → s), otherwise '?'.
 * (Standard 14 fonts are WinAnsi-only; full Unicode needs an embedded font.)
 */
export function toWinAnsi(s) {
  if (!s) return '';
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code === 0x00A0) out += ' ';
    else if ((code >= 0x20 && code < 0x7F) || (code >= 0xA0 && code <= 0xFF)) out += ch;
    else if (code === 0x09) out += ' ';
    else if (CP1252[code]) out += String.fromCharCode(CP1252[code]);
    else if (FALLBACK[code]) out += FALLBACK[code];
    else if (code < 0x20) out += '';
    else {
      // outside WinAnsi: drop the diacritic if the base letter fits (ș → s), else '?'
      const base = ch.normalize('NFD')[0];
      const b = base.codePointAt(0);
      out += base !== ch && ((b >= 0x20 && b < 0x7F) || (b >= 0xA0 && b <= 0xFF)) ? base : '?';
    }
  }
  return out;
}

// a byte string (encodeStandard) as a literal: control bytes octal-escaped,
// so no CR or LF is taken for a line end
function escapeBytes(bytes) {
  return bytes.replace(/[\\()]/g, c => `\\${c}`).replace(/[\x00-\x1f\x7f]/g, c => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);
}

function escapeText(text) {
  return toWinAnsi(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}
