/**
 * Purefield / core / maxicode.js
 *
 * MaxiCode (ISO/IEC 16023): 33 rows of 30 hexagonal modules round a
 * bullseye. Mode 2 or 3 (structured carrier message) when the data opens
 * with "[)>␞01␝yy" and a postal code, country and service class, else Mode 4
 * (standard symbol, standard error correction). Text is compacted in code
 * sets A to E with the shortest sequence of latches, shifts and numeric
 * runs (Bue Jensen's backtracking, as BWIPP and zint do); the primary
 * message has its 10 error codewords and the secondary 40, interleaved
 * even and odd, over GF(64).
 *
 * Ported from zint (backend/maxicode.c, maxicode.h; BSD-3-Clause,
 * Copyright (C) 2008-2025 Robin Stuart), whose module grid and code set
 * tables are ISO/IEC 16023's.
 *
 *   encodeMaxiCode({ bytes }, env) → { kind: 'maxicode', modules: 33 rows of 30 } | null
 */

// ISO/IEC 16023 Figure 5: each module's place in the codeword bit sequence
// (33 rows of 30; 0: not data)
const GRID = [
  122, 121, 128, 127, 134, 133, 140, 139, 146, 145, 152, 151, 158, 157, 164, 163, 170, 169, 176, 175, 182, 181, 188, 187, 194, 193, 200, 199, 0, 0,
  124, 123, 130, 129, 136, 135, 142, 141, 148, 147, 154, 153, 160, 159, 166, 165, 172, 171, 178, 177, 184, 183, 190, 189, 196, 195, 202, 201, 817, 0,
  126, 125, 132, 131, 138, 137, 144, 143, 150, 149, 156, 155, 162, 161, 168, 167, 174, 173, 180, 179, 186, 185, 192, 191, 198, 197, 204, 203, 819, 818,
  284, 283, 278, 277, 272, 271, 266, 265, 260, 259, 254, 253, 248, 247, 242, 241, 236, 235, 230, 229, 224, 223, 218, 217, 212, 211, 206, 205, 820, 0,
  286, 285, 280, 279, 274, 273, 268, 267, 262, 261, 256, 255, 250, 249, 244, 243, 238, 237, 232, 231, 226, 225, 220, 219, 214, 213, 208, 207, 822, 821,
  288, 287, 282, 281, 276, 275, 270, 269, 264, 263, 258, 257, 252, 251, 246, 245, 240, 239, 234, 233, 228, 227, 222, 221, 216, 215, 210, 209, 823, 0,
  290, 289, 296, 295, 302, 301, 308, 307, 314, 313, 320, 319, 326, 325, 332, 331, 338, 337, 344, 343, 350, 349, 356, 355, 362, 361, 368, 367, 825, 824,
  292, 291, 298, 297, 304, 303, 310, 309, 316, 315, 322, 321, 328, 327, 334, 333, 340, 339, 346, 345, 352, 351, 358, 357, 364, 363, 370, 369, 826, 0,
  294, 293, 300, 299, 306, 305, 312, 311, 318, 317, 324, 323, 330, 329, 336, 335, 342, 341, 348, 347, 354, 353, 360, 359, 366, 365, 372, 371, 828, 827,
  410, 409, 404, 403, 398, 397, 392, 391, 80, 79, 0, 0, 14, 13, 38, 37, 3, 0, 45, 44, 110, 109, 386, 385, 380, 379, 374, 373, 829, 0,
  412, 411, 406, 405, 400, 399, 394, 393, 82, 81, 41, 0, 16, 15, 40, 39, 4, 0, 0, 46, 112, 111, 388, 387, 382, 381, 376, 375, 831, 830,
  414, 413, 408, 407, 402, 401, 396, 395, 84, 83, 42, 0, 0, 0, 0, 0, 6, 5, 48, 47, 114, 113, 390, 389, 384, 383, 378, 377, 832, 0,
  416, 415, 422, 421, 428, 427, 104, 103, 56, 55, 17, 0, 0, 0, 0, 0, 0, 0, 21, 20, 86, 85, 434, 433, 440, 439, 446, 445, 834, 833,
  418, 417, 424, 423, 430, 429, 106, 105, 58, 57, 0, 0, 0, 0, 0, 0, 0, 0, 23, 22, 88, 87, 436, 435, 442, 441, 448, 447, 835, 0,
  420, 419, 426, 425, 432, 431, 108, 107, 60, 59, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 90, 89, 438, 437, 444, 443, 450, 449, 837, 836,
  482, 481, 476, 475, 470, 469, 49, 0, 31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 54, 53, 464, 463, 458, 457, 452, 451, 838, 0,
  484, 483, 478, 477, 472, 471, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 466, 465, 460, 459, 454, 453, 840, 839,
  486, 485, 480, 479, 474, 473, 52, 51, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 43, 468, 467, 462, 461, 456, 455, 841, 0,
  488, 487, 494, 493, 500, 499, 98, 97, 62, 61, 0, 0, 0, 0, 0, 0, 0, 0, 0, 27, 92, 91, 506, 505, 512, 511, 518, 517, 843, 842,
  490, 489, 496, 495, 502, 501, 100, 99, 64, 63, 0, 0, 0, 0, 0, 0, 0, 0, 29, 28, 94, 93, 508, 507, 514, 513, 520, 519, 844, 0,
  492, 491, 498, 497, 504, 503, 102, 101, 66, 65, 18, 0, 0, 0, 0, 0, 0, 0, 19, 30, 96, 95, 510, 509, 516, 515, 522, 521, 846, 845,
  560, 559, 554, 553, 548, 547, 542, 541, 74, 73, 33, 0, 0, 0, 0, 0, 0, 11, 68, 67, 116, 115, 536, 535, 530, 529, 524, 523, 847, 0,
  562, 561, 556, 555, 550, 549, 544, 543, 76, 75, 0, 0, 8, 7, 36, 35, 12, 0, 70, 69, 118, 117, 538, 537, 532, 531, 526, 525, 849, 848,
  564, 563, 558, 557, 552, 551, 546, 545, 78, 77, 0, 34, 10, 9, 26, 25, 0, 0, 72, 71, 120, 119, 540, 539, 534, 533, 528, 527, 850, 0,
  566, 565, 572, 571, 578, 577, 584, 583, 590, 589, 596, 595, 602, 601, 608, 607, 614, 613, 620, 619, 626, 625, 632, 631, 638, 637, 644, 643, 852, 851,
  568, 567, 574, 573, 580, 579, 586, 585, 592, 591, 598, 597, 604, 603, 610, 609, 616, 615, 622, 621, 628, 627, 634, 633, 640, 639, 646, 645, 853, 0,
  570, 569, 576, 575, 582, 581, 588, 587, 594, 593, 600, 599, 606, 605, 612, 611, 618, 617, 624, 623, 630, 629, 636, 635, 642, 641, 648, 647, 855, 854,
  728, 727, 722, 721, 716, 715, 710, 709, 704, 703, 698, 697, 692, 691, 686, 685, 680, 679, 674, 673, 668, 667, 662, 661, 656, 655, 650, 649, 856, 0,
  730, 729, 724, 723, 718, 717, 712, 711, 706, 705, 700, 699, 694, 693, 688, 687, 682, 681, 676, 675, 670, 669, 664, 663, 658, 657, 652, 651, 858, 857,
  732, 731, 726, 725, 720, 719, 714, 713, 708, 707, 702, 701, 696, 695, 690, 689, 684, 683, 678, 677, 672, 671, 666, 665, 660, 659, 654, 653, 859, 0,
  734, 733, 740, 739, 746, 745, 752, 751, 758, 757, 764, 763, 770, 769, 776, 775, 782, 781, 788, 787, 794, 793, 800, 799, 806, 805, 812, 811, 861, 860,
  736, 735, 742, 741, 748, 747, 754, 753, 760, 759, 766, 765, 772, 771, 778, 777, 784, 783, 790, 789, 796, 795, 802, 801, 808, 807, 814, 813, 862, 0,
  738, 737, 744, 743, 750, 749, 756, 755, 762, 761, 768, 767, 774, 773, 780, 779, 786, 785, 792, 791, 798, 797, 804, 803, 810, 809, 816, 815, 864, 863,
];
// Appendix A: which code sets (A 1, B 2, E 4, C 8, D 16) hold each byte
const CODE_SET = [
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 31, 31, 31, 4,
  31, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 3, 3,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 2, 2, 2, 2, 2,
  2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 16, 4, 4, 4, 4, 4, 4, 16, 4, 8, 16, 8, 4, 4, 16,
  16, 8, 8, 8, 16, 8, 4, 16, 16, 8, 8, 16, 8, 8, 8, 16,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
];
// Appendix A: each byte's symbol value (its Code Set A value when in several)
const SYMBOL_CHAR = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 30, 28, 29, 30, 35,
  32, 53, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 37, 38, 39, 40, 41,
  52, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 42, 43, 44, 45, 46,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 32, 54, 34, 35, 36,
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 47, 48, 49, 50, 51, 52,
  53, 54, 55, 56, 57, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 36,
  37, 37, 38, 39, 40, 41, 42, 43, 38, 44, 37, 39, 38, 45, 46, 40,
  41, 39, 40, 41, 42, 42, 47, 43, 44, 43, 44, 45, 45, 46, 47, 46,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 32, 33, 34, 35, 36,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 32, 33, 34, 35, 36,
];

const A = 0, B = 1, E = 2, C = 3, D = 4, STATES = 5;
// latch codewords from a set (row) to another (column)
const LATCH_SEQ = [
  [[], [63], [58], [58], [58]],
  [[63], [], [63], [63], [63]],
  [[62, 62], [62, 62], [], [62, 62], [62, 62]],
  [[60, 60], [60, 60], [60, 60], [], [60, 60]],
  [[61, 61], [61, 61], [61, 61], [61, 61], []],
];
const LATCH_LEN = LATCH_SEQ.map(r => r.map(s => s.length));

// operations: digits (nine as one number), a character in a set, a shift to
// another set for one, two or three characters
const OP_DGTS = 0, SETA = 0x01, SETB = 0x02, SETE = 0x04, SETC = 0x08, SETD = 0x10;
const SHA = 0x20 | SETA, SH2A = 0x40 | SETA, SH3A = 0x80 | SETA, SHB = 0x20 | SETB, SHE = 0x20 | SETE, SHC = 0x20 | SETC, SHD = 0x20 | SETD;
const OPS = [[OP_DGTS, 9], [SETA, 1], [SETB, 1], [SETE, 1], [SETC, 1], [SETD, 1], [SHA, 1], [SH2A, 2], [SH3A, 3], [SHB, 1], [SHE, 1], [SHC, 1], [SHD, 1]];
const SHA_IDX = 6;
const STATE_OPS = [[1, 9, 10, 11, 12], [2, 6, 7, 8, 10, 11, 12], [3, 11, 12], [4, 10, 12], [5, 10, 11]];

const can = (op, ch, numA) => (op === SH2A || op === SH3A ? numA >= 2 + (op === SH3A ? 1 : 0) : (CODE_SET[ch] & op) !== 0);

function symbolChar(op, ch) {
  if (CODE_SET[ch] === (op & 0x1F) || (op & SETA)) return SYMBOL_CHAR[ch];
  if (op & SETB) { const p = ' ,./:'.indexOf(String.fromCharCode(ch)); if (p >= 0) return 47 + p; }
  if ((op & SETE) && ch >= 28 && ch <= 30) return ch + 4;
  return ch === 32 ? 59 : ch;
}

// the codewords of one operation, in order
function opCodewords(op, src, i) {
  if (op === OP_DGTS) {
    let v = 0;
    for (let k = 0; k < 9; k++) v = v * 10 + (src[i + k] - 48);
    return [31, (v >> 24) & 0x3F, (v >> 18) & 0x3F, (v >> 12) & 0x3F, (v >> 6) & 0x3F, v & 0x3F];
  }
  if (op === SH2A) return [56, symbolChar(op, src[i]), symbolChar(op, src[i + 1])];
  if (op === SH3A) return [57, symbolChar(op, src[i]), symbolChar(op, src[i + 1]), symbolChar(op, src[i + 2])];
  const v = symbolChar(op, src[i]);
  if (op & 0x20) return [59 + (op === SHC ? 1 : op === SHD ? 2 : op === SHE ? 3 : 0), v];
  return [v];
}

// The shortest codeword sequence for src, and the set it ends in
function compact(src) {
  const n = src.length;
  const bestLen = Array.from({ length: n + 1 }, () => new Array(STATES).fill(0));
  const bestOrg = Array.from({ length: n + 1 }, () => new Array(STATES).fill(0));
  const pathOp = Array.from({ length: n }, () => new Array(STATES).fill(0));
  const prior = Array.from({ length: n }, () => new Array(STATES).fill(0));
  let digits = 0, numA = 0;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    digits = ch >= 48 && ch <= 57 ? digits + 1 : 0;
    numA = CODE_SET[ch] & SETA ? numA + 1 : 0;
    const row = i + 1; // rows are positions after a character; row 0 is the start
    for (let s = 0; s < STATES; s++) {
      let min = Infinity;
      const consider = (opIdx, intake) => {
        const m = row - intake;
        if (m < 0) return;
        const org = bestOrg[m][s];
        const len = bestLen[m][org] + LATCH_LEN[s][org] + (opIdx === 0 ? 6 : intake + (opIdx >= SHA_IDX ? 1 : 0));
        if (len < min) { min = len; pathOp[i][s] = opIdx; prior[i][s] = org; }
      };
      if (digits >= 9) consider(0, 9);
      else for (const idx of STATE_OPS[s]) if (can(OPS[idx][0], ch, numA)) consider(idx, OPS[idx][1]);
      bestLen[row][s] = min;
    }
    for (let s = 0; s < STATES; s++) {
      let org = 0, ol = bestLen[row][0] + LATCH_LEN[s][0];
      for (let o = 1; o < STATES; o++) { const l = bestLen[row][o] + LATCH_LEN[s][o]; if (l < ol) { org = o; ol = l; } }
      bestOrg[row][s] = org;
    }
  }
  let state = 0, min = Infinity;
  for (let s = 0; s < STATES; s++) if (bestLen[n][s] < min) { min = bestLen[n][s]; state = s; }
  const end = state;
  // backwards along the best path
  const out = [];
  for (let i = n; i > 0;) {
    const pcs = prior[i - 1][state];
    const [op, intake] = OPS[pathOp[i - 1][state]];
    i -= intake;
    out.unshift(...opCodewords(op, src, i));
    if (state !== pcs) { out.unshift(...LATCH_SEQ[state][pcs]); state = pcs; }
  }
  return { cw: out, end };
}

// Reed-Solomon over GF(64) (x^6 + x + 1), generator ∏(x − 2^i), i = 1..k;
// the k check symbols, highest power first (Australia Post's too: auspost.js)
const EXP = new Array(126), LOG = new Array(64);
for (let i = 0, x = 1; i < 63; i++) { EXP[i] = EXP[i + 63] = x; LOG[x] = i; x <<= 1; if (x & 64) x ^= 0x43; }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
export function rs(data, k) {
  let g = [1];
  for (let i = 1; i <= k; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    g = next;
  }
  const r = new Array(k).fill(0);
  for (const d of data) {
    const f = d ^ r[0];
    r.shift(); r.push(0);
    for (let j = 0; j < k; j++) r[j] ^= mul(g[j + 1], f);
  }
  return r;
}

/** The 144 codewords for a message (bytes) */
export function maxiCodewords(bytes) {
  const src = Array.from(bytes, b => b & 0xFF);
  const cw = new Array(144).fill(0);
  let secondary = src, mode = 4;
  // a structured carrier message: [)>␞01␝yy postal␝country␝service␝…
  const head = String.fromCharCode(...src.slice(0, 9));
  if (/^\[\)>\x1E01\x1D\d\d$/.test(head)) {
    const fields = String.fromCharCode(...src.slice(9)).split('\x1D');
    const [post = '', country = '', service = ''] = fields;
    if (/^\d{3}$/.test(country) && /^\d{3}$/.test(service) && post.length >= 1 && post.length <= 9) {
      const numeric = /^\d+$/.test(post);
      mode = numeric ? 2 : 3;
      const c = Number(country), s = Number(service);
      if (numeric) {
        let p = post;
        if (c === 840 && p.length === 5) p += '0000';
        const pn = Number(p), pl = p.length;
        cw.splice(0, 10, ((pn & 0x03) << 4) | 2, (pn & 0xFC) >> 2, (pn & 0x3F00) >> 8, (pn & 0xFC000) >> 14, (pn & 0x3F00000) >> 20,
          ((pn & 0x3C000000) >> 26) | ((pl & 0x03) << 4), ((pl & 0x3C) >> 2) | ((c & 0x03) << 4), (c & 0xFC) >> 2,
          ((c & 0x300) >> 8) | ((s & 0x0F) << 2), (s & 0x3F0) >> 4);
      } else {
        const pc = (post.toUpperCase() + '      ').slice(0, 6).split('').map(ch => SYMBOL_CHAR[ch.charCodeAt(0) & 0xFF]);
        cw.splice(0, 10, ((pc[5] & 0x03) << 4) | 3, ((pc[4] & 0x03) << 4) | ((pc[5] & 0x3C) >> 2), ((pc[3] & 0x03) << 4) | ((pc[4] & 0x3C) >> 2),
          ((pc[2] & 0x03) << 4) | ((pc[3] & 0x3C) >> 2), ((pc[1] & 0x03) << 4) | ((pc[2] & 0x3C) >> 2), ((pc[0] & 0x03) << 4) | ((pc[1] & 0x3C) >> 2),
          ((pc[0] & 0x3C) >> 2) | ((c & 0x03) << 4), (c & 0xFC) >> 2, ((c & 0x300) >> 8) | ((s & 0x0F) << 2), (s & 0x3F0) >> 4);
      }
      // the secondary message keeps the header and the fields after these three
      secondary = [...src.slice(0, 9), ...Array.from(fields.slice(3).join('\x1D'), ch => ch.charCodeAt(0) & 0xFF)];
    }
  }
  const { cw: text, end } = compact(secondary);
  const capacity = mode === 4 ? 93 : 84;
  if (text.length > capacity) return null;
  const data = [...text];
  if (data.length < capacity && (end === C || end === D)) data.push(58); // back to A to pad
  while (data.length < capacity) data.push(end === E ? 28 : 33);
  if (mode === 4) {
    cw[0] = 4;
    for (let k = 0; k < 9; k++) cw[1 + k] = data[k];
    for (let k = 9; k < 93; k++) cw[20 + k - 9] = data[k];
  } else {
    for (let k = 0; k < 84; k++) cw[20 + k] = data[k];
  }
  // primary: 10 data, 10 error; secondary: 84 data, 40 error, even and odd apart
  rs(cw.slice(0, 10), 10).forEach((e, j) => { cw[10 + j] = e; });
  for (const odd of [0, 1]) {
    const half = [];
    for (let j = odd; j < 84; j += 2) half.push(cw[20 + j]);
    rs(half, 20).forEach((e, j) => { cw[20 + 84 + 2 * j + odd] = e; });
  }
  return { cw, mode };
}

/** @param {{ bytes: Uint8Array }} payload */
export function encodeMaxiCode(payload, env) {
  const r = maxiCodewords(payload.bytes);
  if (!r) { env.log('XFA_BARCODE_DATA', 'too much data for a MaxiCode symbol'); return null; }
  const modules = Array.from({ length: 33 }, () => new Uint8Array(30));
  for (let i = 0; i < 33; i++) {
    for (let j = 0; j < 30; j++) {
      const seq = GRID[i * 30 + j] + 5;
      const block = Math.floor(seq / 6);
      if (block && (r.cw[block - 1] >> (5 - (seq % 6))) & 1) modules[i][j] = 1;
    }
  }
  // orientation patterns
  for (const [i, j] of [[0, 28], [0, 29], [9, 10], [9, 11], [10, 11], [15, 7], [16, 8], [16, 20], [17, 20], [22, 10], [23, 10], [22, 17], [23, 17]]) modules[i][j] = 1;
  return { kind: 'maxicode', modules, mode: r.mode };
}
