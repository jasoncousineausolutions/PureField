/**
 * Purefield / xfa / script / run.js
 *
 * Runs a form's scripts on the bound instance tree, between binding and the
 * saved form state, so what they decide (presence, values, display text)
 * reaches layout. Events fire once each, in the order Acrobat fires them on
 * opening and printing a form:
 *
 *   initialize             every object, in document order: a container
 *                          before its children (hmrc-c1800-chief's root
 *                          initialize sets up the Styles its children use)
 *   calculate              every calculate script, in document order, twice
 *                          (so a total over later fields settles)
 *   ready ($form)          document order
 *   ready ($layout)        document order; run before layout, as if the
 *                          layout were done (layout queries throw)
 *   docReady               document order
 *   prePrint               document order (the Reader prints are prints)
 *
 * User events (click, change, enter, exit, mouse*, preSubmit, …) never fire.
 * Page-number scripts (pageRole, model.js) are left to painting.
 *
 * FormCalc runs in formcalc.js and JavaScript in js.js; neither hands form
 * code to the host JavaScript engine. A script that fails or uses what the
 * object model lacks stops where it failed, keeps what it already did and
 * is logged (XFA_SCRIPT_FAILED); the next script runs regardless.
 */

import { XfaDom, ScriptError } from './dom.js';
import { runFormCalc } from './formcalc.js';
import { runJavaScript, ScriptObjects } from './js.js';

/**
 * @param {object} root - instance root from bindData()
 * @param {{ record?: Element|null, locales?: object, log?: import('../log.js').XfaLog, now?: Date }} [opts]
 * @returns {{ run: number, failed: number }}
 */
export function runScripts(root, { record = null, locales = {}, log, now, layout = null } = {}) {
  const dom = new XfaDom(root, { record, locales, log, now, layout });
  const stats = { run: 0, failed: 0 };
  const nodes = [];
  // page-area boilerplate: repeated on every page
  const boiler = new Set();
  let inPage = 0;
  const walk = n => {
    nodes.push(n);
    if (inPage) boiler.add(n);
    for (const ps of n.pageSets ?? []) walkPageSet(ps);
    for (const c of n.children ?? []) walk(c);
  };
  const walkPageSet = ps => {
    inPage++;
    for (const pa of ps.pageAreas ?? []) pa.children.forEach(walk);
    for (const sub of ps.pageSets ?? []) walkPageSet(sub);
    inPage--;
  };
  walk(root);
  if (!nodes.some(n => n.events?.length || n.calculate)) {
    Object.defineProperty(stats, 'evaluate', { value: () => { throw new ScriptError('The form has no scripts'); } });
    return stats;
  }

  const objects = new ScriptObjects(dom, nodes, { log });
  // instances a script adds join the list at the end of their parent's
  // subtree and run their initialize before addInstance returns; a removed
  // one leaves it (the loops below read the live list)
  const removed = new Set();
  const subtree = n => { const out = []; const w = x => { out.push(x); (x.children ?? []).forEach(w); }; w(n); return out; };
  dom.inPageArea = n => boiler.has(n);
  dom.instanceAdded = inst => {
    const parent = dom.parents.get(inst);
    let at = nodes.length;
    for (let i = nodes.indexOf(parent); i >= 0 && i < nodes.length; i++) {
      if (i > nodes.indexOf(parent) && !isWithin(nodes[i], parent, dom)) { at = i; break; }
    }
    const added = subtree(inst);
    nodes.splice(at, 0, ...added);
    objects.register(added);
    events(added, 'initialize');
  };
  dom.instanceRemoved = inst => { for (const n of subtree(inst)) removed.add(n); };

  const fire = (n, script, activity) => {
    if (n.pageRole || removed.has(n)) return null;
    const self = dom.wrap(n);
    const event = dom.xfa.event;
    const saved = [event.target, event.activity];
    event.target = self;
    event.activity = activity;
    try {
      const v = script.lang === 'javascript'
        ? runJavaScript(script.text, self, dom, objects)
        : runFormCalc(script.text, self, dom);
      stats.run++;
      return { value: v };
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      stats.failed++;
      log?.once('info', 'XFA_SCRIPT_FAILED', `${activity}|${e.message}`,
        `${n.som ?? n.name} ${activity} (${script.lang}): ${e.message}`);
      return null;
    } finally {
      [event.target, event.activity] = saved;
    }
  };
  // a calculate script's value becomes the field's (JavaScript's undefined
  // leaves it as it is)
  const calculate = n => {
    if (!n.calculate || n.pageRole) return;
    if (n.type !== 'field' && n.type !== 'draw' && n.type !== 'exclGroup') return;
    const r = fire(n, n.calculate, 'calculate');
    if (r && r.value !== undefined) {
      const v = r.value;
      dom.wrap(n).assign(v !== null && typeof v === 'object' ? (typeof v.scalar === 'function' ? v.scalar() : null) : v);
    }
  };
  // boilerplate layout:ready scripts that ask which page they are on run
  // once per page after layout (pageScripts); hmrc-c1800-chief prints its
  // form number on page 1 only
  const pageScripts = [];
  const fireOn = (n, activity, ref) => {
    for (const ev of n.events ?? []) {
      if (ev.activity !== activity) continue;
      if (ref && ev.ref !== ref) continue;
      if (activity === 'ready' && ref === '$layout' && boiler.has(n) && LAYOUT_QUERY.test(ev.script?.text ?? '')) {
        pageScripts.push({ n, script: ev.script });
        continue;
      }
      fire(n, ev.script, ref && ref !== '$form' ? `${activity}:${ref}` : activity);
    }
  };
  // by index: instances added meanwhile are visited in the same pass
  const events = (list, activity, ref) => { for (let i = 0; i < list.length; i++) fireOn(list[i], activity, ref); };
  const calculateAll = () => { for (let i = 0; i < nodes.length; i++) calculate(nodes[i]); };

  // execEvent / execInitialize / execCalculate from a script; nested at
  // most a few deep, so scripts that trigger each other cannot loop
  let depth = 0;
  dom.fireEvent = (n, activity, subtree) => {
    if (depth >= 8) throw new ScriptError('Events nested too deeply');
    depth++;
    try {
      const list = subtree ? nodes.filter(x => isWithin(x, n, dom)) : [n];
      if (activity === 'calculate') list.forEach(calculate);
      else if (subtree && activity === 'initialize') events(list, activity);
      else events(list, activity);
    } finally {
      depth--;
    }
  };

  events(nodes, 'initialize');
  for (let pass = 0; pass < 2; pass++) calculateAll();
  events(nodes, 'ready', '$form');
  events(nodes, 'ready', '$layout');
  events(nodes, 'docReady');
  dom.printing = true;
  events(nodes, 'prePrint');
  dom.printing = false;
  // what prePrint changed reaches the calculations that read it, as Acrobat
  // recalculates (a paper forms barcode copies the value its prePrint built)
  if (nodes.some(n => n.events?.some(e => e.activity === 'prePrint'))) calculateAll();

  if (stats.run || stats.failed) {
    log?.info('XFA_SCRIPTS', `Scripts run: ${stats.run}, failed: ${stats.failed}`);
  }
  // for tests and debugging: run JavaScript against the form as it now is
  Object.defineProperty(stats, 'evaluate', { value: src => runJavaScript(src, dom.wrap(root), dom, objects) });
  // whether a script asked the layout something only a laid-out form knows
  Object.defineProperty(stats, 'layoutQueried', { get: () => dom.xfa.layout.queried });
  // after layout: the presence each page-dependent boilerplate script gives
  // its object on page `page` of `count` (Map node → presence)
  // and the value it gives its field there ("Page 2 / 5")
  const onPage = (page, count) => {
    const presence = new Map(), values = new Map();
    dom.xfa.layout.at = { page, count };
    try {
      for (const { n, script } of pageScripts) {
        const saved = [n.presence, n.raw];
        fire(n, script, 'ready:$layout');
        presence.set(n, n.presence ?? 'visible');
        if (n.raw !== saved[1]) values.set(n, n.raw);
        [n.presence, n.raw] = saved;
      }
    } finally {
      dom.xfa.layout.at = null;
    }
    return { presence, values };
  };
  Object.defineProperty(stats, 'pagePresence', { value: pageScripts.length ? (page, count) => onPage(page, count).presence : null });
  Object.defineProperty(stats, 'pageValues', { value: pageScripts.length ? (page, count) => onPage(page, count).values : null });
  return stats;
}

const LAYOUT_QUERY = /xfa\.layout\.(page|absPage|sheet|pageCount|absPageCount|sheetCount)\s*\(/;

function isWithin(x, n, dom) {
  for (let p = x; p; p = dom.parents.get(p)) if (p === n) return true;
  return false;
}
