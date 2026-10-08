/**
 * Purefield / core / substitute.js
 *
 * Fonts a page uses without embedding them, embedded as Acrobat prints
 * them: a substitute's glyphs at the font's own widths. Acrobat draws such
 * text with its multiple-master Adobe Sans or Serif, each glyph stretched
 * to the width the font declares; other viewers pick whatever font they
 * have, so lines run long or short. Here each such font becomes an
 * embedded TrueType program built for it alone, one glyph per code, every
 * glyph scaled horizontally to its declared width (centred when the scale
 * would pass 0.6–1.6), from the bundled face that suits it:
 *
 *   monospaced (FixedPitch, Courier, Consolas…)      Liberation Mono
 *   serif (Serif flag, Times, Georgia, Garamond…)    Liberation Serif
 *   sans                                             Liberation Sans or
 *                                                    Source Sans Pro, the
 *                                                    better fit to the widths
 *   characters those lack (Arabic…)                  DejaVu Sans
 *
 * in its weight and posture (bold: the ForceBold flag, a weight of 600 or
 * more, or Bold/Black/Semibold in the name; italic: the Italic flag, an
 * italic angle, or Italic/Oblique in the name).
 *
 *   simple fonts   Type1, MMType1 and TrueType: each code's glyph name
 *                  (/Encoding, its /Differences over the base encoding)
 *                  gives the character, else /ToUnicode; the font becomes
 *                  a symbolic TrueType font addressed by code, keeping its
 *                  /Widths (none: the substitute's own) and gaining a
 *                  /ToUnicode
 *   Type0 fonts    with Identity-H or -V: /ToUnicode gives each CID's
 *                  character (a TrueType CIDFont without one: the Windows
 *                  font's glyph order); the CIDFont gets a program and a
 *                  /CIDToGIDMap, keeping its /W and /DW
 *   CJK fonts      with a predefined CMap (90ms-RKSJ-H, GBK-EUC-H…), when a
 *                  CJK TrueType font is supplied (load('CJK')): an
 *                  embedded CMap over the codes the pages show, each
 *                  drawn with the CJK font (core/cjk.js decodes them)
 *
 * Left as they are: the standard 14 fonts every viewer has, symbolic fonts
 * without an encoding (Wingdings, Symbol, Dingbats: no bundled glyphs),
 * CJK fonts when no CJK font is supplied, CID fonts with CMaps that are
 * not predefined, and CFF CID fonts without a /ToUnicode (their CIDs name
 * glyphs of a collection we have no table of).
 */

import { parseTtf } from './ttf.js';
import { glyphContours, scaleContours, buildTtf, postNames } from './outline.js';
import { baseEncoding, StandardEncoding, WinAnsiEncoding } from './encodings.js';
import { glyphMapFor } from './glyphmaps.js';
import { predefinedCMap, splitCodes } from './cjk.js';

const STANDARD_14 = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold',
  'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats']);
const FIXED = 1, SERIF = 2, SYMBOLIC = 4, ITALIC = 64, NONSYMBOLIC = 32, FORCE_BOLD = 262144;
const MIN_SCALE = 0.6, MAX_SCALE = 1.6;
// fonts of symbols, not letters: no bundled glyphs draw them
const SYMBOL_FONTS = /wingding|webding|symbol|dingbat|marlett|mtextra|bookshelf|zapf/i;

// glyph names outside the bundled fonts' post tables
const EXTRA_NAMES = { fi: 0xFB01, fl: 0xFB02, ff: 0xFB00, ffi: 0xFB03, ffl: 0xFB04, nbspace: 0xA0, nonbreakingspace: 0xA0,
  sfthyphen: 0xAD, softhyphen: 0xAD, middot: 0xB7, overscore: 0xAF, Ohm: 0x2126, Euro: 0x20AC, dotlessj: 0x237,
  apple: 0xF8FF, mu1: 0xB5, Delta: 0x2206, Omega: 0x2126, Tcommaaccent: 0x162, tcommaaccent: 0x163, Scommaaccent: 0x218, scommaaccent: 0x219 };

/**
 * A substitute faces source: loads and caches the bundled faces by name.
 * @param {(name: string) => Promise<Uint8Array>} load
 */
export function substituteFaces(load) {
  const cache = new Map();
  let names = null;
  const face = name => {
    if (!cache.has(name)) cache.set(name, load(name).then(b => parseTtf(b)).catch(() => null));
    return cache.get(name);
  };
  return {
    face,
    // glyph name → code point, read from Liberation Sans's glyph names
    async names() {
      if (!names) {
        const lib = await face('LiberationSans-Regular');
        names = new Map();
        if (lib) for (const [n, g] of postNames(lib)) { const u = lib.unicodeOf(g); if (u !== null) names.set(n, u); }
      }
      return names;
    },
    async unicodeOfName(name) {
      return nameToUnicode(name, await this.names());
    },
  };
}

export function nameToUnicode(name, names = new Map()) {
  if (!name || name === '.notdef') return null;
  if (EXTRA_NAMES[name] !== undefined) return EXTRA_NAMES[name];
  if (names.has(name)) return names.get(name);
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (m) return parseInt(m[1], 16);
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return parseInt(m[1], 16);
  // a suffixed variant ("a.sc", "one.oldstyle"): its base
  const dot = name.indexOf('.');
  if (dot > 0) return nameToUnicode(name.slice(0, dot), names);
  return null;
}

/**
 * The font's replacement, or null to copy it as it is.
 * @param {object} d - the font dictionary (parser values)
 * @param {{ resolve, stream, serialize, add, ref, deflate, faces, log }} api
 * @returns {Promise<string|null>} the new font dictionary
 */
export async function substituteFont(d, api) {
  const subtype = d.Subtype?.value;
  if (subtype === 'Type0') return substituteType0(d, api);
  if (subtype !== 'Type1' && subtype !== 'TrueType' && subtype !== 'MMType1') return null;
  const baseFont = String(d.BaseFont?.value ?? '');
  const plain = baseFont.replace(/^[A-Z]{6}\+/, '');
  const fd = dictOf(await api.resolve(d.FontDescriptor));
  if (fd && (fd.FontFile || fd.FontFile2 || fd.FontFile3)) return null;
  // a name in another script (a GBK-encoded Chinese font name): its codes
  // are not Latin text
  if (STANDARD_14.has(plain) || !plain || /[^\x20-\x7E]/.test(plain)) return null;
  const flags = Number(await api.resolve(fd?.Flags)) || 0;

  // each code's character: encoding names, else /ToUnicode
  const enc = await api.resolve(d.Encoding);
  const encDict = dictOf(enc);
  const symbolic = (flags & SYMBOLIC) && !(flags & NONSYMBOLIC);
  if ((symbolic && !enc) || SYMBOL_FONTS.test(plain)) {
    api.log?.once?.('info', 'FONT_NOT_SUBSTITUTED', plain, `symbol font ${plain} is not embedded and has no substitute`);
    return null;
  }
  const baseName = enc?.type === 'name' ? enc.value : (await api.resolve(encDict?.BaseEncoding))?.value;
  const names = [...(baseEncoding(baseName) ?? (subtype === 'TrueType' ? WinAnsiEncoding : StandardEncoding))];
  const diffs = await api.resolve(encDict?.Differences);
  if (diffs?.type === 'array') {
    let code = 0;
    for (const item of diffs.value) {
      const v = await api.resolve(item);
      if (typeof v === 'number') code = v;
      else if (v?.type === 'name' && code < 256) names[code++] = v.value;
    }
  }
  const toUnicode = await readToUnicode(d.ToUnicode, api);
  const chars = new Map();
  for (let code = 0; code < 256; code++) {
    let u = await api.faces.unicodeOfName(names[code]);
    if (u === null && toUnicode.has(code)) u = toUnicode.get(code);
    if (u !== null && u !== undefined) chars.set(code, u);
  }
  if (!chars.size) return null;

  // declared widths, in 1000 units
  const first = Number(await api.resolve(d.FirstChar)) || 0;
  const widthsArr = await api.resolve(d.Widths);
  const widths = new Map();
  if (widthsArr?.type === 'array') {
    let i = 0;
    for (const w of widthsArr.value) widths.set(first + i++, Number(await api.resolve(w)) || 0);
  }
  const candidates = await facesFor(plain, fd, flags, api);
  if (!candidates.length) return null;
  const pick = choose(candidates, chars, widths);

  // glyph 0 is .notdef; then one glyph per code
  const glyphs = [{ contours: [], advance: 0 }];
  const codes = new Map(), used = new Map();
  for (const [code, u] of chars) {
    if (widths.size && !widths.has(code)) continue;
    const g = glyphOf(pick, candidates, u, widths.get(code));
    if (!g) continue;
    codes.set(code, glyphs.length);
    used.set(code, u);
    glyphs.push(g.glyph);
  }
  if (!codes.size) return null;
  const tag = subsetTag(plain + [...codes.keys()].join());
  const program = buildTtf(pick, glyphs, { codes });
  const fontFile = await addFontFile(program, api);
  const descriptor = api.add({ body: descriptorBody(`${tag}+${pdfName(plain)}`, pick, fd, flags, fontFile, true, api) });
  const tu = await addToUnicode(used, 1, api);
  let widthsPart;
  if (widths.size) {
    widthsPart = `/FirstChar ${first} /LastChar ${first + widths.size - 1} /Widths ${await api.serialize(d.Widths)}`;
  } else {
    // none declared: the substitute's own advances
    const lo = Math.min(...codes.keys()), hi = Math.max(...codes.keys());
    const ws = [];
    for (let c = lo; c <= hi; c++) ws.push(codes.has(c) ? Math.round(glyphs[codes.get(c)].advance * 1000 / pick.unitsPerEm) : 0);
    widthsPart = `/FirstChar ${lo} /LastChar ${hi} /Widths [${ws.join(' ')}]`;
  }
  api.log?.once?.('info', 'FONT_SUBSTITUTED', plain, `${plain} is not embedded: drawn with ${pick.label} glyphs at its widths`);
  return `<< /Type /Font /Subtype /TrueType /BaseFont /${tag}+${pdfName(plain)} ${widthsPart} /FontDescriptor ${api.ref(descriptor)} /ToUnicode ${api.ref(tu)} >>`;
}

async function substituteType0(d, api) {
  const enc = await api.resolve(d.Encoding);
  const encName = enc?.type === 'name' ? enc.value : null;
  if (encName && encName !== 'Identity-H' && encName !== 'Identity-V') return substituteCjk(d, api, encName);
  if (encName !== 'Identity-H' && encName !== 'Identity-V') return null;
  const descArr = await api.resolve(d.DescendantFonts);
  const cidRef = descArr?.type === 'array' ? descArr.value[0] : null;
  const cid = dictOf(await api.resolve(cidRef));
  if (!cid || (cid.Subtype?.value !== 'CIDFontType2' && cid.Subtype?.value !== 'CIDFontType0')) return null;
  const fd = dictOf(await api.resolve(cid.FontDescriptor));
  if (!fd || fd.FontFile || fd.FontFile2 || fd.FontFile3) return null;
  const plain = String(d.BaseFont?.value ?? cid.BaseFont?.value ?? '').replace(/^[A-Z]{6}\+/, '').replace(/-Identity-[HV]$/, '');
  if (SYMBOL_FONTS.test(plain)) return null;
  let toUnicode = await readToUnicode(d.ToUnicode, api);
  const ownToUnicode = !!toUnicode.size;
  // a CIDFontType0 (CFF) font's CIDs are its collection's: only a
  // /ToUnicode says what they are
  if (!ownToUnicode && cid.Subtype?.value !== 'CIDFontType2') return null;
  const tuName = (await api.resolve(d.ToUnicode))?.type === 'name' ? (await api.resolve(d.ToUnicode)).value : null;
  if (!toUnicode.size && (tuName === 'Identity-H' || tuName === 'Identity-V')) {
    // /ToUnicode /Identity-H: each CID is its own character, for the CIDs
    // its /CIDToGIDMap or /W names
    const mapBytes = cid.CIDToGIDMap?.type === 'ref' ? await api.stream(cid.CIDToGIDMap) : null;
    const cids = new Set((await readW(cid.W, api)).keys());
    if (mapBytes) for (let c = 0; 2 * c + 1 < mapBytes.length; c++) if (mapBytes[2 * c] | mapBytes[2 * c + 1]) cids.add(c);
    for (const c of cids) if (c >= 32 && (c < 0xD800 || c > 0xDFFF)) toUnicode.set(c, c);
  }
  if (!toUnicode.size) {
    // no /ToUnicode: the CIDs are glyph numbers of the font named, read
    // through its known glyph order (Arial, Times New Roman…), through
    // /CIDToGIDMap when it has one
    const names = await api.faces.names();
    const gidMap = glyphMapFor(plain, n => nameToUnicode(n, names));
    if (!gidMap) {
      api.log?.once?.('info', 'FONT_NOT_SUBSTITUTED', plain, `${plain} is not embedded and has no /ToUnicode: its glyph numbers cannot be read`);
      return null;
    }
    const mapBytes = cid.CIDToGIDMap?.type === 'ref' ? await api.stream(cid.CIDToGIDMap) : null;
    toUnicode = new Map();
    if (mapBytes) {
      for (let c = 0; 2 * c + 1 < mapBytes.length; c++) {
        const u = gidMap.get((mapBytes[2 * c] << 8) | mapBytes[2 * c + 1]);
        if (u !== undefined) toUnicode.set(c, u);
      }
    } else {
      for (const [g, u] of gidMap) toUnicode.set(g, u);
    }
    api.log?.once?.('info', 'FONT_GLYPH_ORDER', plain, `${plain} has no /ToUnicode: its CIDs read as the Windows font's glyph numbers`);
  }
  const flags = Number(await api.resolve(fd.Flags)) || 0;
  const dw = Number(await api.resolve(cid.DW)) || 1000;
  const widths = await readW(cid.W, api);
  const candidates = await facesFor(plain, fd, flags, api);
  // Chinese, Japanese and Korean characters: the CJK font supplied, if any
  if ([...toUnicode.values()].some(isCjkChar)) {
    const cjk = await api.faces.face('CJK');
    if (cjk) candidates.push({ ...cjk, label: 'CJK', fallback: true, cjk: true });
  }
  if (!candidates.length) return null;
  const pick = choose(candidates, toUnicode, widths);

  const glyphs = [{ contours: [], advance: 0 }];
  const cidToGid = new Map(), used = new Map();
  for (const [c, u] of [...toUnicode].sort((a, b) => a[0] - b[0])) {
    if (c > 0xFFFF) continue;
    const g = glyphOf(pick, candidates, u, widths.get(c) ?? dw);
    if (!g) continue;
    cidToGid.set(c, glyphs.length);
    used.set(c, u);
    glyphs.push(g.glyph);
  }
  if (!cidToGid.size) return null;
  const maxCid = Math.max(...cidToGid.keys());
  const map = new Uint8Array(2 * (maxCid + 1));
  for (const [c, g] of cidToGid) { map[2 * c] = g >> 8; map[2 * c + 1] = g & 0xFF; }
  const mapBytes = await api.deflate(map);
  const mapRef = api.add({ head: `<< /Filter /FlateDecode /Length ${mapBytes.length} >>`, bytes: mapBytes });
  const tag = subsetTag(plain + [...cidToGid.keys()].join());
  const program = buildTtf(pick, glyphs);
  const fontFile = await addFontFile(program, api);
  const descriptor = api.add({ body: descriptorBody(`${tag}+${pdfName(plain)}`, pick, fd, flags, fontFile, false, api) });
  let cidBody = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${tag}+${pdfName(plain)}`
    + ` /CIDSystemInfo ${await api.serialize(cid.CIDSystemInfo ?? null) === 'null' ? '<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>' : await api.serialize(cid.CIDSystemInfo)}`
    + ` /FontDescriptor ${api.ref(descriptor)} /DW ${dw} /CIDToGIDMap ${api.ref(mapRef)}`;
  if (cid.W) cidBody += ` /W ${await api.serialize(cid.W)}`;
  const cidNum = api.add({ body: cidBody + ' >>' });
  api.log?.once?.('info', 'FONT_SUBSTITUTED', plain, `${plain} is not embedded: drawn with ${pick.label} glyphs at its widths`);
  const tu = ownToUnicode ? await api.serialize(d.ToUnicode) : api.ref(await addToUnicode(used, 2, api));
  return `<< /Type /Font /Subtype /Type0 /BaseFont /${tag}+${pdfName(plain)} /Encoding /${encName} /DescendantFonts [${api.ref(cidNum)}] /ToUnicode ${tu} >>`;
}

// A CJK font with a predefined CMap (90ms-RKSJ-H, GBK-EUC-H, UniJIS-UCS2-H…)
// that is not embedded, drawn by Reader with its own Japanese, Chinese or
// Korean fonts and by viewers without them not at all: with a CJK
// TrueType font supplied (fonts/CJK.ttf, load('CJK')), an embedded font of
// the codes the pages show. The strings keep their bytes: an embedded CMap
// with the predefined one's code space ranges gives each code a CID, the
// CJK font's glyph for its character (the CMap's encoding decoded) at the
// font's width (/W of a Japanese single byte's half-width CID, else /DW:
// Reader advances "(57)" and a Korean space a full em with no /W),
// centred in it.
async function substituteCjk(d, api, encName) {
  const cmap = predefinedCMap(encName);
  if (!cmap) return null;
  const descArr = await api.resolve(d.DescendantFonts);
  const cid = dictOf(await api.resolve(descArr?.type === 'array' ? descArr.value[0] : null));
  if (!cid) return null;
  const fd = dictOf(await api.resolve(cid.FontDescriptor));
  if (fd && (fd.FontFile || fd.FontFile2 || fd.FontFile3)) return null;
  const plain = String(d.BaseFont?.value ?? cid.BaseFont?.value ?? '').replace(/^[A-Z]{6}\+/, '').replace(new RegExp(`-${encName}$`), '');
  const face = await api.faces.face('CJK');
  if (!face) {
    api.log?.once?.('info', 'FONT_CJK_NOT_EMBEDDED', plain, `CJK font ${plain} (${encName}) is not embedded; supply a CJK TrueType font as fonts/CJK.ttf to embed a substitute`);
    return null;
  }
  // the codes the pages show, in order of their bytes
  const codes = new Map();
  for (const bytes of await api.shown?.() ?? []) {
    for (const c of splitCodes(bytes, cmap.ranges)) codes.set(hexOf(c), c);
  }
  if (!codes.size) return null;
  const dw = Number(await api.resolve(cid.DW)) || 1000;
  const widths = await readW(cid.W, api);
  const latin = await api.faces.face('LiberationSans-Regular');
  const glyphs = [{ contours: [], advance: 0 }];
  const entries = [];  // [code bytes, CID, code point]
  const ws = [];
  for (const [, code] of [...codes].sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))) {
    const u = cmap.decode(code);
    if (u === null) continue;
    const half = cmap.halfWidthCid(code);
    const width = code.length === 1 && half !== null && widths.has(half) ? widths.get(half) : dw;
    const f = face.glyphFor(u) || u === 0x20 ? face : latin?.glyphFor(u) ? latin : null;
    if (!f) continue;
    const g = f.glyphFor(u);
    const k = face.unitsPerEm / f.unitsPerEm;
    const target = width * face.unitsPerEm / 1000;
    const natural = g ? f.advance(g) * k : target;
    let contours = g ? glyphContours(f, g).map(c => c.map(p => ({ x: p.x * k, y: p.y * k, on: p.on }))) : [];
    contours = scaleContours(contours, 1, (target - natural) / 2);
    entries.push([code, glyphs.length, u]);
    ws.push(width);
    glyphs.push({ contours, advance: target });
  }
  if (!entries.length) return null;

  const tag = subsetTag(plain + encName + [...codes.keys()].join());
  const name = `${tag}+${pdfName(plain)}`;
  const program = buildTtf(face, glyphs);
  const fontFile = await addFontFile(program, api);
  const flags = Number(await api.resolve(fd?.Flags)) || 4;
  const descriptor = api.add({ body: descriptorBody(name, face, fd, flags, fontFile, false, api) });
  // CIDs 1… are the glyphs 1… of the program
  const cidNum = api.add({ body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name}`
    + ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>'
    + ` /FontDescriptor ${api.ref(descriptor)} /DW ${dw} /W [1 [${ws.join(' ')}]] /CIDToGIDMap /Identity`
    + (cid.DW2 ? ` /DW2 ${await api.serialize(cid.DW2)}` : '') + ' >>' });
  const space = cmap.ranges.map(x => `<${hexOf(x.lo)}> <${hexOf(x.hi)}>`);
  const encoding = await addCMap(`Jcs-${tag}-${encName}`, space, 'cidchar', entries.map(([c, n]) => `<${hexOf(c)}> ${n}`), cmap.wmode, api);
  const tu = await addCMap('Adobe-Identity-UCS', space, 'bfchar', entries.map(([c, , u]) => `<${hexOf(c)}> <${utf16Hex(u)}>`), null, api);
  api.log?.once?.('info', 'FONT_SUBSTITUTED', plain, `${plain} is not embedded: drawn with the CJK font supplied, ${entries.length} character(s) embedded`);
  return `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding ${api.ref(encoding)} /DescendantFonts [${api.ref(cidNum)}] /ToUnicode ${api.ref(tu)} >>`;
}

// CJK ideographs, kana, Hangul, CJK punctuation and full-width forms
const isCjkChar = u => (u >= 0x2E80 && u <= 0x9FFF) || (u >= 0xAC00 && u <= 0xD7AF) || (u >= 0xF900 && u <= 0xFAFF)
  || (u >= 0xFF00 && u <= 0xFFEF) || (u >= 0x20000 && u <= 0x3FFFF);

const hexOf = bytes => Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const utf16Hex = cp => {
  const h = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  return cp > 0xFFFF ? h(0xD800 + ((cp - 0x10000) >> 10)) + h(0xDC00 + ((cp - 0x10000) & 0x3FF)) : h(cp);
};

// An embedded CMap stream: an encoding (cidchar entries, wmode 0 or 1) or a
// ToUnicode CMap (bfchar entries, wmode null), over the code space given
async function addCMap(name, space, kind, entries, wmode, api) {
  const lines = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (${wmode === null ? 'UCS' : 'Identity'}) /Supplement 0 >> def`,
    `/CMapName /${name} def`, `/CMapType ${wmode === null ? 2 : 1} def`];
  if (wmode !== null) lines.push(`/WMode ${wmode} def`);
  lines.push(`${space.length} begincodespacerange`, ...space, 'endcodespacerange');
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    lines.push(`${part.length} begin${kind}`, ...part, `end${kind}`);
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  const z = await api.deflate(new TextEncoder().encode(lines.join('\n')));
  const head = wmode === null ? '' : ` /Type /CMap /CMapName /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /WMode ${wmode}`;
  return api.add({ head: `<<${head} /Filter /FlateDecode /Length ${z.length} >>`, bytes: z });
}

// ---------------------------------------------------------------------------

/** The style and class of a font from its name and descriptor */
export function classify(name, flags = 0, weight = 0, italicAngle = 0) {
  const n = name.toLowerCase().replace(/[\s_-]/g, '');
  const bold = !!(flags & FORCE_BOLD) || weight >= 600 || /bold|black|heavy|semibold|demibold|demi\b|extrab/.test(n);
  const italic = !!(flags & ITALIC) || (italicAngle && Math.abs(italicAngle) > 1) || /italic|oblique|kursiv|slant/.test(n);
  const mono = !!(flags & FIXED) || /courier|mono|consol|typewriter|lucidaconsole|andale|fixedsys|ocr/.test(n);
  const sansName = /sans|arial|helv|gothic|verdana|tahoma|calibri|segoe|trebuchet|frutiger|univers|futura|lucida|myriad|candara|corbel|franklin|geneva|optima|gill/.test(n);
  const serifName = /times|roman|serif|georgia|garamond|cambria|palatino|antiqua|bookman|century|bodoni|baskerville|minion|caslon|didot|goudy|perpetua|rockwell|constantia|schoolbook|charter|utopia|cochin|plantin|sabon|bembo|mincho|song|ming/.test(n);
  const serif = !mono && (serifName && !sansName ? true : sansName ? false : !!(flags & SERIF));
  return { bold, italic, mono, serif };
}

async function facesFor(name, fd, flags, api) {
  const weight = Number(await api.resolve(fd?.FontWeight)) || 0;
  const angle = Number(await api.resolve(fd?.ItalicAngle)) || 0;
  const { bold, italic, mono, serif } = classify(name, flags, weight, angle);
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  const ss = { Regular: 'Regular', Bold: 'Bold', Italic: 'It', BoldItalic: 'BoldIt' }[style];
  const names = mono ? [`LiberationMono-${style}`] : serif ? [`LiberationSerif-${style}`] : [`LiberationSans-${style}`, `SourceSansPro-${ss}`];
  const out = [];
  for (const n of names) {
    const f = await api.faces.face(n);
    if (f) out.push({ ...f, label: n });
  }
  // the regular sans last, for characters the others lack: the widest coverage
  const fallback = await api.faces.face('LiberationSans-Regular');
  if (fallback && !out.some(o => o.label === 'LiberationSans-Regular')) out.push({ ...fallback, label: 'LiberationSans-Regular', fallback: true });
  // other alphabets (Arabic, Armenian, Georgian…): DejaVu Sans
  const other = await api.faces.face('DejaVuSans');
  if (other) out.push({ ...other, label: 'DejaVuSans', fallback: true });
  return out;
}

// The candidate whose glyph widths are closest in proportion to the
// declared ones (letters and digits), the first one without widths
function choose(candidates, chars, widths) {
  const own = candidates.filter(c => !c.fallback);
  if (!widths.size || own.length <= 1) return candidates[0];
  let best = own[0], bestMisfit = Infinity;
  for (const c of own) {
    const ratios = [];
    for (const [code, u] of chars) {
      if (!/[A-Za-z0-9]/.test(String.fromCodePoint(u))) continue;
      const w = widths.get(code), g = c.glyphFor(u);
      if (!w || !g) continue;
      ratios.push(Math.log(w / (c.advance(g) * 1000 / c.unitsPerEm)));
    }
    if (!ratios.length) continue;
    const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    const misfit = Math.sqrt(ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length);
    if (misfit < bestMisfit - 1e-9) { best = c; bestMisfit = misfit; }
  }
  return best;
}

// A code's glyph from the picked face (else another candidate that has the
// character), scaled to the declared width (1000 units) in the picked
// face's units
function glyphOf(pick, candidates, u, width) {
  const upem = pick.unitsPerEm;
  const target = width !== undefined ? width * upem / 1000 : null;
  for (const f of [pick, ...candidates.filter(c => c !== pick)]) {
    let g = f.glyphFor(u);
    if (!g && u === 0xA0) g = f.glyphFor(0x20);
    if (!g && u !== 0x20) continue;
    const k = upem / f.unitsPerEm; // another face's units into the picked one's
    let contours = g ? glyphContours(f, g).map(c => c.map(p => ({ x: p.x * k, y: p.y * k, on: p.on }))) : [];
    const natural = (g ? f.advance(g) : f.advance(f.glyphFor(0x20))) * k;
    if (target === null || !natural) return { glyph: { contours, advance: target ?? natural } };
    const s = target / natural;
    // CJK glyphs are centred in their width, not stretched to it
    const sx = f.cjk ? 1 : Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    contours = scaleContours(contours, sx, (target - natural * sx) / 2);
    return { glyph: { contours, advance: target } };
  }
  return null;
}

async function readToUnicode(ref, api) {
  const out = new Map();
  if (!ref) return out;
  const bytes = await api.stream(ref);
  if (!bytes) return out;
  return parseToUnicode(new TextDecoder('latin1').decode(bytes));
}

/** A ToUnicode CMap's code → first code point (a ligature's own character) */
export function parseToUnicode(text) {
  const out = new Map();
  const hex = s => parseInt(s, 16);
  const chars = s => {
    const units = [];
    for (let i = 0; i + 4 <= s.length; i += 4) units.push(hex(s.slice(i, i + 4)));
    if (s.length === 2) units.push(hex(s));
    const str = String.fromCharCode(...units);
    const lig = { ff: 0xFB00, fi: 0xFB01, fl: 0xFB02, ffi: 0xFB03, ffl: 0xFB04 }[str];
    return lig ?? str.codePointAt(0);
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) if (m[2]) out.set(hex(m[1]), chars(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = hex(m[1]), hi = Math.min(hex(m[2]), lo + 0xFFFF);
      if (m[3].startsWith('[')) {
        const list = [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map(x => x[1]);
        list.forEach((s, i) => { if (s && lo + i <= hi) out.set(lo + i, chars(s)); });
      } else {
        const start = chars(m[3].slice(1, -1));
        for (let c = lo; c <= hi; c++) out.set(c, start + (c - lo));
      }
    }
  }
  return out;
}

async function readW(w, api) {
  const out = new Map();
  const arr = await api.resolve(w);
  if (arr?.type !== 'array') return out;
  const items = [];
  for (const it of arr.value) items.push(await api.resolve(it));
  for (let i = 0; i < items.length;) {
    const c = Number(items[i]);
    const next = items[i + 1];
    if (next?.type === 'array') {
      let k = 0;
      for (const x of next.value) out.set(c + k++, Number(await api.resolve(x)) || 0);
      i += 2;
    } else {
      const hi = Number(next), wv = Number(items[i + 2]);
      for (let k = c; k <= hi && k - c < 0x10000; k++) out.set(k, wv);
      i += 3;
    }
  }
  return out;
}

async function addFontFile(program, api) {
  const z = await api.deflate(program);
  return api.add({ head: `<< /Filter /FlateDecode /Length1 ${program.length} /Length ${z.length} >>`, bytes: z });
}

function descriptorBody(name, face, fd, flags, fontFile, simple, api) {
  const k = 1000 / face.unitsPerEm;
  const f = simple ? ((flags & ~NONSYMBOLIC) | SYMBOLIC) : flags;
  return `<< /Type /FontDescriptor /FontName /${name} /Flags ${f} /FontBBox [${face.bbox.map(v => Math.round(v * k)).join(' ')}]`
    + ` /ItalicAngle ${face.italicAngle} /Ascent ${Math.round(face.ascent * k)} /Descent ${Math.round(face.descent * k)}`
    + ` /CapHeight ${Math.round(face.capHeight * k)} /StemV 80 /FontFile2 ${api.ref(fontFile)} >>`;
}

async function addToUnicode(used, bytesPerCode, api) {
  const hex = (n, len) => n.toString(16).toUpperCase().padStart(len, '0');
  const utf16 = cp => (cp > 0xFFFF ? hex(0xD800 + ((cp - 0x10000) >> 10), 4) + hex(0xDC00 + ((cp - 0x10000) & 0x3FF), 4) : hex(cp, 4));
  const entries = [...used].sort((a, b) => a[0] - b[0]);
  const chunks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.map(([c, u]) => `<${hex(c, 2 * bytesPerCode)}> <${utf16(u)}>`).join('\n')}\nendbfchar`);
  }
  const text = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', `<${'00'.repeat(bytesPerCode)}> <${'FF'.repeat(bytesPerCode)}>`, 'endcodespacerange',
    ...chunks, 'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'].join('\n');
  const z = await api.deflate(new TextEncoder().encode(text));
  return api.add({ head: `<< /Filter /FlateDecode /Length ${z.length} >>`, bytes: z });
}

function subsetTag(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let tag = '';
  for (let i = 0; i < 6; i++) { tag += String.fromCharCode(65 + (h % 26)); h = Math.floor(h / 26) + i * 7919; }
  return tag;
}

function pdfName(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    out += c > 0x20 && c < 0x7F && !'()<>[]{}/%#'.includes(ch) ? ch : `#${(c & 0xFF).toString(16).padStart(2, '0')}`;
  }
  return out;
}

function dictOf(v) {
  if (!v) return null;
  if (v.type === 'dict') return v.value;
  if (v.value?.type === 'dict') return v.value.value;
  if (typeof v === 'object' && !v.type) return v;
  return null;
}
