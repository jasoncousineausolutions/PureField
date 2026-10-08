/**
 * Purefield / xfa / proto.js
 *
 * Prototypes: an element with use="#id" / use="som" or usehref="#id",
 * ".#som(expr)", "#som(expr)" inherits from the element it names, as
 * pdf.js applies them ($resolvePrototypes), before the template is modelled:
 *
 *   attributes   the ones it does not set
 *   content      its text, when it has none
 *   properties   a property it has merges with the prototype's, one it
 *                lacks is copied (font, para, margin, border, value, ui, …)
 *   lists        children that may repeat (edges, corners, items, events,
 *                containers) are topped up from the prototype's beyond
 *                its own
 *
 * The prototype must be the same kind of element; a cycle is broken; a
 * reference to another document is left unresolved (XFA_USE_SKIPPED).
 * Designer stylesheets are prototypes in a <proto> of the root subform,
 * named by SOM ($template.#subform.designer__stylesheet.a_Para): the
 * echr-application-es form takes its Calibri fonts and widget borders
 * from them.
 *
 * DOM use is limited to what browsers and @xmldom/xmldom share.
 */

const CONTAINERS = new Set(['subform', 'subformSet', 'area', 'exclGroup', 'field', 'draw']);
// children that may occur more than once (elsewhere: once)
const LISTS = new Set([
  ...CONTAINERS, 'proto', 'event', 'breakBefore', 'breakAfter', 'edge', 'corner', 'items', 'setProperty',
  'bindItems', 'connect', 'traverse', 'pageArea', 'pageSet', 'contentArea', 'script', 'variables', 'extras',
  'speak', 'toolTip',
]);
// parents all of whose children may repeat
const LIST_PARENTS = new Set(['items', 'variables', 'extras', 'desc']);
const NOT_INHERITED = new Set(['id', 'name', 'use', 'usehref']);

/**
 * Resolve every prototype reference under the template element, in place.
 * @param {Element} template - the template packet's document element
 * @param {import('./log.js').XfaLog} [log]
 */
export function resolvePrototypes(template, log) {
  const ids = new Map();
  for (const el of descendants(template)) {
    const id = el.getAttribute('id');
    if (id && !ids.has(id)) ids.set(id, el);
  }
  const ctx = { template, ids, log, done: new Set() };
  const walk = el => {
    resolveOne(el, ctx, new Set());
    for (const c of elementChildren(el)) walk(c);
  };
  walk(template);
}

function resolveOne(el, ctx, ancestors) {
  if (ctx.done.has(el)) return;
  const use = el.getAttribute('use');
  const usehref = el.getAttribute('usehref');
  if (!use && !usehref) { ctx.done.add(el); return; }
  const proto = findPrototype(el, use, usehref, ctx);
  if (!proto) {
    // leave the reference for the model to log
    ctx.done.add(el);
    return;
  }
  el.removeAttribute('use');
  el.removeAttribute('usehref');
  if (localName(proto) !== localName(el) || ancestors.has(proto)) {
    ctx.done.add(el);
    return;
  }
  // the prototype's own references first
  const chain = new Set(ancestors).add(proto);
  resolveOne(proto, ctx, chain);
  apply(el, proto, ctx, chain);
  ctx.done.add(el);
}

function apply(el, proto, ctx, ancestors) {
  for (const a of Array.from(proto.attributes ?? [])) {
    const name = a.name;
    if (NOT_INHERITED.has(name) || el.hasAttribute(name)) continue;
    el.setAttribute(name, a.value);
  }
  const own = elementChildren(el);
  const theirs = elementChildren(proto);
  if (!own.length && !textOf(el).trim() && theirs.length === 0 && textOf(proto)) {
    el.appendChild(el.ownerDocument.createTextNode(textOf(proto)));
  }
  const listParent = LIST_PARENTS.has(localName(el));
  const byTag = new Map();
  for (const c of theirs) {
    const tag = localName(c);
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(c);
  }
  for (const [tag, protoKids] of byTag) {
    const mine = own.filter(c => localName(c) === tag);
    if (listParent || LISTS.has(tag)) {
      for (let i = mine.length; i < protoKids.length; i++) el.appendChild(protoKids[i].cloneNode(true));
    } else if (mine.length) {
      // a property both have: the prototype's is a prototype for it
      resolveOne(mine[0], ctx, ancestors);
      if (!ancestors.has(protoKids[0])) apply(mine[0], protoKids[0], ctx, new Set(ancestors).add(protoKids[0]));
    } else {
      el.appendChild(protoKids[0].cloneNode(true));
    }
  }
}

function findPrototype(el, use, usehref, ctx) {
  let id = null, som = null;
  if (usehref) {
    if (usehref.startsWith('#som(') && usehref.endsWith(')')) som = usehref.slice(5, -1);
    else if (usehref.startsWith('.#som(') && usehref.endsWith(')')) som = usehref.slice(6, -1);
    else if (usehref.startsWith('#')) id = usehref.slice(1);
    else if (usehref.startsWith('.#')) id = usehref.slice(2);
    else return null; // another document
  } else if (use.startsWith('#')) id = use.slice(1);
  else som = use;
  if (id) return ctx.ids.get(id) ?? null;
  return resolveSom(som, el, ctx);
}

// A template SOM expression: $template.#subform.a.b[1], or names found by
// scoping from the element; nameless containers and <proto> are transparent
function resolveSom(expr, from, ctx) {
  const segs = String(expr).trim().split('.').filter(Boolean);
  if (!segs.length) return null;
  let nodes;
  let rest = segs;
  if (segs[0] === '$template' || segs[0] === 'xfa' && segs[1] === 'template') {
    nodes = [ctx.template];
    rest = segs.slice(segs[0] === '$template' ? 1 : 2);
  } else if (segs[0] === '$') {
    nodes = [from];
    rest = segs.slice(1);
  } else {
    const first = parseSeg(segs[0]);
    for (let scope = from.parentNode; scope && scope.nodeType === 1; scope = scope.parentNode) {
      const hits = childrenFor(scope, first);
      if (hits.length) { nodes = [hits[first.index] ?? hits[0]].filter(Boolean); break; }
    }
    if (!nodes) return null;
    rest = segs.slice(1);
  }
  for (const s of rest) {
    const seg = parseSeg(s);
    const hits = nodes.length ? childrenFor(nodes[0], seg) : [];
    const hit = hits[seg.index];
    if (!hit) return null;
    nodes = [hit];
  }
  return nodes[0] ?? null;
}

function parseSeg(s) {
  const m = /^(#?)([^[]+)(?:\[(\d+)\])?$/.exec(s);
  return m ? { byClass: m[1] === '#', name: m[2], index: m[3] ? +m[3] : 0 } : { byClass: false, name: s, index: 0 };
}

function childrenFor(el, seg) {
  const out = [];
  const visit = node => {
    for (const c of elementChildren(node)) {
      const tag = localName(c);
      if (seg.byClass ? tag === seg.name : c.getAttribute('name') === seg.name) out.push(c);
      else if (tag === 'proto' || (CONTAINERS.has(tag) && !c.getAttribute('name') && tag !== 'field' && tag !== 'draw')) visit(c);
    }
  };
  visit(el);
  return out;
}

function* descendants(el) {
  for (const c of elementChildren(el)) {
    yield c;
    yield* descendants(c);
  }
}

function elementChildren(el) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}

function textOf(el) {
  let s = '';
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 || n.nodeType === 4) s += n.nodeValue;
  return s;
}

function localName(el) {
  return el.localName || String(el.nodeName).split(':').pop();
}
