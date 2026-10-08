/**
 * Purefield / xfa / formstate.js
 *
 * The form packet: the state of the merged form as Acrobat last saved it.
 * With restoreState="auto" Acrobat restores it on open instead of re-running
 * scripts, so it records what the scripts did — which sections a script hid
 * (presence) and the values calculations produced. Since this library runs
 * no scripts, it is the best record of that state there is.
 *
 * Applied after binding, by walking the instance tree and the form packet
 * together (same element kind and name, k-th instance ↔ k-th element):
 *   - presence, relevant, x, y, w and h replace the template's
 *   - an unbound field (template default or script value) takes the saved
 *     value; bound fields keep their data (datasets wins, spec §1)
 *   - draw text, caption text and choice-list items take the saved versions
 *     (scripts commonly translate or fill these on open)
 */

import { parseRelevant, parseValue, parseItems, patchBorder, parseBorder } from './model.js';
import { toPt } from '../core/units.js';

const KINDS = new Set(['subform', 'subformSet', 'area', 'exclGroup', 'field', 'draw']);
const VALUE_KINDS = new Set(['text', 'integer', 'decimal', 'float', 'date', 'time', 'dateTime', 'boolean', 'exData']);

/**
 * @param {object} root - instance root from bindData()
 * @param {Document|null} formXml - the form packet
 * @param {{ log?: import('./log.js').XfaLog }} [opts]
 * @returns {{ presence: number, values: number }} how many overrides were applied
 */
export function applyFormState(root, formXml, { log } = {}) {
  const stats = { presence: 0, values: 0, texts: 0, geometry: 0 };
  const top = formXml?.documentElement && elementChildren(formXml.documentElement).find(e => localName(e) === 'subform');
  if (!top) return stats;
  match(root, top, stats);
  // page boilerplate: the packet repeats each pageArea per page; the first
  // occurrence of each name is applied (every page shares one instance)
  const pageAreaEls = [];
  const collect = el => {
    for (const c of elementChildren(el)) {
      if (localName(c) === 'pageArea') pageAreaEls.push(c);
      else if (localName(c) === 'pageSet') collect(c);
    }
  };
  for (const c of elementChildren(top)) if (localName(c) === 'pageSet') collect(c);
  const seen = new Set();
  for (const pa of listPageAreas(root.pageSets ?? [])) {
    const el = pageAreaEls.find(e => (e.getAttribute('name') ?? '') === pa.name && !seen.has(e));
    if (!el) continue;
    seen.add(el);
    match({ children: pa.children }, el, stats);
  }
  if (stats.presence || stats.values || stats.texts) {
    log?.info('XFA_FORM_STATE', `Saved form state applied: ${stats.presence} presence change(s), ${stats.values} saved value(s), ${stats.texts} text/caption/item change(s)`);
  }
  return stats;
}

function match(inst, el, stats) {
  apply(inst, el, stats);
  const pools = new Map();
  for (const c of elementChildren(el)) {
    const tag = localName(c);
    if (!KINDS.has(tag)) continue;
    const key = `${tag}|${c.getAttribute('name') ?? ''}`;
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(c);
  }
  const used = new Map();
  for (const child of inst.children ?? []) {
    const key = `${child.type}|${child.name ?? ''}`;
    const i = used.get(key) ?? 0;
    used.set(key, i + 1);
    const partner = pools.get(key)?.[i];
    if (partner) match(child, partner, stats);
  }
}

function apply(inst, el, stats) {
  const presence = el.getAttribute('presence');
  if (presence && ['visible', 'hidden', 'invisible', 'inactive'].includes(presence) && presence !== inst.presence) {
    inst.presence = presence;
    stats.presence++;
  }
  const relevant = el.getAttribute('relevant');
  if (relevant) inst.relevant = parseRelevant(relevant);
  // geometry a script changed (imm1294e's office-use box, grown to 1.307in)
  for (const k of ['x', 'y', 'w', 'h']) {
    const v = el.getAttribute(k);
    if (!v || inst.type === 'pageArea') continue;
    const pt = toPt(v);
    if (Number.isFinite(pt) && pt !== inst[k]) { inst[k] = pt; stats.geometry++; }
  }

  const kids = elementChildren(el);
  const valueEl = kids.find(e => localName(e) === 'value');

  if (inst.type === 'draw' && valueEl) {
    const v = parseValue(valueEl);
    if (v && (v.kind === 'text' || v.kind === 'rich') && v.text !== inst.value?.text) {
      inst.value = v;
      stats.texts++;
    }
  }

  // border edges and corners a script hid or showed (hmrc-c1800-chief's
  // dashed design-time outlines are saved hidden)
  const borderEl = kids.find(e => localName(e) === 'border');
  // a fill a script gave an object without a border (itext-release-objects
  // saves its page subform red; its docReady script turns red into blue)
  if (borderEl && !inst.border && elementChildren(borderEl).some(e => localName(e) === 'fill')) {
    inst.border = parseBorder(borderEl);
    stats.presence++;
  } else if (borderEl && inst.border) {
    let b = inst.border;
    const fillEl = elementChildren(borderEl).find(e => localName(e) === 'fill');
    const fill = fillEl ? parseBorder(borderEl).fill : null;
    if (fill) b = { ...b, fill: { ...(b.fill ?? {}), ...fill } };
    const parts = { edge: 'edges', corner: 'corners' };
    const seen = { edge: 0, corner: 0 };
    for (const c of elementChildren(borderEl)) {
      const tag = localName(c);
      if (!parts[tag]) continue;
      const i = seen[tag]++;
      const presence = c.getAttribute('presence');
      if (presence && ['visible', 'hidden', 'invisible'].includes(presence)) b = patchBorder(b, parts[tag], i, { presence });
    }
    const presence = borderEl.getAttribute('presence');
    if (presence && ['visible', 'hidden', 'invisible'].includes(presence)) b = { ...b, presence };
    if (b !== inst.border) { inst.border = b; stats.presence++; }
  }

  const captionEl = kids.find(e => localName(e) === 'caption');
  const capValueEl = captionEl && elementChildren(captionEl).find(e => localName(e) === 'value');
  if (capValueEl && inst.caption) {
    const v = parseValue(capValueEl);
    if (v && (v.kind === 'text' || v.kind === 'rich') && v.text !== inst.caption.value?.text) {
      inst.caption = { ...inst.caption, value: v };
      stats.texts++;
    }
  }

  const itemsEls = kids.filter(e => localName(e) === 'items');
  if (itemsEls.length && (inst.type === 'field')) {
    inst.items = itemsEls.map(parseItems);
    stats.texts++;
  }

  if (inst.type === 'field' && !inst.bound && !inst.pageRole) {
    const v = valueEl && elementChildren(valueEl).find(e => VALUE_KINDS.has(localName(e)));
    if (v) {
      const text = localName(v) === 'exData' ? v.textContent : v.textContent;
      if (text !== '' && text !== inst.raw) {
        inst.raw = text;
        stats.values++;
      }
    }
  }
}

function listPageAreas(pageSets) {
  return pageSets.flatMap(ps => [...ps.pageAreas, ...listPageAreas(ps.pageSets ?? [])]);
}

function localName(el) {
  return el.localName || String(el.nodeName).split(':').pop();
}

function elementChildren(el) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}
