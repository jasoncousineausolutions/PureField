/**
 * Purefield / core / units.js
 *
 * XFA measurements → PDF points (spec §2, docs/REDUCED_XFA_SPEC.txt).
 *
 * A measurement is an optional sign, a number, and an optional unit suffix
 * stuck to the number. A bare number is inches (Adobe XFA spec; pdf.js
 * treats it as points — Designer almost always writes a unit). Everything
 * downstream works in points, 1 pt = 1/72 inch, origin top-left, Y down.
 */

// Rational conversion factors, unit → points
const UNIT_TO_PT = {
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  pt: 1,
  pc: 12,
  mp: 0.001,
};

const MEASUREMENT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;

/**
 * Split a measurement string into its number and unit.
 *
 * @param {string|number|null} value
 * @returns {{ value: number, unit: string }|null} - null if not a measurement
 */
export function parseMeasurement(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const m = MEASUREMENT_RE.exec(s);
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: m[2].toLowerCase() || 'in' };
}

/**
 * Parse an XFA measurement string and return a value in points.
 *
 * Percent and em can only be resolved with context:
 *   opts.percentOf - the parent content width or height in points
 *   opts.em        - the element font size in points (fallback 10pt)
 * Without percentOf, a percentage resolves to 0.
 *
 * Examples:
 *   "6.35mm" → 18     "576pt" → 576     "1.5cm" → 42.52
 *   "2"      → 144    (bare number = inches)
 *   "0"      → 0      ""/null → 0
 *   "10px"   → 0      (px is not an XFA unit; logged)
 *
 * @param {string|number|null} value
 * @param {{ percentOf?: number, em?: number, log?: import('../xfa/log.js').XfaLog }} [opts]
 * @returns {number}
 */
export function toPt(value, opts = {}) {
  const m = parseMeasurement(value);
  if (!m) {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      opts.log?.warn('XFA_UNIT_INVALID', `Not a measurement: "${value}"`);
    }
    return 0;
  }
  if (m.value === 0) return 0;

  if (m.unit in UNIT_TO_PT) return m.value * UNIT_TO_PT[m.unit];
  if (m.unit === '%') return opts.percentOf !== undefined ? m.value / 100 * opts.percentOf : 0;
  if (m.unit === 'em') return m.value * (opts.em ?? 10);

  opts.log?.warn('XFA_UNIT_UNKNOWN', `Unknown unit "${m.unit}" in "${value}"`);
  return 0;
}

/**
 * Parse an XFA angle (degrees counterclockwise) and snap it to a quarter turn.
 *
 * @param {string|number|null} value
 * @returns {0|90|180|270}
 */
export function toQuarterTurn(value) {
  const deg = parseFloat(value);
  if (!Number.isFinite(deg)) return 0;
  const quarter = Math.round(deg / 90);
  return (((quarter % 4) + 4) % 4) * 90;
}

/**
 * Convert points back to mm (useful for debugging output).
 */
export function toMm(pt) {
  return pt / UNIT_TO_PT.mm;
}

/** Stock page sizes in points, portrait (short edge first). */
export const STOCK_SIZES = {
  letter:  [612, 792],
  legal:   [612, 1008],
  tabloid: [792, 1224],
  a4:      [595.2756, 841.8898],
  a3:      [841.8898, 1190.5512],
  a5:      [419.5276, 595.2756],
};

/**
 * Resolve a pageArea/medium element's attributes to a page size.
 * short and long win over stock; landscape swaps the edges.
 *
 * @param {{ short?: string, long?: string, stock?: string, orientation?: string }} medium
 * @returns {{ width: number, height: number }}
 */
export function mediumSize(medium = {}) {
  let short = toPt(medium.short);
  let long  = toPt(medium.long);
  if (!(short > 0 && long > 0)) {
    const stock = STOCK_SIZES[String(medium.stock || 'letter').toLowerCase()] ?? STOCK_SIZES.letter;
    [short, long] = stock;
  }
  return medium.orientation === 'landscape'
    ? { width: long, height: short }
    : { width: short, height: long };
}

/**
 * Standard US Letter page size in points.
 * XFA page size comes from the <medium> element but Letter is the default.
 */
export const PAGE = {
  width:  612,   // 8.5in
  height: 792,   // 11in
};
