/**
 * Purefield / xfa / script / js.js
 *
 * An interpreter for the JavaScript that XFA forms run in Acrobat (ES3/ES5:
 * var, function, closures, if/for/for-in/while/do/switch, try/catch/throw,
 * object and array literals, new, regular expressions), on the object model
 * in dom.js.
 *
 * Form code is untrusted, so it is never handed to the host engine (no eval,
 * no Function): it is parsed and walked here, and every member access goes
 * through getMember/setMember, which expose only an allow-list of string,
 * number, array, date and regexp methods, plain objects the script made
 * itself (null-prototype, so constructor and __proto__ lead nowhere), and
 * the XFA object model. A step budget and a call-depth limit stop runaway
 * scripts.
 *
 * Names resolve as in Acrobat: local variables, then the document's globals
 * (built-ins and undeclared assignments, shared by all scripts), then SOM
 * scoping from the object the script belongs to (dom.lookup), which also
 * finds script objects (<variables><script name="…">): a script object is
 * run once, on first use, and its top-level variables and functions are its
 * properties.
 */

import { ScriptError, NodeList, toText, Manifest } from './dom.js';

const MAX_STEPS = 2_000_000;
const MAX_DEPTH = 200;

/** A JavaScript exception thrown by form code (catchable by form code) */
class JsThrow {
  constructor(value) { this.value = value; }
}
// Not catchable by form code: the step budget, call depth
class Fatal extends ScriptError {}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'if', 'else', 'for', 'in', 'while', 'do', 'return', 'break',
  'continue', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw', 'new', 'delete',
  'typeof', 'instanceof', 'void', 'this', 'null', 'true', 'false', 'with',
]);

const PUNCT = [
  '>>>=', '===', '!==', '>>>', '<<=', '>>=',
  '<=', '>=', '==', '!=', '++', '--', '<<', '>>', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.',
];

// tokens after which "/" is division rather than a regular expression
function divisionAfter(t) {
  if (!t) return false;
  if (t.type === 'num' || t.type === 'str' || t.type === 'id' || t.type === 'regex') return true;
  if (t.type === 'kw') return ['this', 'null', 'true', 'false'].includes(t.value);
  return t.type === 'p' && (t.value === ')' || t.value === ']' || t.value === '}');
}

function tokenize(src) {
  const toks = [];
  let i = 0, line = 1, nl = false;
  const push = (type, value, extra) => { toks.push({ type, value, line, nl, ...extra }); nl = false; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n' || ch === ' ' || ch === ' ') { line++; nl = true; i++; continue; }
    if (/\s/.test(ch) || ch === '﻿') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end);
      const lines = body.split('\n').length - 1;
      if (lines) { line += lines; nl = true; }
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let s = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length || src[j] === '\n') throw new ScriptError(`Unterminated string on line ${line}`);
        const c = src[j];
        if (c === ch) { j++; break; }
        if (c === '\\') {
          const e = src[j + 1];
          j += 2;
          switch (e) {
            case 'n': s += '\n'; break;
            case 't': s += '\t'; break;
            case 'r': s += '\r'; break;
            case 'b': s += '\b'; break;
            case 'f': s += '\f'; break;
            case 'v': s += '\v'; break;
            case '0': s += '\0'; break;
            case 'x': s += String.fromCharCode(parseInt(src.slice(j, j + 2), 16)); j += 2; break;
            case 'u': s += String.fromCharCode(parseInt(src.slice(j, j + 4), 16)); j += 4; break;
            case '\r': if (src[j] === '\n') j++; break;
            case '\n': line++; break;
            default: s += e;
          }
          continue;
        }
        s += c;
        j++;
      }
      i = j;
      push('str', s);
      continue;
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (num && (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] ?? '')))) {
      push('num', Number(num[0]));
      i += num[0].length;
      continue;
    }
    // E4X attribute access (node.@style): parsed as a property named "@style"
    // so the rest of the script loads; XML objects themselves are not modelled
    if (ch === '@' && toks.length && toks[toks.length - 1].value === '.' && /[\p{L}_$]/u.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < src.length && /[\p{L}\p{N}_$]/u.test(src[j])) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[\p{L}_$]/u.test(ch) || ch === '\\') {
      let j = i;
      while (j < src.length && /[\p{L}\p{N}_$‌‍]/u.test(src[j])) j++;
      if (j === i) throw new ScriptError(`Unexpected character "${ch}" on line ${line}`);
      const word = src.slice(i, j);
      i = j;
      push(KEYWORDS.has(word) ? 'kw' : 'id', word);
      continue;
    }
    if (ch === '/' && !divisionAfter(toks[toks.length - 1])) {
      let j = i + 1, cls = false;
      for (;;) {
        if (j >= src.length || src[j] === '\n') throw new ScriptError(`Unterminated regular expression on line ${line}`);
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') cls = true;
        else if (c === ']') cls = false;
        else if (c === '/' && !cls) break;
        j++;
      }
      const body = src.slice(i + 1, j);
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k])) k++;
      const flags = src.slice(j + 1, k);
      i = k;
      push('regex', body, { flags });
      continue;
    }
    const p = PUNCT.find(q => src.startsWith(q, i));
    if (!p) throw new ScriptError(`Unexpected character "${ch}" on line ${line}`);
    push('p', p);
    i += p.length;
  }
  push('eof', null);
  return toks;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const BINARY = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, instanceof: 7, in: 7,
  '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=']);

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  peek(o = 0) { return this.toks[this.i + o]; }
  next() { return this.toks[this.i++]; }
  is(v, o = 0) { const t = this.peek(o); return (t.type === 'p' || t.type === 'kw') && t.value === v; }
  eat(v) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v) {
    const t = this.next();
    if ((t.type !== 'p' && t.type !== 'kw') || t.value !== v) throw this.error(t, `Expected "${v}"`);
    return t;
  }
  error(t, msg) {
    return new ScriptError(`${msg} on line ${t.line}, found "${t.type === 'eof' ? 'end of script' : t.value}"`);
  }
  ident() {
    const t = this.next();
    if (t.type !== 'id') throw this.error(t, 'Expected a name');
    return t.value;
  }
  // automatic semicolon insertion
  semicolon() {
    if (this.eat(';')) return;
    const t = this.peek();
    if (t.type === 'eof' || this.is('}') || t.nl) return;
    throw this.error(t, 'Expected ";"');
  }

  program() {
    const body = [];
    while (this.peek().type !== 'eof') body.push(this.statement());
    return { t: 'program', body };
  }

  statement() {
    const t = this.peek();
    if (t.type === 'p') {
      if (t.value === '{') return this.block();
      if (t.value === ';') { this.next(); return { t: 'empty' }; }
    }
    if (t.type === 'kw') {
      switch (t.value) {
        case 'var': case 'let': case 'const': {
          this.next();
          const s = this.varDecls(false);
          this.semicolon();
          return s;
        }
        case 'function': {
          this.next();
          const name = this.ident();
          return { t: 'fundecl', name, fn: this.functionRest(name) };
        }
        case 'if': {
          this.next();
          this.expect('(');
          const test = this.expression();
          this.expect(')');
          const then = this.statement();
          const otherwise = this.eat('else') ? this.statement() : null;
          return { t: 'if', test, then, otherwise };
        }
        case 'for': return this.forStatement();
        case 'while': {
          this.next();
          this.expect('(');
          const test = this.expression();
          this.expect(')');
          return { t: 'while', test, body: this.statement() };
        }
        case 'do': {
          this.next();
          const body = this.statement();
          this.expect('while');
          this.expect('(');
          const test = this.expression();
          this.expect(')');
          this.eat(';');
          return { t: 'dowhile', test, body };
        }
        case 'return': {
          this.next();
          const n = this.peek();
          const arg = n.nl || n.type === 'eof' || this.is(';') || this.is('}') ? null : this.expression();
          this.semicolon();
          return { t: 'return', arg };
        }
        case 'break': case 'continue': {
          this.next();
          const n = this.peek();
          if (n.type === 'id' && !n.nl) throw new ScriptError(`Labels are not supported (line ${n.line})`);
          this.semicolon();
          return { t: t.value };
        }
        case 'throw': {
          this.next();
          const arg = this.expression();
          this.semicolon();
          return { t: 'throw', arg };
        }
        case 'try': {
          this.next();
          const block = this.block();
          let param = null, handler = null, finalizer = null;
          if (this.eat('catch')) {
            this.expect('(');
            param = this.ident();
            this.expect(')');
            handler = this.block();
          }
          if (this.eat('finally')) finalizer = this.block();
          if (!handler && !finalizer) throw this.error(this.peek(), 'Expected catch or finally');
          return { t: 'try', block, param, handler, finalizer };
        }
        case 'switch': {
          this.next();
          this.expect('(');
          const disc = this.expression();
          this.expect(')');
          this.expect('{');
          const cases = [];
          while (!this.eat('}')) {
            let test = null;
            if (this.eat('default')) test = null;
            else { this.expect('case'); test = this.expression(); }
            this.expect(':');
            const body = [];
            while (!this.is('case') && !this.is('default') && !this.is('}')) body.push(this.statement());
            cases.push({ test, body });
          }
          return { t: 'switch', disc, cases };
        }
        case 'with': throw new ScriptError(`"with" is not supported (line ${t.line})`);
      }
    }
    if (t.type === 'id' && this.is(':', 1)) throw new ScriptError(`Labels are not supported (line ${t.line})`);
    const expr = this.expression();
    this.semicolon();
    return { t: 'expr', expr };
  }

  block() {
    this.expect('{');
    const body = [];
    while (!this.eat('}')) {
      if (this.peek().type === 'eof') throw this.error(this.peek(), 'Expected "}"');
      body.push(this.statement());
    }
    return { t: 'block', body };
  }

  varDecls(noIn) {
    const decls = [];
    do {
      const name = this.ident();
      const init = this.eat('=') ? this.assignment(noIn) : null;
      decls.push({ name, init });
    } while (this.eat(','));
    return { t: 'var', decls };
  }

  forStatement() {
    this.expect('for');
    this.expect('(');
    let init = null;
    if (this.is('var') || this.is('let') || this.is('const')) {
      this.next();
      init = this.varDecls(true);
      if (init.decls.length === 1 && this.eat('in')) {
        const right = this.expression();
        this.expect(')');
        return { t: 'forin', decl: init.decls[0].name, left: null, right, body: this.statement() };
      }
    } else if (!this.is(';')) {
      const expr = this.expression(true);
      if (this.eat('in')) {
        const right = this.expression();
        this.expect(')');
        return { t: 'forin', decl: null, left: expr, right, body: this.statement() };
      }
      init = { t: 'expr', expr };
    }
    this.expect(';');
    const test = this.is(';') ? null : this.expression();
    this.expect(';');
    const update = this.is(')') ? null : this.expression();
    this.expect(')');
    return { t: 'for', init, test, update, body: this.statement() };
  }

  functionRest(name) {
    this.expect('(');
    const params = [];
    if (!this.is(')')) {
      do params.push(this.ident()); while (this.eat(','));
    }
    this.expect(')');
    const body = this.block().body;
    return { name, params, body, hoisted: hoist(body) };
  }

  expression(noIn = false) {
    const e = this.assignment(noIn);
    if (!this.is(',')) return e;
    const list = [e];
    while (this.eat(',')) list.push(this.assignment(noIn));
    return { t: 'seq', list };
  }

  assignment(noIn) {
    const left = this.conditional(noIn);
    const t = this.peek();
    if (t.type === 'p' && ASSIGN.has(t.value)) {
      if (left.t !== 'id' && left.t !== 'member') throw this.error(t, 'Invalid assignment target');
      this.next();
      return { t: 'assign', op: t.value, target: left, value: this.assignment(noIn) };
    }
    return left;
  }

  conditional(noIn) {
    const test = this.binary(0, noIn);
    if (!this.eat('?')) return test;
    const then = this.assignment(false);
    this.expect(':');
    return { t: 'cond', test, then, otherwise: this.assignment(noIn) };
  }

  binary(minPrec, noIn) {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const op = t.value;
      const prec = (t.type === 'p' || t.type === 'kw') ? BINARY[op] : undefined;
      if (prec === undefined || prec <= minPrec || (noIn && op === 'in')) return left;
      this.next();
      const right = this.binary(prec, noIn);
      left = op === '&&' || op === '||' ? { t: 'logical', op, left, right } : { t: 'bin', op, left, right };
    }
  }

  unary() {
    const t = this.peek();
    if ((t.type === 'p' && ['!', '~', '+', '-', '++', '--'].includes(t.value)) || (t.type === 'kw' && ['typeof', 'void', 'delete'].includes(t.value))) {
      this.next();
      const arg = this.unary();
      if (t.value === '++' || t.value === '--') {
        if (arg.t !== 'id' && arg.t !== 'member') throw this.error(t, 'Invalid update target');
        return { t: 'update', op: t.value, prefix: true, arg };
      }
      return { t: 'unary', op: t.value, arg };
    }
    return this.postfix();
  }

  postfix() {
    const e = this.callMember();
    const t = this.peek();
    if (t.type === 'p' && (t.value === '++' || t.value === '--') && !t.nl) {
      if (e.t !== 'id' && e.t !== 'member') throw this.error(t, 'Invalid update target');
      this.next();
      return { t: 'update', op: t.value, prefix: false, arg: e };
    }
    return e;
  }

  callMember() {
    let e;
    if (this.is('new')) {
      this.next();
      let callee = this.primary();
      for (;;) {
        if (this.eat('.')) { callee = { t: 'member', obj: callee, prop: { t: 'lit', v: this.propName() } }; continue; }
        if (this.is('[')) { this.next(); const prop = this.expression(); this.expect(']'); callee = { t: 'member', obj: callee, prop }; continue; }
        break;
      }
      const args = this.is('(') ? this.args() : [];
      e = { t: 'new', callee, args };
    } else {
      e = this.primary();
    }
    for (;;) {
      if (this.eat('.')) { e = { t: 'member', obj: e, prop: { t: 'lit', v: this.propName() } }; continue; }
      if (this.is('[')) { this.next(); const prop = this.expression(); this.expect(']'); e = { t: 'member', obj: e, prop }; continue; }
      if (this.is('(')) { e = { t: 'call', callee: e, args: this.args() }; continue; }
      return e;
    }
  }

  propName() {
    const t = this.next();
    if (t.type === 'id' || t.type === 'kw') return t.value;
    throw this.error(t, 'Expected a property name');
  }

  args() {
    this.expect('(');
    const out = [];
    if (this.eat(')')) return out;
    do out.push(this.assignment(false)); while (this.eat(','));
    this.expect(')');
    return out;
  }

  primary() {
    const t = this.next();
    switch (t.type) {
      case 'num': return { t: 'lit', v: t.value };
      case 'str': return { t: 'lit', v: t.value };
      case 'regex': return { t: 'regex', source: t.value, flags: t.flags };
      case 'id': return { t: 'id', name: t.value };
      case 'kw':
        switch (t.value) {
          case 'this': return { t: 'this' };
          case 'null': return { t: 'lit', v: null };
          case 'true': return { t: 'lit', v: true };
          case 'false': return { t: 'lit', v: false };
          case 'function': {
            const name = this.peek().type === 'id' ? this.next().value : null;
            return { t: 'func', fn: this.functionRest(name) };
          }
        }
        break;
      case 'p':
        if (t.value === '(') { const e = this.expression(); this.expect(')'); return e; }
        if (t.value === '[') {
          const items = [];
          while (!this.eat(']')) {
            if (this.is(',')) { this.next(); items.push(null); continue; }
            items.push(this.assignment(false));
            if (!this.is(']')) this.expect(',');
          }
          return { t: 'array', items };
        }
        if (t.value === '{') {
          const props = [];
          while (!this.eat('}')) {
            const k = this.next();
            let key;
            if (k.type === 'id' || k.type === 'kw' || k.type === 'str') key = String(k.value);
            else if (k.type === 'num') key = numberKey(k.value);
            else throw this.error(k, 'Expected a property name');
            this.expect(':');
            props.push({ key, value: this.assignment(false) });
            if (!this.is('}')) this.expect(',');
          }
          return { t: 'object', props };
        }
    }
    throw this.error(t, 'Unexpected token');
  }
}

// var names and function declarations of a body, not descending into functions
function hoist(body) {
  const vars = new Set();
  const funcs = [];
  const walk = s => {
    if (!s) return;
    switch (s.t) {
      case 'var': for (const d of s.decls) vars.add(d.name); break;
      case 'fundecl': funcs.push(s); break;
      case 'block': s.body.forEach(walk); break;
      case 'if': walk(s.then); walk(s.otherwise); break;
      case 'for': walk(s.init); walk(s.body); break;
      case 'forin': if (s.decl) vars.add(s.decl); walk(s.body); break;
      case 'while': case 'dowhile': walk(s.body); break;
      case 'try': walk(s.block); walk(s.handler); walk(s.finalizer); break;
      case 'switch': for (const c of s.cases) c.body.forEach(walk); break;
    }
  };
  body.forEach(walk);
  return { vars: [...vars], funcs };
}

const parsedCache = new Map();
export function parseJavaScript(src) {
  let ast = parsedCache.get(src);
  if (!ast) {
    ast = new Parser(tokenize(src)).program();
    ast.hoisted = hoist(ast.body);
    if (parsedCache.size > 500) parsedCache.clear();
    parsedCache.set(src, ast);
  }
  return ast;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

class Env {
  constructor(parent) { this.parent = parent; this.vars = new Map(); }
  lookup(name) {
    for (let e = this; e; e = e.parent) if (e.vars.has(name)) return e;
    return null;
  }
}

/** A function written in form code */
class Closure {
  constructor(fn, env, somScope, interp) {
    this.fn = fn;
    this.env = env;
    this.somScope = somScope;
    this.interp = interp;
    this.props = obj();
    this.props.prototype = withConstructor(obj(), this);
  }
}

/** A built-in: fn(thisArg, args, interp); construct(args, interp) for new */
class Native {
  constructor(name, fn, construct = null) {
    this.name = name;
    this.fn = fn;
    this.construct = construct;
    // Object.prototype and the like exist (scripts read and extend them);
    // they are plain script objects, unrelated to the host's prototypes
    this.props = obj(construct ? { prototype: withConstructor(obj(), this) } : undefined);
  }
}

/** A script object: its top-level variables and functions are its properties */
class ScriptObject {
  constructor(name, env, owner = null) { this.name = name; this.env = env; this.owner = owner; }
}

// f.prototype.constructor is f, and like JavaScript's it is not enumerable
function withConstructor(proto, f) {
  Object.defineProperty(proto, 'constructor', { value: f, writable: true, enumerable: false, configurable: true });
  return proto;
}

function obj(props) {
  const o = Object.create(null);
  if (props) Object.assign(o, props);
  return o;
}

const isPlain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null;
const isNodeLike = v => v !== null && typeof v === 'object' && typeof v.childrenByName === 'function';
const isCallable = v => v instanceof Closure || v instanceof Native;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function numberKey(n) { return String(n); }

function typeOf(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'object';
  if (isCallable(v)) return 'function';
  const t = typeof v;
  return t === 'object' ? 'object' : t;
}

function toPrimitive(v, hint) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return hint === 'number' ? v.getTime() : String(v);
  if (v instanceof RegExp) return String(v);
  if (Array.isArray(v)) return v.map(x => (x === null || x === undefined ? '' : toStr(x))).join(',');
  if (v instanceof Closure || v instanceof Native) return `function ${v.name ?? v.fn?.name ?? ''}() { [native code] }`;
  if (v instanceof ScriptObject) return '[object Object]';
  if (isNodeLike(v)) {
    // a field or data value used as a value is its value
    if (typeof v.scalar === 'function' && (v.className === 'field' || v.className === 'dataValue' || v.className === 'exclGroup' || v.className === 'draw')) {
      const s = v.scalar();
      return s === null ? (hint === 'number' ? 0 : '') : s;
    }
    return `[object ${v.className ?? 'Object'}]`;
  }
  if (isPlain(v)) {
    if (typeof v.message === 'string' && typeof v.name === 'string') return `${v.name}: ${v.message}`;
    return '[object Object]';
  }
  return '[object Object]';
}

function toStr(v) {
  const p = toPrimitive(v, 'string');
  if (typeof p === 'number') return String(p);
  return String(p);
}

function toNum(v) {
  const p = toPrimitive(v, 'number');
  return Number(p);
}

function toBool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'object') return true;
  return Boolean(v);
}

function propKey(v) {
  if (typeof v === 'number') return numberKey(v);
  return toStr(v);
}

function looseEqual(a, b) {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    // an empty XFA field reads as null in Acrobat; it is still not ""
    return false;
  }
  const ao = typeof a === 'object' || typeof a === 'function';
  const bo = typeof b === 'object' || typeof b === 'function';
  if (ao && bo) return false;
  const pa = ao ? toPrimitive(a) : a;
  const pb = bo ? toPrimitive(b) : b;
  // eslint-disable-next-line eqeqeq
  return pa == pb;
}

function jsError(name, message) {
  return new JsThrow(obj({ name, message: String(message) }));
}

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

function nativeMethods(table) {
  const out = obj();
  for (const [k, fn] of Object.entries(table)) out[k] = new Native(k, fn);
  return out;
}

function callback(interp, f) {
  if (!isCallable(f)) throw jsError('TypeError', 'callback is not a function');
  return (...args) => interp.call(f, undefined, args);
}

function regexArg(v) {
  return v instanceof RegExp ? v : toStr(v);
}

const STRING_METHODS = nativeMethods({
  charAt: (s, [i]) => s.charAt(toNum(i ?? 0) || 0),
  charCodeAt: (s, [i]) => s.charCodeAt(toNum(i ?? 0) || 0),
  indexOf: (s, [a, from]) => s.indexOf(toStr(a), toNum(from ?? 0) || 0),
  lastIndexOf: (s, [a, from]) => (from === undefined ? s.lastIndexOf(toStr(a)) : s.lastIndexOf(toStr(a), toNum(from))),
  substring: (s, [a, b]) => s.substring(toNum(a) || 0, b === undefined ? undefined : toNum(b) || 0),
  substr: (s, [a, b]) => s.substr(toNum(a) || 0, b === undefined ? undefined : toNum(b) || 0),
  slice: (s, [a, b]) => s.slice(toNum(a) || 0, b === undefined ? undefined : toNum(b) || 0),
  toUpperCase: s => s.toUpperCase(),
  toLowerCase: s => s.toLowerCase(),
  toLocaleUpperCase: s => s.toUpperCase(),
  toLocaleLowerCase: s => s.toLowerCase(),
  trim: s => s.trim(),
  split: (s, [sep, limit]) => (sep === undefined ? [s] : s.split(regexArg(sep), limit === undefined ? undefined : toNum(limit))),
  concat: (s, args) => s + args.map(toStr).join(''),
  replace: (s, [pat, rep], interp) => {
    const p = regexArg(pat);
    if (isCallable(rep)) {
      const f = callback(interp, rep);
      return s.replace(p, (...m) => toStr(f(...m.map(x => (typeof x === 'object' ? undefined : x)))));
    }
    return s.replace(p, toStr(rep));
  },
  match: (s, [pat]) => s.match(pat instanceof RegExp ? pat : new RegExp(toStr(pat))),
  search: (s, [pat]) => s.search(pat instanceof RegExp ? pat : new RegExp(toStr(pat))),
  localeCompare: (s, [b]) => (s < toStr(b) ? -1 : s > toStr(b) ? 1 : 0),
  toString: s => s,
  valueOf: s => s,
});

const NUMBER_METHODS = nativeMethods({
  toFixed: (n, [d]) => n.toFixed(Math.max(0, Math.min(20, toNum(d ?? 0) || 0))),
  toPrecision: (n, [d]) => (d === undefined ? String(n) : n.toPrecision(Math.max(1, Math.min(21, toNum(d))))),
  toString: (n, [radix]) => n.toString(radix === undefined ? 10 : Math.max(2, Math.min(36, toNum(radix)))),
  valueOf: n => n,
  toLocaleString: n => String(n),
});

const BOOLEAN_METHODS = nativeMethods({ toString: b => String(b), valueOf: b => b });

const ARRAY_METHODS = nativeMethods({
  push: (a, args) => { a.push(...args); return a.length; },
  pop: a => a.pop(),
  shift: a => a.shift(),
  unshift: (a, args) => a.unshift(...args),
  join: (a, [sep]) => a.map(x => (x === null || x === undefined ? '' : toStr(x))).join(sep === undefined ? ',' : toStr(sep)),
  slice: (a, [b, e]) => a.slice(b === undefined ? 0 : toNum(b), e === undefined ? undefined : toNum(e)),
  splice: (a, [b, n, ...items]) => a.splice(toNum(b), n === undefined ? a.length : toNum(n), ...items),
  concat: (a, args) => a.concat(...args.map(x => (Array.isArray(x) ? x : [x]))),
  reverse: a => a.reverse(),
  indexOf: (a, [x, from]) => a.indexOf(x, from === undefined ? 0 : toNum(from)),
  lastIndexOf: (a, [x]) => a.lastIndexOf(x),
  sort: (a, [cmp], interp) => {
    if (cmp === undefined) return a.sort((x, y) => { const s = toStr(x), t = toStr(y); return s < t ? -1 : s > t ? 1 : 0; });
    const f = callback(interp, cmp);
    return a.sort((x, y) => toNum(f(x, y)));
  },
  forEach: (a, [f], interp) => { const g = callback(interp, f); a.forEach((x, i) => g(x, i, a)); },
  map: (a, [f], interp) => { const g = callback(interp, f); return a.map((x, i) => g(x, i, a)); },
  filter: (a, [f], interp) => { const g = callback(interp, f); return a.filter((x, i) => toBool(g(x, i, a))); },
  some: (a, [f], interp) => { const g = callback(interp, f); return a.some((x, i) => toBool(g(x, i, a))); },
  every: (a, [f], interp) => { const g = callback(interp, f); return a.every((x, i) => toBool(g(x, i, a))); },
  toString: a => toPrimitive(a),
});

const DATE_METHODS = nativeMethods(Object.fromEntries([
  'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
  'getTime', 'valueOf', 'getTimezoneOffset', 'getYear', 'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay',
  'getUTCHours', 'getUTCMinutes', 'getUTCSeconds',
  'toString', 'toDateString', 'toTimeString', 'toLocaleDateString', 'toLocaleTimeString', 'toLocaleString', 'toUTCString', 'toISOString',
].map(m => [m, d => (m === 'getYear' ? d.getFullYear() - 1900 : d[m]())]).concat([
  'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds', 'setTime',
  'setUTCFullYear', 'setUTCMonth', 'setUTCDate', 'setUTCHours', 'setUTCMinutes', 'setUTCSeconds',
].map(m => [m, (d, args) => d[m](...args.map(toNum))]))));

const REGEXP_METHODS = nativeMethods({
  test: (r, [s]) => r.test(toStr(s)),
  exec: (r, [s]) => r.exec(toStr(s)),
  toString: r => String(r),
});

const OBJECT_METHODS = nativeMethods({
  hasOwnProperty: (o, [k]) => (isPlain(o) ? hasOwn(o, propKey(k)) : false),
  toString: o => toPrimitive(o),
  valueOf: o => o,
});

const FUNCTION_METHODS = nativeMethods({
  call: (f, [thisArg, ...args], interp) => interp.call(f, thisArg, args),
  apply: (f, [thisArg, args], interp) => interp.call(f, thisArg, Array.isArray(args) ? args : []),
  toString: f => toPrimitive(f),
});

// XFA object-model methods a script may call (dom.js decides what they do)
const NODE_METHODS = new Set([
  'resolveNode', 'resolveNodes', 'getAttribute', 'setAttribute', 'isPropertySpecified', 'getDisplayItem',
  'getSaveItem', 'boundItem', 'clearItems', 'addItem', 'execInitialize', 'execCalculate', 'execValidate',
  'execEvent', 'recalculate', 'remerge', 'relayout', 'item', 'append', 'namedItem', 'messageBox', 'beep',
  'setFocus', 'resetData', 'openList', 'exportData', 'gotoURL', 'print', 'importData', 'numPages',
  'page', 'pageCount', 'sheet', 'sheetCount', 'absPage', 'absPageCount', 'pageSpan',
  'relayoutPageArea', 'addInstance', 'removeInstance', 'setInstances', 'moveInstance', 'insertInstance',
  'setItems', 'deleteItem', 'getItemState', 'setItemState', 'clone', 'createNode', 'loadXML', 'saveXML',
  'applyXSL', 'assignNode', 'removeChild', 'appendChild', 'insert', 'remove', 'getElement', 'setElement',
  'getItemState', 'setItemState', 'deleteItem', 'setItems', 'selectedMember', 'evaluate', 'formNodes',
]);

function makeGlobals(interp) {
  const dom = interp.dom;
  const g = new Env(null);
  const set = (k, v) => g.vars.set(k, v);
  set('undefined', undefined);
  set('NaN', NaN);
  set('Infinity', Infinity);
  // the XFA object model, or (AcroForm scripts, acroscript.js) the host's event
  if (dom.xfa) { set('xfa', dom.xfa); set('event', dom.xfa.event); }
  else if (dom.event) set('event', dom.event);
  set('Math', obj({
    PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, SQRT2: Math.SQRT2,
    ...Object.fromEntries(['abs', 'ceil', 'floor', 'round', 'sqrt', 'pow', 'min', 'max', 'sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'asin', 'acos']
      .map(m => [m, new Native(m, (_, args) => Math[m](...args.map(toNum)))])),
    random: new Native('random', () => 0.5),
  }));
  const pf = (_, [s]) => parseFloat(toStr(s));
  set('parseFloat', new Native('parseFloat', pf));
  set('parseInt', new Native('parseInt', (_, [s, r]) => parseInt(toStr(s), r === undefined ? undefined : toNum(r))));
  set('isNaN', new Native('isNaN', (_, [v]) => Number.isNaN(toNum(v))));
  set('isFinite', new Native('isFinite', (_, [v]) => Number.isFinite(toNum(v))));
  set('encodeURIComponent', new Native('encodeURIComponent', (_, [s]) => encodeURIComponent(toStr(s))));
  set('decodeURIComponent', new Native('decodeURIComponent', (_, [s]) => decodeURIComponent(toStr(s))));
  set('escape', new Native('escape', (_, [s]) => encodeURIComponent(toStr(s))));
  set('unescape', new Native('unescape', (_, [s]) => decodeURIComponent(toStr(s))));
  set('String', new Native('String', (_, args) => (args.length ? toStr(args[0]) : ''), args => (args.length ? toStr(args[0]) : '')));
  g.vars.get('String').props.fromCharCode = new Native('fromCharCode', (_, args) => String.fromCharCode(...args.map(toNum)));
  set('Number', new Native('Number', (_, args) => (args.length ? toNum(args[0]) : 0), args => (args.length ? toNum(args[0]) : 0)));
  set('Boolean', new Native('Boolean', (_, [v]) => toBool(v), ([v]) => toBool(v)));
  const makeArray = args => (args.length === 1 && typeof args[0] === 'number' ? new Array(args[0]).fill(undefined) : [...args]);
  set('Array', new Native('Array', (_, args) => makeArray(args), makeArray));
  set('Object', new Native('Object', () => obj(), () => obj()));
  const makeRegExp = ([p, f]) => {
    try { return new RegExp(p instanceof RegExp ? p.source : toStr(p ?? ''), f === undefined ? '' : toStr(f)); }
    catch (e) { throw jsError('SyntaxError', e.message); }
  };
  set('RegExp', new Native('RegExp', (_, args) => makeRegExp(args), makeRegExp));
  for (const name of ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']) {
    const make = ([m]) => obj({ name, message: m === undefined ? '' : toStr(m) });
    set(name, new Native(name, (_, args) => make(args), make));
  }
  const makeDate = args => {
    if (args.length === 0) return new Date(dom.now.getTime());
    if (args.length === 1) {
      const a = args[0];
      if (a instanceof Date) return new Date(a.getTime());
      return typeof a === 'number' ? new Date(a) : new Date(toStr(a));
    }
    const n = args.map(toNum);
    return new Date(n[0], n[1], n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0, n[6] ?? 0);
  };
  const DateFn = new Native('Date', () => String(new Date(dom.now.getTime())), makeDate);
  DateFn.props.now = new Native('now', () => dom.now.getTime());
  DateFn.props.parse = new Native('parse', (_, [s]) => Date.parse(toStr(s)));
  DateFn.props.UTC = new Native('UTC', (_, args) => Date.UTC(...args.map(toNum)));
  set('Date', DateFn);
  // Acrobat's app, util and console, as far as a print needs them
  set('app', obj({
    viewerVersion: 11, viewerType: 'Reader', viewerVariation: 'Reader', platform: 'WIN', language: 'ENU',
    formsVersion: 11, calculate: true, runtimeHighlight: false,
    alert: new Native('alert', () => 1),
    beep: new Native('beep', () => undefined),
    response: new Native('response', () => null),
    setTimeOut: new Native('setTimeOut', () => obj()),
    setInterval: new Native('setInterval', () => obj()),
    clearTimeOut: new Native('clearTimeOut', () => undefined),
    clearInterval: new Native('clearInterval', () => undefined),
    launchURL: new Native('launchURL', () => undefined),
    execMenuItem: new Native('execMenuItem', () => undefined),
  }));
  set('zoomtype', obj({ none: 'NoVary', fitP: 'FitPage', fitW: 'FitWidth', fitH: 'FitHeight', fitV: 'FitVisibleWidth', pref: 'Preferred', refW: 'ReflowWidth' }));
  set('console', obj({
    println: new Native('println', () => undefined),
    show: new Native('show', () => undefined),
    clear: new Native('clear', () => undefined),
    log: new Native('log', () => undefined),
  }));
  set('util', obj({
    printd: new Native('printd', (_, [fmt, d]) => (d instanceof Date ? printd(toStr(fmt), d) : '')),
    printf: new Native('printf', (_, [fmt, ...args]) => {
      let k = 0;
      return toStr(fmt).replace(/%(?:[,+ 0#]*\d*(?:\.(\d+))?)([dfsx%])/g, (m, prec, c) => {
        if (c === '%') return '%';
        const v = args[k++];
        if (c === 'd') return String(Math.trunc(toNum(v)));
        if (c === 'f') return toNum(v).toFixed(prec === undefined ? 6 : +prec);
        if (c === 'x') return Math.trunc(toNum(v)).toString(16);
        return toStr(v);
      });
    }),
  }));
  // a host's own globals (AcroForm: app, util, color, AF functions…)
  dom.extendGlobals?.((k, v) => g.vars.set(k, v));
  return g;
}

// util.printd: the date tokens Acrobat documents (yyyy, yy, mmmm, mmm, mm, m, dd, d, HH, H, MM, M, ss, s)
function printd(fmt, d) {
  if (/^\d$/.test(fmt)) fmt = ['D:yyyymmddHHMMss', 'yyyy.mm.dd HH:MM:ss', 'yyyy/mm/dd HH:MM:ss'][+fmt] ?? fmt;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = n => String(n).padStart(2, '0');
  return fmt.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|HH|H|hh|h|MM|M|ss|s|tt/g, t => {
    switch (t) {
      case 'yyyy': return String(d.getFullYear());
      case 'yy': return pad(d.getFullYear() % 100);
      case 'mmmm': return months[d.getMonth()];
      case 'mmm': return months[d.getMonth()].slice(0, 3);
      case 'mm': return pad(d.getMonth() + 1);
      case 'm': return String(d.getMonth() + 1);
      case 'dddd': return days[d.getDay()];
      case 'ddd': return days[d.getDay()].slice(0, 3);
      case 'dd': return pad(d.getDate());
      case 'd': return String(d.getDate());
      case 'HH': return pad(d.getHours());
      case 'H': return String(d.getHours());
      case 'hh': return pad(d.getHours() % 12 || 12);
      case 'h': return String(d.getHours() % 12 || 12);
      case 'MM': return pad(d.getMinutes());
      case 'M': return String(d.getMinutes());
      case 'ss': return pad(d.getSeconds());
      case 's': return String(d.getSeconds());
      case 'tt': return d.getHours() < 12 ? 'am' : 'pm';
    }
    return t;
  });
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

class BreakSignal {}
class ContinueSignal {}
class ReturnSignal { constructor(v) { this.value = v; } }

class Interpreter {
  constructor(dom, objects) {
    this.dom = dom;
    this.objects = objects;
    this.steps = 0;
    this.depth = 0;
    // properties scripts set on XFA objects that are not XFA properties
    // (form1.hidePagesExcept = function …): kept per object, as Acrobat's
    // JavaScript wrappers keep them
    this.expandos = new Map();
    this.globals = makeGlobals(this);
  }

  tick() {
    if (++this.steps > MAX_STEPS) throw new Fatal('Script ran too long');
  }

  /** Run a program in a fresh scope below the globals; its completion value */
  runProgram(ast, thisValue, somScope, env = new Env(this.globals)) {
    this.hoistInto(ast.hoisted, env, somScope);
    const ctx = { thisValue, somScope };
    let completion;
    for (const s of ast.body) {
      const v = this.exec(s, env, ctx);
      if (v !== EMPTY) completion = v;
    }
    return completion;
  }

  hoistInto(hoisted, env, somScope) {
    for (const v of hoisted.vars) if (!env.vars.has(v)) env.vars.set(v, undefined);
    for (const f of hoisted.funcs) env.vars.set(f.name, new Closure(f.fn, env, somScope, this));
  }

  call(f, thisArg, args) {
    this.tick();
    if (f instanceof Native) {
      try {
        return f.fn(thisArg, args, this);
      } catch (e) {
        if (e instanceof JsThrow || e instanceof ScriptError || e instanceof BreakSignal) throw e;
        if (e instanceof RangeError && /call stack/i.test(e.message)) throw new Fatal('Script recursed too deeply');
        throw jsError('Error', e.message);
      }
    }
    if (!(f instanceof Closure)) throw jsError('TypeError', `${typeOf(f)} is not a function`);
    if (++this.depth > MAX_DEPTH) { this.depth--; throw new Fatal('Script recursed too deeply'); }
    try {
      const fn = f.fn;
      const env = new Env(f.env);
      fn.params.forEach((p, i) => env.vars.set(p, args[i]));
      if (!fn.params.includes('arguments')) env.vars.set('arguments', [...args]);
      if (fn.name && !env.vars.has(fn.name)) env.vars.set(fn.name, f);
      this.hoistInto(fn.hoisted, env, f.somScope);
      // a plain call's this is the global object, which in Acrobat's XFA
      // context answers for the object the script belongs to (hmrc-iform
      // helpers call this.resolveNodes)
      const ctx = { thisValue: thisArg === undefined || thisArg === null ? f.somScope : thisArg, somScope: f.somScope };
      const savedArgs = f.activeArgs;
      f.activeArgs = env.vars.get('arguments') ?? [...args];
      try {
        for (const s of fn.body) this.exec(s, env, ctx);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        throw e;
      } finally {
        f.activeArgs = savedArgs;
      }
      return undefined;
    } finally {
      this.depth--;
    }
  }

  construct(f, args) {
    if (f instanceof Native) {
      if (!f.construct) throw jsError('TypeError', `${f.name} is not a constructor`);
      return f.construct(args, this);
    }
    if (!(f instanceof Closure)) throw jsError('TypeError', `${typeOf(f)} is not a constructor`);
    // a prototype that itself inherits (Sub.prototype = new F()) keeps its chain
    const p = f.props.prototype;
    const proto = p !== null && typeof p === 'object' && (isPlain(p) || isPlainChain(p)) ? p : null;
    const o = Object.create(proto);
    const r = this.call(f, o, args);
    return r !== null && typeof r === 'object' ? r : o;
  }

  // --- statements --------------------------------------------------------

  exec(s, env, ctx) {
    this.tick();
    switch (s.t) {
      case 'expr': return this.eval(s.expr, env, ctx);
      case 'var':
        for (const d of s.decls) {
          if (d.init) {
            const v = this.eval(d.init, env, ctx);
            const scope = env.lookup(d.name) ?? env;
            scope.vars.set(d.name, v);
          }
        }
        return EMPTY;
      case 'fundecl': return EMPTY;
      case 'empty': return EMPTY;
      case 'block': {
        let c = EMPTY;
        for (const x of s.body) { const v = this.exec(x, env, ctx); if (v !== EMPTY) c = v; }
        return c;
      }
      case 'if':
        if (toBool(this.eval(s.test, env, ctx))) return this.exec(s.then, env, ctx);
        return s.otherwise ? this.exec(s.otherwise, env, ctx) : EMPTY;
      case 'while': {
        let c = EMPTY;
        while (toBool(this.eval(s.test, env, ctx))) {
          try { const v = this.exec(s.body, env, ctx); if (v !== EMPTY) c = v; }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return c;
      }
      case 'dowhile': {
        let c = EMPTY;
        do {
          try { const v = this.exec(s.body, env, ctx); if (v !== EMPTY) c = v; }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        } while (toBool(this.eval(s.test, env, ctx)));
        return c;
      }
      case 'for': {
        if (s.init) this.exec(s.init, env, ctx);
        let c = EMPTY;
        for (;;) {
          if (s.test && !toBool(this.eval(s.test, env, ctx))) break;
          try { const v = this.exec(s.body, env, ctx); if (v !== EMPTY) c = v; }
          catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
          if (s.update) this.eval(s.update, env, ctx);
        }
        return c;
      }
      case 'forin': {
        const target = this.eval(s.right, env, ctx);
        let c = EMPTY;
        for (const key of enumerate(target)) {
          if (s.decl) (env.lookup(s.decl) ?? env).vars.set(s.decl, key);
          else this.assignTo(s.left, key, env, ctx);
          try { const v = this.exec(s.body, env, ctx); if (v !== EMPTY) c = v; }
          catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return c;
      }
      case 'return': throw new ReturnSignal(s.arg ? this.eval(s.arg, env, ctx) : undefined);
      case 'break': throw new BreakSignal();
      case 'continue': throw new ContinueSignal();
      case 'throw': throw new JsThrow(this.eval(s.arg, env, ctx));
      case 'try': {
        let c = EMPTY;
        try {
          c = this.exec(s.block, env, ctx);
        } catch (e) {
          if (!s.handler) throw e;
          let value;
          if (e instanceof JsThrow) value = e.value;
          else if (e instanceof ScriptError && !(e instanceof Fatal)) value = obj({ name: 'Error', message: e.message });
          else throw e;
          const inner = new Env(env);
          inner.vars.set(s.param, value);
          c = this.exec(s.handler, inner, ctx);
        } finally {
          if (s.finalizer) this.exec(s.finalizer, env, ctx);
        }
        return c;
      }
      case 'switch': {
        const d = this.eval(s.disc, env, ctx);
        let i = s.cases.findIndex(k => k.test && this.eval(k.test, env, ctx) === d);
        if (i < 0) i = s.cases.findIndex(k => !k.test);
        if (i < 0) return EMPTY;
        let c = EMPTY;
        try {
          for (; i < s.cases.length; i++) for (const x of s.cases[i].body) { const v = this.exec(x, env, ctx); if (v !== EMPTY) c = v; }
        } catch (e) { if (!(e instanceof BreakSignal)) throw e; }
        return c;
      }
    }
    throw new ScriptError(`Unsupported statement ${s.t}`);
  }

  // --- expressions -------------------------------------------------------

  eval(e, env, ctx) {
    this.tick();
    switch (e.t) {
      case 'lit': return e.v;
      case 'id': return this.lookup(e.name, env, ctx);
      case 'this': return ctx.thisValue;
      case 'regex':
        try { return new RegExp(e.source, e.flags); }
        catch (x) { throw jsError('SyntaxError', x.message); }
      case 'array': return e.items.map(x => (x ? this.eval(x, env, ctx) : undefined));
      case 'object': {
        const o = obj();
        for (const p of e.props) o[p.key] = this.eval(p.value, env, ctx);
        return o;
      }
      case 'func': {
        const c = new Closure(e.fn, env, ctx.somScope, this);
        if (e.fn.name) {
          const inner = new Env(env);
          inner.vars.set(e.fn.name, c);
          c.env = inner;
        }
        return c;
      }
      case 'seq': { let v; for (const x of e.list) v = this.eval(x, env, ctx); return v; }
      case 'cond': return toBool(this.eval(e.test, env, ctx)) ? this.eval(e.then, env, ctx) : this.eval(e.otherwise, env, ctx);
      case 'logical': {
        const l = this.eval(e.left, env, ctx);
        if (e.op === '&&') return toBool(l) ? this.eval(e.right, env, ctx) : l;
        return toBool(l) ? l : this.eval(e.right, env, ctx);
      }
      case 'bin': return binop(e.op, this.eval(e.left, env, ctx), this.eval(e.right, env, ctx));
      case 'unary': return this.unary(e, env, ctx);
      case 'update': {
        const old = toNum(this.eval(e.arg, env, ctx));
        const v = e.op === '++' ? old + 1 : old - 1;
        this.assignTo(e.arg, v, env, ctx);
        return e.prefix ? v : old;
      }
      case 'assign': {
        let v;
        if (e.op === '=') v = this.eval(e.value, env, ctx);
        else {
          const target = e.target.t === 'member' ? this.memberRef(e.target, env, ctx) : null;
          const cur = target ? this.getMember(target.obj, target.key) : this.eval(e.target, env, ctx);
          v = binop(e.op.slice(0, -1), cur, this.eval(e.value, env, ctx));
          if (target) { this.setMember(target.obj, target.key, v); return v; }
        }
        this.assignTo(e.target, v, env, ctx);
        return v;
      }
      case 'member': {
        const r = this.memberRef(e, env, ctx);
        return this.getMember(r.obj, r.key);
      }
      case 'call': {
        let thisArg, f;
        if (e.callee.t === 'member') {
          const r = this.memberRef(e.callee, env, ctx);
          thisArg = r.obj;
          f = this.getMember(r.obj, r.key);
          if (!isCallable(f)) throw jsError('TypeError', `${describe(r.obj)}.${r.key} is not a function`);
        } else {
          f = this.eval(e.callee, env, ctx);
          thisArg = undefined;
          if (!isCallable(f)) throw jsError('TypeError', `${describeExpr(e.callee)} is not a function`);
        }
        const args = e.args.map(a => this.eval(a, env, ctx));
        return this.call(f, thisArg, args);
      }
      case 'new': {
        const f = this.eval(e.callee, env, ctx);
        const args = e.args.map(a => this.eval(a, env, ctx));
        return this.construct(f, args);
      }
    }
    throw new ScriptError(`Unsupported expression ${e.t}`);
  }

  unary(e, env, ctx) {
    if (e.op === 'typeof') {
      if (e.arg.t === 'id') {
        const found = this.tryLookup(e.arg.name, env, ctx);
        return found.found ? typeOf(found.value) : 'undefined';
      }
      return typeOf(this.eval(e.arg, env, ctx));
    }
    if (e.op === 'delete') {
      if (e.arg.t !== 'member') return true;
      const r = this.memberRef(e.arg, env, ctx);
      if (isPlain(r.obj) && hasOwn(r.obj, r.key)) delete r.obj[r.key];
      return true;
    }
    const v = this.eval(e.arg, env, ctx);
    switch (e.op) {
      case '!': return !toBool(v);
      case '-': return -toNum(v);
      case '+': return toNum(v);
      case '~': return ~toNum(v);
      case 'void': return undefined;
    }
    throw new ScriptError(`Unsupported operator ${e.op}`);
  }

  memberRef(e, env, ctx) {
    const o = this.eval(e.obj, env, ctx);
    const key = propKey(this.eval(e.prop, env, ctx));
    if (o === null || o === undefined) {
      throw jsError('TypeError', `${e.obj.t === 'id' ? e.obj.name : describeExpr(e.obj)} is ${o === null ? 'null' : 'undefined'} (reading "${key}")`);
    }
    return { obj: o, key };
  }

  // --- names -------------------------------------------------------------

  tryLookup(name, env, ctx) {
    const scope = env.lookup(name);
    if (scope) return { found: true, value: scope.vars.get(name) };
    // SOM shortcuts are names in Acrobat's JavaScript too ($, $record, …)
    if (name[0] === '$') {
      const sc = this.dom.shortcut(name, name === '$' ? ctx.thisValue ?? ctx.somScope : ctx.somScope);
      if (sc !== undefined) return { found: true, value: sc };
    }
    const hits = this.dom.lookup(name, ctx.somScope);
    if (hits.length) return { found: true, value: hits[0] };
    return { found: false };
  }

  lookup(name, env, ctx) {
    const r = this.tryLookup(name, env, ctx);
    if (!r.found) throw jsError('ReferenceError', `${name} is not defined`);
    return r.value instanceof ScriptObjectRef ? r.value.resolve() : r.value;
  }

  assignTo(target, v, env, ctx) {
    if (target.t === 'id') {
      const scope = env.lookup(target.name);
      if (scope) { scope.vars.set(target.name, v); return; }
      // an XFA object by that name: Acrobat assigns its value (field = 5)
      const hits = this.dom.lookup(target.name, ctx.somScope);
      if (hits.length && typeof hits[0].assign === 'function' && !(hits[0] instanceof ScriptObjectRef)) {
        hits[0].assign(v === undefined ? null : toPrimitive(v, 'string'));
        return;
      }
      this.globals.vars.set(target.name, v);
      return;
    }
    if (target.t === 'member') {
      const r = this.memberRef(target, env, ctx);
      this.setMember(r.obj, r.key, v);
      return;
    }
    throw new ScriptError('Invalid assignment target');
  }

  // --- members: the only way form code reaches anything ------------------

  getMember(o, key) {
    if (o instanceof ScriptObjectRef) o = o.resolve();
    switch (typeof o) {
      case 'string':
        if (key === 'length') return o.length;
        if (/^\d+$/.test(key)) return o[Number(key)];
        return STRING_METHODS[key];
      case 'number': return NUMBER_METHODS[key];
      case 'boolean': return BOOLEAN_METHODS[key];
      case 'undefined': throw jsError('TypeError', `undefined has no property "${key}"`);
    }
    if (o === null) throw jsError('TypeError', `null has no property "${key}"`);
    if (Array.isArray(o)) {
      if (key === 'length') return o.length;
      if (/^\d+$/.test(key)) return o[Number(key)];
      return ARRAY_METHODS[key];
    }
    if (o instanceof Date) return DATE_METHODS[key];
    if (o instanceof RegExp) {
      if (['source', 'global', 'ignoreCase', 'multiline', 'lastIndex'].includes(key)) return o[key];
      return REGEXP_METHODS[key];
    }
    if (o instanceof Closure || o instanceof Native) {
      if (hasOwn(o.props, key)) return o.props[key];
      if (key === 'length') return o instanceof Closure ? o.fn.params.length : 0;
      // the old fn.arguments: the arguments of its running call, else null
      if (key === 'arguments') return o instanceof Closure ? (o.activeArgs ?? null) : null;
      if (key === 'name') return o instanceof Closure ? (o.fn.name ?? '') : o.name;
      return FUNCTION_METHODS[key];
    }
    if (o instanceof ScriptObject) {
      if (o.env.vars.has(key)) return o.env.vars.get(key);
      // a script object answers node methods for the subform that holds it
      // (hmrc-c1800-chief: this.resolveNode(…) inside AccessibilityTabs.Obj)
      if (o.owner && (NODE_METHODS.has(key) || key === 'name' || key === 'parent')) {
        if (key === 'name') return o.name;
        if (key === 'parent') return o.owner;
        return this.nodeMember(o.owner, key);
      }
      return undefined;
    }
    if (isPlain(o) || (o !== null && typeof o === 'object' && isPlainChain(o))) {
      for (let p = o; p; p = Object.getPrototypeOf(p)) if (hasOwn(p, key)) return p[key];
      return OBJECT_METHODS[key];
    }
    if (isNodeLike(o) || o instanceof NodeList) return this.nodeMember(o, key);
    return undefined;
  }

  nodeMember(o, key) {
    if (o instanceof NodeList) {
      if (key === 'length') return o.length;
      if (/^\d+$/.test(key)) return o.item(Number(key));
    }
    const own = this.expandos.get(o);
    if (own && hasOwn(own, key)) return own[key];
    // a host object may name methods of its own (layout's h, w, x, y)
    const method = NODE_METHODS.has(key) || o.methods?.has(key);
    const prop = method ? undefined : o.getProperty?.(key);
    if (prop !== undefined) return prop.value;
    const kids = o.childrenByName?.(key) ?? [];
    if (kids.length) return kids[0] instanceof ScriptObjectRef ? kids[0].resolve() : kids[0];
    if (method && typeof o.call === 'function') {
      return new Native(key, (self, args) => {
        const target = self !== null && typeof self === 'object' && typeof self.call === 'function' && isNodeLike(self) ? self : o;
        const r = target.call(key, args.map(a => (a instanceof ScriptObjectRef ? a.resolve() : a)));
        return r === undefined ? null : r;
      });
    }
    if (key === 'toString' || key === 'valueOf') return OBJECT_METHODS[key];
    return undefined;
  }

  setMember(o, key, v) {
    if (o instanceof ScriptObjectRef) o = o.resolve();
    if (o === null || o === undefined) throw jsError('TypeError', `Cannot set "${key}" of ${o}`);
    if (Array.isArray(o)) {
      if (key === 'length') { o.length = Math.max(0, Math.min(1e6, toNum(v) | 0)); return; }
      if (/^\d+$/.test(key) && Number(key) < 1e6) o[Number(key)] = v;
      return;
    }
    if (o instanceof Closure || o instanceof Native) { o.props[key] = v; return; }
    if (o instanceof ScriptObject) { o.env.vars.set(key, v); return; }
    if (isPlain(o) || (typeof o === 'object' && isPlainChain(o))) { o[key] = v; return; }
    if (o instanceof RegExp && key === 'lastIndex') { o.lastIndex = toNum(v); return; }
    // a host object that takes script values as they are (acroscript.js:
    // colour arrays, numbers)
    if (isNodeLike(o) && o.rawValues) {
      if (!o.setProperty(key, v)) {
        if (!this.expandos.has(o)) this.expandos.set(o, obj());
        this.expandos.get(o)[key] = v;
      }
      return;
    }
    if (isNodeLike(o) && typeof o.setProperty === 'function') {
      const value = v === undefined ? null : (v !== null && typeof v === 'object' && !isNodeLike(v)) ? toPrimitive(v, 'string') : v;
      if (o.getProperty?.(key) !== undefined || ['presence', 'relevant', 'rawValue', 'formattedValue'].includes(key)) {
        o.setProperty(key, isNodeLike(value) ? value.scalar?.() ?? null : value);
      } else {
        // not an XFA property: a script's own property on the object
        if (!this.expandos.has(o)) this.expandos.set(o, obj());
        this.expandos.get(o)[key] = v;
      }
      return;
    }
    // primitives, dates and the like: silently nothing, as in sloppy JavaScript
  }
}

// an object made by `new` on a form-code constructor: its chain ends at null
// (host objects' chains all pass through Object.prototype)
function isPlainChain(o) {
  let p = Object.getPrototypeOf(o);
  for (let n = 0; n < 100; n++) {
    if (p === null) return true;
    if (p === Object.prototype || typeof p !== 'object') return false;
    p = Object.getPrototypeOf(p);
  }
  return false;
}

const EMPTY = Symbol('empty');

function enumerate(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((_, i) => String(i));
  if (typeof v === 'string') return [...v].map((_, i) => String(i));
  if (v instanceof ScriptObject) return [...v.env.vars.keys()];
  if (isPlain(v) || (typeof v === 'object' && isPlainChain(v))) {
    const keys = [];
    for (const k in v) keys.push(k); // null-prototype chain: own and inherited script properties only
    return keys;
  }
  return [];
}

function binop(op, a, b) {
  switch (op) {
    case '+': {
      const pa = toPrimitive(a), pb = toPrimitive(b);
      if (typeof pa === 'string' || typeof pb === 'string') return toStr(pa) + toStr(pb);
      return Number(pa) + Number(pb);
    }
    case '-': return toNum(a) - toNum(b);
    case '*': return toNum(a) * toNum(b);
    case '/': return toNum(a) / toNum(b);
    case '%': return toNum(a) % toNum(b);
    case '<<': return toNum(a) << toNum(b);
    case '>>': return toNum(a) >> toNum(b);
    case '>>>': return toNum(a) >>> toNum(b);
    case '&': return toNum(a) & toNum(b);
    case '|': return toNum(a) | toNum(b);
    case '^': return toNum(a) ^ toNum(b);
    case '==': return looseEqual(a, b);
    case '!=': return !looseEqual(a, b);
    case '===': return a === b;
    case '!==': return a !== b;
    case '<': case '>': case '<=': case '>=': {
      const pa = toPrimitive(a, 'number'), pb = toPrimitive(b, 'number');
      const x = typeof pa === 'string' && typeof pb === 'string' ? pa : Number(pa);
      const y = typeof pa === 'string' && typeof pb === 'string' ? pb : Number(pb);
      return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
    }
    case 'instanceof': {
      if (b instanceof Closure) {
        const proto = b.props.prototype;
        if (a === null || typeof a !== 'object') return false;
        for (let p = Object.getPrototypeOf(a); p; p = Object.getPrototypeOf(p)) if (p === proto) return true;
        return false;
      }
      if (b instanceof Native) {
        switch (b.name) {
          case 'Date': return a instanceof Date;
          case 'Array': return Array.isArray(a);
          case 'RegExp': return a instanceof RegExp;
          case 'Object': return a !== null && typeof a === 'object';
          case 'Error': return isPlain(a) && typeof a.name === 'string' && typeof a.message === 'string';
          default: return isPlain(a) && a.name === b.name;
        }
      }
      throw jsError('TypeError', 'instanceof needs a function');
    }
    case 'in': {
      const key = propKey(a);
      if (Array.isArray(b)) return key === 'length' || (/^\d+$/.test(key) && Number(key) < b.length);
      if (b instanceof ScriptObject) return b.env.vars.has(key);
      if (isPlain(b) || (b !== null && typeof b === 'object' && isPlainChain(b))) {
        for (let p = b; p; p = Object.getPrototypeOf(p)) if (hasOwn(p, key)) return true;
        return false;
      }
      if (isNodeLike(b)) return b.getProperty?.(key) !== undefined || (b.childrenByName?.(key) ?? []).length > 0;
      throw jsError('TypeError', '"in" needs an object');
    }
  }
  throw new ScriptError(`Unsupported operator ${op}`);
}

function describe(v) {
  if (isNodeLike(v)) return v.name || v.className;
  return typeOf(v);
}

function describeExpr(e) {
  if (e.t === 'member' && e.prop.t === 'lit') return `${describeExpr(e.obj)}.${e.prop.v}`;
  if (e.t === 'id') return e.name;
  if (e.t === 'this') return 'this';
  return 'expression';
}

// ---------------------------------------------------------------------------
// Script objects and the entry point
// ---------------------------------------------------------------------------

/** A script object as a child of its subform; run on first use */
class ScriptObjectRef {
  constructor(objects, owner, name, script) {
    this.objects = objects;
    this.owner = owner;
    this.name = name;
    this.script = script;
    this.className = 'script';
    this.value = null;
    this.failed = false;
  }
  childrenByName() { return []; }
  resolve() {
    if (this.value) return this.value;
    if (this.failed) throw new ScriptError(`Script object ${this.name} failed to load`);
    const interp = this.objects.interpreter();
    const env = new Env(interp.globals);
    const owner = this.objects.dom.wrap(this.owner);
    this.value = new ScriptObject(this.name, env, owner);
    let ast;
    try {
      ast = parseJavaScript(this.script.text);
    } catch (e) {
      this.failed = true;
      this.value = null;
      throw e instanceof ScriptError ? e : new ScriptError(`Script object ${this.name}: ${describeThrown(e)}`);
    }
    try {
      interp.runProgram(ast, this.value, owner, env);
    } catch (e) {
      if (e instanceof Fatal) { this.failed = true; this.value = null; throw e; }
      // as in Acrobat, what ran before the error stays defined (functions
      // are hoisted, so all of them): the object is usable
      this.objects.dom.log?.once('info', 'XFA_SCRIPT_FAILED', `script object ${this.name}`,
        `Script object ${this.name} stopped while loading: ${e instanceof ScriptError ? e.message : describeThrown(e)}`);
    }
    return this.value;
  }
}

/** A <variables> named value (<text name="Version">1</text>): its .value */
class NamedValue {
  constructor(name, text) { this.name = name; this.text = text; this.className = 'text'; }
  childrenByName() { return []; }
  getProperty(key) {
    if (key === 'value') return { value: this.text };
    if (key === 'name') return { value: this.name };
    if (key === 'className') return { value: 'text' };
    return undefined;
  }
  setProperty(key, v) { if (key === 'value') { this.text = v === null ? '' : toText(v); return true; } return false; }
  scalar() { return this.text; }
  assign(v) { this.text = v === null ? '' : toText(v); }
}

/**
 * The document's script objects and its one JavaScript context (globals are
 * shared by every script, as in Acrobat). Registers <variables> with the DOM
 * so SOM lookups find them.
 */
export class ScriptObjects {
  constructor(dom, nodes, { log } = {}) {
    this.dom = dom;
    this.log = log;
    this.interp = null;
    this.register(nodes);
  }
  /** Register the <variables> of these nodes (also of instances added later) */
  register(nodes) {
    for (const n of nodes) {
      for (const v of n.variables ?? []) {
        const item = v.script
          ? (v.script.lang === 'javascript' ? new ScriptObjectRef(this, n, v.name, v.script) : null)
          : v.manifest ? new Manifest(this.dom, n, v.name, v.manifest)
            : new NamedValue(v.name, v.text);
        if (item) this.dom.addVariable(n, v.name, item);
      }
    }
  }
  interpreter() {
    if (!this.interp) this.interp = new Interpreter(this.dom, this);
    return this.interp;
  }
}

/**
 * Run an event or calculate script; its completion value
 * @throws {ScriptError} when the script fails
 */
export function runJavaScript(src, self, dom, objects) {
  const interp = objects.interpreter();
  interp.steps = 0;
  const ast = parseJavaScript(src);
  try {
    const v = interp.runProgram(ast, self, self);
    return v instanceof ScriptObjectRef ? v.resolve() : v;
  } catch (e) {
    if (e instanceof ScriptError) throw e;
    if (e instanceof JsThrow) throw new ScriptError(`Uncaught ${describeThrown(e)}`);
    if (e instanceof ReturnSignal) return e.value;
    if (e instanceof BreakSignal || e instanceof ContinueSignal) throw new ScriptError('break or continue outside a loop');
    throw e;
  }
}

function describeThrown(e) {
  const v = e instanceof JsThrow ? e.value : e;
  if (isPlain(v) && typeof v.message === 'string') return `${v.name ?? 'Error'}: ${v.message}`;
  if (v instanceof Error) return v.message;
  try { return toStr(v); } catch { return 'error'; }
}

// For a host object model other than XFA's (acroscript.js): an interpreter
// over `host` (event, now, lookup(name), shortcut(), extendGlobals(set)), and
// a way to run a script in it with `this` bound
export { Native, obj, toStr, toNum, jsError, JsThrow };
export function createInterpreter(host) {
  return new Interpreter(host, { dom: host });
}
export function runIn(interp, src, thisValue, { global = false } = {}) {
  interp.steps = 0;
  const ast = parseJavaScript(src);
  try {
    // global: top-level declarations become globals (Acrobat's document scripts)
    return global ? interp.runProgram(ast, thisValue, thisValue, interp.globals) : interp.runProgram(ast, thisValue, thisValue);
  } catch (e) {
    if (e instanceof ScriptError) throw e;
    if (e instanceof JsThrow) throw new ScriptError(`Uncaught ${describeThrown(e)}`);
    if (e instanceof ReturnSignal) return e.value;
    if (e instanceof BreakSignal || e instanceof ContinueSignal) throw new ScriptError('break or continue outside a loop');
    throw e;
  }
}
