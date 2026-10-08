/**
 * Purefield / acroform.js
 *
 * Flattens an AcroForm (non-XFA) PDF: its pages are copied (core/
 * importer.js) and each printable widget's normal appearance (/AP /N, the
 * state /AS names for buttons) is stamped onto its page as a form XObject,
 * mapped onto the widget rectangle as a viewer does (PDF 32000 §12.5.5:
 * the appearance BBox transformed by its Matrix is fitted to /Rect). The
 * new document has no AcroForm, so no viewer paints the widgets twice.
 *
 * A widget prints when its Print flag is set and its Hidden flag is not,
 * as Reader prints it. Other annotations with an appearance (highlights,
 * ink, stamps, free text) are stamped the same way, in /Annots order;
 * popups never print. Widget appearances the file lacks, or that the form
 * asks to be regenerated (/NeedAppearances), are generated (appearance.js),
 * as are those of comments and markup without one (annotations.js).
 *
 * annotations: false leaves out every annotation that is not a widget.
 * labels: each widget is replaced by its field's full name (a button that
 * shares its name with others gets "=<on state>" after it), printable or
 * not; hidden widgets are left out.
 */

import { importPages } from './core/importer.js';
import { collectWidgets } from './core/widgets.js';
import { generateAppearance, labelAppearance, familyOf, aliasBaseFont } from './appearance.js';
import { runAcroScripts, colorToRgb, DISPLAY } from './acroscript.js';
import { annotationAppearance } from './annotations.js';

const HIDDEN = 2, PRINT = 4;

/**
 * @param {import('./core/parser.js').PdfDocument} doc
 * @param {{ log: import('./xfa/log.js').XfaLog, faces?: object|null, glyphUsage?: Map, extraGlyphs?: Map,
 *           annotations?: boolean, labels?: { color: number[], minSize: number, maxSize: number, name: 'full'|'short' }|null }} opts
 * @returns {Promise<{ painted: object[], imported: import('./core/importer.js').ImportedDoc, widgets: number,
 *           stamped: number, generated: number, labelled: number }>}
 */
export async function flattenAcroForm(doc, { log, faces = null, glyphUsage = new Map(), extraGlyphs = new Map(), annotations = true, labels = null, scripts = true, now, pageFonts = null, scriptFaces = null }) {
  const imported = await importPages(doc, { log, fonts: pageFonts });
  const form = await collectWidgets(doc, imported.pages.map(p => p.num));
  // faces for the writing systems the fields and comments use
  if (scriptFaces) {
    const strings = [];
    for (const w of form.widgets.flat()) {
      strings.push(w.name, ...[w.value, w.mk.ca, w.markup?.contents].flat().filter(v => typeof v === 'string'), ...w.opt.map(o => o.label));
    }
    await scriptFaces(strings.join('\n'));
  }
  // the form's JavaScript, as Acrobat runs it on opening and printing
  let scripted = null;
  if (!labels && scripts) {
    try {
      scripted = await runAcroScripts(doc, form, { log, now, pageCount: imported.pages.length });
    } catch (e) {
      log.warn('ACRO_SCRIPT_FAILED', `form scripts not run: ${e.message}`);
    }
  }
  const fonts = await drFonts(doc, form.dr);
  const fontOf = name => familyOf(fonts.get(name) ?? aliasBaseFont(name) ?? 'Helvetica');
  const painted = [];
  let n = 0, total = 0, stamped = 0, generated = 0, labelled = 0;
  const shared = new Map();
  for (const w of form.widgets.flat()) if (!w.annot) shared.set(w.name, (shared.get(w.name) ?? 0) + 1);
  for (const [i, page] of imported.pages.entries()) {
    const ops = [];
    // graphics states for the generated annotations' opacity and blending
    const states = new Map();
    const graphicsState = gs => {
      const key = Object.entries(gs).map(([k, v]) => `/${k} ${typeof v === 'number' ? +v.toFixed(4) : `/${v}`}`).join(' ');
      if (!states.has(key)) states.set(key, `PfGS${states.size + 1}`);
      return states.get(key);
    };
    for (const w of form.widgets[i]) {
      if (w.annot && !annotations) continue;
      // an annotation in a layer that does not print (optional content)
      if (w.oc && imported.oc && !(await imported.oc.visible(w.oc))) continue;
      total++;
      if (labels && !w.annot) {
        if (w.flags & HIDDEN) continue;
        const name = w.ft === 'Btn' && w.onState && shared.get(w.name) > 1 ? `${w.name}=${w.onState}` : w.name;
        const op = labelAppearance(w, name, { page, labels, faces, glyphUsage, extraGlyphs, log });
        if (op) { ops.push(op); labelled++; }
        continue;
      }
      // NeedAppearances: text and choices are drawn again, and a button
      // with no appearance for its state gets one
      let regenerate = !w.annot && form.needAppearances && (w.ft === 'Tx' || w.ft === 'Ch' || (w.ft === 'Btn' && !w.ap));
      const st = !w.annot ? scripted?.get(w.field) : null;
      if (st) regenerate = applyScripted(w, st) || regenerate;
      if (!(w.flags & PRINT) || (w.flags & HIDDEN)) continue;
      if (w.ap && !regenerate) {
        const op = stampOp(w, page, `JcsAP${n + 1}`);
        if (!op) continue;
        const local = await imported.importObject(w.ap.num, { form: true });
        page.resources.xobject += `/JcsAP${++n} \u0000R${local}\u0000 `;
        ops.push(op);
        stamped++;
      } else if (!w.annot && (!w.hasAp || regenerate)) {
        // a push button's icon, copied as a form XObject
        let icon = null;
        if (w.mk.icon && w.ft === 'Btn') {
          const local = await imported.importObject(w.mk.icon.num, { form: true });
          icon = { ...w.mk.icon, name: `JcsIcon${++n}` };
          page.resources.xobject += `/${icon.name} \u0000R${local}\u0000 `;
        }
        const op = generateAppearance(w, { page, fontOf, da: form.da, q: form.q, faces, glyphUsage, extraGlyphs, log, icon });
        if (op) { ops.push(op); generated++; }
      } else if (w.annot && !w.hasAp) {
        // a comment or markup with no appearance, drawn from its dictionary
        const op = annotationAppearance(w, { page, fontOf, faces, glyphUsage, extraGlyphs, log, graphicsState });
        if (op) { ops.push(op); generated++; }
      }
    }
    painted.push({ width: page.width, height: page.height, content: ops.join('\n'), images: [], base: page,
      extGStates: [...states].map(([key, name]) => `/${name} << ${key} >>`).join(' ') });
  }
  if (total) log.info('ACRO_FLATTENED', `${total} widget(s) and annotation(s): ${stamped} stamped from their appearances, ${generated} generated`
    + (labels ? `, ${labelled} labelled with their field names` : ''));
  return { painted, imported, widgets: total, stamped, generated, labelled };
}

// What the form's scripts did to a widget's field (acroscript.js): its
// display (whether it prints), its value (a button's state, or text that
// needs a new appearance), the formatted text an appearance shows, and its
// colours. Returns whether the appearance must be generated again.
function applyScripted(w, st) {
  let regenerate = false;
  if (st.display !== undefined) {
    w.flags &= ~(HIDDEN | PRINT | 32);
    if (st.display === DISPLAY.hidden) w.flags |= HIDDEN;
    else if (st.display !== DISPLAY.noPrint) w.flags |= PRINT;
  }
  if (st.changed) {
    if (w.ft === 'Btn') {
      const state = typeof st.value === 'string' && w.apStates[st.value] ? st.value : 'Off';
      w.as = state;
      w.value = st.value;
      w.ap = w.apStates[state] ?? null;
      if (!w.ap && w.hasAp && state !== 'Off') regenerate = true;
    } else {
      w.value = st.value;
      regenerate = true;
    }
  }
  if (st.formatted !== null && w.ft !== 'Btn') w.displayValue = st.formatted;
  if (st.styled) {
    if (st.textColor) w.textColor = colorToRgb(st.textColor);
    if (st.fillColor) w.mk.bg = colorToRgb(st.fillColor);
    if (st.borderColor) w.mk.bc = colorToRgb(st.borderColor);
    if (w.ft === 'Tx' || w.ft === 'Ch' || (w.ft === 'Btn' && w.mk.ca)) regenerate = true;
  }
  return regenerate;
}

// The BaseFont of each font in the AcroForm's /DR, by resource name
async function drFonts(doc, dr) {
  const out = new Map();
  const get = async v => (v?.type === 'ref' ? (await doc.getObject(v.num))?.value ?? null : v);
  const fontDict = await get(dr?.Font);
  const entries = fontDict?.type === 'dict' ? fontDict.value : fontDict && !fontDict.type ? fontDict : {};
  for (const [name, ref] of Object.entries(entries ?? {})) {
    const f = await get(ref);
    const d = f?.type === 'dict' ? f.value : f;
    const base = d?.BaseFont?.value;
    if (base) out.set(name, base);
  }
  return out;
}

/**
 * The operators that paint appearance XObject `name` into the widget's
 * rectangle: the BBox, transformed by the appearance Matrix, is scaled and
 * moved onto /Rect (Do applies the Matrix itself). Coordinates are relative
 * to the page box origin, where the writer places our content.
 */
export function stampOp(w, page, name) {
  const [a, b, c, d, e, f] = w.ap.matrix;
  const [x0, y0, x1, y1] = w.ap.bbox;
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const bx0 = Math.min(...pts.map(p => p[0])), bx1 = Math.max(...pts.map(p => p[0]));
  const by0 = Math.min(...pts.map(p => p[1])), by1 = Math.max(...pts.map(p => p[1]));
  if (bx1 - bx0 < 1e-6 || by1 - by0 < 1e-6) return null;
  const [ox, oy] = page.mediaBox;
  const [rx0, ry0, rx1, ry1] = w.rect;
  const sx = (rx1 - rx0) / (bx1 - bx0), sy = (ry1 - ry0) / (by1 - by0);
  const tx = rx0 - ox - bx0 * sx, ty = ry0 - oy - by0 * sy;
  return `q ${num(sx)} 0 0 ${num(sy)} ${num(tx)} ${num(ty)} cm /${name} Do Q`;
}

function num(v) {
  return (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(5)).toString();
}
