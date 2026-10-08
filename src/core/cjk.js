/**
 * Purefield / core / cjk.js
 *
 * The predefined CMaps of CJK PDF fonts (PDF 32000 §9.7.5.2), as far as a
 * substitute needs them: how a string splits into codes (the CMap's code
 * space ranges) and which character each code is (the legacy encoding the
 * CMap is built on, decoded with the platform's TextDecoder: Shift-JIS,
 * EUC-JP, GBK, GB 18030, Big5, EUC-KR/UHC; the Unicode CMaps directly).
 * No CMap files are needed. Vertical (-V) CMaps split and decode as their
 * horizontal forms.
 *
 *   predefinedCMap(name) → { ranges, decode(bytes) → code point | null,
 *                            halfWidthCid(code) → CID | null, wmode } | null
 *   splitCodes(bytes, ranges) → Uint8Array[]
 */

// a code space range: bytes from lo[i] to hi[i] at each of its positions
const r = (...pairs) => ({ lo: pairs.map(p => p[0]), hi: pairs.map(p => p[1]) });
const ONE = r([0x00, 0x80]);

const decoder = label => {
  let d = null;
  return bytes => {
    try { d ??= new TextDecoder(label, { fatal: true }); } catch { return null; }
    try { return d.decode(bytes); } catch { return null; }
  };
};

const FAMILIES = [
  // Japanese: Shift-JIS (single bytes include half-width katakana)
  { test: /RKSJ-[HV]$/, ranges: [ONE, r([0xA0, 0xDF]), r([0xFD, 0xFF]), r([0x81, 0x9F], [0x40, 0xFC]), r([0xE0, 0xFC], [0x40, 0xFC])],
    text: decoder('shift_jis'), japan: true },
  { test: /^EUC-[HV]$/, ranges: [ONE, r([0x8E, 0x8E], [0xA0, 0xDF]), r([0xA1, 0xFE], [0xA1, 0xFE])], text: decoder('euc-jp'), japan: true },
  // raw JIS X 0208 rows and cells (H, V, and the Add/Ext/NWP sets): EUC with the high bits off
  { test: /^(?:(?:Add|Ext|NWP)-)?[HV]$/, ranges: [r([0x21, 0x7E], [0x21, 0x7E])], text: b => decoder('euc-jp')(b.map(x => x | 0x80)), japan: true },
  // simplified Chinese
  { test: /^GBK2K-[HV]$/, ranges: [ONE, r([0x81, 0xFE], [0x40, 0x7E]), r([0x81, 0xFE], [0x80, 0xFE]), r([0x81, 0xFE], [0x30, 0x39], [0x81, 0xFE], [0x30, 0x39])], text: decoder('gb18030') },
  { test: /^GBKp?-EUC-[HV]$/, ranges: [ONE, r([0x81, 0xFE], [0x40, 0xFE])], text: decoder('gbk') },
  { test: /^GB(?:pc|T|Tpc)?-EUC-[HV]$/, ranges: [ONE, r([0xA1, 0xFE], [0xA1, 0xFE])], text: decoder('gbk') },
  // traditional Chinese
  { test: /^(?:B5pc|ETen-B5|ETenms-B5|HKscs-B5|HKdla-B5|HKdlb-B5|HKgccs-B5|HKm314-B5|HKm471-B5)-[HV]$/,
    ranges: [ONE, r([0x81, 0xFE], [0x40, 0x7E]), r([0x81, 0xFE], [0xA1, 0xFE])], text: decoder('big5') },
  // Korean (EUC-KR and its Unified Hangul Code superset)
  { test: /^KSC(?:pc)?-EUC-[HV]$/, ranges: [ONE, r([0xA1, 0xFE], [0xA1, 0xFE])], text: decoder('euc-kr') },
  { test: /^KSCms-UHC(?:-HW)?-[HV]$/, ranges: [ONE, r([0x81, 0xFE], [0x41, 0xFE])], text: decoder('euc-kr') },
  // Unicode
  { test: /^Uni\w+-UCS2(?:-HW)?-[HV]$/, ranges: [r([0x00, 0xFF], [0x00, 0xFF])], text: b => String.fromCharCode((b[0] << 8) | b[1]) },
  { test: /^Uni\w+-UTF16-[HV]$/, ranges: [r([0x00, 0xD7], [0x00, 0xFF]), r([0xE0, 0xFF], [0x00, 0xFF]), r([0xD8, 0xDB], [0x00, 0xFF], [0xDC, 0xDF], [0x00, 0xFF])],
    text: decoder('utf-16be') },
  { test: /^Uni\w+-UTF8-[HV]$/, ranges: [r([0x00, 0x7F]), r([0xC2, 0xDF], [0x80, 0xBF]), r([0xE0, 0xEF], [0x80, 0xBF], [0x80, 0xBF]), r([0xF0, 0xF4], [0x80, 0xBF], [0x80, 0xBF], [0x80, 0xBF])],
    text: decoder('utf-8') },
  { test: /^Uni\w+-UTF32-[HV]$/, ranges: [r([0x00, 0x00], [0x00, 0x10], [0x00, 0xFF], [0x00, 0xFF])], text: b => String.fromCodePoint(((b[1] << 16) | (b[2] << 8) | b[3]) >>> 0) },
];

/**
 * @param {string} name - the /Encoding name
 * @returns {{ ranges: { lo: number[], hi: number[] }[], decode: (bytes: Uint8Array) => number|null,
 *             halfWidthCid: (code: Uint8Array) => number|null, wmode: 0|1 }|null}
 */
export function predefinedCMap(name) {
  const f = FAMILIES.find(x => x.test.test(name));
  if (!f) return null;
  return {
    ranges: f.ranges,
    wmode: /-V$/.test(name) ? 1 : 0,
    decode(bytes) {
      const s = f.text(bytes);
      if (!s) return null;
      const cp = s.codePointAt(0);
      return cp === 0xFFFD ? null : cp;
    },
    // Adobe-Japan1's half-width CIDs for a Japanese CMap's single bytes:
    // roman 0x20–0x7E from 231, katakana 0xA0–0xDF from 326 (where a font's
    // /W gives their widths)
    halfWidthCid(code) {
      if (!f.japan || code.length !== 1) return null;
      const c = code[0];
      return c >= 0x20 && c <= 0x7E ? 231 + c - 0x20 : c >= 0xA0 && c <= 0xDF ? 326 + c - 0xA0 : null;
    },
  };
}

/** A string's codes, split as the CMap's code space ranges split them */
export function splitCodes(bytes, ranges) {
  const out = [];
  const longest = Math.max(...ranges.map(x => x.lo.length));
  for (let i = 0; i < bytes.length;) {
    let n = 0;
    // the shortest code space range the next bytes fall in
    for (let len = 1; len <= longest && !n; len++) {
      if (i + len > bytes.length) break;
      for (const x of ranges) {
        if (x.lo.length !== len) continue;
        let inside = true;
        for (let k = 0; k < len && inside; k++) inside = bytes[i + k] >= x.lo[k] && bytes[i + k] <= x.hi[k];
        if (inside) { n = len; break; }
      }
    }
    // no range matches: as many bytes as the shortest range whose first byte
    // matches, else one (PDF 32000 §9.7.6.3)
    if (!n) n = Math.min(bytes.length - i, ranges.find(x => bytes[i] >= x.lo[0] && bytes[i] <= x.hi[0])?.lo.length ?? 1);
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}
