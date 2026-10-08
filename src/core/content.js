/**
 * Purefield / core / content.js
 *
 * Content streams read just far enough for what the copy needs: a
 * tokenizer that finds operators and their operands (core/optional.js
 * takes hidden layers out with it), and the text each font shows
 * (core/substitute.js builds a CJK substitute from the codes used).
 */

// ---------------------------------------------------------------------------
// A content stream tokenizer: just enough to find operators and their
// operands (strings, names, numbers, arrays, dictionaries, inline images)
// ---------------------------------------------------------------------------

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

export function tokenize(b) {
  const out = [];
  const n = b.length;
  let i = 0;
  const text = (s, e) => String.fromCharCode(...b.subarray(s, Math.min(e, s + 200)));
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // comment
    const start = i;
    if (c === 40) { // (string)
      let depth = 0;
      for (; i < n; i++) {
        if (b[i] === 92) { i++; continue; }
        if (b[i] === 40) depth++;
        else if (b[i] === 41 && --depth === 0) { i++; break; }
      }
      out.push({ kind: 'string', start, end: i });
      continue;
    }
    if (c === 60 && b[i + 1] === 60) { // << dict >> as one operand
      let depth = 0;
      while (i < n) {
        if (b[i] === 60 && b[i + 1] === 60) { depth++; i += 2; continue; }
        if (b[i] === 62 && b[i + 1] === 62) { depth--; i += 2; if (!depth) break; continue; }
        if (b[i] === 40) { const s = tokenizeString(b, i); i = s; continue; }
        i++;
      }
      out.push({ kind: 'dict', start, end: i });
      continue;
    }
    if (c === 60) { while (i < n && b[i] !== 62) i++; i++; out.push({ kind: 'hex', start, end: i }); continue; }
    if (c === 91 || c === 93 || c === 123 || c === 125 || c === 62) { i++; out.push({ kind: 'punct', start, end: i }); continue; }
    if (c === 47) { // /Name
      i++;
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      out.push({ kind: 'name', start, end: i, text: text(start, i) });
      continue;
    }
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === start) { i++; continue; }
    const word = text(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { out.push({ kind: 'number', start, end: i }); continue; }
    if (word === 'true' || word === 'false' || word === 'null') { out.push({ kind: 'value', start, end: i }); continue; }
    if (word === 'BI') {
      // inline image: its dictionary, ID, binary data up to EI
      let j = i;
      while (j < n - 1 && !(b[j] === 73 && b[j + 1] === 68 && WS.has(b[j - 1]) && (WS.has(b[j + 2]) || j + 2 >= n))) j++;
      j += 3;
      while (j < n - 1 && !(WS.has(b[j - 1]) && b[j] === 69 && b[j + 1] === 73 && (j + 2 >= n || WS.has(b[j + 2]) || DELIM.has(b[j + 2])))) j++;
      i = Math.min(n, j + 2);
      out.push({ kind: 'op', start, end: i, text: 'BI' });
      continue;
    }
    out.push({ kind: 'op', start, end: i, text: word });
  }
  return out;
}

function tokenizeString(b, i) {
  let depth = 0;
  for (; i < b.length; i++) {
    if (b[i] === 92) { i++; continue; }
    if (b[i] === 40) depth++;
    else if (b[i] === 41 && --depth === 0) return i + 1;
  }
  return i;
}

// The bytes of a string token: a literal (escapes, octal, line
// continuations) or a hex string
export function stringBytes(b, t) {
  if (t.kind === 'hex') {
    const hex = String.fromCharCode(...b.subarray(t.start + 1, t.end - 1)).replace(/[^0-9A-Fa-f]/g, '');
    const out = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt((hex.slice(2 * i, 2 * i + 2) + '0').slice(0, 2), 16);
    return out;
  }
  const out = [];
  for (let i = t.start + 1; i < t.end - 1; i++) {
    let c = b[i];
    if (c !== 92) { out.push(c); continue; }
    c = b[++i];
    const esc = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[c];
    if (esc !== undefined) out.push(esc);
    else if (c >= 48 && c <= 55) {
      let v = c - 48;
      for (let k = 0; k < 2 && b[i + 1] >= 48 && b[i + 1] <= 55; k++) v = v * 8 + (b[++i] - 48);
      out.push(v & 0xFF);
    } else if (c === 13) { if (b[i + 1] === 10) i++; } // a line continuation
    else if (c !== 10) out.push(c);
  }
  return Uint8Array.from(out);
}

/**
 * The text a content stream shows, run by run, and the XObjects it draws.
 * @param {Uint8Array} b
 * @returns {{ runs: { font: string|null, bytes: Uint8Array }[], xobjects: string[] }}
 *   font: the /Font resource name the run is shown in
 */
export function shownText(b) {
  const runs = [], xobjects = [];
  let font = null;
  const operands = [];
  for (const t of tokenize(b)) {
    if (t.kind !== 'op') { operands.push(t); continue; }
    switch (t.text) {
      case 'Tf': {
        const name = operands.find(o => o.kind === 'name');
        if (name) font = name.text.slice(1);
        break;
      }
      case 'Tj': case "'": case '"': case 'TJ':
        for (const o of operands) if (o.kind === 'string' || o.kind === 'hex') runs.push({ font, bytes: stringBytes(b, o) });
        break;
      case 'Do': {
        const name = operands.at(-1);
        if (name?.kind === 'name') xobjects.push(name.text.slice(1));
        break;
      }
    }
    operands.length = 0;
  }
  return { runs, xobjects };
}
