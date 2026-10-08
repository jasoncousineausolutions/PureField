/**
 * Purefield / xfa / rich.js
 *
 * Rich text: the exData text/html subset (spec §4) — p, span, b/strong,
 * i/em, u, br, div, ul/ol/li — with a short CSS set: font-family, font-size,
 * font-weight, font-style, color, text-decoration, letter-spacing,
 * vertical-align (super/sub), text-align, margin-left/right/top/bottom,
 * text-indent, line-height, list-style-type. Unitless font-size is points. Scripts and images
 * are dropped; links keep their text, blue and underlined.
 *
 *   parseRich(body)                 XHTML → DOM-free paragraphs of styled runs
 *   layoutRich(paras, font, …)      runs → wrapped lines of segments
 *
 * Whitespace collapses as in HTML except inside xfa-spacerun spans;
 * xfa-tab-count spans become one space; <span xfa:embed="#id"/> becomes an
 * embed run (floating field), resolved when painted.
 */

import { resolveFont, textWidth, emBox, fitTolerance, embedText, lineIndent, breakPieces, naturalLineHeight } from './text.js';
import { toPt } from '../core/units.js';

/**
 * @typedef {{ text?: string, embed?: string, style: object }} Run
 * @typedef {{ runs: Run[], align: string|null, marginLeft: number|null, marginRight: number|null,
 *             marginTop: number|null, marginBottom: number|null, textIndent: number|null,
 *             lineHeight: number|null }} Paragraph
 */

/** @returns {Paragraph[]} */
export function parseRich(body) {
  const paras = [];
  let cur = null;
  const newPara = (style, blockCss) => {
    cur = {
      runs: [],
      align: blockCss['text-align'] ?? style.align ?? null,
      marginLeft: len(blockCss['margin-left']) ?? null,
      marginRight: len(blockCss['margin-right']) ?? null,
      marginTop: len(blockCss['margin-top']) ?? null,
      marginBottom: len(blockCss['margin-bottom']) ?? null,
      textIndent: len(blockCss['text-indent']),
      lineHeight: len(blockCss['line-height']),
      // vertical-align as a length on the block: Reader makes each of its
      // lines that much taller, the room above the text (dclUnica's closing
      // statements, vertical-align:3pt, are 17.4pt apart, not 14.4)
      raise: blockLength(blockCss['vertical-align']),
      tabStops: blockCss['tab-stops'] ? parseTabStops(blockCss['tab-stops']) : (style.tabStops ?? null),
    };
    paras.push(cur);
  };
  const ensure = style => { if (!cur) newPara(style, {}); };
  // open ul/ol lists: their marker style and item count
  const lists = [];

  const walk = (node, style, spacerun) => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      let text = node.nodeValue;
      // HTML collapsing: whitespace runs become one space; nbsp never
      // collapses. Inside xfa-spacerun every space (no-break ones too) is
      // kept: all but the last of a run become no-break spaces, and the last
      // is a break opportunity (Acrobat wraps inside long spacerun spans, and
      // after imm5707e's "the<spacerun>&#160;</spacerun>Access")
      if (!spacerun) text = text.replace(/[ \t\r\n]+/g, ' ');
      else text = text.replace(/[\t\u00a0]/g, ' ').replace(/ (?= )/g, '\u00a0');
      if (!text) return;
      ensure(style);
      cur.runs.push(spacerun ? { text, style, keep: true } : { text, style });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node.localName || node.nodeName).toLowerCase();
    if (tag === 'script' || tag === 'style') return;
    if (tag === 'br') { ensure(style); cur.runs.push({ text: '\n', style }); return; }

    const embed = embedRef(node);
    if (embed) { ensure(style); cur.runs.push({ embed, style }); return; }

    const css = parseCss(node.getAttribute?.('style') ?? '');
    if ('xfa-tab-count' in css) {
      ensure(style);
      const n = Math.max(1, parseInt(css['xfa-tab-count'], 10) || 1);
      for (let i = 0; i < n; i++) cur.runs.push({ tab: true, style });
      return;
    }

    // a link is blue and underlined unless its own CSS says otherwise
    // (Acrobat prints of evince, imm1294e, Conflict-of-interest)
    const base = tag === 'a' && node.getAttribute?.('href') ? { ...style, color: [0, 0, 255], underline: 1 } : { ...style };
    const block = tag === 'p' || tag === 'div' || tag === 'li' || tag === 'h1' || tag === 'h2' || tag === 'h3';
    // vertical-align applies to inline content only (CSS); a length on a
    // block makes its lines taller (newPara)
    const next = applyCss(base, block && css['vertical-align']?.trim() !== 'baseline' ? { ...css, 'vertical-align': undefined } : css);
    if (css['tab-stops']) next.tabStops = parseTabStops(css['tab-stops']);
    if (tag === 'b' || tag === 'strong') next.weight = 'bold';
    if (tag === 'i' || tag === 'em') next.posture = 'italic';
    if (tag === 'u') next.underline = 1;
    if (block) { newPara(next, css); if (css['text-align']) next.align = css['text-align']; }
    // a list item is indented 36pt a level, its marker hanging in the
    // indent (mn-dhs-4258a's "I agree that:" bullets, as Reader prints them)
    if (tag === 'li' && lists.length) {
      const list = lists.at(-1);
      list.count++;
      cur.listIndent = 36 * lists.length;
      cur.marker = { text: listMarker(css['list-style-type'] ?? list.type, list.count), style: next };
    }
    const isList = tag === 'ul' || tag === 'ol';
    if (isList) {
      if (cur && !cur.runs.length) paras.pop();
      cur = null;
      lists.push({ type: css['list-style-type'] ?? (tag === 'ol' ? 'decimal' : 'disc'), count: 0 });
    }
    const keepSpaces = spacerun || css['xfa-spacerun'] === 'yes';
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c, next, keepSpaces);
    if (block || isList) cur = null;
    if (isList) lists.pop();
  };

  const rootCss = parseCss(body?.getAttribute?.('style') ?? '');
  walk(body, applyCss({}, rootCss), false);

  // trim leading/trailing collapsed spaces per paragraph
  for (const p of paras) {
    // A <br> that ends a block does not open another line (HTML); a block
    // holding only a <br> is one empty line (Acrobat prints agree)
    if (p.runs.at(-1)?.text === '\n') {
      const br = p.runs.pop();
      if (!p.runs.some(r => r.embed || r.tab || r.text)) p.runs = [{ text: '', style: br.style, keep: true, empty: true }];
    }
    // xfa-spacerun text keeps its spaces (a paragraph holding only one
    // still takes a line, as in Acrobat)
    const first = p.runs[0];
    if (first?.text !== undefined && !first.keep) first.text = first.text.replace(/^ +/, '');
    const last = p.runs.at(-1);
    if (last?.text !== undefined && !last.keep) last.text = last.text.replace(/ +$/, '');
  }
  return paras.filter(p => p.runs.some(r => r.embed || r.tab || r.text || r.empty));
}

/**
 * Plain text holding tabs as paragraphs for layoutRich, so its tabs advance
 * to the para's tab stops (every 0.5in by default) as Reader sets them;
 * spaces are kept as written.
 * @returns {Paragraph[]}
 */
export function plainParas(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map(line => ({
    runs: line ? line.split('\t').flatMap((t, i) => [...(i ? [{ tab: true, style: {} }] : []), ...(t ? [{ text: t, style: {}, keep: true }] : [])])
      : [{ text: '', style: {}, keep: true, empty: true }],
    align: null, marginLeft: null, marginRight: null, marginTop: 0, marginBottom: 0, textIndent: null, lineHeight: null, tabStops: null,
  }));
}

// The marker of list item n (1-based) for a CSS list-style-type
function listMarker(type, n) {
  const alpha = k => { let s = ''; for (; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + (k - 1) % 26) + s; return s; };
  const roman = k => [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
    .reduce((acc, [v, r]) => { while (k >= v) { acc += r; k -= v; } return acc; }, '');
  switch (String(type).trim().toLowerCase()) {
    case 'none': return '';
    case 'circle': return '\u25e6';
    case 'square': return '\u25aa';
    case 'decimal': return `${n}.`;
    case 'lower-alpha': case 'lower-latin': return `${alpha(n)}.`;
    case 'upper-alpha': case 'upper-latin': return `${alpha(n).toUpperCase()}.`;
    case 'lower-roman': return `${roman(n)}.`;
    case 'upper-roman': return `${roman(n).toUpperCase()}.`;
    default: return '\u2022';
  }
}

// CSS / para tab stops: "left 3.75cm right 8cm …" (alignment then position;
// a bare position is a left stop) → [{ align, pos }] sorted by position
export function parseTabStops(v) {
  const stops = [];
  let align = 'left';
  for (const tok of String(v).trim().split(/\s+/)) {
    if (/^(left|right|center|decimal|before|after)$/i.test(tok)) { align = tok.toLowerCase(); continue; }
    const pos = len(tok);
    if (pos !== null && Number.isFinite(pos)) stops.push({ align: align === 'before' ? 'left' : align === 'after' ? 'right' : align, pos });
    align = 'left';
  }
  return stops.sort((a, b) => a.pos - b.pos);
}

/** Plain text of parsed paragraphs (embeds as \u0001id\u0002 tokens) */
export function richPlainText(paras) {
  return paras.map(p => p.runs.map(r => (r.embed ? `\u0001${r.embed}\u0002` : r.tab ? ' ' : r.text)).join('')).join('\n');
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function parseCss(s) {
  const out = {};
  for (const decl of String(s).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

// CSS → model-font-shaped overrides (null = inherit)
function applyCss(style, css) {
  if (css['font-family']) style.typeface = css['font-family'].split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  if (css['font-size']) {
    const v = css['font-size'];
    style.size = /^[\d.]+$/.test(v) ? parseFloat(v) : (v.endsWith('px') ? parseFloat(v) * 0.75 : toPt(v));
  }
  if (css['font-weight']) style.weight = /bold|[6-9]00/.test(css['font-weight']) ? 'bold' : 'normal';
  if (css['font-style']) style.posture = /italic|oblique/.test(css['font-style']) ? 'italic' : 'normal';
  if (css.color) { const c = cssColor(css.color); if (c) style.color = c; }
  if (css['text-decoration']) {
    style.underline = /underline/.test(css['text-decoration']) ? 1 : 0;
    style.lineThrough = /line-through/.test(css['text-decoration']) ? 1 : 0;
  }
  if (css['letter-spacing']) style.letterSpacing = len(css['letter-spacing']) ?? 0;
  if (css['vertical-align']) {
    const v = css['vertical-align'];
    // super, sub, or a length to raise by (Selbstauskunft's m<span
    // style="vertical-align:2pt">2</span>)
    style.shift = v === 'super' ? 'super' : v === 'sub' ? 'sub' : (len(v) || null);
    // baseline puts the text back on the baseline: the font's own
    // baselineShift no longer applies (anaf-d092's closing statement)
    if (v.trim() === 'baseline') style.baselineShift = 0;
  }
  if (css['xfa-font-horizontal-scale']) style.hScale = parseFloat(css['xfa-font-horizontal-scale']);
  return style;
}

// a length, not super, sub or baseline
function blockLength(v) {
  const t = v?.trim();
  return t && !/^(super|sub|baseline|top|middle|bottom)$/.test(t) ? len(t) : null;
}

function len(v) {
  if (v === undefined || v === null || v === '') return null;
  if (/^-?[\d.]+$/.test(v)) return parseFloat(v);
  if (v.endsWith('px')) return parseFloat(v) * 0.75;
  return toPt(v);
}

function cssColor(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map(h => parseInt(h + h, 16));
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v);
  if (m) return [+m[1], +m[2], +m[3]];
  const named = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0], gray: [128, 128, 128], grey: [128, 128, 128] };
  return named[v.toLowerCase()] ?? null;
}

function embedRef(el) {
  for (const a of Array.from(el.attributes ?? [])) {
    if ((a.localName || a.name.split(':').pop()) === 'embed' && a.value) return a.value.replace(/^#/, '');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout: runs → lines of segments
// ---------------------------------------------------------------------------

/**
 * @typedef {{ text?: string, embed?: string, font: object, w: number, shift: 'super'|'sub'|number|null }} Segment
 * @typedef {{ segments: Segment[], width: number, height: number, ascent: number, descent: number,
 *             align: string, indent: number, marginLeft: number, marginRight: number, spaceBefore: number }} Line
 *
 * @param {Paragraph[]} paras
 * @param {object} baseFont     - resolved font of the node
 * @param {object|null} para    - the node's para (hAlign, lineHeight, textIndent, margins)
 * @param {number} maxWidth     - width available for text (before para margins)
 * @param {{ wrap?: boolean, log?: object }} [opts]
 * @returns {Line[]}
 */
export function layoutRich(paras, baseFont, para, maxWidth, { wrap = true, log } = {}) {
  const lines = [];
  const fontCache = new Map();
  const fontFor = style => {
    const key = JSON.stringify(style);
    if (!fontCache.has(key)) fontCache.set(key, resolveFont(style, baseFont, log));
    return fontCache.get(key);
  };

  paras.forEach((p, pi) => {
    // a paragraph's CSS margins replace the para's, as its text-indent does
    // (anaf-d1000's "1.2.2." caption, margin-left:28.346pt under a 28.346pt
    // para marginLeft, starts where its plain-text siblings do in Reader);
    // list items are indented on top
    const ml = (p.marginLeft ?? para?.marginLeft ?? 0) + (p.listIndent ?? 0);
    const mr = p.marginRight ?? para?.marginRight ?? 0;
    const width = maxWidth - ml - mr;
    // CSS text-indent, else the para's (a negative one indents the lines
    // after the first, see lineIndent)
    const indent = p.textIndent ?? para?.textIndent ?? 0;
    const align = p.align ?? para?.hAlign ?? 'left';
    const fixedLH = p.lineHeight ?? (para?.lineHeight > 0 ? para.lineHeight : null);

    let line = null;
    let first = true;
    // soft: the line continues a wrapped one (its leading whitespace drops)
    const startLine = (soft = false) => {
      line = { segments: [], width: 0, align, indent: lineIndent(indent, first), marginLeft: ml, marginRight: mr,
        spaceBefore: first ? (pi > 0 ? p.marginTop ?? para?.spaceAbove ?? 0 : Math.max(0, (p.marginTop ?? 0) - (para?.spaceAbove ?? 0))) : 0, spaceAfter: 0, soft };
      first = false;
    };
    const finish = () => {
      // drop trailing spaces
      while (line.segments.length) {
        const last = line.segments.at(-1);
        if (last.text === undefined || !last.text.endsWith(' ')) break;
        const trimmed = last.text.replace(/ +$/, '');
        const w = textWidth(last.font, trimmed);
        line.width -= last.w - w;
        if (trimmed) { last.text = trimmed; last.w = w; break; }
        line.segments.pop();
      }
      let asc = 0, desc = 0, size = 0, natural = 0, shift = 0, raised = 0;
      for (const s of line.segments.length ? line.segments : [{ font: fontFor(p.runs[0]?.style ?? {}) }]) {
        shift = Math.max(shift, Math.abs(s.font.baselineShift ?? 0));
        const e = emBox(s.font);
        // a run raised by vertical-align reaches above the line
        const rise = typeof s.shift === 'number' ? s.shift : s.shift === 'super' ? s.font.size * 0.33 : 0;
        if (rise > 0 && s.text?.trim()) raised = Math.max(raised, rise + e.ascent);
        asc = Math.max(asc, e.ascent);
        desc = Math.max(desc, e.descent);
        size = Math.max(size, s.font.size * s.font.vScale);
        natural = Math.max(natural, naturalLineHeight(s.font));
      }
      // gap: what a first line does not need when the text is sized. It
      // counts as the font size, or with a set line height as that height
      // or the face's own line height, whichever is less (naturalLineHeight:
      // on-a-103e's two-line 18.75pt Arial bullets are 40.8pt apart in
      // Reader, hmrc-iform's one-line 11.5pt ones 14.3pt, on-5026-41f's
      // 14pt title lines in 14pt bold Arial stay 14pt). Lines are still
      // painted at the full pitch.
      // a line in a font with a baselineShift is taller by the shift
      // (anaf-d092's 7pt-shifted two-line notes are 20.2pt apart in Reader,
      // not 13.2pt; a paragraph set back on the baseline is not)
      // and a raised run taller than the line makes room for itself above
      // the text, as a CSS line box does (anaf-d1000's CIF² lines stand
      // 2.6pt lower in Reader)
      const above = fixedLH ? 0 : Math.max(0, raised - asc) + Math.max(0, p.raise ?? 0);
      const height = (fixedLH ?? 1.2 * size) + shift + above;
      Object.assign(line, { ascent: asc + above, descent: desc, height, gap: fixedLH ? Math.max(0, fixedLH - natural) : 0.2 * size });
      lines.push(line);
    };

    // Atoms: tabs, embeds, line breaks, single spaces and word pieces; a
    // piece glued to the previous one (no space between, e.g. an italic
    // word and its full stop) breaks with it as one word
    const atoms = [];
    for (const run of p.runs) {
      const font = fontFor(run.style);
      const shift = run.style.shift ?? null;
      if (run.tab) { atoms.push({ tab: true, font, shift }); continue; }
      if (run.embed) { atoms.push({ embed: run.embed, font, shift, w: textWidth(font, embedText(run.embed)) }); continue; }
      for (const piece of run.text.split(/(\n| )/)) {
        if (piece === '') continue;
        if (piece === '\n') { atoms.push({ nl: true }); continue; }
        if (piece === ' ') { atoms.push({ text: piece, font, shift, w: textWidth(font, piece), space: true }); continue; }
        // a word may break after a slash (breakPieces); its other pieces
        // stay glued to what precedes them
        breakPieces(piece).forEach((bit, k) => {
          const prev = atoms.at(-1);
          atoms.push({ text: bit, font, shift, w: textWidth(font, bit), space: false,
            glue: k === 0 && prev?.text !== undefined && !prev.space && !prev.text.endsWith('/') });
        });
      }
    }

    const append = a => {
      const last = line.segments.at(-1);
      if (last && !last.tab && last.font === a.font && last.shift === a.shift && last.text !== undefined) {
        last.text += a.text;
        last.w += a.w;
      } else {
        line.segments.push({ text: a.text, font: a.font, w: a.w, shift: a.shift });
      }
      line.width += a.w;
    };

    startLine();
    if (p.marker?.text) {
      const font = fontFor(p.marker.style);
      line.marker = { text: p.marker.text, font, w: textWidth(font, p.marker.text) };
    }
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.nl) { finish(); line.paraEnd = true; startLine(); continue; }
      if (a.tab) {
        // advance to the next stop right of the pen (positions from the
        // paragraph's left edge); past the last stop, every tabDefault
        const x = line.indent + line.width;
        const stops = p.tabStops ?? para?.tabStops ?? [];
        const interval = para?.tabDefault > 0 ? para.tabDefault : 36;
        const stop = stops.find(s => s.pos > x + 0.01);
        const target = stop ? stop.pos : (Math.floor((x + 0.01) / interval) + 1) * interval;
        // a wrapped line drops leading tabs; a tab past the edge wraps
        if (line.soft && !line.segments.length) continue;
        if (wrap && line.segments.length && target > width + 0.01) { finish(); startLine(true); continue; }
        line.segments.push({ text: '', tab: true, font: a.font, w: target - x, shift: a.shift });
        line.width += target - x;
        continue;
      }
      if (a.embed) {
        if (wrap && line.segments.length && line.width + a.w > width - line.indent + 0.01) { finish(); startLine(true); }
        line.segments.push({ embed: a.embed, font: a.font, w: a.w, shift: a.shift });
        line.width += a.w;
        continue;
      }
      if (a.space) {
        if (line.segments.length) append(a);
        continue;
      }
      // whitespace kept by a spacerun drops at the start of a wrapped line
      if (line.soft && !line.segments.length && /^[\s\u00a0]*$/.test(a.text)) continue;
      // a word and the pieces glued to it
      let j = i + 1;
      let w = a.w;
      while (atoms[j]?.glue) w += atoms[j++].w;
      // trailing (no-break) spaces may hang past the edge
      const tail = atoms[j - 1];
      const hang = /[\s\u00a0]+$/.exec(tail.text)?.[0];
      if (hang) w -= textWidth(tail.font, hang);
      if (wrap && line.segments.length && line.width + w > width - line.indent + fitTolerance(a.font)) {
        finish();
        startLine(true);
      }
      for (let k = i; k < j; k++) append(atoms[k]);
      i = j - 1;
    }
    // whitespace that wrapped past the last word opens no line
    if (!(line.soft && !line.segments.length)) finish();
    // the para's spaceAbove/spaceBelow part every paragraph that sets no
    // margin of its own (the box adds them once around the whole text):
    // mn-dhs-4258a's spaceBelow="3pt" draws open a 3pt gap after each <p>
    // in Reader, on-11075e's margin-bottom:0pt address lines stay tight
    // the first paragraph's top margin and the last's bottom margin
    // collapse with the box's own spaceAbove and spaceBelow (on-4871-64f's
    // margin-bottom:10pt paragraph in a spaceBelow="10pt" draw leaves 10pt)
    lines.at(-1).spaceAfter = pi < paras.length - 1 ? p.marginBottom ?? para?.spaceBelow ?? 0
      : Math.max(0, (p.marginBottom ?? 0) - (para?.spaceBelow ?? 0));
    lines.at(-1).paraEnd = true;
  });
  return lines;
}

/** Height laid-out rich lines are sized by */
export function richHeight(lines) {
  return paintedHeight(lines) - (lines[0]?.gap ?? 0);
}

/**
 * Height the lines are painted in: every line takes its full line height.
 * richHeight, the height text is sized by, leaves out the first line's gap
 * (pdf.js TextMeasure firstLineHeight; a registration form print's rich paragraphs
 * are 2pt shorter than 1.2em a line), while Reader paints the lines at the
 * full pitch (ALTMP's multi-paragraph notes keep their positions).
 */
export function paintedHeight(lines) {
  return lines.reduce((h, l) => h + l.spaceBefore + l.height + l.spaceAfter, 0);
}
