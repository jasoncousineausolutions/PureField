/**
 * Purefield / core / images.js
 *
 * Turns embedded image bytes into a PDF image XObject description for
 * PdfWriter, without a canvas where possible:
 *
 *   JPEG                      → passed through as DCTDecode
 *   PNG gray/RGB/palette      → IDAT passed through as FlateDecode + PNG predictor
 *   PNG with alpha (8-bit)    → decoded, composited on white, re-emitted as raw RGB
 *   GIF (first frame)         → LZW-decoded to an Indexed image, transparent
 *                               colour painted white, re-deflated
 *   BMP (uncompressed 1/4/8/24/32-bit) → RGB, deflated
 *   TIFF (first image; none/LZW/PackBits/Deflate, predictor 2; gray,
 *         RGB(A), palette, CMYK, YCbCr unsubsampled; 1/2/4/8/16-bit;
 *         chunky or planar) → RGB composited on white, deflated; CCITT
 *         fax and JPEG in one strip → passed through (CCITTFaxDecode,
 *         DCTDecode, the JPEG tables merged in)
 *   anything else (GIF, interlaced PNG, …)
 *                             → browser canvas if available, else null
 */

/** base64 → bytes (browsers and Node 16+) */
export function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} [contentType]
 * @returns {Promise<object|null>} - writer image fields (minus name) plus
 *   dpi (null if unknown), or null
 */
export async function encodeImage(bytes, contentType = '') {
  const r = await decodeAny(bytes, contentType);
  if (r && !r.dpi) r.dpi = resolution(bytes);
  // raw RGB pixels (alpha PNG, canvas fallback) are deflated rather than stored
  if (r?.pixels) {
    return { width: r.width, height: r.height, colorSpace: '/DeviceRGB', bitsPerComponent: 8,
      filter: 'FlateDecode', decodeParms: null, data: await deflate(r.pixels), dpi: r.dpi ?? null };
  }
  return r;
}

/**
 * Image resolution in dots per inch, from BMP pels/metre, PNG pHYs or the
 * JPEG JFIF density; null if the file does not say.
 */
function resolution(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x42 && bytes[1] === 0x4D && bytes.length > 46) {
    const ppm = dv.getInt32(38, true);
    return ppm > 0 ? ppm / 39.3701 : null;
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    for (let pos = 8; pos + 8 <= bytes.length;) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
      if (type === 'pHYs' && bytes[pos + 16] === 1) return dv.getUint32(pos + 8) / 39.3701;
      if (type === 'IDAT' || type === 'IEND') break;
      pos += 12 + len;
    }
    return null;
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[6] === 0x4A && bytes[7] === 0x46) {
    const units = bytes[13];
    const x = dv.getUint16(14);
    if (x > 1 && units === 1) return x;
    if (x > 1 && units === 2) return x * 2.54;
  }
  return null;
}

async function decodeAny(bytes, contentType) {
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return jpeg(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    const r = await png(bytes);
    if (r) return r;
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const r = await gif(bytes);
    if (r) return r;
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    const r = await bmp(bytes);
    if (r) return r;
  }
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42) || (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[3] === 42)) {
    const r = await tiff(bytes);
    if (r) return r;
  }
  return canvasFallback(bytes, contentType);
}

// ---------------------------------------------------------------------------
// JPEG: read the frame header for size and components
// ---------------------------------------------------------------------------

function jpeg(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const comps = bytes[i + 9];
      return {
        width, height,
        colorSpace: comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK' : '/DeviceRGB',
        bitsPerComponent: 8,
        filter: 'DCTDecode',
        decodeParms: null,
        data: bytes,
      };
    }
    i += 2 + len;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

async function png(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let ihdr = null;
  let plte = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: dv.getUint32(pos + 8), height: dv.getUint32(pos + 12),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || idat.length === 0 || ihdr.interlace !== 0) return null;
  const { width, height, bitDepth, colorType } = ihdr;
  const zdata = concat(idat);

  if (colorType === 0 || colorType === 2 || colorType === 3) {
    const colors = colorType === 2 ? 3 : 1;
    let colorSpace = colorType === 2 ? '/DeviceRGB' : '/DeviceGray';
    if (colorType === 3) {
      if (!plte) return null;
      const hex = Array.from(plte, b => b.toString(16).padStart(2, '0')).join('');
      colorSpace = `[/Indexed /DeviceRGB ${plte.length / 3 - 1} <${hex}>]`;
    }
    return {
      width, height, colorSpace, bitsPerComponent: bitDepth,
      filter: 'FlateDecode',
      decodeParms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent ${bitDepth} /Columns ${width} >>`,
      data: zdata,
    };
  }

  // Gray+alpha (4) or RGBA (6), 8-bit: unfilter, composite on white
  if ((colorType === 4 || colorType === 6) && bitDepth === 8) {
    const channels = colorType === 6 ? 4 : 2;
    const raw = unfilter(await inflate(zdata), width, height, channels);
    const rgb = new Uint8Array(width * height * 3);
    for (let p = 0, q = 0; p < raw.length; p += channels, q += 3) {
      const a = raw[p + channels - 1] / 255;
      const r = raw[p], g = channels === 4 ? raw[p + 1] : raw[p], b = channels === 4 ? raw[p + 2] : raw[p];
      rgb[q] = Math.round(r * a + 255 * (1 - a));
      rgb[q + 1] = Math.round(g * a + 255 * (1 - a));
      rgb[q + 2] = Math.round(b * a + 255 * (1 - a));
    }
    return { width, height, pixels: rgb };
  }
  return null;
}

// ---------------------------------------------------------------------------
// GIF: first frame → Indexed /DeviceRGB, FlateDecode
// ---------------------------------------------------------------------------

async function gif(bytes) {
  const u16 = i => bytes[i] | (bytes[i + 1] << 8);
  let pos = 6;
  const flags = bytes[pos + 4];
  pos += 7;
  let palette = null;
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1));
    palette = bytes.slice(pos, pos + n);
    pos += n;
  }
  let transparent = -1;
  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x21) { // extension
      if (bytes[pos + 1] === 0xF9 && (bytes[pos + 3] & 1)) transparent = bytes[pos + 6];
      pos += 2;
      while (bytes[pos] !== 0) pos += bytes[pos] + 1;
      pos++;
    } else if (block === 0x2C) { // image descriptor
      const width = u16(pos + 5), height = u16(pos + 7);
      const iflags = bytes[pos + 9];
      pos += 10;
      if (iflags & 0x80) {
        const n = 3 * (1 << ((iflags & 7) + 1));
        palette = bytes.slice(pos, pos + n);
        pos += n;
      }
      if (!palette) return null;
      const minCode = bytes[pos++];
      const chunks = [];
      while (bytes[pos] !== 0 && pos < bytes.length) { chunks.push(bytes.subarray(pos + 1, pos + 1 + bytes[pos])); pos += bytes[pos] + 1; }
      let pixels = lzw(concat(chunks), minCode, width * height);
      if (iflags & 0x40) pixels = deinterlace(pixels, width, height);
      const pal = palette.slice();
      if (transparent >= 0 && transparent * 3 + 2 < pal.length) pal.set([255, 255, 255], transparent * 3);
      const hex = Array.from(pal, b => b.toString(16).padStart(2, '0')).join('');
      return {
        width, height,
        colorSpace: `[/Indexed /DeviceRGB ${pal.length / 3 - 1} <${hex}>]`,
        bitsPerComponent: 8,
        filter: 'FlateDecode',
        decodeParms: null,
        data: await deflate(pixels),
      };
    } else {
      return null;
    }
  }
  return null;
}

function lzw(data, minCode, count) {
  const out = new Uint8Array(count);
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; }
  const stack = new Uint8Array(4097);
  let o = 0, prev = -1, bits = 0, acc = 0;
  for (let i = 0; i < data.length && o < count;) {
    while (bits < size && i < data.length) { acc |= data[i++] << bits; bits += 8; }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size; bits -= size;
    if (code === clear) { size = minCode + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) break;
    let c = code, sp = 0;
    if (code >= next) { if (prev < 0) break; stack[sp++] = first[prev]; c = prev; }
    while (c >= clear) { stack[sp++] = suffix[c]; c = prefix[c]; }
    stack[sp++] = c;
    const head = c;
    while (sp > 0 && o < count) out[o++] = stack[--sp];
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev; suffix[next] = head; first[next] = first[prev];
      next++;
      if (next === (1 << size) && size < 12) size++;
    }
    prev = code;
  }
  return out;
}

function deinterlace(px, w, h) {
  const out = new Uint8Array(px.length);
  let row = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) out.set(px.subarray(row * w, (row + 1) * w), y * w), row++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// BMP: uncompressed (BI_RGB / BI_BITFIELDS with standard masks)
// ---------------------------------------------------------------------------

async function bmp(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dibSize = dv.getUint32(14, true);
  const width = dv.getInt32(18, true);
  const rawH = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const compression = dibSize >= 40 ? dv.getUint32(30, true) : 0;
  if (width <= 0 || rawH === 0 || (compression !== 0 && compression !== 3)) return null;
  if (![1, 4, 8, 24, 32].includes(bpp)) return null;
  const height = Math.abs(rawH);
  const topDown = rawH < 0;
  let palette = null;
  if (bpp <= 8) {
    const colors = (dibSize >= 40 && dv.getUint32(46, true)) || (1 << bpp);
    palette = [];
    for (let i = 0; i < colors; i++) {
      const o = 14 + dibSize + i * 4;
      palette.push([bytes[o + 2], bytes[o + 1], bytes[o]]);
    }
  }
  const stride = Math.ceil((width * bpp) / 32) * 4;
  // bfOffBits; some writers leave it 0: the pixels then follow the header,
  // the BI_BITFIELDS masks and the palette (Acrobat reads such files)
  const masks = compression === 3 && dibSize === 40 ? 12 : 0;
  const implied = 14 + dibSize + masks + (palette ? palette.length * 4 : 0);
  let dataOffset = dv.getUint32(10, true);
  if (dataOffset < implied || dataOffset + stride * height > bytes.length) dataOffset = implied;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      let r, g, b;
      if (bpp === 24 || bpp === 32) {
        const o = row + x * (bpp / 8);
        b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
      } else {
        const bit = x * bpp;
        const byte = bytes[row + (bit >> 3)];
        const idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        [r, g, b] = palette[idx] ?? [0, 0, 0];
      }
      const q = (y * width + x) * 3;
      rgb[q] = r; rgb[q + 1] = g; rgb[q + 2] = b;
    }
  }
  return {
    width, height, colorSpace: '/DeviceRGB', bitsPerComponent: 8,
    filter: 'FlateDecode', decodeParms: null, data: await deflate(rgb),
  };
}

// ---------------------------------------------------------------------------
// TIFF: the first IFD, strips or tiles of chunky samples
// ---------------------------------------------------------------------------

async function tiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const u16 = o => dv.getUint16(o, le);
  const u32 = o => dv.getUint32(o, le);
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) return null;
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 16: 8 };
  const tags = new Map();
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    const type = u16(e + 2), count = u32(e + 4);
    const size = (SIZE[type] ?? 1) * count;
    const at = size <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < Math.min(count, 1 << 16); k++) {
      if (type === 3) vals.push(u16(at + 2 * k));
      else if (type === 4) vals.push(u32(at + 4 * k));
      else if (type === 5) vals.push(u32(at + 8 * k) / (u32(at + 8 * k + 4) || 1));
      else vals.push(bytes[at + k]);
    }
    tags.set(u16(e), vals);
  }
  const t = (id, def) => tags.get(id) ?? def;
  const width = t(256)?.[0], height = t(257)?.[0];
  const compression = t(259, [1])[0];
  const photometric = t(262, [1])[0];
  const spp = t(277, [1])[0];
  const bps = t(258, [1])[0];
  const predictor = t(317, [1])[0];
  const planar = t(284, [1])[0];
  const extra = t(338, []);
  const res = t(282, null)?.[0];
  const unit = t(296, [2])[0];
  const dpi = res > 1 ? (unit === 3 ? res * 2.54 : unit === 2 ? res : null) : null;
  if (!width || !height) return null;

  const tiled = tags.has(322);
  const tileW = tiled ? t(322)[0] : width;
  const tileH = tiled ? t(323)[0] : (t(278, [height])[0] || height);
  const offsets = tiled ? t(324, []) : t(273, []);
  const counts = tiled ? t(325, []) : t(279, []);

  // fax (CCITT Group 3 or 4) and JPEG in one strip: their data passes to the
  // PDF as it is, decoded by the viewer
  if ((compression === 2 || compression === 3 || compression === 4) && offsets.length === 1 && !tiled) {
    const t4 = t(292, [0])[0];
    const k = compression === 4 ? -1 : compression === 3 && (t4 & 1) ? 1 : 0;
    const parms = `<< /K ${k} /Columns ${width} /Rows ${height}${compression === 2 || (t4 & 4) ? ' /EncodedByteAlign true' : ''}${photometric === 1 ? ' /BlackIs1 true' : ''} >>`;
    return { width, height, colorSpace: '/DeviceGray', bitsPerComponent: 1, filter: 'CCITTFaxDecode', decodeParms: parms,
      data: bytes.slice(offsets[0], offsets[0] + counts[0]), dpi, passthrough: true };
  }
  if (compression === 7 && offsets.length === 1 && !tiled && (photometric === 6 || photometric === 2 || photometric <= 1)) {
    let data = bytes.subarray(offsets[0], offsets[0] + counts[0]);
    const tables = t(347, null);
    if (tables?.length > 4) {
      // the shared tables (JPEGTables, SOI … EOI) go in before the strip's frame
      const tb = Uint8Array.from(tables);
      const merged = new Uint8Array(tb.length - 2 + data.length - 2);
      merged.set(tb.subarray(0, tb.length - 2), 0);
      merged.set(data.subarray(2), tb.length - 2);
      data = merged;
    }
    return { width, height, colorSpace: spp === 1 ? '/DeviceGray' : '/DeviceRGB', bitsPerComponent: 8, filter: 'DCTDecode', decodeParms: null,
      data: data.slice(), dpi, passthrough: true };
  }
  if (![1, 2, 4, 8, 16].includes(bps) || ![1, 2].includes(planar)) return null;
  if (![1, 5, 8, 32946, 32773].includes(compression) || ![0, 1, 2, 3, 5, 6].includes(photometric)) return null;
  // YCbCr only without subsampling
  const sub = t(530, [2, 2]);
  if (photometric === 6 && (sub[0] !== 1 || sub[1] !== 1)) return null;

  const planes = planar === 2 ? spp : 1;
  const perPlane = planar === 2 ? 1 : spp;
  const rowBytes = Math.ceil(tileW * perPlane * bps / 8);
  const across = Math.ceil(width / tileW);
  const chunksPerPlane = Math.ceil(offsets.length / planes);
  const samples = bps === 16 ? new Uint16Array(width * height * spp) : new Uint8Array(width * height * spp);

  for (let c = 0; c < offsets.length; c++) {
    let data = bytes.subarray(offsets[c], offsets[c] + counts[c]);
    if (compression === 5) data = tiffLzw(data);
    else if (compression === 8 || compression === 32946) data = await inflate(data);
    else if (compression === 32773) data = packBits(data);
    const plane = planar === 2 ? Math.floor(c / chunksPerPlane) : 0;
    const cc = c % chunksPerPlane;
    const x0 = (cc % across) * tileW, y0 = Math.floor(cc / across) * tileH;
    const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let y = 0; y < tileH && y0 + y < height; y++) {
      const off = y * rowBytes;
      const row = data.subarray(off, off + rowBytes);
      if (predictor === 2 && bps === 8) for (let i = perPlane; i < row.length; i++) row[i] = (row[i] + row[i - perPlane]) & 255;
      if (predictor === 2 && bps === 16) {
        for (let i = perPlane; i < tileW * perPlane && 2 * i + 1 < row.length; i++) {
          const prev = ddv.getUint16(off + 2 * (i - perPlane), le);
          ddv.setUint16(off + 2 * i, (ddv.getUint16(off + 2 * i, le) + prev) & 0xFFFF, le);
        }
      }
      for (let x = 0; x < tileW && x0 + x < width; x++) {
        for (let k = 0; k < perPlane; k++) {
          let v;
          const i = x * perPlane + k;
          if (bps === 8) v = row[i] ?? 0;
          else if (bps === 16) v = 2 * i + 1 < row.length ? ddv.getUint16(off + 2 * i, le) : 0;
          else {
            const bit = i * bps;
            v = ((row[bit >> 3] ?? 0) >> (8 - bps - (bit & 7))) & ((1 << bps) - 1);
          }
          samples[((y0 + y) * width + x0 + x) * spp + plane + k] = v;
        }
      }
    }
  }

  const pixels = new Uint8Array(width * height * 3);
  const map = t(320, null);
  const max = (1 << bps) - 1;
  const to8 = v => (bps === 8 ? v : Math.round(v * 255 / max));
  // colour channels before any alpha: gray 1, RGB and YCbCr 3, CMYK 4
  const colours = photometric === 2 || photometric === 6 ? 3 : photometric === 5 ? 4 : 1;
  const alphaAt = extra.length && colours < spp && extra[0] !== 0 ? colours : -1;
  for (let i = 0; i < width * height; i++) {
    let r, g, b;
    const s0 = samples[i * spp];
    if (photometric === 2) { r = to8(s0); g = to8(samples[i * spp + 1]); b = to8(samples[i * spp + 2]); }
    else if (photometric === 5) {
      // CMYK, as a viewer without colour management shows it
      const [c, m, y, k] = [0, 1, 2, 3].map(j => to8(samples[i * spp + j]) / 255);
      r = 255 * (1 - c) * (1 - k); g = 255 * (1 - m) * (1 - k); b = 255 * (1 - y) * (1 - k);
    } else if (photometric === 6) {
      const Y = to8(s0), cb = to8(samples[i * spp + 1]) - 128, cr = to8(samples[i * spp + 2]) - 128;
      r = Y + 1.402 * cr; g = Y - 0.344136 * cb - 0.714136 * cr; b = Y + 1.772 * cb;
    } else if (photometric === 3 && map) {
      const n = 1 << bps;
      r = map[s0] >> 8; g = map[n + s0] >> 8; b = map[2 * n + s0] >> 8;
    } else {
      const v = to8(s0);
      r = g = b = photometric === 0 ? 255 - v : v;
    }
    if (alphaAt >= 0) {
      const a = to8(samples[i * spp + alphaAt]) / 255;
      r = r * a + 255 * (1 - a); g = g * a + 255 * (1 - a); b = b * a + 255 * (1 - a);
    }
    pixels[i * 3] = Math.min(255, Math.max(0, Math.round(r)));
    pixels[i * 3 + 1] = Math.min(255, Math.max(0, Math.round(g)));
    pixels[i * 3 + 2] = Math.min(255, Math.max(0, Math.round(b)));
  }
  return { width, height, pixels, dpi };
}

// TIFF LZW: MSB-first codes, 256 clear, 257 end, early change
function tiffLzw(data) {
  const out = [];
  let dict = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); };
  reset();
  let width = 9, bitPos = 0, prev = null;
  const total = data.length * 8;
  while (bitPos + width <= total) {
    let code = 0;
    for (let i = 0; i < width; i++) {
      const p = bitPos + i;
      code = (code << 1) | ((data[p >> 3] >> (7 - (p & 7))) & 1);
    }
    bitPos += width;
    if (code === 256) { reset(); width = 9; prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const v of entry) out.push(v);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length + 1 >= (1 << width) && width < 12) width++;
  }
  return Uint8Array.from(out);
}

function packBits(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const n = (data[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]); }
    else if (n !== -128) { const v = data[i++]; for (let k = 0; k < 1 - n; k++) out.push(v); }
  }
  return Uint8Array.from(out);
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unfilter(data, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let v;
      switch (ft) {
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = raw;
      }
      out[dst + x] = v & 0xFF;
    }
  }
  return out;
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Browser fallback (GIF, BMP, interlaced PNG, …)
// ---------------------------------------------------------------------------

async function canvasFallback(bytes, contentType) {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: contentType || 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const g = canvas.getContext('2d');
    g.fillStyle = 'white';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0);
    const rgba = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
    }
    return { width: canvas.width, height: canvas.height, pixels: rgb };
  } catch {
    return null;
  }
}
