/**
 * Purefield / xfa / script / formcalc.js
 *
 * A FormCalc interpreter (XFA 3.3 §25), run on the object model in dom.js.
 * Nothing is compiled to host JavaScript: the source is tokenised, parsed to
 * a tree and walked, so a form's script can do no more than the object model
 * allows, and a step budget stops runaway loops.
 *
 *   statements  if/elseif/else/endif, while, for upto/downto/step,
 *               foreach … in (…), do … end, func … endfunc, var, break,
 *               continue, return, assignment
 *   operators   or | and & == <> eq ne < <= > >= lt le gt ge + - * / not
 *   accessors   SOM paths: $, $record, $data, $form, $host, xfa, !, names
 *               found by SOM scoping, a[2], a[*], a..b, a.#class, methods
 *   functions   the arithmetic, date, logical and string built-ins below
 *
 * Values are numbers, strings and null. Keywords and function names are
 * case-insensitive; object names are not. A comparison of two strings is a
 * string comparison, any other a numeric one, with null equal only to null,
 * "" or 0 (FormCalc's null promotion). A script's value is the value of its
 * last expression (what a calculate script assigns).
 */

import { ScriptError, NodeList, numberText } from './dom.js';
import { formatPicture } from '../picture.js';

const KEYWORDS = new Set([
  'if', 'then', 'elseif', 'else', 'endif', 'while', 'do', 'endwhile', 'for', 'upto', 'downto',
  'step', 'endfor', 'foreach', 'in', 'func', 'endfunc', 'var', 'break', 'continue', 'return',
  'end', 'and', 'or', 'not', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'null', 'infinity', 'nan',
]);

const MAX_STEPS = 1_000_000;

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function tokenize(src) {
  const toks = [];
  let i = 0, line = 1;
  const push = (type, value) => toks.push({ type, value, line });
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    // comments: ; or // to the end of the line
    if (ch === ';' || (ch === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ScriptError('Unterminated string');
        const c = src[i];
        if (c === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++;
          break;
        }
        if (c === '\\' && src[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
          s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        if (c === '\n') line++;
        s += c;
        i++;
      }
      push('str', s);
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
    if (num && !(ch === '.' && toks.length && isOperand(toks[toks.length - 1]))) {
      push('num', parseFloat(num[0]));
      i += num[0].length;
      continue;
    }
    if (/[\p{L}_$!]/u.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[\p{L}\p{N}_$]/u.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      const lower = word.toLowerCase();
      // a keyword is a keyword only where it can be one: not after a dot
      const afterDot = toks.length && ['.', '..', '.#'].includes(toks[toks.length - 1].value) && toks[toks.length - 1].type === 'op';
      if (KEYWORDS.has(lower) && !afterDot) push('kw', lower);
      else push('id', word);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '<>', '<=', '>=', '..', '.#', '.*'].includes(two)) { push('op', two); i += 2; continue; }
    if ('=<>+-*/&|()[],.'.includes(ch)) { push('op', ch); i++; continue; }
    if (ch === '#') {
      // #name: a class name step (a.#field written without the dot is not SOM)
      let j = i + 1;
      while (j < src.length && /[\p{L}\p{N}_]/u.test(src[j])) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    throw new ScriptError(`Unexpected character "${ch}" on line ${line}`);
  }
  push('eof', null);
  return toks;
}

function isOperand(t) {
  return t.type === 'id' || t.type === 'num' || t.type === 'str' || (t.type === 'op' && (t.value === ')' || t.value === ']'));
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  peek(o = 0) { return this.toks[this.i + o]; }
  next() { return this.toks[this.i++]; }
  isKw(v, o = 0) { const t = this.peek(o); return t.type === 'kw' && t.value === v; }
  isOp(v, o = 0) { const t = this.peek(o); return t.type === 'op' && t.value === v; }
  expectKw(v) {
    const t = this.next();
    if (t.type !== 'kw' || t.value !== v) throw new ScriptError(`Expected "${v}" on line ${t.line}, found "${t.value ?? 'end of script'}"`);
  }
  expectOp(v) {
    const t = this.next();
    if (t.type !== 'op' || t.value !== v) throw new ScriptError(`Expected "${v}" on line ${t.line}, found "${t.value ?? 'end of script'}"`);
  }
  ident() {
    const t = this.next();
    if (t.type !== 'id') throw new ScriptError(`Expected a name on line ${t.line}, found "${t.value ?? 'end of script'}"`);
    return t.value;
  }

  program() {
    const body = this.list(new Set());
    if (this.peek().type !== 'eof') throw new ScriptError(`Unexpected "${this.peek().value}" on line ${this.peek().line}`);
    return body;
  }

  // expressions up to (not including) one of the terminating keywords
  list(stops) {
    const out = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof' || (t.type === 'kw' && stops.has(t.value))) return out;
      out.push(this.expression());
    }
  }

  expression() {
    const t = this.peek();
    if (t.type === 'kw') {
      switch (t.value) {
        case 'if': return this.ifExpr();
        case 'while': {
          this.next();
          this.expectOp('(');
          const cond = this.simple();
          this.expectOp(')');
          this.expectKw('do');
          const body = this.list(new Set(['endwhile']));
          this.expectKw('endwhile');
          return { t: 'while', cond, body };
        }
        case 'for': {
          this.next();
          const name = this.ident();
          this.expectOp('=');
          const from = this.simple();
          const dir = this.next();
          if (dir.type !== 'kw' || (dir.value !== 'upto' && dir.value !== 'downto')) throw new ScriptError(`Expected upto or downto on line ${dir.line}`);
          const to = this.simple();
          let step = null;
          if (this.isKw('step')) { this.next(); step = this.simple(); }
          this.expectKw('do');
          const body = this.list(new Set(['endfor']));
          this.expectKw('endfor');
          return { t: 'for', name, from, to, step, down: dir.value === 'downto', body };
        }
        case 'foreach': {
          this.next();
          const name = this.ident();
          this.expectKw('in');
          this.expectOp('(');
          const items = this.args(')');
          this.expectKw('do');
          const body = this.list(new Set(['endfor']));
          this.expectKw('endfor');
          return { t: 'foreach', name, items, body };
        }
        case 'do': {
          this.next();
          const body = this.list(new Set(['end']));
          this.expectKw('end');
          return { t: 'block', body };
        }
        case 'func': {
          this.next();
          const name = this.ident();
          this.expectOp('(');
          const params = [];
          if (!this.isOp(')')) {
            for (;;) {
              params.push(this.ident());
              if (this.isOp(',')) { this.next(); continue; }
              break;
            }
          }
          this.expectOp(')');
          this.expectKw('do');
          const body = this.list(new Set(['endfunc']));
          this.expectKw('endfunc');
          return { t: 'func', name, params, body };
        }
        case 'var': {
          this.next();
          const name = this.ident();
          let init = null;
          if (this.isOp('=')) { this.next(); init = this.simple(); }
          return { t: 'var', name, init };
        }
        case 'break': this.next(); return { t: 'break' };
        case 'continue': this.next(); return { t: 'continue' };
        case 'return': {
          const kw = this.next();
          const n = this.peek();
          const value = n.type !== 'eof' && n.line === kw.line && !(n.type === 'kw' && ['endfunc', 'endif', 'else', 'elseif', 'end', 'endfor', 'endwhile'].includes(n.value))
            ? this.simple() : null;
          return { t: 'return', value };
        }
      }
    }
    const e = this.simple();
    if (this.isOp('=')) {
      this.next();
      if (e.t !== 'acc') throw new ScriptError(`Cannot assign to this expression (line ${t.line})`);
      return { t: 'assign', target: e, value: this.simple() };
    }
    return e;
  }

  ifExpr() {
    this.expectKw('if');
    const branches = [];
    this.expectOp('(');
    let cond = this.simple();
    this.expectOp(')');
    this.expectKw('then');
    branches.push({ cond, body: this.list(new Set(['elseif', 'else', 'endif'])) });
    let otherwise = null;
    for (;;) {
      if (this.isKw('elseif')) {
        this.next();
        this.expectOp('(');
        cond = this.simple();
        this.expectOp(')');
        this.expectKw('then');
        branches.push({ cond, body: this.list(new Set(['elseif', 'else', 'endif'])) });
        continue;
      }
      if (this.isKw('else')) {
        this.next();
        otherwise = this.list(new Set(['endif']));
      }
      break;
    }
    this.expectKw('endif');
    return { t: 'if', branches, otherwise };
  }

  simple() { return this.or(); }

  binary(next, ops) {
    let left = next();
    for (;;) {
      const t = this.peek();
      const op = (t.type === 'op' || t.type === 'kw') ? ops[t.value] : undefined;
      if (!op) return left;
      this.next();
      left = { t: 'bin', op, left, right: next() };
    }
  }
  or() { return this.binary(() => this.and(), { or: 'or', '|': 'or' }); }
  and() { return this.binary(() => this.equality(), { and: 'and', '&': 'and' }); }
  equality() { return this.binary(() => this.relational(), { '==': 'eq', eq: 'eq', '<>': 'ne', ne: 'ne' }); }
  relational() { return this.binary(() => this.additive(), { '<': 'lt', lt: 'lt', '<=': 'le', le: 'le', '>': 'gt', gt: 'gt', '>=': 'ge', ge: 'ge' }); }
  additive() { return this.binary(() => this.multiplicative(), { '+': '+', '-': '-' }); }
  multiplicative() { return this.binary(() => this.unary(), { '*': '*', '/': '/' }); }

  unary() {
    if (this.isOp('-')) { this.next(); return { t: 'neg', e: this.unary() }; }
    if (this.isOp('+')) { this.next(); return { t: 'pos', e: this.unary() }; }
    if (this.isKw('not')) { this.next(); return { t: 'not', e: this.unary() }; }
    return this.primary();
  }

  primary() {
    const t = this.next();
    if (t.type === 'num') return { t: 'lit', v: t.value };
    if (t.type === 'str') return { t: 'lit', v: t.value };
    if (t.type === 'kw') {
      if (t.value === 'null') return { t: 'lit', v: null };
      if (t.value === 'infinity') return { t: 'lit', v: Infinity };
      if (t.value === 'nan') return { t: 'lit', v: NaN };
      if (t.value === 'if') { this.i--; return this.ifExpr(); }
    }
    if (t.type === 'op' && t.value === '(') {
      const e = this.simple();
      this.expectOp(')');
      return e;
    }
    if (t.type === 'id') return this.accessor(t);
    throw new ScriptError(`Unexpected "${t.value ?? 'end of script'}" on line ${t.line}`);
  }

  // name, name(args), name[i].b..c.#d.method(args)
  accessor(t) {
    if (this.isOp('(')) {
      this.next();
      return { t: 'call', name: t.value, args: this.args(')') };
    }
    const head = { name: t.value, index: this.index() };
    const parts = [];
    for (;;) {
      if (this.isOp('.') || this.isOp('..') || this.isOp('.#')) {
        const op = this.next().value;
        if (op === '.' && this.isOp('*')) { this.next(); parts.push({ op: '.*', index: this.index() }); continue; }
        const nt = this.next();
        if (nt.type !== 'id' && nt.type !== 'kw') throw new ScriptError(`Expected a name after "${op}" on line ${nt.line}`);
        const name = nt.value;
        if (op === '.' && this.isOp('(')) {
          this.next();
          parts.push({ op: 'call', name, args: this.args(')') });
          continue;
        }
        parts.push({ op, name, index: this.index() });
        continue;
      }
      if (this.isOp('.*')) { this.next(); parts.push({ op: '.*', index: this.index() }); continue; }
      return { t: 'acc', head, parts, line: t.line };
    }
  }

  index() {
    if (!this.isOp('[')) return null;
    this.next();
    let idx;
    if (this.isOp('*')) { this.next(); idx = { all: true }; }
    else if (this.isOp('+') || this.isOp('-')) {
      const sign = this.next().value === '-' ? -1 : 1;
      idx = { relative: true, e: { t: 'neg', e: this.simple(), sign } };
      idx.e = sign < 0 ? { t: 'neg', e: idx.e.e } : idx.e.e;
    } else idx = { e: this.simple() };
    this.expectOp(']');
    return idx;
  }

  args(close) {
    const out = [];
    if (this.isOp(close)) { this.next(); return out; }
    for (;;) {
      out.push(this.simple());
      if (this.isOp(',')) { this.next(); continue; }
      this.expectOp(close);
      return out;
    }
  }
}

/** Parse a FormCalc script (cached by source text) */
const parsed = new Map();
export function parseFormCalc(src) {
  let ast = parsed.get(src);
  if (!ast) {
    ast = new Parser(tokenize(src)).program();
    if (parsed.size > 500) parsed.clear();
    parsed.set(src, ast);
  }
  return ast;
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

class Break {}
class Continue {}
class Return { constructor(v) { this.value = v; } }

class Scope {
  constructor(parent) { this.parent = parent; this.vars = new Map(); this.funcs = new Map(); }
  find(name) {
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s;
    return null;
  }
  func(name) {
    const key = name.toLowerCase();
    for (let s = this; s; s = s.parent) if (s.funcs.has(key)) return s.funcs.get(key);
    return null;
  }
}

/**
 * Run a FormCalc script with `self` as $ (the object the script belongs to)
 * @param {string} src
 * @param {object} self - a dom.js node
 * @param {import('./dom.js').XfaDom} dom
 * @returns {*} the value of the last expression
 */
export function runFormCalc(src, self, dom) {
  const ast = parseFormCalc(src);
  const ctx = { dom, self, steps: 0 };
  return execList(ast, new Scope(null), ctx);
}

function tick(ctx) {
  if (++ctx.steps > MAX_STEPS) throw new ScriptError('Script ran too long');
}

function execList(list, scope, ctx) {
  let v = null;
  for (const e of list) v = exec(e, scope, ctx);
  return v;
}

function exec(e, scope, ctx) {
  tick(ctx);
  switch (e.t) {
    case 'if': {
      for (const b of e.branches) {
        if (truthy(value(b.cond, scope, ctx))) return execList(b.body, new Scope(scope), ctx);
      }
      return e.otherwise ? execList(e.otherwise, new Scope(scope), ctx) : null;
    }
    case 'while': {
      let v = null;
      while (truthy(value(e.cond, scope, ctx))) {
        tick(ctx);
        try { v = execList(e.body, new Scope(scope), ctx); }
        catch (x) { if (x instanceof Break) break; if (x instanceof Continue) continue; throw x; }
      }
      return v;
    }
    case 'for': {
      const from = num(value(e.from, scope, ctx));
      const to = num(value(e.to, scope, ctx));
      const step = e.step ? num(value(e.step, scope, ctx)) : 1;
      if (step <= 0) throw new ScriptError('A for loop step must be positive');
      const inner = new Scope(scope);
      let v = null;
      for (let i = from; e.down ? i >= to : i <= to; i += e.down ? -step : step) {
        tick(ctx);
        inner.vars.set(e.name, i);
        try { v = execList(e.body, new Scope(inner), ctx); }
        catch (x) { if (x instanceof Break) break; if (x instanceof Continue) { i = num(inner.vars.get(e.name)); continue; } throw x; }
        i = num(inner.vars.get(e.name));
      }
      return v;
    }
    case 'foreach': {
      const items = e.items.flatMap(a => values(a, scope, ctx));
      const inner = new Scope(scope);
      let v = null;
      for (const item of items) {
        tick(ctx);
        inner.vars.set(e.name, item);
        try { v = execList(e.body, new Scope(inner), ctx); }
        catch (x) { if (x instanceof Break) break; if (x instanceof Continue) continue; throw x; }
      }
      return v;
    }
    case 'block': return execList(e.body, new Scope(scope), ctx);
    case 'func': scope.funcs.set(e.name.toLowerCase(), e); return null;
    case 'var': {
      const v = e.init ? value(e.init, scope, ctx) : '';
      scope.vars.set(e.name, v);
      return v;
    }
    case 'break': throw new Break();
    case 'continue': throw new Continue();
    case 'return': throw new Return(e.value ? value(e.value, scope, ctx) : null);
    case 'assign': {
      const v = value(e.value, scope, ctx);
      assign(e.target, v, scope, ctx);
      return v;
    }
    default: return value(e, scope, ctx);
  }
}

// An expression as a single value
function value(e, scope, ctx) {
  tick(ctx);
  switch (e.t) {
    case 'lit': return e.v;
    case 'neg': return -num(value(e.e, scope, ctx));
    case 'pos': return num(value(e.e, scope, ctx));
    case 'not': return truthy(value(e.e, scope, ctx)) ? 0 : 1;
    case 'bin': return binary(e, scope, ctx);
    case 'call': return callFunction(e, scope, ctx);
    case 'acc': return scalarOf(resolveAcc(e, scope, ctx), e);
    default: return exec(e, scope, ctx);
  }
}

// An argument's values: an a[*] accessor gives one per match
function values(e, scope, ctx) {
  if (e.t === 'acc') {
    const r = resolveAcc(e, scope, ctx);
    if (r.kind === 'nodes') return r.nodes.map(n => scalarNode(n));
    return [r.value];
  }
  return [value(e, scope, ctx)];
}

function binary(e, scope, ctx) {
  if (e.op === 'and') return truthy(value(e.left, scope, ctx)) && truthy(value(e.right, scope, ctx)) ? 1 : 0;
  if (e.op === 'or') return truthy(value(e.left, scope, ctx)) || truthy(value(e.right, scope, ctx)) ? 1 : 0;
  const a = value(e.left, scope, ctx);
  const b = value(e.right, scope, ctx);
  // arithmetic on two nulls is null (an empty quantity times an empty
  // price leaves Purchase.Order's Amount blank in Reader); one null is 0
  if (a === null && b === null && ['+', '-', '*', '/'].includes(e.op)) return null;
  switch (e.op) {
    case '+': return num(a) + num(b);
    case '-': return num(a) - num(b);
    case '*': return num(a) * num(b);
    case '/': {
      const d = num(b);
      if (d === 0) throw new ScriptError('Division by zero');
      return num(a) / d;
    }
    case 'eq': return equal(a, b) ? 1 : 0;
    case 'ne': return equal(a, b) ? 0 : 1;
    default: {
      const c = compare(a, b);
      if (c === null) return 0;
      return { lt: c < 0, le: c <= 0, gt: c > 0, ge: c >= 0 }[e.op] ? 1 : 0;
    }
  }
}

export function equal(a, b) {
  if (a === null || b === null) {
    if (a === null && b === null) return true;
    const other = a === null ? b : a;
    return other === '' || other === 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  return num(a) === num(b);
}

function compare(a, b) {
  if (a === null && b === null) return 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const x = num(a), y = num(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  return 0;
}

function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return numberText(v);
  return String(v);
}

function truthy(v) {
  return num(v) !== 0;
}

// --- accessors --------------------------------------------------------------

// → { kind: 'var', name, scope } | { kind: 'nodes', nodes } | { kind: 'value', value, owner, prop }
function resolveAcc(e, scope, ctx) {
  const { dom } = ctx;
  const head = e.head;
  const varScope = scope.find(head.name);
  let cur;
  if (varScope) {
    const v = varScope.vars.get(head.name);
    if (!e.parts.length) return { kind: 'var', name: head.name, scope: varScope, value: v };
    cur = isNode(v) ? { kind: 'nodes', nodes: [v] } : { kind: 'value', value: v };
  } else {
    const sc = dom.shortcut(head.name, ctx.self);
    let nodes;
    if (sc !== undefined) nodes = sc ? [sc] : [];
    else nodes = dom.lookup(head.name, ctx.self);
    cur = { kind: 'nodes', nodes: applyIndex(nodes, head.index, scope, ctx) };
    if (!cur.nodes.length && sc === undefined && !e.parts.length) {
      throw new ScriptError(`Accessor "${head.name}" is unknown`);
    }
  }

  for (let i = 0; i < e.parts.length; i++) {
    const p = e.parts[i];
    if (cur.kind !== 'nodes') {
      throw new ScriptError(`"${p.name ?? p.op}" applied to a value (line ${e.line})`);
    }
    const nodes = cur.nodes;
    if (!nodes.length) throw new ScriptError(`Accessor "${accText(e, i)}" is unknown`);
    if (p.op === 'call') {
      const args = p.args.map(a => value(a, scope, ctx));
      const target = nodes[0];
      if (typeof target.call !== 'function') throw new ScriptError(`${p.name}() is not supported here`);
      const r = target.call(p.name, args);
      cur = isNode(r) ? { kind: 'nodes', nodes: [r] } : r instanceof NodeList ? { kind: 'nodes', nodes: r.items, list: r } : { kind: 'value', value: r ?? null };
      continue;
    }
    if (p.op === '.' && !p.index) {
      // a property of the (first) node wins over a child of the same name
      const prop = nodes[0].getProperty?.(p.name);
      if (prop !== undefined) {
        const v = prop.value;
        cur = isNode(v) ? { kind: 'nodes', nodes: [v], owner: nodes[0], prop: p.name }
          : v instanceof NodeList ? { kind: 'nodes', nodes: v.items, owner: nodes[0], prop: p.name }
          : { kind: 'value', value: v ?? null, owner: nodes[0], prop: p.name };
        continue;
      }
    }
    const next = [];
    const all = p.index?.all;
    for (const n of nodes) {
      const kids = p.op === '..' ? (n.descendantsByName?.(p.name) ?? [])
        : p.op === '.#' ? (n.childrenByClass?.(p.name.replace(/^#/, '')) ?? [])
        : p.op === '.*' ? (n.children ?? [])
        : n.childrenByName(p.name);
      next.push(...applyIndex(kids, p.index, scope, ctx));
      if (!all && next.length) break;
    }
    cur = { kind: 'nodes', nodes: next };
  }
  return cur;
}

function accText(e, upto) {
  return [e.head.name, ...e.parts.slice(0, upto + 1).map(p => p.name ?? '*')].join('.');
}

function applyIndex(nodes, index, scope, ctx) {
  if (!index) return nodes.length ? [nodes[0]] : [];
  if (index.all) return nodes;
  const i = Math.trunc(num(value(index.e, scope, ctx)));
  if (index.relative) throw new ScriptError('Relative indexes are not supported');
  return nodes[i] ? [nodes[i]] : [];
}

function isNode(v) {
  return v !== null && typeof v === 'object' && typeof v.childrenByName === 'function';
}

function scalarNode(n) {
  if (typeof n.scalar === 'function') return n.scalar();
  return null;
}

function scalarOf(r, e) {
  if (r.kind === 'var') return r.value;
  if (r.kind === 'value') return r.value;
  if (!r.nodes.length) throw new ScriptError(`Accessor "${accText(e, e.parts.length - 1)}" is unknown`);
  return scalarNode(r.nodes[0]);
}

function assign(target, v, scope, ctx) {
  // a plain variable
  const varScope = !target.parts.length ? scope.find(target.head.name) : null;
  if (varScope) { varScope.vars.set(target.head.name, v); return; }
  // a property: resolve everything but the last step, then set it
  const last = target.parts[target.parts.length - 1];
  if (last && last.op === '.' && !last.index) {
    const owner = resolveAcc({ ...target, parts: target.parts.slice(0, -1) }, scope, ctx);
    if (owner.kind !== 'nodes' || !owner.nodes.length) throw new ScriptError(`Accessor "${accText(target, target.parts.length - 2)}" is unknown`);
    const node = owner.nodes[0];
    if (node.getProperty?.(last.name) !== undefined) {
      if (typeof node.setProperty !== 'function') throw new ScriptError(`"${last.name}" cannot be set`);
      node.setProperty(last.name, v);
      return;
    }
  }
  const r = resolveAcc(target, scope, ctx);
  if (r.kind === 'value' && r.owner && typeof r.owner.setProperty === 'function') { r.owner.setProperty(r.prop, v); return; }
  if (r.kind !== 'nodes' || !r.nodes.length) throw new ScriptError(`Cannot assign to "${accText(target, target.parts.length - 1)}"`);
  if (r.owner && r.prop && typeof r.owner.setProperty === 'function') { r.owner.setProperty(r.prop, v); return; }
  for (const n of target.parts.at(-1)?.index?.all || target.head.index?.all ? r.nodes : [r.nodes[0]]) {
    if (typeof n.assign !== 'function') throw new ScriptError('Cannot assign to this object');
    n.assign(v);
  }
}

// --- functions ---------------------------------------------------------------

function callFunction(e, scope, ctx) {
  const user = scope.func(e.name);
  if (user) {
    const args = e.args.map(a => value(a, scope, ctx));
    const inner = new Scope(scope);
    user.params.forEach((p, i) => inner.vars.set(p, args[i] ?? null));
    try { return execList(user.body, inner, ctx); }
    catch (x) { if (x instanceof Return) return x.value; throw x; }
  }
  const name = e.name.toLowerCase();
  // reference-taking built-ins
  if (name === 'exists') {
    if (e.args.length !== 1) throw new ScriptError('Exists() takes one argument');
    const a = e.args[0];
    if (a.t !== 'acc') return 0;
    try {
      const r = resolveAcc(a, scope, ctx);
      if (r.kind === 'nodes') return r.nodes.length ? 1 : 0;
      return 1;
    } catch (x) {
      if (x instanceof ScriptError) return 0;
      throw x;
    }
  }
  if (name === 'ref') {
    const a = e.args[0];
    if (a?.t === 'acc') {
      const r = resolveAcc(a, scope, ctx);
      return r.kind === 'nodes' ? r.nodes[0] ?? null : r.value;
    }
    return a ? value(a, scope, ctx) : null;
  }
  const fn = BUILTINS[name];
  if (!fn) throw new ScriptError(`FormCalc function ${e.name}() is not supported`);
  const spread = SPREADS.has(name);
  const args = spread ? e.args.flatMap(a => values(a, scope, ctx)) : e.args.map(a => value(a, scope, ctx));
  return fn(args, ctx);
}

// functions whose arguments may be a[*] lists
const SPREADS = new Set(['sum', 'avg', 'count', 'max', 'min', 'concat', 'oneof', 'choose']);

const isNullish = v => v === null || v === undefined;
const nonNull = args => args.filter(v => !isNullish(v));

// days since 1899-12-31 (1900-01-01 is day 1), FormCalc's date number
const DAY = 86400000;
const EPOCH = Date.UTC(1900, 0, 1);
function dateNumber(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY) + 1; }
function fromDateNumber(n) {
  const t = new Date(EPOCH + (Math.trunc(n) - 1) * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function localeOf(args, i, ctx) {
  return args[i] ? str(args[i]) : ctx.dom.localeOf(ctx.self.inst ?? {});
}

function dateFormat(fmt, locale, ctx, kind) {
  if (fmt) return fmt;
  const loc = ctx.dom.locales[locale];
  return loc?.datePatterns?.med ?? (kind === 'time' ? 'h:MM:SS A' : 'MMM D, YYYY');
}

const BUILTINS = {
  // arithmetic
  abs: ([a]) => (isNullish(a) ? null : Math.abs(num(a))),
  avg: args => { const v = nonNull(args); return v.length ? v.reduce((s, x) => s + num(x), 0) / v.length : null; },
  ceil: ([a]) => (isNullish(a) ? null : Math.ceil(num(a))),
  count: args => nonNull(args).length,
  floor: ([a]) => (isNullish(a) ? null : Math.floor(num(a))),
  max: args => { const v = nonNull(args); return v.length ? Math.max(...v.map(num)) : null; },
  min: args => { const v = nonNull(args); return v.length ? Math.min(...v.map(num)) : null; },
  mod: ([a, b]) => {
    if (isNullish(a) || isNullish(b)) return null;
    const d = num(b);
    if (d === 0) throw new ScriptError('Mod() by zero');
    return num(a) % d;
  },
  round: ([a, d]) => {
    if (isNullish(a)) return null;
    const p = Math.min(12, Math.max(0, Math.trunc(num(d ?? 0))));
    const f = 10 ** p;
    return Math.sign(num(a)) * Math.round(Math.abs(num(a)) * f + 1e-9) / f;
  },
  sum: args => { const v = nonNull(args); return v.length ? v.reduce((s, x) => s + num(x), 0) : null; },

  // dates
  date: (_, ctx) => { const n = ctx.dom.now; return dateNumber(n.getFullYear(), n.getMonth() + 1, n.getDate()); },
  num2date: (args, ctx) => {
    const [n, fmt] = args;
    if (isNullish(n)) return null;
    if (num(n) < 1) return '';
    const { y, m, d } = fromDateNumber(num(n));
    const locale = localeOf(args, 2, ctx);
    const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return formatPicture(`date{${dateFormat(fmt && str(fmt), locale, ctx)}}`, iso, { locale, locales: ctx.dom.locales });
  },
  date2num: (args, ctx) => {
    const [s, fmt] = args;
    if (isNullish(s)) return null;
    const v = parseDate(str(s), fmt ? str(fmt) : null, ctx.dom.locales[localeOf(args, 2, ctx)]);
    return v ? dateNumber(v.y, v.m, v.d) : 0;
  },
  isodate2num: ([s]) => {
    const v = parseDate(str(s), null);
    return v ? dateNumber(v.y, v.m, v.d) : 0;
  },
  datefmt: (args, ctx) => {
    const loc = ctx.dom.locales[localeOf(args, 1, ctx)];
    const style = ['med', 'short', 'med', 'long', 'full'][Math.trunc(num(args[0] ?? 0))] ?? 'med';
    return loc?.datePatterns?.[style] ?? 'MMM D, YYYY';
  },
  time: (_, ctx) => {
    const n = ctx.dom.now;
    return n.getHours() * 3600000 + n.getMinutes() * 60000 + n.getSeconds() * 1000 + n.getMilliseconds();
  },

  // logical
  choose: ([n, ...rest]) => { const i = Math.trunc(num(n)); return i >= 1 && i <= rest.length ? rest[i - 1] : ''; },
  hasvalue: ([a]) => (isNullish(a) || String(a).trim() === '' ? 0 : 1),
  oneof: ([a, ...rest]) => (rest.some(b => equal(a, b)) ? 1 : 0),
  within: ([a, lo, hi]) => {
    if (isNullish(a)) return null;
    if (typeof a === 'string' && typeof lo === 'string' && typeof hi === 'string') return a >= lo && a <= hi ? 1 : 0;
    return num(a) >= num(lo) && num(a) <= num(hi) ? 1 : 0;
  },
  null: () => null,

  // strings
  at: ([a, b]) => { const s = str(a); const t = str(b); return t === '' ? 1 : s.indexOf(t) + 1; },
  concat: args => args.map(str).join(''),
  left: ([s, n]) => (isNullish(s) ? null : str(s).slice(0, Math.max(0, Math.trunc(num(n))))),
  len: ([s]) => str(s).length,
  lower: ([s]) => (isNullish(s) ? null : str(s).toLowerCase()),
  ltrim: ([s]) => (isNullish(s) ? null : str(s).replace(/^\s+/, '')),
  replace: ([s, a, b]) => (isNullish(s) ? null : str(s).split(str(a)).join(str(b ?? ''))),
  right: ([s, n]) => { if (isNullish(s)) return null; const t = str(s); const k = Math.max(0, Math.trunc(num(n))); return k ? t.slice(-k) : ''; },
  rtrim: ([s]) => (isNullish(s) ? null : str(s).replace(/\s+$/, '')),
  space: ([n]) => ' '.repeat(Math.max(0, Math.trunc(num(n)))),
  str: ([n, w, d]) => {
    if (isNullish(n)) return null;
    const width = isNullish(w) ? 10 : Math.trunc(num(w));
    const digits = isNullish(d) ? 0 : Math.max(0, Math.min(15, Math.trunc(num(d))));
    const s = num(n).toFixed(digits);
    return s.length > width ? '*'.repeat(width) : s.padStart(width, ' ');
  },
  stuff: ([s, start, n, ins]) => {
    if (isNullish(s)) return null;
    const t = str(s);
    const i = Math.max(0, Math.trunc(num(start)) - 1);
    return t.slice(0, i) + str(ins ?? '') + t.slice(i + Math.max(0, Math.trunc(num(n))));
  },
  substr: ([s, start, n]) => {
    if (isNullish(s)) return null;
    const i = Math.max(0, Math.trunc(num(start)) - 1);
    return str(s).substr(i, Math.max(0, Math.trunc(num(n))));
  },
  upper: ([s]) => (isNullish(s) ? null : str(s).toUpperCase()),
  format: ([pic, v], ctx) => formatPicture(str(pic), isNullish(v) ? null : str(v), { locale: ctx.dom.localeOf(ctx.self.inst ?? {}), locales: ctx.dom.locales }),
};

// A date string: canonical (YYYY-MM-DD, YYYYMMDD) or by a simple picture
// of D, DD, M, MM, MMM, MMMM, YY, YYYY and literals
function parseDate(s, fmt, loc) {
  const iso = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s.trim());
  if (!fmt) return iso ? { y: +iso[1], m: +iso[2], d: +iso[3] } : null;
  const re = [];
  const groups = [];
  const toks = fmt.match(/(Y+|M+|D+|'[^']*'|.)/g) ?? [];
  for (const t of toks) {
    if (/^Y+$/.test(t)) { re.push(t.length === 2 ? '(\\d{2})' : '(\\d{4})'); groups.push('Y' + t.length); }
    else if (t === 'MMMM' || t === 'MMM') {
      const names = (t === 'MMMM' ? loc?.months : loc?.monthsAbbr) ?? [];
      re.push(`(${names.map(escapeRe).join('|') || '[^\\s]+'})`);
      groups.push(t);
    } else if (/^M+$/.test(t)) { re.push(t.length === 1 ? '(\\d{1,2})' : '(\\d{2})'); groups.push('M'); }
    else if (/^D+$/.test(t)) { re.push(t.length === 1 ? '(\\d{1,2})' : '(\\d{2})'); groups.push('D'); }
    else if (t.startsWith("'")) re.push(escapeRe(t.slice(1, -1)));
    else re.push(escapeRe(t));
  }
  const m = new RegExp(`^${re.join('')}$`, 'i').exec(s.trim());
  if (!m) return null;
  const v = { y: 1900, m: 1, d: 1 };
  groups.forEach((g, i) => {
    const x = m[i + 1];
    if (g === 'Y4') v.y = +x;
    else if (g === 'Y2') v.y = +x < 30 ? 2000 + +x : 1900 + +x;
    else if (g === 'M') v.m = +x;
    else if (g === 'MMMM' || g === 'MMM') {
      const names = (g === 'MMMM' ? loc?.months : loc?.monthsAbbr) ?? [];
      v.m = names.findIndex(n => n.toLowerCase() === x.toLowerCase()) + 1;
    } else if (g === 'D') v.d = +x;
  });
  return v.m >= 1 ? v : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
