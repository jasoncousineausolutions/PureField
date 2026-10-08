/**
 * Purefield / core / auspost.js
 *
 * Australia Post 4-state customer barcodes (Customer Barcoding Technical
 * Specifications): a start pair, the format control code (FCC) and the
 * 8-digit delivery point identifier (DPID) two bars a digit (N table),
 * customer information (Customer Barcodes 2 and 3) two bars a digit when it
 * is all digits, else three bars a character (C table: A-Z a-z 0-9 space #),
 * tracker fillers to the format's length, four Reed-Solomon check symbols
 * over GF(64) (x^6 + x + 1, from ∏(x − 2^i), i = 1..4) of the bars after
 * the start pair taken three at a time, and a stop pair.
 *
 *   type                FCC   bars   customer information
 *   postAUSStandard     11    37     none
 *   postAUSReplyPaid    45    37     none
 *   postAUSCust2        59    52     8 digits or 5 characters
 *   postAUSCust3        62    67     15 digits or 10 characters
 *
 * The N and C tables as zint has them (backend/auspost.c; BSD-3-Clause,
 * Copyright (C) 2008-2026 Robin Stuart), from the specification.
 *
 *   encodeAusPost(text, type, env) → { kind: 'bars', bars: 'F' | 'A' | 'D' | 'T'... } | null
 */

import { rs } from './maxicode.js';

// bar values: 0 full (ascender and descender), 1 ascender, 2 descender, 3 tracker
const BAR = 'FADT';
const N = ['00', '01', '02', '10', '11', '12', '20', '21', '22', '30'];
const C_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz #';
const C = [
  '222', '300', '301', '302', '310', '311', '312', '320', '321', '322', '000', '001', '002', '010', '011', '012',
  '020', '021', '022', '100', '101', '102', '110', '111', '112', '120', '121', '122', '200', '201', '202', '210',
  '211', '212', '220', '221', '023', '030', '031', '032', '033', '103', '113', '123', '130', '131', '132', '133',
  '203', '213', '223', '230', '231', '232', '233', '303', '313', '323', '330', '331', '332', '333', '003', '013',
];
const FORMATS = {
  postausstandard: { fcc: '11', length: 23, digits: 0, chars: 0 },
  postausreplypaid: { fcc: '45', length: 23, digits: 0, chars: 0 },
  postauscust2: { fcc: '59', length: 38, digits: 8, chars: 5 },
  postauscust3: { fcc: '62', length: 53, digits: 15, chars: 10 },
};

export function encodeAusPost(text, type, env) {
  const f = FORMATS[type.toLowerCase()];
  let dpid = text.slice(0, 8);
  if (!/^\d+$/.test(dpid)) {
    env.log('XFA_BARCODE_DATA', 'an Australia Post barcode opens with an 8-digit DPID');
    return null;
  }
  if (dpid.length < 8) {
    env.log('XFA_BARCODE_DATA', `the DPID takes 8 digits, got ${dpid.length}; padded with zeros`);
    dpid = dpid.padStart(8, '0');
  }
  let info = '';
  for (const ch of text.slice(8)) {
    if (C_CHARS.includes(ch)) info += ch;
    else env.log('XFA_BARCODE_CHAR', `"${ch}" cannot be encoded in an Australia Post barcode; skipped`);
  }
  const numeric = /^\d*$/.test(info);
  const max = numeric ? f.digits : f.chars;
  if (info.length > max) {
    env.log('XFA_BARCODE_DATA', max ? `${type} holds ${max} customer ${numeric ? 'digits' : 'characters'}; the rest left out` : `${type} holds the DPID alone; the rest left out`);
    info = info.slice(0, max);
  }
  let bars = `13${[...f.fcc + dpid].map(d => N[d]).join('')}`;
  bars += numeric ? [...info].map(d => N[d]).join('') : [...info].map(ch => C[C_CHARS.indexOf(ch)]).join('');
  bars = bars.padEnd(f.length, '3');
  // the check symbols: the bars after the start pair, three to a symbol
  const symbols = [];
  for (let i = 2; i < bars.length; i += 3) symbols.push(Number(bars[i]) * 16 + Number(bars[i + 1]) * 4 + Number(bars[i + 2]));
  for (const s of rs(symbols, 4)) bars += `${s >> 4}${(s >> 2) & 3}${s & 3}`;
  bars += '13';
  return { kind: 'bars', bars: [...bars].map(b => BAR[b]), text: '' };
}
