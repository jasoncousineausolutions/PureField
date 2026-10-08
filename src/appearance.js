/**
 * Purefield / appearance.js
 *
 * Generates the normal appearance of an AcroForm widget that has none, or
 * whose form asks for appearances to be regenerated (/NeedAppearances), as
 * a viewer would before printing (PDF 32000 §12.7.3.3, §12.7.4). The
 * rectangle is fixed; inside it:
 *
 *   background   /MK /BG, then the border in /MK /BC, /BS /W and /BS /S
 *                (solid, dashed, beveled, inset, underline); radio buttons
 *                in the circle style are round
 *   text         /DA (font, size, colour; size 0 fits the box), /Q
 *                alignment; one line centred vertically, or wrapped from
 *                the top (multiline), or one character per cell (comb,
 *                MaxLen); passwords as asterisks
 *   choice       a combo box shows the label of its value; a list box its
 *                options from /TI, the selected ones highlighted
 *   check box,   when /AS (else /V) is on: the /MK /CA ZapfDingbats mark
 *   radio        (check 4, circle l, cross 8, diamond u, square n, star H),
 *                drawn as a shape
 *   push button  its /MK /CA caption, centred; one with no caption is left
 *                out
 *
 * Text goes through the same fonts as XFA text (xfa/text.js, xfa/paint.js
 * drawRun): the /DR font's family picks the standard face or the bundled
 * one, and a face the form declares is measured at its own widths.
 */

import { ContentStream } from './core/writer.js';
import { resolveFont, textWidth, wrapText, emBox, naturalLineHeight } from './xfa/text.js';
import { drawRun, paintLabel } from './xfa/paint.js';

const MULTILINE = 1 << 12, PASSWORD = 1 << 13, RADIO = 1 << 15, PUSH = 1 << 16, COMBO = 1 << 17, COMB = 1 << 24;
const K = 0.5522847498;
const HIGHLIGHT = [0.6, 0.757, 0.855]; // a list box's selected rows

/**
 * Operators that draw a generated appearance for widget `w` on its page
 * (coordinates relative to the page box origin), or null when there is
 * nothing to draw.
 * @param {import('./core/widgets.js').Widget} w
 * @param {{ page: object, fontOf: (name: string) => { typeface: string, bold: boolean, italic: boolean },
 *           da: string|null, q: number, faces: object|null, glyphUsage: Map, extraGlyphs: Map, log: object }} env
 */
export function generateAppearance(w, env) {
  if (w.ft !== 'Tx' && w.ft !== 'Ch' && w.ft !== 'Btn' && w.ft !== 'Sig') return null;
  const push = w.ft === 'Btn' && (w.ff & PUSH);
  const icon = push && w.mk.tp !== 0 ? env.icon ?? null : null;

  const fr = frame(w);
  if (!fr) return null;
  const { W, H } = fr;

  const cs = new ContentStream();
  const ctx = { cs, H, glyphUsage: env.glyphUsage, extraGlyphs: env.extraGlyphs, log: env.log };
  // a radio button is round in the circle style (/MK /CA l, the default),
  // square in the others
  const round = w.ft === 'Btn' && !push && (w.ff & RADIO) && (w.mk.ca ?? 'l') === 'l';
  const bw = w.mk.bc ? Math.max(0, w.border.width) : 0;
  chrome(cs, w, W, H, bw, round);

  // with no /DA anywhere Reader draws a text or choice field's chrome alone
  if ((w.ft === 'Tx' || w.ft === 'Ch') && w.da == null && env.da == null) {
    env.log.warn('ACRO_NO_DA', `field "${w.name}" has no default appearance (/DA); its value is not drawn`);
    return place(cs, fr, w, env.page);
  }
  const da = parseDa(w.da ?? env.da ?? '/Helv 0 Tf 0 g');
  if (w.textColor) da.color = w.textColor; // set by a form script
  const family = env.fontOf(da.font);
  const style = w.border.style;
  const pad = bw * (style === 'B' || style === 'I' ? 2 : 1);
  const inner = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad };
  const mkFont = size => resolveFont({ typeface: family.typeface, size, weight: family.bold ? 'bold' : 'normal',
    posture: family.italic ? 'italic' : 'normal', color: da.color.map(c => Math.round(c * 255)) }, env.faces ? { ttf: env.faces } : null, env.log);

  if (w.ft === 'Sig') {
    // an unsigned signature field: its background and border alone
  } else if (w.ft === 'Btn' && !push) {
    if (on(w)) mark(cs, w.mk.ca ?? (round ? 'l' : '4'), inner, da, round);
  } else if (push) {
    pushButton(ctx, cs, w, icon, w.mk.fit?.fb ? { x: 0, y: 0, w: W, h: H } : inner, mkFont, da.size);
  } else if (w.ft === 'Tx') {
    // the plain value: Reader draws a rich text field's /V, not its /RV
    let value = Array.isArray(w.value) ? w.value.join(' ') : w.value ?? '';
    value = String(value);
    if (w.ff & PASSWORD) value = '*'.repeat([...value].length);
    // the text its format action shows (acroscript.js)
    else if (w.displayValue !== undefined && w.displayValue !== null) value = String(w.displayValue);
    const q = w.q ?? env.q ?? 0;
    if ((w.ff & COMB) && w.maxLen > 0 && !(w.ff & (MULTILINE | PASSWORD))) comb(ctx, cs, value, { x: 0, y: inner.y, w: W, h: inner.h }, mkFont, da.size, w.maxLen);
    else if (w.ff & MULTILINE) textBox(ctx, cs, [value], inner, mkFont, da.size, q, true);
    else textBox(ctx, cs, [value.replace(/[\r\n]+/g, ' ')], inner, mkFont, da.size, q, false);
  } else if (w.ft === 'Ch') {
    const values = Array.isArray(w.value) ? w.value : w.value === null ? [] : [w.value];
    const label = v => w.opt.find(o => o.value === v)?.label ?? v;
    if (w.ff & COMBO) textBox(ctx, cs, [String(w.displayValue ?? label(values[0] ?? ''))], inner, mkFont, da.size, w.q ?? env.q ?? 0, false);
    else listBox(ctx, cs, w, values, inner, mkFont, da.size);
  }

  return place(cs, fr, w, env.page);
}

/**
 * Operators that draw `text` (the field's name) in widget `w` instead of the
 * widget, as paintLabel sets it, turned by /MK /R like the widget's content.
 * @param {{ page: object, labels: { color: number[], minSize: number, maxSize: number, name: 'full'|'short' }, faces: object|null,
 *           glyphUsage: Map, extraGlyphs: Map, log: object }} env
 */
export function labelAppearance(w, text, env) {
  const fr = frame(w);
  if (!fr) return null;
  const cs = new ContentStream();
  const ctx = { cs, H: fr.H, labels: { ...env.labels, faces: env.faces }, glyphUsage: env.glyphUsage, extraGlyphs: env.extraGlyphs, log: env.log };
  paintLabel(ctx, text, { x: 0, y: 0, w: fr.W, h: fr.H });
  return place(cs, fr, w, env.page);
}

// /MK /R turns the content: the box is drawn in its own upright frame, W by H
function frame(w) {
  const [x0, y0, x1, y1] = w.rect;
  const r = ((w.mk.r % 360) + 360) % 360;
  const W = r === 90 || r === 270 ? y1 - y0 : x1 - x0;
  const H = r === 90 || r === 270 ? x1 - x0 : y1 - y0;
  if (W <= 0 || H <= 0) return null;
  const turn = r === 90 ? `0 1 -1 0 ${num(x1 - x0)} 0 cm` : r === 180 ? `-1 0 0 -1 ${num(W)} ${num(H)} cm` : r === 270 ? `0 -1 1 0 0 ${num(y1 - y0)} cm` : '';
  return { W, H, turn };
}

// The frame's content moved onto the widget rectangle, relative to the page
// box origin
function place(cs, fr, w, page) {
  const body = cs.toString();
  if (!body) return null;
  const [ox, oy] = page.mediaBox;
  return `q 1 0 0 1 ${num(w.rect[0] - ox)} ${num(w.rect[1] - oy)} cm ${fr.turn}\n${body}\nQ`;
}

// A push button: its icon (/MK /I) and caption (/MK /CA) placed by /MK /TP
// (0 caption only, 1 icon only, 2 caption below the icon, 3 above, 4 to
// its right, 5 to its left, 6 over it), the icon fitted by /MK /IF
function pushButton(ctx, cs, w, icon, box, mkFont, size) {
  const caption = w.mk.ca ?? '';
  const tp = icon ? w.mk.tp : 0;
  if (!icon || tp === 0) { if (caption) textBox(ctx, cs, [caption], box, mkFont, size, 1, false); return; }
  let iconBox = box, textArea = null;
  if (caption && tp >= 2 && tp <= 5) {
    const f = mkFont(size > 0 ? size : 12);
    const lh = naturalLineHeight(f) + 2;
    const tw = textWidth(f, caption) + 2 * HPAD;
    if (tp === 2) { textArea = { ...box, h: Math.min(lh, box.h) }; iconBox = { ...box, y: box.y + textArea.h, h: box.h - textArea.h }; }
    else if (tp === 3) { textArea = { ...box, y: box.y + box.h - Math.min(lh, box.h), h: Math.min(lh, box.h) }; iconBox = { ...box, h: box.h - textArea.h }; }
    else if (tp === 4) { textArea = { ...box, x: box.x + box.w - Math.min(tw, box.w), w: Math.min(tw, box.w) }; iconBox = { ...box, w: box.w - textArea.w }; }
    else { textArea = { ...box, w: Math.min(tw, box.w) }; iconBox = { ...box, x: box.x + textArea.w, w: box.w - textArea.w }; }
  } else if (caption && tp === 6) textArea = box;
  placeIcon(cs, icon, iconBox, w.mk.fit);
  if (textArea && caption) textBox(ctx, cs, [caption], textArea, mkFont, size, 1, false);
}

/** The operators that draw icon XObject `icon.name` in box, fitted by /IF */
export function placeIcon(cs, icon, box, fit = { sw: 'A', s: 'P', a: [0.5, 0.5] }) {
  const [a, b, c, d, e, f] = icon.matrix;
  const [x0, y0, x1, y1] = icon.bbox;
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const bx0 = Math.min(...pts.map(p => p[0])), by0 = Math.min(...pts.map(p => p[1]));
  const iw = Math.max(...pts.map(p => p[0])) - bx0, ih = Math.max(...pts.map(p => p[1])) - by0;
  if (iw <= 0 || ih <= 0 || box.w <= 0 || box.h <= 0) return;
  let sx = box.w / iw, sy = box.h / ih;
  if (fit.s !== 'A') sx = sy = Math.min(sx, sy);
  const bigger = iw > box.w || ih > box.h;
  if (fit.sw === 'N' || (fit.sw === 'B' && !bigger) || (fit.sw === 'S' && bigger)) sx = sy = 1;
  const [ax, ay] = fit.a ?? [0.5, 0.5];
  const tx = box.x + (box.w - iw * sx) * ax - bx0 * sx, ty = box.y + (box.h - ih * sy) * ay - by0 * sy;
  cs.save().rect(box.x, box.y, box.w, box.h).clip();
  cs._ops.push(`q ${num(sx)} 0 0 ${num(sy)} ${num(tx)} ${num(ty)} cm /${icon.name} Do Q`);
  cs.restore();
}

// A check box or radio button is on when its state (else its value) is not Off
function on(w) {
  const s = w.as ?? (typeof w.value === 'string' ? w.value : null);
  return !!s && s !== 'Off';
}

// ---------------------------------------------------------------------------
// Background and border
// ---------------------------------------------------------------------------

function chrome(cs, w, W, H, bw, round) {
  const shape = (inset) => {
    if (round) ellipsePath(cs, inset, inset, W - 2 * inset, H - 2 * inset);
    else cs.rect(inset, inset, W - 2 * inset, H - 2 * inset);
  };
  if (w.mk.bg) { cs.fillColor(...w.mk.bg); shape(0); cs.fill(); }
  if (!w.mk.bc || bw <= 0) return;
  const style = w.border.style;
  if (style === 'B' || style === 'I') {
    // the bevel inside the border: light top-left, dark bottom-right
    const [light, dark] = style === 'B'
      ? [[1, 1, 1], (w.mk.bg ?? [1, 1, 1]).map(c => c / 2)]
      : [[0.5, 0.5, 0.5], [0.75, 0.75, 0.75]];
    if (!round) {
      const b = bw;
      cs.fillColor(...light).moveTo(b, b).lineTo(b, H - b).lineTo(W - b, H - b).lineTo(W - 2 * b, H - 2 * b)
        .lineTo(2 * b, H - 2 * b).lineTo(2 * b, 2 * b).closePath().fill();
      cs.fillColor(...dark).moveTo(W - b, H - b).lineTo(W - b, b).lineTo(b, b).lineTo(2 * b, 2 * b)
        .lineTo(W - 2 * b, 2 * b).lineTo(W - 2 * b, H - 2 * b).closePath().fill();
    }
  }
  cs.strokeColor(...w.mk.bc).lineWidth(bw);
  if (style === 'U') {
    cs.moveTo(0, bw / 2).lineTo(W, bw / 2).stroke();
    return;
  }
  if (style === 'D') cs.dash(w.border.dash);
  shape(bw / 2);
  cs.stroke();
  if (style === 'D') cs.dash([]);
}

export function ellipsePath(cs, x, y, w, h) {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  cs.moveTo(cx + rx, cy)
    .curveTo(cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry)
    .curveTo(cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy)
    .curveTo(cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry)
    .curveTo(cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy)
    .closePath();
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const HPAD = 2; // text sits 2pt inside the border, as Acrobat sets it

/**
 * Lines of text in a box: one centred vertically, or (multiline) wrapped
 * from the top. Size 0 fits the box: one line to its height and width,
 * wrapped text the largest size whose lines all fit, at most 12pt.
 */
export function textBox(ctx, cs, texts, box, mkFont, size, q, multiline) {
  const text = texts.join('\n');
  if (!text) return;
  const avail = box.w - 2 * HPAD;
  if (avail <= 0 || box.h <= 0) return;
  let font, lines;
  if (multiline) {
    const fits = s => {
      const f = mkFont(s);
      const ls = wrapText(f, text, avail);
      return { f, ls, ok: s + (ls.length - 1) * naturalLineHeight(f) <= box.h - 2 };
    };
    if (size > 0) ({ f: font, ls: lines } = fits(size));
    else {
      let s = 12, r = fits(s);
      while (!r.ok && s > 4) r = fits(s -= 0.5);
      ({ f: font, ls: lines } = r);
    }
  } else {
    let s = size;
    if (!(s > 0)) {
      const probe = mkFont(1);
      const e = emBox(probe);
      s = Math.min(12, (box.h - 2) / (e.ascent + e.descent));
      const tw = textWidth(probe, text);
      if (tw > 0) s = Math.min(s, avail / tw);
      s = Math.max(4, Math.floor(s * 2) / 2);
    }
    font = mkFont(s);
    lines = [text];
  }

  cs.save().rect(box.x, box.y, box.w, box.h).clip();
  const { ascent, descent } = emBox(font);
  const lh = naturalLineHeight(font);
  // baselines in the frame the text is drawn in (y down from the top)
  const top = ctx.H - (box.y + box.h);
  let first = multiline ? top + 1 + ascent : top + (box.h - (ascent + descent)) / 2 + ascent;
  lines.forEach((line, i) => {
    const w = textWidth(font, line);
    const x = q === 1 ? box.x + (box.w - w) / 2 : q === 2 ? box.x + box.w - HPAD - w : box.x + HPAD;
    if (line) drawRun(ctx, font, line, x, first + i * lh);
  });
  cs.restore();
}

// A comb: the box split into MaxLen cells, one character centred in each
function comb(ctx, cs, text, box, mkFont, size, cells) {
  if (!text) return;
  const cw = box.w / cells;
  let s = size;
  if (!(s > 0)) {
    const e = emBox(mkFont(1));
    s = Math.max(4, Math.min(12, (box.h - 2) / (e.ascent + e.descent)));
  }
  const font = mkFont(s);
  const { ascent, descent } = emBox(font);
  const baseline = ctx.H - (box.y + box.h) + (box.h - (ascent + descent)) / 2 + ascent;
  [...text].slice(0, cells).forEach((ch, i) => {
    const w = textWidth(font, ch);
    drawRun(ctx, font, ch, box.x + i * cw + (cw - w) / 2, baseline);
  });
}

// A list box: its options from the top index, the selected rows highlighted
function listBox(ctx, cs, w, values, box, mkFont, size) {
  if (!w.opt.length) return;
  const font = mkFont(size > 0 ? size : 12);
  const lh = naturalLineHeight(font);
  const { ascent } = emBox(font);
  const selected = new Set(w.selected.length ? w.selected : w.opt.map((o, i) => (values.includes(o.value) ? i : -1)).filter(i => i >= 0));
  cs.save().rect(box.x, box.y, box.w, box.h).clip();
  let top = 0;
  for (let i = w.topIndex; i < w.opt.length && top < box.h; i++, top += lh) {
    const yTop = box.y + box.h - top;
    if (selected.has(i)) cs.fillColor(...HIGHLIGHT).rect(box.x, yTop - lh, box.w, lh).fill();
    drawRun(ctx, font, w.opt[i].label, box.x + HPAD, ctx.H - yTop + (lh - font.size) / 2 + ascent);
  }
  cs.restore();
}

// ---------------------------------------------------------------------------
// Check marks
// ---------------------------------------------------------------------------

// A ZapfDingbats caption character drawn as the shape it stands for, sized
// to the box (or to the /DA size) and centred, in the /DA colour
function mark(cs, ca, box, da, round) {
  const side = Math.min(box.w, box.h);
  const s = da.size > 0 ? Math.min(side, da.size) : side * 0.8;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const L = cx - s / 2, B = cy - s / 2;
  cs.save().fillColor(...da.color).strokeColor(...da.color);
  switch (String(ca)[0]) {
    case 'l': // circle (a radio button's dot)
      ellipsePath(cs, cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6); cs.fill(); break;
    case '8': // cross
      cs.lineWidth(Math.max(0.5, s * 0.1)).moveTo(L + s * 0.15, B + s * 0.15).lineTo(L + s * 0.85, B + s * 0.85)
        .moveTo(L + s * 0.15, B + s * 0.85).lineTo(L + s * 0.85, B + s * 0.15).stroke();
      break;
    case 'u': // diamond
      cs.moveTo(cx, B + s * 0.9).lineTo(L + s * 0.9, cy).lineTo(cx, B + s * 0.1).lineTo(L + s * 0.1, cy).closePath().fill(); break;
    case 'n': // square
      cs.rect(L + s * 0.2, B + s * 0.2, s * 0.6, s * 0.6).fill(); break;
    case 'H': { // star
      cs.moveTo(...star(cx, cy, s * 0.45, 0));
      for (let i = 1; i < 10; i++) cs.lineTo(...star(cx, cy, i % 2 ? s * 0.18 : s * 0.45, i));
      cs.closePath().fill();
      break;
    }
    default: // check (4)
      cs.lineWidth(Math.max(0.5, s * 0.12)).lineCap(1).lineJoin(1)
        .moveTo(L + s * 0.15, B + s * 0.5).lineTo(L + s * 0.4, B + s * 0.2).lineTo(L + s * 0.85, B + s * 0.85).stroke();
  }
  cs.restore();
  void round;
}

function star(cx, cy, r, i) {
  const a = Math.PI / 2 + i * Math.PI / 5;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// ---------------------------------------------------------------------------
// Default appearance strings and fonts
// ---------------------------------------------------------------------------

/** /DA: "/Helv 12 Tf 0 0 1 rg" → { font: 'Helv', size: 12, color: [0, 0, 1] } (colour 0..1) */
export function parseDa(da) {
  const out = { font: 'Helv', size: 0, color: [0, 0, 0] };
  const stack = [];
  for (const tok of String(da).match(/\/[^\s/[\]()<>]+|[^\s/]+/g) ?? []) {
    if (tok === 'Tf') { out.size = Number(stack.pop()) || 0; const n = stack.pop(); if (typeof n === 'string' && n.startsWith('/')) out.font = n.slice(1); stack.length = 0; }
    else if (tok === 'g') { const g = Number(stack.pop()); out.color = [g, g, g]; stack.length = 0; }
    else if (tok === 'rg') { const b = Number(stack.pop()), g = Number(stack.pop()), r = Number(stack.pop()); out.color = [r, g, b]; stack.length = 0; }
    else if (tok === 'k') {
      const k = Number(stack.pop()), y = Number(stack.pop()), m = Number(stack.pop()), c = Number(stack.pop());
      out.color = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
      stack.length = 0;
    } else stack.push(tok.startsWith('/') ? tok : Number.isFinite(Number(tok)) ? Number(tok) : tok);
  }
  out.color = out.color.map(c => (Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0));
  return out;
}

// Conventional resource names when /DR does not define them
const ALIASES = { Helv: 'Helvetica', HeBo: 'Helvetica-Bold', TiRo: 'Times-Roman', TiBo: 'Times-Bold', TiIt: 'Times-Italic',
  Cour: 'Courier', CoBo: 'Courier-Bold', ZaDb: 'ZapfDingbats', Symb: 'Symbol' };

/**
 * A font's family and style from its PostScript name: "Arial-BoldItalicMT"
 * → Arial, bold, italic; "TimesNewRomanPSMT" → Times New Roman;
 * "ABCDEF+MyriadPro-Regular" → Myriad Pro.
 */
export function familyOf(baseFont) {
  let n = String(baseFont ?? 'Helvetica').replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(n);
  const italic = /italic|oblique/i.test(n);
  n = n.split(/[,-]/)[0].replace(/(PSMT|PS|MT)$/, '');
  if (n === 'Times') n = 'Times New Roman';
  const typeface = n.replace(/([a-z])([A-Z])/g, '$1 $2');
  return { typeface, bold, italic };
}

export function aliasBaseFont(name) {
  return ALIASES[name] ?? null;
}

function num(v) {
  return (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(4)).toString();
}
