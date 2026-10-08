/**
 * Purefield / xfa / paint.js
 *
 * Placed boxes → PDF content streams (spec §7 Field chrome, §8 Draws,
 * §4 Typography). This is the page seal: the only place Y flips
 * (lly = H − (y + h)).
 *
 * Paint order is document order; per box: border fill, border edges, then
 * caption, ui widget box, value. Text is clipped to its rectangle.
 */

import { ContentStream, standardFontName, encodeStandard } from '../core/writer.js';
import { base64ToBytes, encodeImage } from '../core/images.js';
import { emBox, textWidth, embeddedFace, faceRuns, runWidth, timesScale, lineIndent, symbolText, resolveFont } from './text.js';
import { shapeArabic, visualOrder } from './scripts.js';
import { paintedHeight } from './rich.js';
import { itemPairs } from './format.js';
import { XfaLog } from './log.js';
import { paintBarcode, compressPayloads } from './barcodes.js';

const K = 0.5522847498; // Bézier circle constant
const DEFAULT_EDGE = Object.freeze({ presence: 'visible', thickness: 0.5, color: [0, 0, 0], stroke: 'solid' });

/**
 * @param {import('./flow.js').Page[]} pages
 * @param {{ log?: XfaLog, byId?: Map<string, object>, overlay?: boolean }} [opts]
 *   byId resolves floating fields. overlay: static-form mode (spec §9) — the
 *   shell page already shows boilerplate and field chrome, so paint only
 *   field values and check marks, with white behind each value string.
 *   glyphUsage: Map(ttf → Map(gid → code point)) filled with the glyphs drawn
 *   xfaImages: Map(href → bytes) of the images the PDF stores for the template
 *   labels: { color, minSize, maxSize } paints each field's name where its
 *           value goes instead of the value (index.js labelFields); faces:
 *           the TrueType faces the labels are drawn with
 *   extraGlyphs: Map(code point → code) of the Latin Extended-A letters drawn
 *                with the standard fonts (writer.js encodeStandard)
 *   in embedded faces, for subsetting
 * @returns {Promise<{ width, height, content, images }[]>} PdfWriter pages
 */
export async function paintPages(pages, { log = new XfaLog(), byId = new Map(), overlay = false, shells = null, glyphUsage = new Map(), extraGlyphs = new Map(), xfaImages = new Map(), labels = null, faces = null, resolveImage = null, barcodes = 'reader' } = {}) {
  const images = overlay ? new Map() : await loadImages(pages, log, xfaImages, resolveImage);
  const compressed = await compressPayloads(pages);
  const out = [];
  for (const page of pages) {
    const cs = new ContentStream();
    // static pages: the comb widgets of the shell page (core/importer.js)
    const shell = shells?.[pages.indexOf(page)] ?? null;
    const combs = shell?.combs ?? [];
    const ctx = { cs, H: page.height, log, images, page, byId, overlay, combs, glyphUsage, extraGlyphs, shadings: [], compressed, barcodes,
      labels: labels && { ...labels, faces }, shell, widgetsByName: shell?.widgets ? widgetIndex(shell.widgets) : null, stamps: [] };
    for (const item of page.items) {
      if (!item.paint) continue;
      paintItem(item, ctx);
    }
    const used = new Set();
    for (const item of page.items) {
      const img = images.get(item.node.proto ?? item.node);
      if (img && item.paint) used.add(img);
    }
    out.push({ width: page.width, height: page.height, content: cs.toString(), images: [...used], shadings: ctx.shadings, stamps: ctx.stamps });
  }
  return out;
}

function paintItem(item, ctx) {
  if (item.rots?.length) {
    // the seal: turn about each anchor in PDF space, then paint as if upright
    ctx.cs.save();
    for (const r of item.rots) {
      const a = r.angle * Math.PI / 180;
      const c = Math.cos(a), s = Math.sin(a);
      const px = r.ox, py = ctx.H - r.oy;
      ctx.cs._ops.push(`${fx(c)} ${fx(s)} ${fx(-s)} ${fx(c)} ${fx(px - c * px + s * py)} ${fx(py - s * px - c * py)} cm`);
    }
    paintUpright(item, ctx);
    ctx.cs.restore();
    return;
  }
  paintUpright(item, ctx);
}

function fx(v) {
  return (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(4)).toString();
}

function paintUpright(item, ctx) {
  const n = item.node;
  const box = { x: item.x, y: item.y, w: item.w, h: item.h };
  if (ctx.overlay) { if (n.type === 'field') paintFieldValue(n, box, ctx); return; }
  if (n.type === 'field') paintField(n, box, ctx);
  else if (n.type === 'draw') paintDraw(n, box, ctx);
  else if (n.border) paintBorder(n.border, inset(box, n.margin, false), ctx, false);
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function paintField(n, box, ctx) {
  const p = n.parts;
  if (!p) return;
  if (n.border) paintBorder(n.border, box, ctx, false);

  const kind = n.ui?.kind;
  // labelled: the field's name where its widget goes (a button's caption is
  // its face, so the whole button is labelled)
  if (ctx.labels && kind === 'button') { paintLabel(ctx, fieldLabel(n), box); return; }
  // a barcode takes the whole field, and a caption above or below it goes
  // outside the field (echr-application-es's PDF417 and its reference line)
  const place = n.caption?.placement;
  if (kind === 'barcode' && !ctx.labels && p.caption && n.caption && (place === 'top' || place === 'bottom')) {
    const cap = { ...p.caption, y: place === 'bottom' ? box.h : -p.caption.h };
    paintCaption(n, { ...p, caption: cap }, box, ctx);
    paintBarcode(n, inset(box, n.margin, true), ctx);
    return;
  }
  if (p.caption && n.caption) paintCaption(n, p, box, ctx);

  const value = offset(p.value, box);
  if (ctx.labels) { paintLabel(ctx, fieldLabel(n), value); return; }
  if (kind === 'checkButton') { paintCheck(n, value, ctx); return; }
  if (n.ui?.border) paintBorder(n.ui.border, value, ctx, false);
  const textRect = inset(value, n.ui?.margin, true);

  if (kind === 'imageEdit') {
    const aspect = n.value?.kind === 'image' ? n.value.aspect : 'fit';
    // bound data, else the template's own image (adobe-master-pages-test)
    paintImage(n, textRect, ctx, n.raw ? { contentType: 'image/png', data: n.raw, aspect } : (n.value?.kind === 'image' && (n.value.data || n.value.href) ? n.value : null));
    return;
  }
  // a field of another kind whose value is an embedded image shows the
  // image (pdfium-png-image's text field holding a PNG, as Reader prints it)
  if (n.value?.kind === 'image' && n.value.data && !n.bound) {
    paintImage(n, textRect, ctx, n.value);
    return;
  }
  if (kind === 'barcode') { paintBarcode(n, textRect, ctx); return; }
  if (kind === 'signature' || kind === 'button') {
    if (kind !== 'button') ctx.log.once('info', 'XFA_UI_OPAQUE', kind, `${kind} fields paint no glyph`);
    return;
  }

  if ((kind === 'textEdit' || kind === 'numericEdit') && n.ui.comb > 0) { paintComb(n, textRect, ctx, value); return; }
  if (p.richLines && !n.pageRole) { paintRich(ctx, p.richLines, n.para, textRect); return; }
  const lines = n.pageRole ? [String(pageValue(n.pageRole, ctx))] : p.lines;
  paintText(ctx, lines, n.font_, n.para, textRect, p.lineH);
}

// Static overlay: value string on white, or just the check mark
// The shell page's widgets by field name, "[0]" indices and the class
// names of nameless containers dropped ("form1[0].#subform[0].f[0]" and our
// "form1.#.f" are one name)
export function widgetName(s) {
  return String(s).replace(/#(subform|area|subformSet|exclGroup)/g, '#').replace(/\[0\]/g, '');
}
function widgetIndex(widgets) {
  const map = new Map();
  for (const w of widgets) {
    const k = widgetName(w.name);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(w);
  }
  return map;
}

// The widget a static field was saved with, when its rectangle disagrees
// with the template's by more than a point: Reader draws the widget there,
// so the value goes into the widget's rectangle, or the widget's own
// appearance is stamped (index.js) when it has one. Rectangles are top-left
// page points; the widget's are converted from the shell page.
function disagreeingWidget(n, rect, ctx) {
  const list = ctx.widgetsByName?.get(widgetName(n.som));
  if (!list || list.length !== 1) return null;
  const w = list[0];
  const [ox, oy] = ctx.shell.mediaBox;
  const wr = { x: w.rect[0] - ox, y: ctx.H - (w.rect[3] - oy), w: w.rect[2] - w.rect[0], h: w.rect[3] - w.rect[1] };
  const d = Math.max(Math.abs(wr.x - rect.x), Math.abs(wr.y - rect.y), Math.abs(wr.x + wr.w - rect.x - rect.w), Math.abs(wr.y + wr.h - rect.y - rect.h));
  return d > 1 ? { widget: w, rect: wr } : null;
}

function paintFieldValue(n, box, ctx) {
  const p = n.parts;
  if (!p) return;
  const kind = n.ui?.kind;
  let value = offset(p.value, box);
  if (ctx.labels) {
    const off = disagreeingWidget(n, value, ctx);
    paintLabel(ctx, fieldLabel(n), off ? off.rect : value);
    return;
  }
  if (kind !== 'checkButton') {
    const off = disagreeingWidget(n, value, ctx);
    if (off?.widget.ap) { ctx.stamps.push(off.widget); return; }
    if (off) value = off.rect;
  }
  // a comb's box and cells live only in its widget appearance, not on the
  // shell page; Reader draws them in the field's own style, so they are
  // painted where the shell page has a comb widget over the field
  if ((kind === 'textEdit' || kind === 'numericEdit') && n.ui.comb > 0 && hasCombWidget(value, ctx)) {
    if (n.ui.border) paintBorder(n.ui.border, value, ctx, false);
    paintCombCells(n, value, ctx);
  }
  if (kind === 'checkButton') { paintCheck(n, value, ctx, true); return; }
  if (kind === 'signature' || kind === 'button' || kind === 'imageEdit') return;
  const textRect = inset(value, n.ui?.margin, true);
  if (kind === 'barcode') {
    // over the shell page, on white (a design-time placeholder stays hidden)
    if (n.raw === null || n.raw === undefined || n.raw === '') return;
    ctx.cs.save().fillColor(1, 1, 1).rect(textRect.x, ctx.H - textRect.y - textRect.h, textRect.w, textRect.h).fill().restore();
    paintBarcode(n, textRect, ctx);
    return;
  }
  const lines = n.pageRole ? [String(pageValue(n.pageRole, ctx))] : p.lines;
  if (!lines.length || !lines.some(l => l.trim())) return;
  const { cs, H } = ctx;
  cs.save().fillColor(1, 1, 1).rect(textRect.x, H - textRect.y - textRect.h, textRect.w, textRect.h).fill().restore();
  if ((kind === 'textEdit' || kind === 'numericEdit') && n.ui.comb > 0) { paintComb(n, textRect, ctx); return; }
  paintText(ctx, lines, n.font_, n.para, textRect, p.lineH);
}

// exclGroup members carry the group's raw value; marked when it equals the on value
function paintCheck(n, rect, ctx, markOnly = false) {
  const size = n.ui.size ?? 10;
  const m = n.ui.margin ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const inner = inset(rect, m, true);
  // Acrobat-generated static pages put a captionless check box at the right
  // of its content box and a captioned one at the left (observed on IMM 5645)
  const hAlign = n.para?.hAlign ?? (n.parts?.caption ? 'left' : 'right');
  const vAlign = n.para?.vAlign ?? 'middle';
  const x = hAlign === 'center' ? inner.x + (inner.w - size) / 2 : hAlign === 'right' ? inner.x + inner.w - size : inner.x;
  const y = vAlign === 'top' ? inner.y : vAlign === 'bottom' ? inner.y + inner.h - size : inner.y + (inner.h - size) / 2;
  let b = { x, y, w: size, h: size };
  if (markOnly) {
    const off = disagreeingWidget(n, b, ctx);
    if (off?.widget.ap) { ctx.stamps.push(off.widget); return; }
    if (off) b = off.rect;
  }
  const round = n.ui.shape === 'round';

  const edges = n.ui.border?.edges ?? [];
  const edge = edges.find(e => e.presence === 'visible') ?? (n.ui.border && edges.length ? null : DEFAULT_EDGE);
  const { cs, H } = ctx;
  if (!markOnly && n.ui.border?.fill && n.ui.border.fill.presence === 'visible') {
    cs.save().fillColor(...rgb(n.ui.border.fill.color));
    round ? ellipse(cs, b, H) : cs.rect(b.x, H - b.y - b.h, b.w, b.h);
    cs.fill().restore();
  }
  if (!markOnly && edge && edge.thickness > 0) {
    cs.save().strokeColor(...rgb(edge.color)).lineWidth(edge.thickness);
    round ? ellipse(cs, b, H) : cs.rect(b.x, H - b.y - b.h, b.w, b.h);
    cs.stroke().restore();
  }

  const pairs = itemPairs(n);
  const on = pairs[0]?.save ?? '1';
  const checked = n.raw !== null && n.raw !== undefined && (n.raw === on || (pairs.length === 0 && n.raw === 'on'));
  if (!checked) return;

  // Reader marks a square box with a cross by default (pdfjs-button-widget,
  // anaf-d093 and ALTMP prints), a round one with a dot
  let mark = n.ui.mark ?? 'default';
  if (mark === 'default') mark = round ? 'circle' : 'cross';
  const color = rgb(n.font_?.color ?? [0, 0, 0]);
  const L = b.x, T = H - b.y, s = b.w;
  cs.save().fillColor(...color).strokeColor(...color);
  switch (mark) {
    case 'circle': ellipse(cs, { x: b.x + s * 0.25, y: b.y + s * 0.25, w: s * 0.5, h: s * 0.5 }, H); cs.fill(); break;
    case 'square': cs.rect(L + s * 0.25, T - s * 0.75, s * 0.5, s * 0.5).fill(); break;
    case 'diamond':
      cs.moveTo(L + s / 2, T - s * 0.2).lineTo(L + s * 0.8, T - s / 2).lineTo(L + s / 2, T - s * 0.8).lineTo(L + s * 0.2, T - s / 2).closePath().fill();
      break;
    case 'cross':
      cs.lineWidth(Math.max(0.5, s * 0.07)).moveTo(L + s * 0.15, T - s * 0.15).lineTo(L + s * 0.85, T - s * 0.85)
        .moveTo(L + s * 0.85, T - s * 0.15).lineTo(L + s * 0.15, T - s * 0.85).stroke();
      break;
    default: // check (and star, painted as a check)
      cs.lineWidth(Math.max(0.5, s * 0.12)).lineCap(1).lineJoin(1)
        .moveTo(L + s * 0.2, T - s * 0.55).lineTo(L + s * 0.42, T - s * 0.78).lineTo(L + s * 0.82, T - s * 0.22).stroke();
  }
  cs.restore();
}

// A shell-page comb widget overlapping most of the rectangle (top-left page
// points; widget rects are PDF user space)
function hasCombWidget(r, ctx) {
  return ctx.combs.some(({ rect: [ax, ay, bx, by] }) => {
    const w = Math.min(bx, r.x + r.w) - Math.max(ax, r.x);
    const h = Math.min(ctx.H - ay, r.y + r.h) - Math.max(ctx.H - by, r.y);
    return w > 0 && h > 0 && w * h > 0.5 * r.w * r.h;
  });
}

// comb cell dividers in the widget's edge style (Acrobat draws them)
function paintCombCells(n, outer, ctx) {
  const cells = n.ui.comb;
  const edge = n.ui.border?.edges?.find(e => e.presence === 'visible' && e.thickness > 0);
  if (!edge) return;
  const { cs, H } = ctx;
  const ow = outer.w / cells;
  cs.save().strokeColor(...rgb(edge.color)).lineWidth(edge.thickness);
  for (let i = 1; i < cells; i++) cs.moveTo(outer.x + i * ow, H - outer.y).lineTo(outer.x + i * ow, H - outer.y - outer.h);
  cs.stroke().restore();
}

function paintComb(n, rect, ctx, outer = rect) {
  const cells = n.ui.comb;
  const text = [...(n.display ?? n.raw ?? '')];
  const cw = rect.w / cells;
  if (!ctx.overlay) paintCombCells(n, outer, ctx);
  const font = n.font_;
  const { ascent, descent } = emBox(font);
  const baseline = rect.y + (rect.h - (ascent + descent)) / 2 + ascent;
  ctx.cs.save();
  clipRect(ctx, rect);
  for (let i = 0; i < Math.min(cells, text.length); i++) {
    const w = textWidth(font, text[i]);
    drawRun(ctx, font, text[i], rect.x + i * cw + (cw - w) / 2, baseline);
  }
  ctx.cs.restore();
}

// ---------------------------------------------------------------------------
// Draws
// ---------------------------------------------------------------------------

function paintDraw(n, box, ctx) {
  if (n.border) paintBorder(n.border, box, ctx, false);
  const v = n.value;
  if (!v) return;
  const inner = inset(box, n.margin, true);
  switch (v.kind) {
    case 'text':
    case 'rich': {
      const p = n.parts;
      if (p) {
        if (p.caption && n.caption) paintCaption(n, p, box, ctx);
        const r = inset(offset(p.value, box), n.ui?.margin, true);
        if (p.richLines) paintRich(ctx, p.richLines, n.para, r);
        else paintText(ctx, p.lines, n.font_, n.para, r, p.lineH);
      }
      break;
    }
    case 'rectangle': paintBorder(v, inner, ctx, true); break;
    case 'line': paintLine(v, inner, ctx); break;
    case 'arc': paintArc(v, inner, ctx); break;
    case 'image': paintImage(n, inner, ctx, v); break;
  }
}

function paintLine(v, r, ctx) {
  const e = v.edge ?? DEFAULT_EDGE;
  if (e.presence !== 'visible' || e.thickness <= 0) return;
  const { cs, H } = ctx;
  cs.save().strokeColor(...rgb(e.color)).lineWidth(e.thickness);
  applyStroke(cs, e);
  // A degenerate box is a horizontal or vertical rule
  if (r.h < 0.01) cs.moveTo(r.x, H - r.y).lineTo(r.x + r.w, H - r.y);
  else if (r.w < 0.01) cs.moveTo(r.x, H - r.y).lineTo(r.x, H - r.y - r.h);
  else if (v.slope === '/') cs.moveTo(r.x, H - r.y - r.h).lineTo(r.x + r.w, H - r.y);
  else cs.moveTo(r.x, H - r.y).lineTo(r.x + r.w, H - r.y - r.h);
  cs.stroke().restore();
}

function paintArc(v, r, ctx) {
  const { cs, H } = ctx;
  let b = r;
  if (v.circular) {
    const d = Math.min(r.w, r.h);
    b = { x: r.x + (r.w - d) / 2, y: r.y + (r.h - d) / 2, w: d, h: d };
  }
  const full = Math.abs(v.sweepAngle) >= 360;
  if (v.fill && v.fill.presence === 'visible') {
    cs.save().fillColor(...rgb(v.fill.color));
    full ? ellipse(cs, b, H) : arcPath(cs, b, H, v.startAngle, v.sweepAngle, true);
    cs.fill().restore();
  }
  const e = v.edge ?? DEFAULT_EDGE;
  if (e.presence === 'visible' && e.thickness > 0) {
    cs.save().strokeColor(...rgb(e.color)).lineWidth(e.thickness);
    applyStroke(cs, e);
    full ? ellipse(cs, b, H) : arcPath(cs, b, H, v.startAngle, v.sweepAngle, false);
    cs.stroke().restore();
  }
}

// Elliptical arc in Bézier segments; angles counterclockwise from +X. A
// filled arc closes with the chord between its ends, not through the
// centre (Reader's print of pdf.js issue 14315: two filled quarter arcs
// are segments, not quarter discs)
function arcPath(cs, b, H, start, sweep, close) {
  const cx = b.x + b.w / 2, cy = H - b.y - b.h / 2, rx = b.w / 2, ry = b.h / 2;
  const segs = Math.ceil(Math.abs(sweep) / 90);
  const step = (sweep / segs) * Math.PI / 180;
  let a = start * Math.PI / 180;
  const pt = t => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  cs.moveTo(...pt(a));
  for (let i = 0; i < segs; i++) {
    const k = (4 / 3) * Math.tan(step / 4);
    const [x0, y0] = pt(a), [x3, y3] = pt(a + step);
    cs.curveTo(x0 - k * rx * Math.sin(a), y0 + k * ry * Math.cos(a),
      x3 + k * rx * Math.sin(a + step), y3 - k * ry * Math.cos(a + step), x3, y3);
    a += step;
  }
  if (close) cs.closePath();
}

function paintImage(n, r, ctx, v) {
  const img = ctx.images.get(n.proto ?? n);
  if (!img || !v) return;
  const aspect = v.aspect ?? 'fit';
  let w = r.w, h = r.h, x = r.x, y = r.y;
  const iw = img.width, ih = img.height;
  if (aspect === 'fit' || aspect === 'width' || aspect === 'height') {
    const scale = aspect === 'width' ? r.w / iw : aspect === 'height' ? r.h / ih : Math.min(r.w / iw, r.h / ih);
    w = iw * scale; h = ih * scale;
    // the scaled image sits by para hAlign/vAlign, top-left by default
    // (Acrobat prints; pdf.js centres it with object-fit: contain)
    const ha = n.para?.hAlign, va = n.para?.vAlign;
    x = r.x + (ha === 'center' ? (r.w - w) / 2 : ha === 'right' ? r.w - w : 0);
    y = r.y + (va === 'middle' ? (r.h - h) / 2 : va === 'bottom' ? r.h - h : 0);
  } else if (aspect === 'actual') {
    // intrinsic size from the image's own resolution, 72 dpi when it has none
    const scale = 72 / (img.dpi || 72);
    w = iw * scale; h = ih * scale;
  }
  const { cs, H } = ctx;
  cs.save();
  clipRect(ctx, r);
  cs.image(img.name, x, H - y - h, w, h);
  cs.restore();
}

// xfaImages: href → image file bytes from the PDF's /XFAImages name tree;
// a data: URI carries its bytes; resolveImage(href): the caller's bytes for
// any other href (a file or URL beside the form), or null
async function loadImages(pages, log, xfaImages = new Map(), resolveImage = null) {
  const map = new Map();
  let i = 0;
  for (const page of pages) {
    for (const item of page.items) {
      const n = item.node;
      const key = n.proto ?? n;
      if (map.has(key)) continue;
      let v = null;
      if (n.type === 'draw' && n.value?.kind === 'image') v = n.value;
      else if (n.type === 'field' && n.ui?.kind === 'imageEdit' && n.raw) v = { data: n.raw, contentType: 'image/png' };
      else if (n.type === 'field' && n.ui?.kind === 'imageEdit' && n.value?.kind === 'image' && (n.value.data || n.value.href)) v = n.value;
      else if (n.type === 'field' && n.value?.kind === 'image' && n.value.data && !n.bound) v = n.value;
      if (!v) continue;
      let named = !v.data && v.href ? xfaImages.get(v.href) ?? null : null;
      if (!v.data && !named && v.href) {
        const uri = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(v.href.trim());
        if (uri) named = uri[2] ? base64ToBytes(uri[3]) : new TextEncoder().encode(decodeURIComponent(uri[3]));
        else if (resolveImage) {
          try { named = await resolveImage(v.href); } catch (e) { log.once('info', 'XFA_IMAGE_EXTERNAL', v.href, `Image ${v.href} not loaded: ${e.message}`); }
          if (named && !(named instanceof Uint8Array)) named = new Uint8Array(named);
        }
      }
      if (!v.data && !named) {
        if (v.href) log.once('info', 'XFA_IMAGE_EXTERNAL', v.href, `Image href not resolved: ${v.href}`);
        continue;
      }
      try {
        const enc = await encodeImage(named ?? base64ToBytes(v.data), v.contentType);
        if (enc) map.set(key, { name: `Im${++i}`, ...enc });
        else log.once('info', 'XFA_IMAGE_UNSUPPORTED', v.contentType ?? '?', `Image type not supported here: ${v.contentType}`);
      } catch (e) {
        log.warn('XFA_IMAGE_UNSUPPORTED', `${n.som}: ${e.message}`);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Borders (spec §7): fill, then edges; one corner radius applies to all
// ---------------------------------------------------------------------------

function paintBorder(border, r, ctx, isRectangle) {
  if (!border || border.presence === 'hidden' || border.presence === 'invisible' || border.presence === 'inactive') return;
  const { cs, H } = ctx;
  // a radius only rounds a corner whose join is round; "square" (the
  // default) ignores it, as pdf.js does and Acrobat prints show
  const radius = border.corners?.find(c => c.radius > 0 && c.join === 'round' && c.presence !== 'hidden')?.radius ?? 0;

  const fill = border.fill;
  if (fill && fill.presence === 'visible' && fill.gradient && r.w > 0 && r.h > 0) {
    paintGradient(fill, r, ctx, radius);
  } else if (fill && fill.presence === 'visible') {
    // a stipple: its colour blended into the fill colour at its rate
    const color = fill.stipple
      ? fill.color.map((c, i) => c + (fill.stipple.color[i] - c) * fill.stipple.rate / 100)
      : fill.color;
    cs.save().fillColor(...rgb(color));
    roundRect(cs, r, H, radius);
    cs.fill().restore();
    if (fill.hatch && r.w > 0 && r.h > 0) paintHatch(fill.hatch, r, ctx, radius);
  }

  // A border with no edge elements still has one default edge
  const edges = border.edges?.length ? border.edges : [DEFAULT_EDGE, DEFAULT_EDGE, DEFAULT_EDGE, DEFAULT_EDGE];
  const visible = edges.map(e => e.presence === 'visible' && e.thickness > 0);
  if (!visible.some(Boolean)) return;

  const uniform = visible.every(Boolean) && edges.every(e => sameEdge(e, edges[0]));
  if (uniform && (edges[0].stroke === 'lowered' || edges[0].stroke === 'raised') && radius === 0) {
    paintBevel(cs, r, H, edges[0]);
    return;
  }
  if (uniform && (edges[0].stroke === 'etched' || edges[0].stroke === 'embossed') && radius === 0) {
    paintGroove(cs, r, H, edges[0]);
    return;
  }
  if (uniform) {
    const e = edges[0];
    cs.save().strokeColor(...rgb(e.color)).lineWidth(e.thickness);
    applyStroke(cs, e);
    roundRect(cs, r, H, radius);
    cs.stroke().restore();
    return;
  }
  const top = H - r.y, bottom = H - r.y - r.h, left = r.x, right = r.x + r.w;
  const sides = [
    [left, top, right, top],       // top
    [right, top, right, bottom],   // right
    [left, bottom, right, bottom], // bottom
    [left, top, left, bottom],     // left
  ];
  edges.forEach((e, i) => {
    if (!visible[i]) return;
    cs.save().strokeColor(...rgb(e.color)).lineWidth(e.thickness).lineCap(2);
    applyStroke(cs, e);
    const [x1, y1, x2, y2] = sides[i];
    cs.moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
  });
}

// lowered / raised edges as Acrobat prints them: inside the box, a band in
// the edge colour, then a bevel band of the same width (lowered: grey top
// and left, light grey bottom and right; raised: white, then grey)
function paintBevel(cs, r, H, e) {
  const t = e.thickness;
  const inset = d => ({ x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) });
  cs.save().strokeColor(...rgb(e.color)).lineWidth(t);
  const o = inset(t / 2);
  cs.rect(o.x, H - o.y - o.h, o.w, o.h).stroke().restore();
  const O = inset(t), I = inset(2 * t);
  if (I.w <= 0 || I.h <= 0) return;
  const [light, dark] = e.stroke === 'lowered' ? [[128, 128, 128], [212, 208, 200]] : [[255, 255, 255], [128, 128, 128]];
  const pt = (x, y) => [x, H - y];
  const poly = (color, pts) => {
    cs.save().fillColor(...rgb(color)).moveTo(...pts[0]);
    for (const p of pts.slice(1)) cs.lineTo(...p);
    cs.closePath().fill().restore();
  };
  const [ol, ot, or, ob] = [O.x, O.y, O.x + O.w, O.y + O.h];
  const [il, it, ir, ib] = [I.x, I.y, I.x + I.w, I.y + I.h];
  poly(light, [pt(ol, ot), pt(or, ot), pt(ir, it), pt(il, it), pt(il, ib), pt(ol, ob)]);
  poly(dark, [pt(or, ob), pt(ol, ob), pt(il, ib), pt(ir, ib), pt(ir, it), pt(or, ot)]);
}

// An etched edge is a groove, an embossed one a ridge, as CSS draws them
// (pdf.js maps them so): the edge's width in two bands, the outer one grey
// at the top and left and white at the bottom and right, the inner one the
// other way round (embossed: reversed)
function paintGroove(cs, r, H, e) {
  const t = e.thickness;
  if (t <= 0 || r.w <= 2 * t || r.h <= 2 * t) return;
  const grey = [128, 128, 128], white = [255, 255, 255];
  const etched = e.stroke === 'etched';
  const pt = (x, y) => [x, H - y];
  const band = (d0, d1, topLeft, bottomRight) => {
    const [ol, ot, or, ob] = [r.x + d0, r.y + d0, r.x + r.w - d0, r.y + r.h - d0];
    const [il, it, ir, ib] = [r.x + d1, r.y + d1, r.x + r.w - d1, r.y + r.h - d1];
    const poly = (color, pts) => {
      cs.save().fillColor(...rgb(color)).moveTo(...pts[0]);
      for (const p of pts.slice(1)) cs.lineTo(...p);
      cs.closePath().fill().restore();
    };
    poly(topLeft, [pt(ol, ot), pt(or, ot), pt(ir, it), pt(il, it), pt(il, ib), pt(ol, ob)]);
    poly(bottomRight, [pt(or, ob), pt(ol, ob), pt(il, ib), pt(ir, ib), pt(ir, it), pt(or, ot)]);
  };
  band(0, t / 2, etched ? grey : white, etched ? white : grey);
  band(t / 2, t, etched ? white : grey, etched ? grey : white);
}

function sameEdge(a, b) {
  return a.thickness === b.thickness && a.stroke === b.stroke && a.color.join() === b.color.join();
}

function applyStroke(cs, e) {
  const t = Math.max(e.thickness, 0.5);
  switch (e.stroke) {
    case 'dashed': cs.dash([3 * t, 3 * t]); break;
    case 'dotted': cs.lineCap(1).dash([0, 2 * t]); break;
    case 'dashDot': cs.dash([3 * t, 2 * t, t, 2 * t]); break;
    case 'dashDotDot': cs.dash([3 * t, 2 * t, t, 2 * t, t, 2 * t]); break;
    default: break; // solid (and rounded or mixed lowered, raised, etched, embossed edges)
  }
}

// A pattern fill's lines over its fill colour, clipped to the shape: 1pt
// lines every 4pt, horizontal, vertical, diagonal (left: rising to the left,
// right: rising to the right), or both of a pair (crossHatch,
// crossDiagonal)
const HATCH_PITCH = 4, HATCH_WIDTH = 1;
function paintHatch(hatch, r, ctx, radius) {
  const { cs, H } = ctx;
  const x0 = r.x, y0 = H - r.y - r.h, x1 = x0 + r.w, y1 = y0 + r.h;
  const dirs = { horizontal: ['h'], vertical: ['v'], diagonalLeft: ['l'], diagonalRight: ['r'], crossHatch: ['h', 'v'], crossDiagonal: ['l', 'r'] }[hatch.type] ?? ['h', 'v'];
  cs.save();
  roundRect(cs, r, H, radius);
  cs.clip();
  cs.strokeColor(...rgb(hatch.color)).lineWidth(HATCH_WIDTH);
  const span = r.w + r.h;
  for (const d of dirs) {
    if (d === 'h') for (let y = y0 + HATCH_PITCH / 2; y < y1; y += HATCH_PITCH) cs.moveTo(x0, y).lineTo(x1, y);
    else if (d === 'v') for (let x = x0 + HATCH_PITCH / 2; x < x1; x += HATCH_PITCH) cs.moveTo(x, y0).lineTo(x, y1);
    else {
      // 45° lines, HATCH_PITCH apart measured across them
      const step = HATCH_PITCH * Math.SQRT2;
      for (let t = -r.h; t < r.w + step; t += step) {
        if (d === 'r') cs.moveTo(x0 + t, y0).lineTo(x0 + t + span, y0 + span);
        else cs.moveTo(x1 - t, y0).lineTo(x1 - t - span, y0 + span);
      }
    }
  }
  cs.stroke().restore();
}

// A linear or radial fill: an axial or radial shading from the fill colour
// to the gradient colour, clipped to the box (anaf-d093's toLeft section
// headings fade from grey at the left to white, as Reader prints them).
// toRight starts at the left edge, toLeft at the right, toBottom at the
// top, toTop at the bottom; radial toEdge starts at the centre and reaches
// the end colour at the corners, toCenter the other way round.
function paintGradient(fill, r, ctx, radius) {
  const { cs, H } = ctx;
  const x0 = r.x, x1 = r.x + r.w, yb = H - r.y - r.h, yt = H - r.y;
  const xm = (x0 + x1) / 2, ym = (yb + yt) / 2;
  const { type, color } = fill.gradient;
  let shading;
  if (fill.pattern === 'radial') {
    const rr = Math.hypot(r.w, r.h) / 2;
    const out = type === 'toCenter';
    shading = { type: 3, coords: [xm, ym, 0, xm, ym, rr], c0: out ? color : fill.color, c1: out ? fill.color : color };
  } else {
    const coords = type === 'toLeft' ? [x1, ym, x0, ym] : type === 'toBottom' ? [xm, yt, xm, yb] : type === 'toTop' ? [xm, yb, xm, yt] : [x0, ym, x1, ym];
    shading = { type: 2, coords, c0: fill.color, c1: color };
  }
  const list = ctx.shadings;
  const name = `Sh${list.length + 1}`;
  list.push({ name, ...shading });
  cs.save();
  roundRect(cs, r, H, radius);
  cs._ops.push('W n', `/${name} sh`);
  cs.restore();
}

function roundRect(cs, r, H, radius) {
  const x = r.x, y = H - r.y - r.h, w = r.w, h = r.h;
  const rad = Math.min(radius, w / 2, h / 2);
  if (rad <= 0) { cs.rect(x, y, w, h); return; }
  const k = rad * K;
  cs.moveTo(x + rad, y)
    .lineTo(x + w - rad, y).curveTo(x + w - rad + k, y, x + w, y + rad - k, x + w, y + rad)
    .lineTo(x + w, y + h - rad).curveTo(x + w, y + h - rad + k, x + w - rad + k, y + h, x + w - rad, y + h)
    .lineTo(x + rad, y + h).curveTo(x + rad - k, y + h, x, y + h - rad + k, x, y + h - rad)
    .lineTo(x, y + rad).curveTo(x, y + rad - k, x + rad - k, y, x + rad, y)
    .closePath();
}

function ellipse(cs, b, H) {
  const cx = b.x + b.w / 2, cy = H - b.y - b.h / 2, rx = b.w / 2, ry = b.h / 2;
  cs.moveTo(cx + rx, cy)
    .curveTo(cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry)
    .curveTo(cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy)
    .curveTo(cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry)
    .curveTo(cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy)
    .closePath();
}

// ---------------------------------------------------------------------------
// Text (spec §4): para alignment inside a rectangle, clipped
// ---------------------------------------------------------------------------

function paintText(ctx, lines, font, para, rect, lineH) {
  if (!lines?.length || !font || font.hScale === 0 || font.vScale === 0) return;
  const pl = para?.marginLeft ?? 0, pr = para?.marginRight ?? 0;
  const above = para?.spaceAbove ?? 0, below = para?.spaceBelow ?? 0;
  const r = { x: rect.x + pl, y: rect.y + above, w: rect.w - pl - pr, h: rect.h - above - below };
  // The text block runs from the first line's ascent to the last line's
  // descent: no half-leading above the first baseline or below the last
  // (Acrobat prints: top-aligned text sits one ascent below the top,
  // bottom-aligned text one descent above the bottom)
  const { ascent, descent } = emBox(font);
  const total = (lines.length - 1) * lineH + ascent + descent;
  const vAlign = para?.vAlign ?? 'top';
  const top = vAlign === 'middle' ? r.y + (r.h - total) / 2 : vAlign === 'bottom' ? r.y + r.h - total : r.y;
  const hAlign = para?.hAlign ?? 'left';

  ctx.cs.save();
  clipRect(ctx, textClip(rect, font.size * font.vScale));
  lines.forEach((line, i) => {
    const baseline = top + ascent + i * lineH;
    const w = textWidth(font, line);
    let x = r.x + lineIndent(para?.textIndent ?? 0, i === 0);
    if (hAlign === 'center') x = r.x + (r.w - w) / 2;
    else if (hAlign === 'right' || hAlign === 'radix') x = r.x + r.w - w;
    const lastOfPara = lines.paraEnds ? lines.paraEnds.has(i) : i === lines.length - 1;
    if ((hAlign === 'justify' && !lastOfPara) || hAlign === 'justifyAll') {
      drawJustified(ctx, font, line, x, baseline, r.x + r.w - x);
    } else {
      drawRun(ctx, font, line, x, baseline);
    }
    if (font.underline) {
      const { cs, H } = ctx;
      cs.save().strokeColor(...rgb(font.color)).lineWidth(Math.max(0.5, font.size / 20))
        .moveTo(x, H - baseline - font.size * 0.1).lineTo(x + w, H - baseline - font.size * 0.1).stroke().restore();
    }
  });
  ctx.cs.restore();
}

// A justified line: words drawn one by one, the slack shared by the spaces
function drawJustified(ctx, font, line, x, baseline, avail) {
  const words = line.split(' ');
  const gaps = words.length - 1;
  const extra = gaps > 0 ? Math.max(0, avail - textWidth(font, line)) / gaps : 0;
  const space = textWidth(font, ' ') + font.letterSpacing;
  for (const word of words) {
    drawRun(ctx, font, word, x, baseline);
    x += textWidth(font, word) + (word ? font.letterSpacing : 0) + space + extra;
  }
}

function pageValue(role, ctx) {
  return role === 'page' ? ctx.page.pageNumber : ctx.page.pageCount;
}

// Floating fields: \u0001id\u0002 → the referenced field's value, or the
// page number / count for page-number fields
function resolveEmbeds(str, ctx) {
  return str.replace(/\u0001([^\u0002]*)\u0002/g, (_, id) => {
    const f = ctx.byId.get(id);
    if (!f) return '';
    if (f.pageRole) return String(pageValue(f.pageRole, ctx));
    return f.display ?? f.raw ?? '';
  });
}

// Rich-text baseline shift: super/sub keywords, or a length in points
function shiftRise(shift, f) {
  if (typeof shift === 'number') return shift;
  return shift === 'super' ? f.size * 0.33 : shift === 'sub' ? -f.size * 0.2 : 0;
}

export function drawRun(ctx, font, str, x, baseline, extraRise = 0) {
  if (str.includes('\u0001')) str = resolveEmbeds(str, ctx);
  if (!str) return;
  str = symbolText(font, str);
  // Arabic joined, right-to-left runs in display order (xfa/scripts.js) in
  // a left-to-right line, as Reader lays out a field's value ("שלום עולם
  // (test)" prints its Hebrew first, at the left)
  str = visualOrder(shapeArabic(str), 'ltr');
  const runs = faceRuns(font, str);
  if (runs.length > 1 || runs[0].scale) {
    // runs of different faces, one after another
    for (const r of runs) {
      const f = r.scale ? { ...font, size: font.size * r.scale, hScale: font.hScale * r.squeeze } : font;
      drawFace(ctx, f, r.text, x, baseline, extraRise, r.face);
      x += runWidth(font, r) * font.hScale + [...r.text].length * font.letterSpacing;
    }
    return;
  }
  drawFace(ctx, font, str, x, baseline, extraRise, runs[0].face);
}

// A run in one face: an embedded one (two-byte glyph ids, a CJK font's
// UTF-16), else the standard font
function drawFace(ctx, font, str, x, baseline, extraRise, ttf) {
  const opts = {
    hScale: font.hScale,
    vScale: font.vScale,
    charSpacing: font.letterSpacing ? font.letterSpacing / (font.hScale || 1) : 0,
    rise: (font.baselineShift ? -font.baselineShift : 0) + extraRise,
  };
  if (ttf?.cjk) {
    if (!ctx.glyphUsage.has(ttf)) ctx.glyphUsage.set(ttf, new Map());
    let hex = '';
    for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0');
    ctx.cs.text(x, ctx.H - baseline, ttf.resName, font.size, rgb(font.color), str, {
      ...opts, hex, skew: font.italic ? 0.21 : 0, fakeBold: font.bold,
    });
    return;
  }
  if (ttf?.squeeze && ttf.squeeze !== 1) {
    opts.hScale *= ttf.squeeze;
    opts.charSpacing /= ttf.squeeze;
  }
  if (ttf) {
    // Identity-H: two-byte glyph ids; remember them for the subset and ToUnicode
    let used = ctx.glyphUsage.get(ttf);
    if (!used) ctx.glyphUsage.set(ttf, used = new Map());
    let hex = '';
    // substitute glyphs sit centred in the slots of the face they stand in
    // for: TJ moves each one right by its offset and back after it
    const tj = ttf.centreOffset ? [] : null;
    let carry = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      const gid = ttf.glyphFor(cp);
      if (gid && !used.has(gid)) used.set(gid, cp);
      const g = gid.toString(16).padStart(4, '0');
      hex += g;
      if (tj) {
        const d = ttf.centreOffset(gid, cp);
        const adj = Math.round((carry - d) * 100) / 100;
        if (Math.abs(adj) >= 0.5) tj.push(adj);
        if (typeof tj.at(-1) === 'string') tj[tj.length - 1] += g; else tj.push(g);
        carry = d;
      }
    }
    if (tj && Math.abs(carry) >= 0.5) tj.push(Math.round(carry * 100) / 100);
    const plain = !tj || tj.length === 1;
    ctx.cs.text(x, ctx.H - baseline, ttf.resName, font.size, rgb(font.color), str, {
      ...opts, hex, tj: plain ? null : tj,
      skew: font.italic && !ttf.native && !ttf.glyphItalic ? 0.21 : 0, // synthesized oblique
      fakeBold: font.bold && !ttf.native && !ttf.glyphBold,           // synthesized bold
    });
    return;
  }
  // a declared serif face: the standard Times stretched to its widths
  const k = timesScale(font, str);
  if (k !== 1) { opts.hScale *= k; opts.charSpacing /= k; }
  ctx.cs.text(x, ctx.H - baseline, standardFontName(font.face, font.bold, font.italic), font.size, rgb(font.color),
    encodeStandard(str, ctx.extraGlyphs), { ...opts, encoded: true });
}

function paintCaption(n, p, box, ctx) {
  const rect = offset(p.caption, box, n.caption.margin);
  // Reader centres a caption between the field's top inset and its outer
  // bottom edge: the bottom inset does not count (the itext and pdfium
  // sample fields' 1mm insets put their captions 1.4pt lower in Reader,
  // dclUnica and declaratieUnica agree)
  // A check box's caption is centred between both insets (declaratieUnica's
  // i13, bottomInset 5mm, prints its caption 7pt higher than the rule above)
  if ((n.caption.para?.vAlign ?? 'top') === 'middle' && n.ui?.kind !== 'checkButton') rect.h += n.margin?.bottom ?? 0;
  if (p.captionRich) paintRich(ctx, p.captionRich, n.caption.para, rect);
  else paintText(ctx, p.captionLines, p.captionFont, n.caption.para, rect, p.captionLineH);
}

// Styled lines from rich.js: per-line alignment, per-segment font, colour,
// underline/strike-through and super/subscript, clipped to the rectangle
export function paintRich(ctx, lines, para, rect) {
  if (!lines?.length) return;
  const above = para?.spaceAbove ?? 0, below = para?.spaceBelow ?? 0;
  const r = { x: rect.x, y: rect.y + above, w: rect.w, h: rect.h - above - below };
  const total = paintedHeight(lines);
  const vAlign = para?.vAlign ?? 'top';
  let y = vAlign === 'middle' ? r.y + (r.h - total) / 2 : vAlign === 'bottom' ? r.y + r.h - total : r.y;
  const { cs, H } = ctx;

  cs.save();
  clipRect(ctx, textClip(rect, Math.max(...lines.map(l => l.ascent + l.descent))));
  for (const line of lines) {
    y += line.spaceBefore;
    const baseline = y + (line.height - (line.ascent + line.descent)) / 2 + line.ascent;
    const avail = r.w - line.marginLeft - line.marginRight;
    let x = r.x + line.marginLeft + line.indent;
    if (line.align === 'center') x = r.x + line.marginLeft + (avail - line.width) / 2;
    else if (line.align === 'right' || line.align === 'radix') x = r.x + line.marginLeft + avail - line.width;
    // justify: the slack is shared by the spaces of every line but a
    // paragraph's last (justifyAll: every line)
    // a list marker hangs left of the item's text, half an em away
    if (line.marker) {
      const m = line.marker;
      drawRun(ctx, m.font, m.text, r.x + line.marginLeft + line.indent - 0.5 * m.font.size - m.w, baseline, 0);
    }
    let extra = 0;
    if ((line.align === 'justify' && !line.paraEnd) || line.align === 'justifyAll') {
      const gaps = line.segments.reduce((n, s) => n + (s.text?.match(/ /g)?.length ?? 0), 0);
      if (gaps) extra = Math.max(0, avail - line.indent - line.width) / gaps;
    }
    for (const seg of line.segments) {
      if (extra && seg.text?.includes(' ')) {
        const f = seg.font;
        const rise = shiftRise(seg.shift, f);
        const sw = textWidth(f, ' ');
        const words = seg.text.split(' ');
        words.forEach((word, k) => {
          if (word && f.hScale !== 0 && f.vScale !== 0) drawRun(ctx, f, word, x, baseline, rise);
          const ww = textWidth(f, word);
          if ((f.underline || f.lineThrough) && word) {
            const yy = f.underline ? H - baseline - f.size * 0.1 : H - baseline + f.size * 0.3;
            cs.save().strokeColor(...rgb(f.color)).lineWidth(Math.max(0.5, f.size / 20)).moveTo(x, yy).lineTo(x + ww, yy).stroke().restore();
          }
          x += ww;
          if (k < words.length - 1) x += sw + extra;
        });
        continue;
      }
      const f = seg.font;
      const rise = shiftRise(seg.shift, f);
      const str = seg.embed ? resolveEmbeds(`\u0001${seg.embed}\u0002`, ctx) : seg.text;
      if (f.hScale !== 0 && f.vScale !== 0) drawRun(ctx, f, str, x, baseline, rise);
      const w = seg.embed ? textWidth(f, str) : seg.w;
      if ((f.underline || f.lineThrough) && str.trim()) {
        const yy = f.underline ? H - baseline + f.size * 0.1 * -1 : H - baseline + f.size * 0.3;
        cs.save().strokeColor(...rgb(f.color)).lineWidth(Math.max(0.5, f.size / 20)).moveTo(x, yy).lineTo(x + w, yy).stroke().restore();
      }
      x += w;
    }
    y += line.height + line.spaceAfter;
  }
  cs.restore();
}

// ---------------------------------------------------------------------------
// Field-name labels
// ---------------------------------------------------------------------------

/**
 * A field's name on one line in `rect` (top-left points in ctx's frame), at
 * the largest size from labels.maxSize down to labels.minSize that fits the
 * rectangle, centred vertically; a name too long at the smallest size is cut
 * off at the right edge (labels.name 'short': only the last part of the
 * name). Drawn in Helvetica (or the bundled face standing in
 * for it) in labels.color (0..255).
 */
export function paintLabel(ctx, text, rect) {
  const { color, minSize, maxSize, faces, name } = ctx.labels;
  if (name === 'short') text = shortName(text);
  if (!text || !(rect.w > 0) || !(rect.h > 0)) return;
  const mk = size => resolveFont({ typeface: 'Helvetica', size, weight: 'normal', posture: 'normal', color }, faces ? { ttf: faces } : null, ctx.log);
  const probe = mk(1);
  const { ascent, descent } = emBox(probe);
  const pad = rect.w > 10 ? LABEL_PAD : 0;
  const tw = textWidth(probe, text);
  let size = Math.min(maxSize, rect.h / (ascent + descent));
  if (tw > 0) size = Math.min(size, (rect.w - 2 * pad) / tw);
  size = Math.max(minSize, Math.floor(size * 4) / 4);
  const font = mk(size);
  const baseline = rect.y + (rect.h - size * (ascent + descent)) / 2 + size * ascent;
  // clipped at the sides only: a name in a box lower than the smallest size
  // still shows whole
  const top = Math.min(rect.y, baseline - size * ascent * 1.3), bottom = Math.max(rect.y + rect.h, baseline + size * descent * 1.5);
  ctx.cs.save();
  clipRect(ctx, { x: rect.x, y: top, w: rect.w, h: bottom - top });
  drawRun(ctx, font, text, rect.x + pad, baseline);
  ctx.cs.restore();
}
const LABEL_PAD = 2;

// The last part of a full name, without a [0] index ("a[0].b[0].c[2]" →
// "c[2]"; a button's "=<on state>" is kept)
export function shortName(full) {
  const [name, ...state] = String(full).split('=');
  const last = name.split('.').filter(Boolean).at(-1) ?? '';
  return [last.replace(/\[0\]$/, ''), ...state].join('=');
}

// A field's full name as Acrobat shows it: every level with its index,
// a nameless container as #subform ("form1[0].#subform[0].Name[0]")
function fieldLabel(n) {
  return String(n.som ?? n.name ?? '').split('.').filter(Boolean)
    .map(s => (s.startsWith('#') ? `#subform${s.slice(1)}` : s))
    .map(s => (/\[\d+\]$/.test(s) ? s : `${s}[0]`)).join('.');
}

// ---------------------------------------------------------------------------
// Geometry helpers (top-left page points until the seal)
// ---------------------------------------------------------------------------

function offset(rel, box, margin) {
  const r = { x: box.x + rel.x, y: box.y + rel.y, w: rel.w, h: rel.h };
  return margin ? inset(r, margin, true) : r;
}

function inset(r, m, apply) {
  if (!m || !apply) return r;
  return { x: r.x + m.left, y: r.y + m.top, w: Math.max(0, r.w - m.left - m.right), h: Math.max(0, r.h - m.top - m.bottom) };
}

// Text clips to its box with headroom above and below: accents on capitals
// and descenders reach past the ascent/descent box the text is placed by,
// and Reader does not cut them off (Stammdatenaenderung's 'Änderungen')
function textClip(r, size) {
  const pad = 0.3 * size;
  return { x: r.x, y: r.y - pad, w: r.w, h: r.h + 2 * pad };
}

function clipRect(ctx, r) {
  ctx.cs.rect(r.x, ctx.H - r.y - r.h, Math.max(0, r.w), Math.max(0, r.h)).clip();
}

function rgb(c) {
  const v = c ?? [0, 0, 0];
  return [v[0] / 255, v[1] / 255, v[2] / 255];
}

