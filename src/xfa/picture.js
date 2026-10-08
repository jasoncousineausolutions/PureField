/**
 * Purefield / xfa / picture.js
 *
 * Reduced picture clauses: raw canonical value → display string (spec §6).
 *
 * A clause is alternates split on "|"; the first alternate that accepts the
 * raw value wins:
 *
 *   date{…}  canonical YYYY-MM-DD (or YYYYMMDD, optional Thh:mm:ss)
 *   time{…}  canonical hh:mm:ss
 *   num{…}   canonical number, "." decimal, no grouping
 *   text{…}  any string
 *   null{…}  raw null (or empty)       zero{…}  numeric zero
 *   'lit'    a quoted literal alternate always accepts
 *
 * Also accepted: a category with a locale, date(fr_CA){…}; named locale
 * patterns, num.currency{} / date.short{}; and a bare pattern with no
 * category, read as date, num or text from the field's ui widget.
 * A clause that matches nothing paints the raw string. Unsupported symbols
 * paint the raw string and log XFA_PICTURE_UNSUPPORTED.
 */

const EN_US = {
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  monthsAbbr: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  daysAbbr: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  meridiem: ['AM', 'PM'],
  decimal: '.', grouping: ',', percent: '%', minus: '-', currency: '$',
  datePatterns: { full: 'EEEE, MMMM D, YYYY', long: 'MMMM D, YYYY', med: 'MMM D, YYYY', short: 'M/D/YY' },
  timePatterns: { full: 'h:MM:SS A Z', long: 'h:MM:SS A Z', med: 'h:MM:SS A', short: 'h:MM A' },
  numberPatterns: { numeric: 'z,zz9.zzz', currency: '$z,zz9.99', percent: 'z,zz9%', integer: 'z,zzz,zzz,zz9', decimal: 'z,zzz,zzz,zz9.zzz' },
};

/**
 * Parse the localeSet packet into { name → locale symbols }.
 * @param {Document|null} xml
 */
export function parseLocaleSet(xml) {
  const out = {};
  const root = xml?.documentElement;
  if (!root) return out;
  for (const loc of kids(root, 'locale')) {
    const name = loc.getAttribute('name');
    if (!name) continue;
    const l = { ...EN_US, datePatterns: { ...EN_US.datePatterns }, timePatterns: { ...EN_US.timePatterns }, numberPatterns: { ...EN_US.numberPatterns } };
    const cal = kids(loc, 'calendarSymbols')[0];
    if (cal) {
      for (const mn of kids(cal, 'monthNames')) l[mn.getAttribute('abbr') === '1' ? 'monthsAbbr' : 'months'] = kids(mn, 'month').map(t);
      for (const dn of kids(cal, 'dayNames')) l[dn.getAttribute('abbr') === '1' ? 'daysAbbr' : 'days'] = kids(dn, 'day').map(t);
      const mer = kids(cal, 'meridiemNames')[0];
      if (mer) l.meridiem = kids(mer, 'meridiem').map(t);
    }
    for (const p of kids(kids(loc, 'datePatterns')[0], 'datePattern')) l.datePatterns[p.getAttribute('name')] = t(p);
    for (const p of kids(kids(loc, 'timePatterns')[0], 'timePattern')) l.timePatterns[p.getAttribute('name')] = t(p);
    for (const p of kids(kids(loc, 'numberPatterns')[0], 'numberPattern')) l.numberPatterns[p.getAttribute('name')] = t(p);
    for (const s of kids(kids(loc, 'numberSymbols')[0], 'numberSymbol')) {
      const n = s.getAttribute('name');
      if (n === 'decimal' || n === 'grouping' || n === 'percent' || n === 'minus') l[n] = t(s);
    }
    for (const s of kids(kids(loc, 'currencySymbols')[0], 'currencySymbol')) {
      if (s.getAttribute('name') === 'symbol') l.currency = t(s);
    }
    out[name] = l;
  }
  return out;
}

/**
 * @param {string} picture - the clause text
 * @param {string|null} raw
 * @param {{ locale?: string, locales?: object, kind?: string, log?: import('./log.js').XfaLog }} [opts]
 * @returns {string}
 */
export function formatPicture(picture, raw, { locale, locales = {}, kind, log } = {}) {
  const alts = splitAlternates(String(picture).trim());
  const isNull = raw === null || raw === undefined || raw === '';
  for (const alt of alts) {
    const parsed = parseAlternate(alt, kind);
    if (!parsed) continue;
    const loc = locales[parsed.locale ?? locale] ?? locales[locale] ?? EN_US;
    const body = parsed.named ? namedPattern(parsed.category, parsed.named, loc) : parsed.body;

    if (parsed.category === 'literal') return body;
    if (parsed.category === 'null') { if (isNull) return literalText(body); continue; }
    if (isNull) continue;
    if (parsed.category === 'zero') { if (isZero(raw)) return literalText(body); continue; }

    let result = null;
    try {
      if (parsed.category === 'date') result = formatDate(body, raw, loc, log);
      else if (parsed.category === 'time') result = formatTime(body, raw, loc, log);
      else if (parsed.category === 'datetime') result = formatDateTime(body, raw, loc, log);
      else if (parsed.category === 'num') result = formatNum(body, raw, loc, log);
      else if (parsed.category === 'text') result = formatText(body, raw);
    } catch (e) {
      if (e instanceof Unsupported) { log?.once('info', 'XFA_PICTURE_UNSUPPORTED', picture, `Picture "${picture}": ${e.message}`); return String(raw); }
      throw e;
    }
    if (result !== null) return result;
  }
  return isNull ? '' : String(raw);
}

class Unsupported extends Error {}

// ---------------------------------------------------------------------------
// Clause parsing
// ---------------------------------------------------------------------------

function splitAlternates(s) {
  const out = [];
  let cur = '', depth = 0, quote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") quote = !quote;
    else if (!quote && ch === '{') depth++;
    else if (!quote && ch === '}') depth--;
    if (ch === '|' && depth === 0 && !quote) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(a => a.trim()).filter(a => a !== '');
}

const CATEGORIES = new Set(['date', 'time', 'datetime', 'num', 'text', 'null', 'zero']);

function parseAlternate(alt, kind) {
  const m = /^([a-z]+)(?:\(([^)]*)\))?(?:\.([a-z]+))?\{([\s\S]*)\}$/i.exec(alt);
  if (m && CATEGORIES.has(m[1].toLowerCase())) {
    return { category: m[1].toLowerCase(), locale: m[2] || null, named: m[3] || null, body: m[4] };
  }
  // a whole alternate that is one quoted literal
  if (/^'([^']|'')*'$/.test(alt)) return { category: 'literal', body: literalText(alt) };
  // bare pattern: category from the widget
  const category = kind === 'dateTimeEdit' ? 'date' : kind === 'numericEdit' ? 'num' : 'text';
  return { category, locale: null, named: null, body: alt };
}

function namedPattern(category, name, loc) {
  if (category === 'date') return loc.datePatterns[name] ?? EN_US.datePatterns[name] ?? 'YYYY-MM-DD';
  if (category === 'time') return loc.timePatterns[name] ?? EN_US.timePatterns[name] ?? 'HH:MM:SS';
  if (category === 'num') return loc.numberPatterns[name] ?? EN_US.numberPatterns[name] ?? 'z,zz9.zzz';
  return '';
}

// Quoted segments are literal ('' is a quote); everything else verbatim
// null{} and zero{} bodies: quoted runs are literal; an unquoted * is a
// digit placeholder that shows as a space (Acrobat prints null{*******-**}
// as seven blanks, a hyphen and two blanks)
function literalText(body) {
  return String(body).split(/('(?:[^']|'')*')/).map(part => (part.startsWith("'")
    ? part.slice(1, -1).replace(/''/g, "'")
    : part.replace(/\*/g, ' '))).join('');
}

function isZero(raw) {
  const n = Number(String(raw).trim());
  return String(raw).trim() !== '' && Number.isFinite(n) && n === 0;
}

// Tokenise a pattern into literals and runs of one symbol letter
function tokens(body, symbols) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'") {
      let j = i + 1, lit = '';
      while (j < body.length) {
        if (body[j] === "'" && body[j + 1] === "'") { lit += "'"; j += 2; continue; }
        if (body[j] === "'") break;
        lit += body[j++];
      }
      out.push({ lit });
      i = j + 1;
    } else if (symbols.includes(ch)) {
      let j = i;
      while (body[j] === ch) j++;
      out.push({ sym: ch, n: j - i });
      i = j;
    } else {
      out.push({ lit: ch });
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

function parseCanonicalDate(raw) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):?(\d{2})(?::?(\d{2}))?)?/.exec(String(raw).trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
}

function parseCanonicalTime(raw) {
  const m = /^(\d{2}):?(\d{2})(?::?(\d{2}))?/.exec(String(raw).trim());
  return m ? { h: +m[1], mi: +m[2], s: +(m[3] ?? 0) } : null;
}

function formatDate(body, raw, loc) {
  const v = parseCanonicalDate(raw);
  if (!v) return null;
  return renderDate(body, v, loc);
}

function renderDate(body, v, loc) {
  const pad = (n, w) => String(n).padStart(w, '0');
  const dow = new Date(Date.UTC(v.y, v.mo - 1, v.d)).getUTCDay();
  const jday = Math.round((Date.UTC(v.y, v.mo - 1, v.d) - Date.UTC(v.y, 0, 1)) / 86400000) + 1;
  return tokens(body, 'YMDJE').map(tk => {
    if (tk.lit !== undefined) return tk.lit;
    switch (tk.sym) {
      case 'Y': if (tk.n === 4) return pad(v.y, 4); if (tk.n === 2) return pad(v.y % 100, 2); break;
      case 'M':
        if (tk.n === 4) return loc.months[v.mo - 1];
        if (tk.n === 3) return loc.monthsAbbr[v.mo - 1];
        if (tk.n === 2) return pad(v.mo, 2);
        if (tk.n === 1) return String(v.mo);
        break;
      case 'D': if (tk.n === 2) return pad(v.d, 2); if (tk.n === 1) return String(v.d); break;
      case 'J': if (tk.n === 3) return pad(jday, 3); if (tk.n === 1) return String(jday); break;
      case 'E':
        if (tk.n === 4) return loc.days[dow];
        if (tk.n === 3) return loc.daysAbbr[dow];
        if (tk.n === 1) return String(dow + 1);
        break;
    }
    throw new Unsupported(`date symbol ${tk.sym.repeat(tk.n)}`);
  }).join('');
}

function formatTime(body, raw, loc) {
  const v = parseCanonicalTime(raw);
  if (!v) return null;
  return renderTime(body, v, loc);
}

function renderTime(body, v, loc) {
  const pad = n => String(n).padStart(2, '0');
  const h12 = v.h % 12 === 0 ? 12 : v.h % 12;
  return tokens(body, 'HhMSAKkZz').map(tk => {
    if (tk.lit !== undefined) return tk.lit;
    switch (tk.sym) {
      case 'H': if (tk.n <= 2) return tk.n === 2 ? pad(v.h) : String(v.h); break;
      case 'h': if (tk.n <= 2) return tk.n === 2 ? pad(h12) : String(h12); break;
      case 'M': if (tk.n <= 2) return tk.n === 2 ? pad(v.mi) : String(v.mi); break;
      case 'S': if (tk.n <= 2) return tk.n === 2 ? pad(v.s) : String(v.s); break;
      case 'A': if (tk.n === 1) return loc.meridiem[v.h < 12 ? 0 : 1]; break;
      case 'Z': case 'z': return ''; // time zone: canonical values carry none
    }
    throw new Unsupported(`time symbol ${tk.sym.repeat(tk.n)}`);
  }).join('');
}

function formatDateTime(body, raw, loc) {
  const v = parseCanonicalDate(raw);
  if (!v) return null;
  const [d, t] = body.split('T');
  return renderDate(d, v, loc) + (t !== undefined ? renderTime(t, v, loc) : '');
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function formatNum(body, raw, loc) {
  const s = String(raw).trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  let value = Number(s);
  if (!Number.isFinite(value)) return null;

  const toks = tokens(body, '9zZ.,v$%sSE');
  if (toks.some(tk => tk.sym === 'E')) throw new Unsupported('exponent');
  const isDigit = tk => tk.sym === '9' || tk.sym === 'z' || tk.sym === 'Z';
  const dot = toks.findIndex(tk => tk.sym === '.' || tk.sym === 'v');
  const intToks = dot === -1 ? toks : toks.slice(0, dot);
  const fracToks = dot === -1 ? [] : toks.slice(dot + 1);
  const fracSlots = fracToks.filter(isDigit).flatMap(tk => Array(tk.n).fill(tk.sym));
  const intSlots = intToks.filter(isDigit).flatMap(tk => Array(tk.n).fill(tk.sym));

  if (toks.some(tk => tk.sym === '%')) value *= 100;
  const negative = value < 0 && Math.abs(value).toFixed(fracSlots.length) !== (0).toFixed(fracSlots.length);
  const [intStr, fracStr = ''] = Math.abs(value).toFixed(fracSlots.length).split('.');
  const digits = intStr === '0' ? '' : intStr;

  // Integer slots fill right to left; digits beyond the slots are prepended
  const overflow = digits.length > intSlots.length ? digits.slice(0, digits.length - intSlots.length) : '';
  const tail = digits.slice(overflow.length);
  const filled = intSlots.map((sym, i) => {
    const j = i - (intSlots.length - tail.length);
    if (j >= 0) return tail[j];
    return sym === '9' ? '0' : sym === 'Z' ? ' ' : '';
  });

  let out = overflow;
  let seenDigit = overflow !== '';
  let slot = 0;
  for (const tk of intToks) {
    if (tk.lit !== undefined) out += tk.lit;
    else if (isDigit(tk)) {
      for (let i = 0; i < tk.n; i++) {
        const d = filled[slot++];
        out += d;
        if (/\d/.test(d)) seenDigit = true;
      }
    } else if (tk.sym === ',') { if (seenDigit) out += loc.grouping.repeat(tk.n); }
    else if (tk.sym === '$') out += loc.currency;
    else if (tk.sym === '%') out += loc.percent;
    else if (tk.sym === 's' || tk.sym === 'S') out += negative ? loc.minus : tk.sym === 'S' ? ' ' : '';
  }

  if (dot !== -1) {
    // trailing z slots holding 0 are dropped
    let keep = fracSlots.length;
    while (keep > 0 && fracSlots[keep - 1] === 'z' && fracStr[keep - 1] === '0') keep--;
    let frac = '';
    let fi = 0;
    for (const tk of fracToks) {
      if (tk.lit !== undefined) frac += tk.lit;
      else if (isDigit(tk)) for (let i = 0; i < tk.n; i++, fi++) { if (fi < keep) frac += fracStr[fi]; }
      else if (tk.sym === '$') frac += loc.currency;
      else if (tk.sym === '%') frac += loc.percent;
    }
    const sep = toks[dot].sym === 'v' ? '' : loc.decimal;
    out += keep > 0 ? sep + frac : frac;
  }

  if (negative && !toks.some(tk => tk.sym === 's' || tk.sym === 'S')) out = loc.minus + out;
  return out;
}

// ---------------------------------------------------------------------------
// Text: A letter, 9 digit, X any, O/0 alphanumeric; other characters literal
// ---------------------------------------------------------------------------

function formatText(body, raw) {
  const s = [...String(raw)];
  let i = 0;
  let out = '';
  for (const tk of tokens(body, 'A9XO0')) {
    if (tk.lit !== undefined) { out += tk.lit; continue; }
    for (let k = 0; k < tk.n; k++) {
      const ch = s[i];
      if (ch === undefined) return null;
      const ok = tk.sym === 'X' || (tk.sym === 'A' && /\p{L}/u.test(ch)) || (tk.sym === '9' && /\d/.test(ch))
        || ((tk.sym === 'O' || tk.sym === '0') && /[\p{L}\d]/u.test(ch));
      if (!ok) return null;
      out += ch;
      i++;
    }
  }
  return i === s.length ? out : null;
}

// ---------------------------------------------------------------------------

function kids(el, name) {
  const out = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n.localName || n.nodeName) === name) out.push(n);
  }
  return out;
}

function t(el) {
  return el.textContent;
}
