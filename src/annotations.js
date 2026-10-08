/**
 * Purefield / annotations.js
 *
 * Draws the annotations a file gives no appearance (/AP), as a viewer
 * generates them before printing: the comment and markup types Acrobat
 * makes (PDF 32000 §12.5.6). Each is drawn from its dictionary:
 *
 *   Highlight     each quadrilateral of /QuadPoints filled in /C (yellow
 *                 by default), multiplied with the page beneath
 *   Underline,    a line under or through each quadrilateral, or zig-zagging
 *   StrikeOut,    along its bottom, in /C, sized by the quadrilateral's
 *   Squiggly      height as Reader draws them
 *   Line          /L, /BS width and dash, /LE endings (arrows, squares,
 *                 circles, diamonds, butts, slashes), endings filled in /IC
 *   Square,       the rectangle (less /RD), border inside it, filled in /IC
 *   Circle
 *   Polygon,      /Vertices joined, a polygon closed and filled in /IC, a
 *   PolyLine      polyline with /LE endings
 *   Ink           each path of /InkList, round caps and joins
 *   FreeText      /Contents wrapped in the rectangle (less /RD and the
 *                 border) in the /DA font, size and colour (/DS colour and
 *                 size take precedence), aligned by /Q; /C fills the box,
 *                 the border is in the /DA colour; a callout's /CL line
 *   Caret         a caret filled in /C
 *   Text          a note icon in /C (yellow by default)
 *   Stamp         Reader's placeholder: the rectangle crossed corner to
 *                 corner in black
 *
 * /CA, the annotation's opacity, applies to all of it. A cloudy border
 * (/BE /S /C) on a square, circle, polygon or free text is drawn as
 * Acrobat draws its curls (core/cloudy.js). File attachments, sounds and
 * redactions without an appearance print nothing (logged); links never
 * print.
 */

import { ContentStream } from './core/writer.js';
import { resolveFont } from './xfa/text.js';
import { textBox, ellipsePath, parseDa } from './appearance.js';
import { cloudyRect, cloudyEllipse, cloudyPolygon, rectLessDiff } from './core/cloudy.js';

const SKIPPED = new Set(['FileAttachment', 'Sound', 'Redact', 'Movie', 'Screen', '3D', 'RichMedia', 'Watermark']);

/**
 * Operators that draw annotation `w` (a Widget from core/widgets.js whose
 * `annot` is its subtype and `markup` its markupData) on its page, in
 * coordinates relative to the page box origin, or null.
 * @param {{ page: object, fontOf: (name: string) => { typeface: string, bold: boolean, italic: boolean },
 *           faces: object|null, glyphUsage: Map, extraGlyphs: Map, log: object,
 *           graphicsState: (gs: { CA?: number, ca?: number, BM?: string }) => string }} env
 */
export function annotationAppearance(w, env) {
  const m = w.markup;
  if (!m) return null;
  const type = w.annot;
  const cs = new ContentStream();
  const width = w.border.width;
  const dashed = w.border.style === 'D';
  const stroke = (c, lw = width) => {
    cs.strokeColor(...c).lineWidth(lw);
    if (dashed) cs.dash(w.border.dash);
  };
  // a cloudy border (/BE /S /C) of this intensity (core/cloudy.js)
  const curl = m.cloudy > 0 ? m.cloudy : 0;

  const quads = () => {
    const q = m.quadPoints ?? [];
    const out = [];
    for (let i = 0; i + 8 <= q.length; i += 8) out.push(q.slice(i, i + 8));
    if (!out.length) {
      const [x0, y0, x1, y1] = w.rect;
      out.push([x0, y1, x1, y1, x0, y0, x1, y0]);
    }
    return out;
  };

  let blend = null;
  switch (type) {
    case 'Highlight': {
      cs.fillColor(...(m.c ?? [1, 1, 0]));
      for (const p of quads()) cs.moveTo(p[0], p[1]).lineTo(p[2], p[3]).lineTo(p[6], p[7]).lineTo(p[4], p[5]).closePath();
      cs.fill();
      blend = 'Multiply';
      break;
    }
    // Underline, StrikeOut and Squiggly as Reader prints them, sized by
    // each quadrilateral's height h (measured on Reader's print of PDFium's
    // annotation_markup_multiline_no_ap): a line h/14 wide, 0.15h up from
    // the bottom edge or 0.44h up through the text; a zig-zag h/8 high and
    // h/4 long, h/16 above the bottom edge, in a thin line (h/50)
    case 'Underline':
    case 'StrikeOut': {
      const t = type === 'Underline' ? 0.15 : 0.44;
      for (const p of quads()) {
        const h = Math.hypot(p[0] - p[4], p[1] - p[5]);
        if (!(h > 0)) continue;
        stroke(m.c ?? [0, 0, 0], h / 14);
        cs.moveTo(p[4] + (p[0] - p[4]) * t, p[5] + (p[1] - p[5]) * t).lineTo(p[6] + (p[2] - p[6]) * t, p[7] + (p[3] - p[7]) * t).stroke();
      }
      break;
    }
    case 'Squiggly': {
      for (const p of quads()) {
        const h = p[1] - p[5];
        if (!(h > 0)) continue;
        stroke(m.c ?? [0, 0, 0], h / 50);
        const lo = p[5] + h / 16, hi = lo + h / 8, step = h / 8, end = p[6];
        let x = p[4], up = false;
        cs.moveTo(x, lo);
        while (x < end) { x = Math.min(end, x + step); up = !up; cs.lineTo(x, up ? hi : lo); }
        cs.stroke();
      }
      break;
    }
    case 'Line': {
      const l = m.l;
      if (!l || l.length < 4) return null;
      const lw = width || 1;
      stroke(m.c ?? [0, 0, 0], lw);
      cs.moveTo(l[0], l[1]).lineTo(l[2], l[3]).stroke();
      if (dashed) cs.dash([]);
      lineEnding(cs, m.le[0], l[2], l[3], l[0], l[1], lw, m.ic);
      lineEnding(cs, m.le[1], l[0], l[1], l[2], l[3], lw, m.ic);
      break;
    }
    case 'Square':
    case 'Circle': {
      if (width <= 0 && !m.ic) return null;
      const [l = 0, t = 0, r = 0, b = 0] = m.rd ?? [];
      const x0 = w.rect[0] + l + width / 2, y0 = w.rect[1] + b + width / 2;
      const rw = w.rect[2] - r - width / 2 - x0, rh = w.rect[3] - t - width / 2 - y0;
      if (rw <= 0 || rh <= 0) return null;
      if (m.ic) cs.fillColor(...m.ic);
      if (width > 0) stroke(m.c ?? [0, 0, 0]);
      if (curl && type === 'Square') cloudyRect(cs, ...rectLessDiff(w.rect, m.rd, width / 2), curl, width);
      else if (curl) cloudyEllipse(cs, ...rectLessDiff(w.rect, m.rd, 0), curl, width);
      else if (type === 'Square') cs.rect(x0, y0, rw, rh);
      else ellipsePath(cs, x0, y0, rw, rh);
      if (m.ic && width > 0) cs.fillStroke();
      else if (m.ic) cs.fill();
      else cs.stroke();
      break;
    }
    case 'Polygon':
    case 'PolyLine': {
      const v = m.vertices;
      if (!v || v.length < 4) return null;
      const lw = width || 1;
      const fill = type === 'Polygon' ? m.ic : null;
      stroke(m.c ?? [0, 0, 0], lw);
      if (fill) cs.fillColor(...fill);
      cs.lineJoin(1);
      if (curl && type === 'Polygon') {
        const pts = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
        cloudyPolygon(cs, pts, curl, lw);
      } else {
        for (let i = 0; i + 1 < v.length; i += 2) i ? cs.lineTo(v[i], v[i + 1]) : cs.moveTo(v[i], v[i + 1]);
        if (type === 'Polygon') cs.closePath();
      }
      if (fill) cs.fillStroke(); else cs.stroke();
      if (type === 'PolyLine' && v.length >= 6) {
        if (dashed) cs.dash([]);
        const n = v.length - (v.length % 2);
        lineEnding(cs, m.le[0], v[2], v[3], v[0], v[1], lw, m.ic);
        lineEnding(cs, m.le[1], v[n - 4], v[n - 3], v[n - 2], v[n - 1], lw, m.ic);
      }
      break;
    }
    case 'Ink': {
      if (!m.inkList.length) return null;
      stroke(m.c ?? [0, 0, 0], width || 1);
      cs.lineCap(1).lineJoin(1);
      for (const path of m.inkList) {
        for (let i = 0; i + 1 < path.length; i += 2) i ? cs.lineTo(path[i], path[i + 1]) : cs.moveTo(path[i], path[i + 1]);
        // a single point is a dot
        if (path.length < 4) cs.lineTo(path[0], path[1]);
      }
      cs.stroke();
      break;
    }
    case 'FreeText':
      if (!freeText(cs, w, m, env, curl)) return null;
      break;
    case 'Caret': {
      const [l = 0, t = 0, r = 0, b = 0] = m.rd ?? [];
      const x0 = w.rect[0] + l, y0 = w.rect[1] + b, x1 = w.rect[2] - r, y1 = w.rect[3] - t;
      if (x1 <= x0 || y1 <= y0) return null;
      const xm = (x0 + x1) / 2, h = y1 - y0, cw = x1 - x0;
      cs.fillColor(...(m.c ?? [0, 0, 1]))
        .moveTo(x0, y0).curveTo(xm - cw * 0.05, y0 + h * 0.1, xm, y0 + h * 0.5, xm, y1)
        .curveTo(xm, y0 + h * 0.5, xm + cw * 0.05, y0 + h * 0.1, x1, y0).closePath().fill();
      break;
    }
    case 'Text':
      noteIcon(cs, w, m);
      break;
    case 'Stamp':
      if (!stamp(cs, w)) return null;
      break;
    default:
      if (SKIPPED.has(type)) env.log.once('info', 'ACRO_ANNOT_NO_APPEARANCE', type, `${type} annotation(s) without an appearance not printed`);
      return null;
  }
  const body = cs.toString();
  if (!body) return null;
  const gs = m.ca < 1 || blend ? env.graphicsState({ ...(m.ca < 1 ? { CA: m.ca, ca: m.ca } : {}), ...(blend ? { BM: blend } : {}) }) : null;
  const [ox, oy] = env.page.mediaBox;
  const move = ox || oy ? `1 0 0 1 ${-ox} ${-oy} cm\n` : '';
  return `q\n${move}${gs ? `/${gs} gs\n` : ''}${body}\nQ`;
}

/**
 * A line ending (§12.5.6.7, Table 176) at (x, y), for a line arriving from
 * (fx, fy): its size six times the line width, closed shapes filled in ic.
 */
export function lineEnding(cs, kind, fx, fy, x, y, lw, ic) {
  if (!kind || kind === 'None') return;
  const len = Math.hypot(x - fx, y - fy);
  if (!(len > 0)) return;
  const ux = (x - fx) / len, uy = (y - fy) / len; // along the line, outwards
  const nx = -uy, ny = ux;
  const size = 6 * lw;
  const at = (a, b) => [x + ux * a + nx * b, y + uy * a + ny * b]; // a along, b across
  const closed = ['ClosedArrow', 'RClosedArrow', 'Square', 'Circle', 'Diamond'].includes(kind);
  const finish = () => {
    if (closed && ic) cs.fillColor(...ic).fillStroke();
    else if (closed) cs.stroke();
    else cs.stroke();
  };
  const half = size * Math.tan(Math.PI / 6); // 30° either side of the line
  switch (kind) {
    case 'OpenArrow':
    case 'ClosedArrow': {
      const [ax, ay] = at(-size, half), [bx, by] = at(-size, -half);
      cs.moveTo(ax, ay).lineTo(x, y).lineTo(bx, by);
      if (kind === 'ClosedArrow') cs.closePath();
      finish();
      break;
    }
    case 'ROpenArrow':
    case 'RClosedArrow': {
      const [ax, ay] = at(size, half), [bx, by] = at(size, -half);
      cs.moveTo(ax, ay).lineTo(x, y).lineTo(bx, by);
      if (kind === 'RClosedArrow') cs.closePath();
      finish();
      break;
    }
    case 'Square': {
      const h = size / 2;
      const pts = [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
      cs.moveTo(...pts[0]).lineTo(...pts[1]).lineTo(...pts[2]).lineTo(...pts[3]).closePath();
      finish();
      break;
    }
    case 'Diamond': {
      const h = size / 2;
      const pts = [at(-h, 0), at(0, h), at(h, 0), at(0, -h)];
      cs.moveTo(...pts[0]).lineTo(...pts[1]).lineTo(...pts[2]).lineTo(...pts[3]).closePath();
      finish();
      break;
    }
    case 'Circle':
      ellipsePath(cs, x - size / 2, y - size / 2, size, size);
      finish();
      break;
    case 'Butt':
      cs.moveTo(...at(0, size / 2)).lineTo(...at(0, -size / 2));
      finish();
      break;
    case 'Slash': {
      // 30° clockwise from the perpendicular
      const a = Math.PI / 6, h = size / 2;
      cs.moveTo(...at(-Math.sin(a) * h, Math.cos(a) * h)).lineTo(...at(Math.sin(a) * h, -Math.cos(a) * h));
      finish();
      break;
    }
  }
}

// /DS: a CSS style string ("font: 12pt Helvetica; color:#FF0000")
function parseDs(ds) {
  const out = {};
  if (!ds) return out;
  const color = /color\s*:\s*#([0-9a-f]{6})\b/i.exec(ds);
  if (color) out.color = [0, 2, 4].map(i => parseInt(color[1].slice(i, i + 2), 16) / 255);
  const size = /(?:font-size\s*:|font\s*:[^;]*?)\s*([\d.]+)\s*pt/i.exec(ds);
  if (size) out.size = Number(size[1]);
  return out;
}

function freeText(cs, w, m, env, curl) {
  const da = parseDa(m.da ?? '/Helv 12 Tf 0 g');
  const ds = parseDs(m.ds);
  const [l = 0, t = 0, r = 0, b = 0] = m.rd ?? [];
  const x0 = w.rect[0] + l, y0 = w.rect[1] + b, x1 = w.rect[2] - r, y1 = w.rect[3] - t;
  const bw = Math.max(0, w.border.width);
  let drew = false;

  // the callout line, from the point it marks to the box
  const cl = m.cl;
  if (m.intent === 'FreeTextCallout' && cl && cl.length >= 4) {
    cs.strokeColor(...da.color).lineWidth(bw || 1);
    cs.moveTo(cl[0], cl[1]);
    for (let i = 2; i + 1 < cl.length; i += 2) cs.lineTo(cl[i], cl[i + 1]);
    cs.stroke();
    lineEnding(cs, m.le[0], cl[2], cl[3], cl[0], cl[1], bw || 1, m.c);
    drew = true;
  }
  if (x1 <= x0 || y1 <= y0) return drew;
  if (curl) {
    // the clouds hang outside the box path; the text stays inside it
    if (m.c) cs.fillColor(...m.c);
    cs.strokeColor(...da.color).lineWidth(bw || 1);
    cloudyRect(cs, ...rectLessDiff(w.rect, m.rd, (bw || 1) / 2), curl, bw || 1);
    if (m.c) cs.fillStroke(); else cs.stroke();
    drew = true;
  } else {
    if (m.c) { cs.fillColor(...m.c).rect(x0, y0, x1 - x0, y1 - y0).fill(); drew = true; }
    if (bw > 0) {
      cs.strokeColor(...da.color).lineWidth(bw);
      if (w.border.style === 'D') cs.dash(w.border.dash);
      cs.rect(x0 + bw / 2, y0 + bw / 2, x1 - x0 - bw, y1 - y0 - bw).stroke();
      if (w.border.style === 'D') cs.dash([]);
      drew = true;
    }
  }
  const text = (m.contents ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return drew;
  if (m.rotate % 360) env.log.once('info', 'ACRO_FREETEXT_ROTATED', 'rotate', 'free text /Rotate not applied');
  const color = ds.color ?? da.color;
  const size = ds.size ?? (da.size || 12);
  const family = env.fontOf(da.font);
  const mkFont = s => resolveFont({ typeface: family.typeface, size: s, weight: family.bold ? 'bold' : 'normal',
    posture: family.italic ? 'italic' : 'normal', color: color.map(c => Math.round(c * 255)) }, env.faces ? { ttf: env.faces } : null, env.log);
  // the text box, drawn in its own frame from its bottom-left corner
  const W = x1 - x0 - 2 * bw, H = y1 - y0 - 2 * bw;
  if (W <= 0 || H <= 0) return drew;
  const inner = new ContentStream();
  const ctx = { cs: inner, H, glyphUsage: env.glyphUsage, extraGlyphs: env.extraGlyphs, log: env.log };
  textBox(ctx, inner, [text], { x: 0, y: 0, w: W, h: H }, mkFont, size, m.q, true);
  const body = inner.toString();
  if (!body) return drew;
  cs.save();
  cs._ops.push(`1 0 0 1 ${+(x0 + bw).toFixed(3)} ${+(y0 + bw).toFixed(3)} cm`, body);
  cs.restore();
  return true;
}

// A note: a sheet with a folded corner and ruled lines, filled in /C, at
// the rectangle's top-left (20 by 20 when the rectangle is smaller)
function noteIcon(cs, w, m) {
  const [rx0, , , ry1] = w.rect;
  const s = Math.min(w.rect[2] - rx0, ry1 - w.rect[1]) >= 10 ? Math.min(w.rect[2] - rx0, ry1 - w.rect[1]) : 20;
  const x = rx0, y = ry1 - s, u = s / 20;
  cs.save().lineWidth(u).strokeColor(0, 0, 0).fillColor(...(m.c ?? [1, 1, 0])).lineJoin(1);
  cs.moveTo(x + 2 * u, y + 1 * u).lineTo(x + 2 * u, y + 19 * u).lineTo(x + 18 * u, y + 19 * u).lineTo(x + 18 * u, y + 6 * u)
    .lineTo(x + 13 * u, y + 1 * u).closePath().fillStroke();
  cs.moveTo(x + 13 * u, y + 1 * u).lineTo(x + 13 * u, y + 6 * u).lineTo(x + 18 * u, y + 6 * u).stroke();
  for (const ly of [15, 12, 9]) cs.moveTo(x + 5 * u, y + ly * u).lineTo(x + 15 * u, y + ly * u);
  cs.moveTo(x + 5 * u, y + 6 * u).lineTo(x + 10 * u, y + 6 * u).stroke();
  cs.restore();
}

// ---------------------------------------------------------------------------
// Stamps (§12.5.6.12): Reader draws a stamp with no appearance as a
// placeholder, whatever its /Name and /C: the rectangle crossed corner to
// corner, in black 1pt lines inside it

function stamp(cs, w) {
  const [x0, y0, x1, y1] = w.rect;
  if (x1 - x0 <= 1 || y1 - y0 <= 1) return false;
  const [l, b, r, t] = [x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5];
  cs.save().strokeColor(0, 0, 0).lineWidth(1)
    .rect(l, b, r - l, t - b).moveTo(l, b).lineTo(r, t).moveTo(l, t).lineTo(r, b).stroke().restore();
  return true;
}
