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

// ---------------------------------------------------------------------------
// Parsing: display or data text → canonical value (bind and edit pictures)
// ---------------------------------------------------------------------------

/**
 * The canonical value a picture clause reads from text, as Reader reads a
 * value from data through a <bind><picture> (IRCC forms bind month cells
 * with num{99}, so "05" in the data is 5 to their scripts and prints "05"
 * through the format picture): the first alternate that accepts the text
 * wins. Dates become YYYY-MM-DD, times HH:MM:SS, numbers plain digits
 * ("." decimal, no grouping, no leading zeros), text the characters the
 * symbols take (literals dropped).
 * @returns {string|null} null when no alternate accepts the text
 */
export function parsePicture(picture, text, { locale, locales = {}, kind } = {}) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  for (const alt of splitAlternates(String(picture).trim())) {
    const parsed = parseAlternate(alt, kind);
    if (!parsed) continue;
    const loc = locales[parsed.locale ?? locale] ?? locales[locale] ?? EN_US;
    const body = parsed.named ? namedPattern(parsed.category, parsed.named, loc) : parsed.body;
    let r = null;
    try {
      if (parsed.category === 'date') r = parseDateText(body, s, loc);
      else if (parsed.category === 'time') r = parseTimeText(body, s, loc);
      else if (parsed.category === 'num') r = parseNumText(body, s, loc);
      else if (parsed.category === 'text') r = parseTextText(body, s);
      else if (parsed.category === 'null') r = s.trim() === literalText(body).trim() ? '' : null;
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
    }
    if (r !== null) return r;
  }
  return null;
}

const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameAlt = list => list.map(reEscape).sort((a, b) => b.length - a.length).join('|');

function parseDateText(body, s, loc) {
  const groups = [];
  let re = '';
  for (const tk of tokens(body, 'YMDJE')) {
    if (tk.lit !== undefined) { re += reEscape(tk.lit); continue; }
    const k = tk.sym + tk.n;
    switch (k) {
      case 'Y4': re += '(\\d{4})'; groups.push('y'); break;
      case 'Y2': re += '(\\d{2})'; groups.push('yy'); break;
      case 'M1': re += '(\\d{1,2})'; groups.push('m'); break;
      case 'M2': re += '(\\d{2})'; groups.push('m'); break;
      case 'M3': re += `(${nameAlt(loc.monthsAbbr)})`; groups.push('mAbbr'); break;
      case 'M4': re += `(${nameAlt(loc.months)})`; groups.push('mName'); break;
      case 'D1': re += '(\\d{1,2})'; groups.push('d'); break;
      case 'D2': re += '(\\d{2})'; groups.push('d'); break;
      case 'E1': re += '\\d'; break;
      case 'E3': re += `(?:${nameAlt(loc.daysAbbr)})`; break;
      case 'E4': re += `(?:${nameAlt(loc.days)})`; break;
      default: throw new Unsupported(`date symbol ${tk.sym.repeat(tk.n)}`);
    }
  }
  const m = new RegExp(`^${re}$`, 'i').exec(s.trim());
  if (!m) return null;
  let y = null, mo = null, d = null;
  groups.forEach((g, i) => {
    const v = m[i + 1];
    if (g === 'y') y = +v;
    else if (g === 'yy') y = +v < 30 ? 2000 + +v : 1900 + +v;
    else if (g === 'm') mo = +v;
    else if (g === 'mAbbr') mo = loc.monthsAbbr.findIndex(x => x.toLowerCase() === v.toLowerCase()) + 1;
    else if (g === 'mName') mo = loc.months.findIndex(x => x.toLowerCase() === v.toLowerCase()) + 1;
    else if (g === 'd') d = +v;
  });
  if (y === null || mo === null) return null;
  d ??= 1;
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`;
}

function parseTimeText(body, s, loc) {
  const groups = [];
  let re = '';
  for (const tk of tokens(body, 'HhMSAKkZz')) {
    if (tk.lit !== undefined) { re += reEscape(tk.lit); continue; }
    const k = tk.sym + tk.n;
    if (k === 'H1' || k === 'h1') { re += '(\\d{1,2})'; groups.push(tk.sym); }
    else if (k === 'H2' || k === 'h2') { re += '(\\d{2})'; groups.push(tk.sym); }
    else if (k === 'M1' || k === 'S1') { re += '(\\d{1,2})'; groups.push(tk.sym); }
    else if (k === 'M2' || k === 'S2') { re += '(\\d{2})'; groups.push(tk.sym); }
    else if (k === 'A1') { re += `(${nameAlt(loc.meridiem)})`; groups.push('A'); }
    else throw new Unsupported(`time symbol ${tk.sym.repeat(tk.n)}`);
  }
  const m = new RegExp(`^${re}$`, 'i').exec(s.trim());
  if (!m) return null;
  let h = 0, mi = 0, sec = 0, pm = null;
  groups.forEach((g, i) => {
    const v = m[i + 1];
    if (g === 'H' || g === 'h') h = +v;
    else if (g === 'M') mi = +v;
    else if (g === 'S') sec = +v;
    else if (g === 'A') pm = v.toLowerCase() === String(loc.meridiem[1]).toLowerCase();
  });
  if (pm !== null) h = (h % 12) + (pm ? 12 : 0);
  if (h > 23 || mi > 59 || sec > 59) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(mi)}:${pad(sec)}`;
}

function parseNumText(body, s, loc) {
  const toks = tokens(body, '9zZ.,v$%sSE');
  if (toks.some(tk => tk.sym === 'E' || tk.sym === '%' || tk.sym === 'v')) throw new Unsupported('num symbol');
  const isDigit = tk => tk.sym === '9' || tk.sym === 'z' || tk.sym === 'Z';
  const dot = toks.findIndex(tk => tk.sym === '.');
  const slots = list => list.filter(isDigit).reduce((a, tk) => a + tk.n, 0);
  const intSlots = slots(dot === -1 ? toks : toks.slice(0, dot));
  const fracSlots = dot === -1 ? 0 : slots(toks.slice(dot + 1));
  let t = s.trim();
  // literals the pattern prints, grouping, currency: not part of the number
  for (const tk of toks) if (tk.lit !== undefined && tk.lit.trim() && !/[\d.,+-]/.test(tk.lit)) t = t.split(tk.lit).join('');
  if (loc.currency) t = t.split(loc.currency).join('');
  t = t.split(loc.grouping).join('').replace(/\s+/g, '');
  const neg = t.startsWith(loc.minus) || t.startsWith('-');
  if (neg || t.startsWith('+')) t = t.slice(1);
  const parts = t.split(loc.decimal);
  if (parts.length > 2) return null;
  const [int, frac = ''] = parts;
  if (!/^\d*$/.test(int) || !/^\d*$/.test(frac) || (int === '' && frac === '')) return null;
  // more digits than the slots take is not this pattern (a 3-digit value
  // does not read through num{99})
  if (int.replace(/^0+(?=\d)/, '').length > Math.max(intSlots, 1) && int.length > intSlots) return null;
  if (frac.length > fracSlots && dot !== -1) return null;
  if (frac && dot === -1) return null;
  const i = int.replace(/^0+(?=\d)/, '') || '0';
  return `${neg ? '-' : ''}${i}${frac ? `.${frac}` : ''}`;
}

function parseTextText(body, s) {
  const chars = [...s];
  let i = 0;
  let out = '';
  for (const tk of tokens(body, 'A9XO0')) {
    if (tk.lit !== undefined) {
      for (const ch of tk.lit) { if (chars[i] !== ch) return null; i++; }
      continue;
    }
    for (let k = 0; k < tk.n; k++) {
      const ch = chars[i];
      if (ch === undefined) return null;
      const ok = tk.sym === 'X' || (tk.sym === 'A' && /\p{L}/u.test(ch)) || (tk.sym === '9' && /\d/.test(ch))
        || ((tk.sym === 'O' || tk.sym === '0') && /[\p{L}\d]/u.test(ch));
      if (!ok) return null;
      out += ch;
      i++;
    }
  }
  return i === chars.length ? out : null;
}
