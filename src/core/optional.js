/**
 * Purefield / core / optional.js
 *
 * Optional content (layers, PDF 32000 §8.11) as Reader prints it. The
 * output has no /OCProperties, so content of a group that does not print is
 * taken out of the page instead: marked content `/OC /name BDC … EMC`, a
 * `Do` of an XObject whose /OC does not print, an annotation whose /OC does
 * not print. What is left prints in every viewer.
 *
 * Which groups print: the default configuration (/D: BaseState, then its
 * ON and OFF arrays), then, for the groups its /AS array lists for the
 * Print event, each group's /Usage /Print /PrintState. An optional content
 * membership dictionary (OCMD) prints by its /VE expression, else by its
 * /P policy over its /OCGs (AnyOn by default). A group the document does
 * not list in /OCProperties /OCGs, or a missing one, prints.
 */

import { tokenize } from './content.js';

/**
 * @param {import('./parser.js').PdfDocument} doc
 * @returns {Promise<OptionalContent|null>} null when the document has no layers
 *
 * @typedef {{ visible: (oc: object) => Promise<boolean>, hidden: Set<number> }} OptionalContent
 */
export async function printVisibility(doc) {
  const res = async v => (v?.type === 'ref' ? unwrap(await doc.getObject(v.num)) : v);
  const cat = dictOf(unwrap(await doc.catalog()));
  const props = dictOf(await res(cat?.OCProperties));
  if (!props) return null;
  const all = items(await res(props.OCGs)).filter(r => r?.type === 'ref').map(r => r.num);
  const known = new Set(all);
  const state = new Map(all.map(n => [n, true]));
  const d = dictOf(await res(props.D)) ?? {};
  const base = d.BaseState?.value ?? 'ON';
  if (base === 'OFF') for (const n of all) state.set(n, false);
  for (const r of items(await res(d.ON))) if (r?.type === 'ref') state.set(r.num, true);
  for (const r of items(await res(d.OFF))) if (r?.type === 'ref') state.set(r.num, false);
  // usage applied at printing
  for (const asRef of items(await res(d.AS))) {
    const as = dictOf(await res(asRef));
    if (as?.Event?.value !== 'Print') continue;
    const cats = items(await res(as.Category)).map(c => c?.value);
    if (cats.length && !cats.includes('Print')) continue;
    for (const r of items(await res(as.OCGs))) {
      if (r?.type !== 'ref') continue;
      const g = dictOf(await res(r));
      const usage = dictOf(await res(g?.Usage));
      const print = dictOf(await res(usage?.Print));
      const ps = print?.PrintState?.value;
      if (ps === 'ON') state.set(r.num, true);
      else if (ps === 'OFF') state.set(r.num, false);
    }
  }
  // (with every group on, a membership expression such as /Not can still
  // hide content, so the content is always resolved)
  const hidden = new Set([...state].filter(([, on]) => !on).map(([n]) => n));

  const groupOn = num => !known.has(num) || state.get(num) !== false;
  // a visibility expression: [/And e…], [/Or e…], [/Not e], or a group
  const expr = async (v, depth = 0) => {
    if (depth > 20) return true;
    if (v?.type === 'ref') {
      const o = await res(v);
      if (o?.type === 'array') return expr(o, depth + 1);
      return groupOn(v.num);
    }
    if (v?.type !== 'array' || !v.value.length) return true;
    const [op, ...args] = v.value;
    const vals = [];
    for (const a of args) vals.push(await expr(a, depth + 1));
    switch (op?.value) {
      case 'And': return vals.every(Boolean);
      case 'Or': return vals.some(Boolean);
      case 'Not': return !vals[0];
      default: return true;
    }
  };
  const cache = new Map();
  const visible = async oc => {
    if (!oc) return true;
    const key = oc.type === 'ref' ? oc.num : null;
    if (key !== null && cache.has(key)) return cache.get(key);
    const dict = dictOf(await res(oc));
    let on = true;
    if (dict?.Type?.value === 'OCMD' || dict?.OCGs || dict?.VE) {
      if (dict.VE) on = await expr(await res(dict.VE));
      else {
        const ocgs = await res(dict.OCGs);
        const refs = (ocgs?.type === 'array' ? ocgs.value : [dict.OCGs]).filter(r => r?.type === 'ref');
        const states = refs.map(r => groupOn(r.num));
        const p = dict.P?.value ?? 'AnyOn';
        on = !states.length ? true
          : p === 'AllOn' ? states.every(Boolean)
            : p === 'AnyOff' ? states.some(s => !s)
              : p === 'AllOff' ? states.every(s => !s)
                : states.some(Boolean);
      }
    } else if (key !== null) {
      on = groupOn(key);
    }
    if (key !== null) cache.set(key, on);
    return on;
  };
  return { visible, hidden };
}

/**
 * The content stream with the content of groups that do not print taken
 * out: everything between `/OC /name BDC` and its EMC, and each `Do` of an
 * XObject that does not print. The groups that print become plain marked
 * content (`/JcsOC BMC`): the output has no /OCProperties, and viewers
 * left with an /OC tag disagree (PDFium evaluates its membership
 * expression with every group on, poppler shows it). Names are looked up
 * in the stream's resources (/Properties, /XObject). Returns null when
 * nothing changes.
 * @param {Uint8Array} bytes - the decoded content stream
 * @param {{ properties: (name: string) => object|null, xobject: (name: string) => object|null,
 *           visible: (oc: object) => Promise<boolean>, xobjectVisible: (ref: object) => Promise<boolean> }} env
 */
export async function filterContent(bytes, env) {
  const tokens = tokenize(bytes);
  const keep = [];         // [start, end, replacement?] ranges kept
  let pos = 0;             // start of the next range to keep
  let operandsStart = -1;  // where the current operator's operands begin
  const operands = [];
  const stack = [];        // per BDC/BMC: was the region hidden by this one
  let hiddenDepth = 0;     // > 0 while inside a hidden region
  let hideFrom = -1;
  let changed = false;
  for (const t of tokens) {
    if (t.kind !== 'op') {
      if (operandsStart < 0) operandsStart = t.start;
      operands.push(t);
      continue;
    }
    const opStart = operandsStart >= 0 ? operandsStart : t.start;
    switch (t.text) {
      case 'BDC': {
        let hides = false, oc = null;
        if (!hiddenDepth && operands.length >= 2 && operands[0].text === '/OC') {
          const p = operands[1];
          oc = p.kind === 'name' ? env.properties(p.text.slice(1)) : null;
          if (oc && !(await env.visible(oc))) hides = true;
        }
        stack.push(hides);
        if (hides) { hiddenDepth++; hideFrom = opStart; }
        else if (hiddenDepth) hiddenDepth++;
        else if (oc) {
          // a group that prints: its tag without the group
          keep.push([pos, opStart, '/JcsOC BMC']);
          pos = t.end;
          changed = true;
        }
        break;
      }
      case 'BMC':
        stack.push(false);
        if (hiddenDepth) hiddenDepth++;
        break;
      case 'EMC': {
        const hides = stack.pop();
        if (hiddenDepth) {
          hiddenDepth--;
          if (hides && hiddenDepth === 0) {
            keep.push([pos, hideFrom]);
            pos = t.end;
            changed = true;
          }
        }
        break;
      }
      case 'Do': {
        if (!hiddenDepth && operands.length && operands[operands.length - 1].kind === 'name') {
          const ref = env.xobject(operands[operands.length - 1].text.slice(1));
          if (ref && !(await env.xobjectVisible(ref))) {
            keep.push([pos, opStart]);
            pos = t.end;
            changed = true;
          }
        }
        break;
      }
    }
    operands.length = 0;
    operandsStart = -1;
  }
  // a hidden region left open runs to the end of the stream
  if (hiddenDepth) { keep.push([pos, hideFrom]); pos = bytes.length; changed = true; }
  if (!changed) return null;
  keep.push([pos, bytes.length]);
  const extra = keep.reduce((n, k) => n + (k[2]?.length ?? 0), 0);
  const total = keep.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
  const out = new Uint8Array(total + 2 * keep.length + extra);
  let o = 0;
  for (const [a, b, put] of keep) {
    if (b > a) { out.set(bytes.subarray(a, b), o); o += b - a; }
    out[o++] = 0x0a; // keep tokens apart where a region was cut
    if (put) { for (let i = 0; i < put.length; i++) out[o++] = put.charCodeAt(i); out[o++] = 0x0a; }
  }
  return out.subarray(0, o);
}

function unwrap(o) {
  if (!o) return null;
  if (o.streamBytes) return { type: 'dict', value: o.dict };
  return o.value ?? o;
}
function dictOf(v) {
  if (!v) return null;
  if (v.type === 'dict') return v.value;
  if (v.value?.type === 'dict') return v.value.value;
  return null;
}
function items(v) {
  if (!v) return [];
  if (v.type === 'array') return v.value;
  return [];
}
