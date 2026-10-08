/**
 * Purefield / xfa / bind.js
 *
 * Merges the template model with xfa:data and emits the instance tree that
 * layout consumes (spec §5, docs/REDUCED_XFA_SPEC_DETAIL.txt).
 *
 *   - match="once"    first unbound child of the current data node, same local name
 *   - match="dataRef" the node(s) named by the SOM ref; no fallback to name match
 *   - match="global"  first unbound node of that name anywhere under the record
 *   - match="none"    template default only, nothing consumed
 *
 * Subforms that bind push their data node as the current node for their
 * children; occur decides how many instances a subform gets. Fields store the
 * raw value (string or null), not the display value. No scripts, pictures,
 * calculate or validate run here.
 *
 * Every instance node is a shallow copy of its template node (so it carries
 * the same font, border, ui… objects) plus:
 *   proto     the template node
 *   som       e.g. "form1.line[1].sku"
 *   index     instance index among its prototype's instances
 *   children  instance children
 * and, on fields and exclGroups:
 *   raw       string | null
 *   bound     true if the value came from data
 *   dataPath  path of the bound data node, or null
 */

import { XfaLog } from './log.js';
import { parseRich, richPlainText } from './rich.js';

/**
 * @param {{ root: object }} model           - from parseTemplateModel()
 * @param {Element|null} record              - XfaStreams.dataRoot
 * @param {{ log?: XfaLog }} [opts]
 * @returns {{ root: object, grew: boolean, log: XfaLog }}
 *   grew — some occur produced more instances than its initial count
 *          (secondary dynamic-form signal, spec §9)
 */
export function bindData(model, record, { log } = {}) {
  log ??= model.log ?? new XfaLog();
  const ctx = {
    log,
    record: record ?? null,
    dataEl: record?.parentNode?.nodeType === 1 ? record.parentNode : null,
    bound: new Set(),
    grew: false,
  };

  const proto = model.root;
  const current = record ?? EMPTY;
  const root = instantiate(proto, 0, rootName(proto), current, record, ctx);
  if (proto.pageSets) root.pageSets = proto.pageSets.map(ps => bindPageSet(ps, root.som, current, ctx));
  // kept for scripts that add instances (script/dom.js instance manager)
  Object.defineProperty(root, 'bindContext', { value: ctx });
  return { root, grew: ctx.grew, log };
}

// A synthetic empty data node: every match against it fails closed
const EMPTY = Object.freeze({ synthetic: true });

function rootName(proto) {
  return proto.name || 'form1';
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function instantiate(proto, index, som, dataNode, boundEl, ctx) {
  const inst = { ...proto, proto, som, index, children: [] };
  delete inst.pageSets;
  // the data node its children bind under (an instance added later merges there)
  Object.defineProperty(inst, 'dataScope', { value: dataNode, writable: true });
  if (boundEl) inst.dataPath = dataPath(boundEl, ctx);
  bindChildren(inst, proto, dataNode, ctx);
  return inst;
}

function bindChildren(inst, proto, dataNode, ctx) {
  // Same-named siblings share an index counter for SOM paths
  const seen = new Map();
  const nextIndex = name => {
    const i = seen.get(name) ?? 0;
    seen.set(name, i + 1);
    return i;
  };

  for (const child of proto.children) {
    switch (child.type) {
      case 'subform':
      case 'subformSet':
        for (const sub of bindSubform(child, inst.som, dataNode, ctx, nextIndex)) {
          inst.children.push(sub);
        }
        break;
      case 'area': {
        // area never binds and never pushes: children see the parent's node
        const i = nextIndex(child.name);
        inst.children.push(instantiate(child, i, somOf(inst.som, child.name, i), dataNode, null, ctx));
        break;
      }
      case 'exclGroup':
        inst.children.push(bindExclGroup(child, inst.som, dataNode, ctx, nextIndex(child.name)));
        break;
      case 'field':
        inst.children.push(bindField(child, inst.som, dataNode, ctx, nextIndex(child.name)));
        break;
      case 'draw': {
        const i = nextIndex(child.name);
        inst.children.push({ ...child, proto: child, som: somOf(inst.som, child.name, i), index: i, children: [] });
        break;
      }
    }
  }
}

function bindSubform(proto, parentSom, dataNode, ctx, nextIndex) {
  const { min, max, initial } = proto.occur ?? { min: 1, max: 1, initial: 1 };
  const match = proto.type === 'subformSet' || !proto.name ? 'none' : (proto.bind?.match ?? 'once');

  // 1. collect candidate data nodes
  let candidates = [];
  if (match === 'once') {
    candidates = unboundChildren(dataNode, proto.name, ctx);
  } else if (match === 'dataRef') {
    candidates = resolveRef(proto.bind.ref, dataNode, ctx).filter(n => n.nodeType === 1);
    if (candidates.length === 0) danglingRef(proto, ctx);
  } else if (match === 'global') {
    candidates = unboundDescendants(ctx.record, proto.name, ctx);
  }

  // 2–3. instance count = clamp(max(n, min, initial-if-no-data), max)
  const n = candidates.length;
  const noData = ctx.record === null;
  // match none (and nameless subforms, subformSets) consume no data: they are
  // instantiated at least once even with min 0, as pdf.js does (and Acrobat's
  // saved form state shows)
  let count = match === 'none'
    ? Math.max(1, min, initial)
    : Math.max(n, min, noData ? initial : 0);
  if (max !== -1) count = Math.min(count, max);
  if (count > initial && count > 1) ctx.grew = true;

  // 4–5. bind the first `count` data nodes; the rest get synthetic empties
  const out = [];
  for (let i = 0; i < count; i++) {
    const el = match === 'none' ? null : (candidates[i] ?? null);
    if (el) ctx.bound.add(el);
    // match none (and nameless subforms, subformSets) stay transparent
    const childData = match === 'none' ? dataNode : (el ?? EMPTY);
    const index = nextIndex(proto.name);
    out.push(instantiate(proto, index, somOf(parentSom, proto.name, index), childData, el, ctx));
  }
  return out;
}

// exclGroup binds one value for the whole group; members don't consume data.
// Each member gets the group's raw value, so a member is marked when that
// value equals its on value (spec §7).
function bindExclGroup(proto, parentSom, dataNode, ctx, index) {
  const som = somOf(parentSom, proto.name, index);
  const inst = { ...proto, proto, som, index, children: [] };

  const match = proto.name ? (proto.bind?.match ?? 'once') : 'none';
  if (match === 'none') {
    // A transparent group: members bind on their own
    bindChildren(inst, proto, dataNode, ctx);
    Object.assign(inst, { raw: null, bound: false, dataPath: null });
    return inst;
  }

  const el = matchLeaf(proto, dataNode, ctx);
  const value = el ? leafValue(el, proto.bind?.ref) : null;
  const memberDefault = proto.children
    .filter(c => c.type === 'field')
    .map(c => templateDefault(c))
    .find(v => v !== '' && v !== null) ?? null;
  inst.raw = el ? value : memberDefault;
  inst.bound = !!el;
  inst.dataPath = el ? dataPath(el.ownerElement ?? el, ctx) : null;

  let i = 0;
  for (const member of proto.children) {
    const mSom = somOf(som, member.name, i++);
    if (member.type === 'field') {
      inst.children.push({ ...member, proto: member, som: mSom, index: 0, children: [],
        raw: inst.raw, bound: inst.bound, dataPath: inst.dataPath });
    } else {
      inst.children.push({ ...member, proto: member, som: mSom, index: 0, children: [] });
    }
  }
  return inst;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function bindField(proto, parentSom, dataNode, ctx, index) {
  const som = somOf(parentSom, proto.name, index);
  const inst = { ...proto, proto, som, index, children: [] };

  const el = matchLeaf(proto, dataNode, ctx);
  if (el) {
    setBoundValue(inst, el);
    inst.bound = true;
    inst.dataPath = dataPath(el.ownerElement ?? el, ctx) + (el.nodeType === 2 ? `.#${el.localName || el.name}` : '');
  } else {
    inst.raw = templateDefault(proto);
    inst.bound = false;
    inst.dataPath = null;
    if ((proto.scripted?.calculate || proto.scripted?.initialize) && !proto.pageRole) {
      ctx.log.info('XFA_BIND_SCRIPT_SKIPPED', `${som}: value would come from a script; using the template default`);
    }
  }
  return inst;
}

// Find (and consume) the data node for a field or exclGroup
function matchLeaf(proto, dataNode, ctx) {
  const match = proto.name || proto.bind?.match === 'dataRef' ? (proto.bind?.match ?? 'once') : 'none';
  let el = null;
  if (match === 'once') {
    el = unboundChildren(dataNode, proto.name, ctx)[0] ?? null;
  } else if (match === 'global') {
    el = unboundDescendants(ctx.record, proto.name, ctx)[0] ?? null;
  } else if (match === 'dataRef') {
    el = resolveRef(proto.bind.ref, dataNode, ctx)[0] ?? null;
    if (!el) danglingRef(proto, ctx);
  }
  if (el && el.nodeType === 1) ctx.bound.add(el);
  return el;
}

/**
 * Raw value of a bound data node (spec §5 Field value): direct text nodes
 * only, "" for an empty element, null for xsi:nil="true", the attribute
 * string for an attribute bind.
 */
export function leafValue(node) {
  if (node.nodeType === 2) return node.value;
  if (isNil(node)) return null;
  let text = '';
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue;
  }
  return text;
}

// A failed match uses value/text, then value/exData plain text, then ""
function templateDefault(proto) {
  const v = proto.value;
  if (!v) return '';
  if (v.kind === 'text' || v.kind === 'rich') return v.text ?? '';
  return '';
}

// raw value of a bound field; rich-text data
// (<X xfa:contentType="text/html"><body …>…</body></X>) also keeps its runs
function setBoundValue(inst, el) {
  inst.raw = leafValue(el);
  const rich = el.nodeType === 1 ? richData(el) : null;
  if (rich) {
    inst.richValue = rich;
    inst.raw = richPlainText(rich);
  }
}

function richData(el) {
  let html = false;
  for (const a of Array.from(el.attributes ?? [])) {
    if ((a.localName || a.name.split(':').pop()) === 'contentType' && /html|xml/.test(a.value)) html = true;
  }
  if (!html) return null;
  let body = null;
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) { body = n; break; }
  const paras = parseRich(body ?? el);
  return paras.length ? paras : null;
}

function isNil(el) {
  for (const a of Array.from(el.attributes ?? [])) {
    if ((a.localName || a.name.split(':').pop()) === 'nil' && a.value === 'true') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// pageSet: boilerplate fields on page areas bind only through explicit
// dataRef or global; "once" would steal data from the body, so it is none.
// ---------------------------------------------------------------------------

function bindPageSet(ps, som, record, ctx) {
  return {
    ...ps,
    pageAreas: ps.pageAreas.map(pa => ({
      ...pa,
      children: pa.children.map((c, i) => bindBoilerplate(c, somOf(som, c.name, i), record, ctx)),
    })),
    pageSets: ps.pageSets.map(p => bindPageSet(p, som, record, ctx)),
  };
}

// A subform with a dataRef bind moves the data node its children's refs are
// relative to (Attestation's footer FrgBoutons binds $.FrgBoutons, and its
// btnvis field $.btnvis under that)
function bindBoilerplate(proto, som, current, ctx) {
  const inst = { ...proto, proto, som, index: 0, children: [] };
  const match = proto.bind?.match;
  if (proto.type === 'field') {
    const el = match === 'dataRef' || match === 'global' ? matchLeaf(proto, current, ctx) : null;
    if (el) setBoundValue(inst, el);
    else inst.raw = templateDefault(proto);
    inst.bound = !!el;
    inst.dataPath = el ? dataPath(el.ownerElement ?? el, ctx) : null;
  } else if (proto.type === 'subform' && match === 'dataRef') {
    const el = resolveRef(proto.bind.ref, current, ctx).find(n => n.nodeType === 1);
    if (el) {
      current = el;
      inst.dataPath = dataPath(el, ctx);
    } else danglingRef(proto, ctx);
  }
  inst.children = proto.children.map((c, i) => bindBoilerplate(c, somOf(som, c.name, i), current, ctx));
  return inst;
}

// ---------------------------------------------------------------------------
// Data lookup
// ---------------------------------------------------------------------------

function unboundChildren(dataNode, name, ctx) {
  if (!name || !dataNode || dataNode.synthetic) return [];
  const out = [];
  for (let n = dataNode.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && localName(n) === name && !ctx.bound.has(n)) out.push(n);
  }
  return out;
}

function unboundDescendants(root, name, ctx) {
  if (!name || !root) return [];
  const out = [];
  const walk = el => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      if (localName(n) === name && !ctx.bound.has(n)) out.push(n);
      walk(n);
    }
  };
  walk(root);
  return out;
}

/**
 * Resolve a reduced SOM ref against the data tree.
 *
 *   $.a.b                  relative to the current data node
 *   a.b                    unqualified: current node, then each ancestor
 *   $                      the current data node
 *   $record.a.b            from the record (data root); record.a.b too
 *                          when nothing named record is in scope
 *   $data.form1.a          from xfa:data
 *   xfa.datasets.data.…    from xfa:data
 *   a[2]  a[*]             index / all instances
 *   a.@x  a.#x             attribute x (tail only)
 *
 * @returns {Node[]} matches in document order (elements, or one attribute)
 */
export function resolveRef(ref, current, ctx) {
  if (!ref) return [];
  let segs = splitSom(ref.trim());
  let nodes;
  if (segs[0] === '$') { nodes = [current]; segs = segs.slice(1); }
  else if (segs[0] === '$record') { nodes = [ctx.record]; segs = segs.slice(1); }
  else if (segs[0] === '$data') { nodes = [ctx.dataEl]; segs = segs.slice(1); }
  else if (segs[0] === 'xfa' && segs[1] === 'datasets' && segs[2] === 'data') { nodes = [ctx.dataEl]; segs = segs.slice(3); }
  else if (segs[0] === '!') { return []; }
  else {
    // Unqualified (a.b): SOM implicit scoping — if the first segment is not a
    // child of the current node, retry from each ancestor (as pdf.js does)
    for (let scope = current; scope && !scope.synthetic && scope.nodeType === 1; scope = scope.parentNode) {
      const found = walkSom([scope], segs);
      if (found.length) return found;
      if (scope === ctx.dataEl) break;
    }
    // record.a.b with no data node named record: Acrobat reads it as
    // $record.a.b (Selbstauskunft binds its totals and comment rows this way)
    if (segs[0] === 'record' && segs.length > 1) return walkSom([ctx.record], segs.slice(1));
    return [];
  }
  return walkSom(nodes, segs);
}

function walkSom(nodes, segs) {
  nodes = nodes.filter(n => n && !n.synthetic);
  for (let s = 0; s < segs.length && nodes.length; s++) {
    const seg = segs[s];
    if (seg[0] === '@' || seg[0] === '#') {
      const attrName = seg.slice(1);
      const a = nodes[0].getAttributeNode?.(attrName);
      return a ? [a] : [];
    }
    const m = /^([^[\]]+)(?:\[(\*|\d+)\])?$/.exec(seg);
    if (!m) return [];
    const [, name, idx] = m;
    const next = [];
    for (const parent of nodes) {
      const kids = [];
      for (let n = parent.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1 && localName(n) === name) kids.push(n);
      }
      if (idx === '*') next.push(...kids);
      else if (kids[idx === undefined ? 0 : parseInt(idx, 10)]) next.push(kids[idx === undefined ? 0 : parseInt(idx, 10)]);
    }
    nodes = next;
  }
  return nodes;
}

function splitSom(ref) {
  // split on dots outside brackets
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of ref) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '.' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.filter(s => s !== '');
}

function danglingRef(proto, ctx) {
  ctx.log.warn('XFA_BIND_DANGLING', `"${proto.name}": ref ${proto.bind.ref} does not resolve`);
}

// "form1.line[1].sku": index suffix only on repeated instances
/**
 * A new instance of subform prototype `proto` under `parent`, as
 * instanceManager.addInstance makes it after binding: with merge, bound to
 * the next unbound data element of its name under the parent's data, or a
 * new empty one appended there; without, to nothing. It goes after the
 * last instance of that name, else where the template puts it.
 * @returns {object} the instance (not yet linked into a script DOM)
 */
export function addInstance(parent, proto, ctx, merge = true, position = null) {
  const kids = parent.children;
  const same = kids.filter(c => c.proto === proto);
  // insertInstance: at a position among the instances, else after the last
  const before = position !== null && position >= 0 && position < same.length ? same[position] : null;
  const index = before ? position : same.length;
  const match = !proto.name ? 'none' : (proto.bind?.match ?? 'once');
  const scope = parent.dataScope;
  let el = null;
  if (merge && match === 'once' && scope && !scope.synthetic) {
    el = unboundChildren(scope, proto.name, ctx)[0] ?? null;
    if (!el && scope.ownerDocument) {
      el = scope.ownerDocument.createElementNS(scope.namespaceURI ?? null, proto.name);
      // an inserted instance's data goes before the data of the one it precedes
      if (before?.boundEl?.parentNode === scope) scope.insertBefore(el, before.boundEl);
      else scope.appendChild(el);
      (ctx.created ??= new Set()).add(el);
    }
    if (el) ctx.bound.add(el);
  }
  const childData = match === 'none' ? scope : (el ?? EMPTY);
  const inst = instantiate(proto, index, somOf(parent.som, proto.name, index), childData, el, ctx);
  if (el) Object.defineProperty(inst, 'boundEl', { value: el });
  let at;
  if (before) at = kids.indexOf(before);
  else if (same.length) at = kids.indexOf(same[same.length - 1]) + 1;
  else {
    // template order: before the first sibling whose prototype comes later
    const order = parent.proto?.children ?? [];
    const pos = order.indexOf(proto);
    at = kids.findIndex(c => order.indexOf(c.proto) > pos);
    if (at < 0) at = kids.length;
  }
  kids.splice(at, 0, inst);
  if (before) renumber(parent, proto);
  return inst;
}

/** moveInstance: instance `from` of proto goes to position `to` among them */
export function moveInstance(parent, proto, from, to) {
  const kids = parent.children;
  const same = kids.filter(c => c.proto === proto);
  if (!(from >= 0 && from < same.length && to >= 0 && to < same.length) || from === to) return;
  const inst = same[from];
  const target = same[to];
  kids.splice(kids.indexOf(inst), 1);
  kids.splice(kids.indexOf(target) + (to > from ? 1 : 0), 0, inst);
  // its data moves with it
  const el = inst.boundEl, ref = target.boundEl;
  if (el && ref && el.parentNode && el.parentNode === ref.parentNode) el.parentNode.insertBefore(el, to > from ? ref.nextSibling : ref);
  renumber(parent, proto);
}

// the instances of proto numbered in their order, their SOM paths after them
function renumber(parent, proto) {
  parent.children.filter(c => c.proto === proto).forEach((c, i) => {
    if (c.index === i) return;
    c.index = i;
    resom(c, somOf(parent.som, c.name, i));
  });
}

/** Remove instance `inst` from `parent` and renumber the later ones of its name */
export function removeInstance(parent, inst, ctx) {
  const kids = parent.children;
  kids.splice(kids.indexOf(inst), 1);
  const el = inst.boundEl;
  if (el && ctx.created?.has(el)) { el.parentNode?.removeChild(el); ctx.created.delete(el); ctx.bound.delete(el); }
  renumber(parent, inst.proto);
}

// a node's SOM path and its descendants', after its index changed
function resom(n, som) {
  n.som = som;
  for (const c of n.children ?? []) resom(c, somOf(som, c.name, c.index ?? 0));
}

function somOf(parentSom, name, index) {
  const seg = (name || '#') + (index > 0 ? `[${index}]` : '');
  return parentSom ? `${parentSom}.${seg}` : seg;
}

// Data path from the record, with [i] for repeated same-name siblings
function dataPath(el, ctx) {
  const segs = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    let i = 0;
    for (let s = n.previousSibling; s; s = s.previousSibling) {
      if (s.nodeType === 1 && localName(s) === localName(n)) i++;
    }
    segs.unshift(localName(n) + (i > 0 ? `[${i}]` : ''));
    if (n === ctx.record) break;
  }
  return segs.join('.');
}

function localName(el) {
  return el.localName || String(el.nodeName).split(':').pop();
}
