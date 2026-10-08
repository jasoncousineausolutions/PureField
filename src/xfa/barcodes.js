/**
 * Purefield / xfa / barcodes.js
 *
 * Paints a <barcode> field's symbol (core/barcode.js) in its value
 * rectangle, as Acrobat prints it:
 *
 *   payload      the raw value (after scripts), in charEncoding (UTF-8,
 *                ISO-8859-1 or UTF-16 big-endian), zlib-compressed for
 *                dataPrep="flateCompress"; dataLength is a validation limit
 *                and does not change it. An empty value paints nothing.
 *   1D           Code 39 and Code 128 fill the rectangle's width, no quiet
 *                zone (mn-dhs-4258a's Code 39 spans its field exactly); the
 *                bars take the height (moduleHeight when set) less a line
 *                of text above or below, or under embedded text; an EAN/UPC
 *                add-on has its digits above it, its bars that much shorter
 *   PDF417       moduleWidth wide modules, as many columns as fit, the rows
 *                stretched over the height with two modules of quiet zone
 *                around; centred (pdfium-barcodes, echr-application-es)
 *   QR, Data     square moduleWidth modules, centred, with four modules
 *   Matrix,      (QR), one (Data Matrix) or two (Aztec, which needs none)
 *   Aztec        of quiet zone
 *   DataBar      the stacked forms fill the rectangle as a 1D symbol
 *   Stacked      does, their rows in proportion (paintStacked)
 *
 * 2D modules are sized on a 300 dpi grid, as Acrobat rasterises them.
 * A caption above or below a barcode prints outside the field, the symbol
 * taking the whole field (paint.js).
 *
 * A symbol wider (or taller) than its rectangle has its modules narrowed to
 * fit. Modules are black rectangles, each run of dark modules on a row one
 * rectangle.
 *
 * Reader does not draw every type (the reader-tests print): Aztec, the GS1
 * DataBar types and upcean2/upcean5 print as a grey box, and EAN/UPC
 * symbols with an add-on leave the layout altogether. That is the default
 * (barcodes: 'reader'); barcodes: 'all' draws their symbols instead.
 * Australia Post symbols print at Reader's fixed size, the value under them.
 */

import { encodeBarcode } from '../core/barcode.js';
import { textWidth, emBox, naturalLineHeight } from './text.js';
import { drawRun } from './paint.js';

const MM = 72 / 25.4;
const DEFAULT_MODULE = 0.25 * MM;

// the types Reader prints as a grey box, and those it leaves out
const READER_BOX = new Set(['aztec', 'rss14', 'rss14truncated', 'rss14stacked', 'rss14stackedomni', 'rss14limited', 'rss14expanded', 'upcean2', 'upcean5']);
const READER_DROPS = new Set(['ean13add2', 'ean13add5', 'ean8add2', 'ean8add5', 'upcaadd2', 'upcaadd5', 'upceadd2', 'upceadd5']);
const typeOf = n => String(n.ui?.barcode?.type ?? '').toLowerCase();

/** How Reader prints a barcode type: 'box' (a grey box), 'dropped' (not at all) or 'drawn' */
export function readerBarcode(type) {
  const t = String(type ?? '').toLowerCase();
  return READER_BOX.has(t) ? 'box' : READER_DROPS.has(t) ? 'dropped' : 'drawn';
}

/**
 * With barcodes: 'reader', the barcode fields Reader leaves out of the
 * print (EAN/UPC with an add-on) leave the layout, as hidden fields do.
 */
export function dropReaderBarcodes(root, log) {
  const walk = n => {
    if (n.type === 'field' && n.ui?.kind === 'barcode' && READER_DROPS.has(typeOf(n)) && n.presence !== 'hidden' && n.presence !== 'inactive') {
      n.presence = 'hidden';
      log.once('info', 'XFA_BARCODE_READER', typeOf(n), `${n.ui.barcode.type} barcode field(s) left out, as Reader prints them (barcodes: 'all' draws them)`);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
}

/**
 * The bytes a barcode field encodes, or null when its value is empty.
 * @param {object} n - a bound field node whose ui.kind is 'barcode'
 * @param {Map<object, Uint8Array>} [compressed] - zlib bytes prepared for
 *   flateCompress fields (compressPayloads)
 */
export function barcodePayload(n, compressed) {
  const b = n.ui.barcode;
  const text = n.raw === null || n.raw === undefined ? '' : String(n.raw);
  if (!text) return null;
  const bytes = encodeText(text, b.charEncoding);
  if (b.dataPrep === 'flateCompress') {
    const z = compressed?.get(n);
    if (z) return { text, bytes: z, compressed: true };
  }
  return { text, bytes };
}

function encodeText(text, enc) {
  const e = String(enc ?? 'UTF-8').toLowerCase().replace(/_/g, '-');
  if (e === 'iso-8859-1' || e === 'latin1' || e === 'none') return Uint8Array.from(text, ch => ch.charCodeAt(0) & 0xff);
  if (e === 'utf-16' || e === 'ucs-2') {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 * i] = c >> 8; out[2 * i + 1] = c & 0xff; }
    return out;
  }
  return new TextEncoder().encode(text);
}

/**
 * zlib (RFC 1950) streams for the flateCompress barcode fields on the pages,
 * prepared before painting (compression is asynchronous).
 * @returns {Promise<Map<object, Uint8Array>>}
 */
export async function compressPayloads(pages) {
  const out = new Map();
  for (const page of pages) {
    for (const item of page.items) {
      const n = item.node;
      if (n.type !== 'field' || n.ui?.kind !== 'barcode' || n.ui.barcode?.dataPrep !== 'flateCompress' || out.has(n)) continue;
      const p = barcodePayload(n);
      if (!p) continue;
      const stream = new Blob([p.bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      out.set(n, new Uint8Array(await new Response(stream).arrayBuffer()));
    }
  }
  return out;
}

/**
 * Paint field n's barcode in rect (top-left page points).
 * @param {{ cs, H: number, log, compressed?: Map }} ctx - paint.js context
 */
export function paintBarcode(n, rect, ctx) {
  const b = n.ui.barcode;
  const payload = barcodePayload(n, ctx.compressed);
  if (!payload) {
    ctx.log.once('info', 'XFA_BARCODE_EMPTY', n.som, `${n.som}: barcode with no value; nothing printed`);
    return;
  }
  if (b.charEncoding && !/^(utf-?8|iso-8859-1|latin1|none|utf-?16|ucs-2)$/i.test(b.charEncoding)) {
    ctx.log.once('warn', 'XFA_BARCODE_ENCODING', b.charEncoding, `barcode charEncoding ${b.charEncoding} not supported; UTF-8 used`);
  }
  if (rect.w <= 0 || rect.h <= 0) return;
  if (ctx.barcodes !== 'all' && READER_BOX.has(typeOf(n))) {
    // Reader's placeholder: the rectangle grey, edged in black
    ctx.log.once('info', 'XFA_BARCODE_READER', typeOf(n), `${b.type} barcode(s) printed as a grey box, as Reader prints them (barcodes: 'all' draws them)`);
    ctx.cs.save().fillColor(0.5, 0.5, 0.5).strokeColor(0, 0, 0).lineWidth(0.5)
      .rect(rect.x + 0.25, ctx.H - rect.y - rect.h + 0.25, rect.w - 0.5, rect.h - 0.5).fillStroke().restore();
    return;
  }
  const mw0 = b.moduleWidth > 0 ? b.moduleWidth : DEFAULT_MODULE;
  const log = (code, msg) => ctx.log.once(code === 'XFA_BARCODE_UNSUPPORTED' ? 'warn' : 'info', code, `${n.som}:${code}`, `${n.som}: ${msg}`);
  const sym = encodeBarcode(b.type, payload, b, { log, box: rect, moduleWidth: mw0 });
  if (!sym) return;
  if (sym.kind === '1d') paint1d(n, sym, rect, ctx);
  else if (sym.kind === 'bars' && /^postaus/.test(typeOf(n))) paintAusPost(n, sym, payload.text, rect, ctx);
  else if (sym.kind === 'bars') paintBars(sym, rect, ctx);
  else if (sym.kind === 'stacked') paintStacked(sym, rect, ctx);
  else if (sym.kind === 'maxicode') paintMaxiCode(sym, rect, ctx);
  else paint2d(sym, rect, ctx, mw0, b.type.toLowerCase());
}

function paint1d(n, sym, rect, ctx) {
  const b = n.ui.barcode;
  const where = b.textLocation ?? 'below';
  const font = n.font_;
  const text = where !== 'none' && font ? sym.text : '';
  const lineH = text ? naturalLineHeight(font) : 0;
  const strip = where === 'above' || where === 'below' ? lineH : 0;
  const avail = Math.max(0, rect.h - strip);
  const barH = b.moduleHeight > 0 ? Math.min(b.moduleHeight, avail) : avail;
  const top = rect.y + (where === 'above' ? strip : 0);
  const unit = rect.w / sym.elements.reduce((a, w) => a + w, 0);
  // an EAN/UPC add-on: its digits above it, its bars shortened under them
  // unless the text line is above the symbol already
  const addAt = sym.addOn ? sym.addOn.at : sym.elements.length;
  const addDrop = sym.addOn && text && where !== 'above' ? Math.min(lineH, barH / 2) : 0;
  const { cs, H } = ctx;
  cs.save().fillColor(0, 0, 0);
  let x = rect.x, addX = rect.x + rect.w;
  sym.elements.forEach((w, i) => {
    if (i === addAt) addX = x;
    const drop = i >= addAt ? addDrop : 0;
    if (i % 2 === 0 && w > 0) cs.rect(x, H - top - barH, w * unit, barH - drop);
    x += w * unit;
  });
  cs.fill().restore();
  if (!text) return;
  const { ascent, descent } = emBox(font);
  const drawLine = (s, x0, x1, ty, embedded) => {
    const tw = textWidth(font, s);
    const tx = x0 + (x1 - x0 - tw) / 2;
    if (embedded) cs.save().fillColor(1, 1, 1).rect(tx - 1, H - ty - lineH, tw + 2, lineH).fill().restore();
    drawRun(ctx, font, s, tx, ty + (lineH - (ascent + descent)) / 2 + ascent);
  };
  const ty = where === 'above' ? rect.y : where === 'below' ? top + barH
    : where === 'aboveEmbedded' ? top : top + barH - lineH;
  const mainEnd = sym.addOn ? addX - sym.elements[addAt - 1] * unit : rect.x + rect.w;
  drawLine(text, rect.x, mainEnd, ty, where.endsWith('Embedded'));
  if (sym.addOn) drawLine(sym.addOn.text, addX, rect.x + rect.w, where === 'above' ? rect.y : top, false);
}

// Postal bars: one equal bar per state across the rectangle's width, a
// bar and its gap equally wide; full bars take the height, a POSTNET short
// bar (tracker) 40% of it at the bottom, RM4SCC's tracker the middle third,
// ascenders reaching the top and descenders the bottom from it
function paintBars(sym, rect, ctx) {
  const { cs, H } = ctx;
  const n = sym.bars.length;
  const pitch = rect.w / (2 * n - 1);
  const fourState = sym.bars.some(t => t === 'A' || t === 'D');
  cs.save().fillColor(0, 0, 0);
  sym.bars.forEach((t, i) => {
    let top = 0, bottom = 1; // fractions of the height, from the top
    if (fourState) {
      if (t === 'A') bottom = 2 / 3;
      else if (t === 'D') top = 1 / 3;
      else if (t === 'T') { top = 1 / 3; bottom = 2 / 3; }
    } else if (t === 'T') top = 0.6;
    cs.rect(rect.x + 2 * i * pitch, H - rect.y - bottom * rect.h, pitch, (bottom - top) * rect.h);
  });
  cs.fill().restore();
}

// Australia Post: Reader's fixed size, measured on its print: bars 1.559pt
// wide every 3.118pt from the rectangle's top-left, the tracker 4.08pt
// high with ascenders and descenders 5.1pt past it; the value under the
// symbol in the field font, centred, its baseline 1.5 font sizes below the
// bars (12pt at 8pt)
const AUS_PITCH = 3.118, AUS_TRACK = 4.08, AUS_EXT = 5.1;
function paintAusPost(n, sym, value, rect, ctx) {
  const { cs, H } = ctx;
  const full = AUS_TRACK + 2 * AUS_EXT;
  cs.save().fillColor(0, 0, 0);
  sym.bars.forEach((t, i) => {
    const top = t === 'F' || t === 'A' ? 0 : AUS_EXT;
    const bottom = t === 'F' || t === 'D' ? full : AUS_EXT + AUS_TRACK;
    cs.rect(rect.x + i * AUS_PITCH, H - rect.y - bottom, AUS_PITCH / 2, bottom - top);
  });
  cs.fill().restore();
  const font = n.font_;
  if (!font || (n.ui.barcode.textLocation ?? 'below') === 'none') return;
  const width = (sym.bars.length - 1) * AUS_PITCH + AUS_PITCH / 2;
  drawRun(ctx, font, value, rect.x + (width - textWidth(font, value)) / 2, rect.y + full + 1.5 * font.size);
}

// GS1 DataBar Stacked: rows of modules across the width, as a 1D symbol
// fills it; separator rows a module high (less when the field is lower
// than the nominal height), the others sharing the rest in their nominal
// proportions (5:7 for Stacked, 1:1 for Stacked Omnidirectional)
function paintStacked(sym, rect, ctx) {
  const unit = rect.w / sym.modules[0].length;
  const nominal = sym.heights.reduce((a, h) => a + h, 0);
  const sep = Math.min(unit, rect.h / nominal);
  const seps = sym.heights.filter(h => h === 1).length;
  const scale = (rect.h - seps * sep) / (nominal - seps);
  let y = rect.y;
  sym.modules.forEach((row, r) => {
    const h = sym.heights[r] === 1 ? sep : sym.heights[r] * scale;
    paintModules(ctx, rect.x, y, [row], unit, h);
    y += h;
  });
}

// MaxiCode: 33 rows of hexagons, every other row half a module in and one
// short, round a bullseye of three dark rings (ISO/IEC 16023 4.2.1.1 and
// figure 8, as zint draws it), as large as the field allows up to its
// nominal 28.14 mm width, centred. W is a hexagon's flat-to-flat width, V
// its point-to-point height, rows W·√3/2 apart.
const MAXI_WIDTH = 28.14 * MM;
function paintMaxiCode(sym, rect, ctx) {
  const { cs, H } = ctx;
  const rowPitch = Math.sqrt(3) / 2, v = 2 / Math.sqrt(3);
  const unitH = 32 * rowPitch + v; // the symbol's height in W
  const w = Math.min(rect.w / 30, rect.h / unitH, MAXI_WIDTH / 30);
  const x0 = rect.x + (rect.w - 30 * w) / 2, y0 = rect.y + (rect.h - unitH * w) / 2;
  const V = v * w;
  cs.save().fillColor(0, 0, 0);
  sym.modules.forEach((row, r) => {
    const cy = H - (y0 + r * rowPitch * w + V / 2);
    const off = r & 1 ? w : w / 2;
    for (let i = 0; i < 30 - (r & 1); i++) {
      if (!row[i]) continue;
      const cx = x0 + i * w + off;
      cs.moveTo(cx, cy + V / 2).lineTo(cx + w / 2, cy + V / 4).lineTo(cx + w / 2, cy - V / 4)
        .lineTo(cx, cy - V / 2).lineTo(cx - w / 2, cy - V / 4).lineTo(cx - w / 2, cy + V / 4).closePath();
    }
  });
  cs.fill();
  // the bullseye: dark between diameters V + 2k·d and V + (2k + 1)·d, k 0 to 2,
  // the whole 9W across
  const cx = x0 + 14.5 * w, cy = H - (y0 + unitH * w / 2);
  const d = (9 * w - V) / 5;
  const circle = r => {
    const k = 0.5522847498 * r;
    cs.moveTo(cx + r, cy).curveTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r).curveTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy)
      .curveTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r).curveTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy).closePath();
  };
  for (let k = 0; k < 3; k++) {
    circle((V + (2 * k + 1) * d) / 2);
    circle((V + 2 * k * d) / 2);
  }
  cs.fillEvenOdd().restore();
}

// Acrobat prints a 2D symbol as a 300 dpi image: module widths round to
// whole pixels and row heights are cut down to them (the 0.338mm modules of
// echr-application-es are 4 pixels, its PDF417 rows 66)
const PX = 72 / 300;
const snap = (v, f = Math.round) => Math.max(1, f(v / PX)) * PX;

function paint2d(sym, rect, ctx, mw0, type) {
  const rows = sym.modules.length, cols = sym.modules[0].length;
  const quiet = type === 'qrcode' ? 4 : type === 'datamatrix' ? 1 : 2;
  let mw = Math.min(snap(mw0), snap(rect.w / (cols + 2 * quiet), Math.floor));
  let mh;
  if (sym.stacked) {
    mh = snap((rect.h - 2 * quiet * mw) / rows, Math.floor);
    if (mh < mw) { mh = rect.h / (rows + 2 * quiet); mw = Math.min(mw, mh); }
  } else {
    mw = Math.min(mw, snap(rect.h / (rows + 2 * quiet), Math.floor));
    mh = mw;
  }
  const x0 = rect.x + (rect.w - cols * mw) / 2;
  const y0 = rect.y + (rect.h - rows * mh) / 2;
  paintModules(ctx, x0, y0, sym.modules, mw, mh);
}

// Dark modules as black rectangles, one per run on a row; origin top-left
function paintModules(ctx, x0, y0, modules, mw, mh) {
  const { cs, H } = ctx;
  cs.save().fillColor(0, 0, 0);
  modules.forEach((row, r) => {
    for (let c = 0; c < row.length;) {
      while (c < row.length && !row[c]) c++;
      const start = c;
      while (c < row.length && row[c]) c++;
      if (c > start) cs.rect(x0 + start * mw, H - (y0 + (r + 1) * mh), (c - start) * mw, mh);
    }
  });
  cs.fill().restore();
}
