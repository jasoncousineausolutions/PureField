/**
 * Purefield / core / embed.js
 *
 * Prepares embedded TrueType faces for PdfWriter as Type 0 / CIDFontType2
 * fonts with Identity-H encoding (CID = glyph id): a subset font program
 * holding only the glyphs drawn, a W widths array, and a ToUnicode CMap so
 * the flattened text stays searchable and copyable.
 */

/**
 * @param {Map<object, Map<number, number>>} glyphUsage - parsed ttf → (gid → code point)
 * @returns {Promise<object[]>} writer `embeddedFonts` entries
 */
export async function buildEmbeddedFonts(glyphUsage) {
  const out = [];
  for (const [ttf, used] of glyphUsage) {
    // a standard CJK font: not embedded, named with its collection's CMap
    if (ttf.cjk) {
      out.push({ resName: ttf.resName, cjk: true, baseFont: ttf.baseFont, cmap: ttf.cmap, ordering: ttf.ordering, supplement: ttf.supplement });
      continue;
    }
    // a face whose runs drew only .notdef is still named by the content
    // stream: embed it with glyph 0 alone (campania-scia-it drew symbol codes
    // no bundled face has)
    const gids = used.size ? [...used.keys()].sort((a, b) => a - b) : [0];
    const program = ttf.subset(gids);
    const scale = 1000 / ttf.unitsPerEm;
    // advanceFor: a face whose widths differ from its glyph program (Myriad stand-in)
    const adv = g => (ttf.advanceFor ? ttf.advanceFor(g, used.get(g)) : ttf.advance(g));
    const w = gids.map(g => `${g} [${Math.round(adv(g) * scale)}]`).join(' ');
    const tag = subsetTag(gids);
    out.push({
      resName: ttf.resName,
      baseFont: `${tag}+${ttf.psName ?? 'LiberationSans'}`,
      fontFile: await deflate(program),
      fontFileLength1: program.length,
      widths: `[${w}]`,
      ascent: Math.round(ttf.ascent * scale),
      descent: Math.round(ttf.descent * scale),
      capHeight: Math.round(ttf.capHeight * scale),
      italicAngle: ttf.italicAngle,
      bbox: ttf.bbox.map(v => Math.round(v * scale)),
      toUnicode: await deflate(new TextEncoder().encode(toUnicodeCMap(used))),
    });
  }
  return out;
}

function toUnicodeCMap(used) {
  const hex4 = n => n.toString(16).padStart(4, '0');
  const utf16 = cp => cp > 0xFFFF
    ? hex4(0xD800 + ((cp - 0x10000) >> 10)) + hex4(0xDC00 + ((cp - 0x10000) & 0x3FF))
    : hex4(cp);
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  const chunks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.map(([g, cp]) => `<${hex4(g)}> <${utf16(cp)}>`).join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...chunks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

// Six uppercase letters derived from the glyph set (PDF subset naming)
function subsetTag(gids) {
  let h = 2166136261;
  for (const g of gids) { h ^= g; h = Math.imul(h, 16777619) >>> 0; }
  let tag = '';
  for (let i = 0; i < 6; i++) { tag += String.fromCharCode(65 + (h % 26)); h = Math.floor(h / 26) + i * 7919; }
  return tag;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
