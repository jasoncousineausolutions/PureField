/**
 * Purefield / core / cloudy.js
 *
 * Cloudy borders (/BE /S /C, PDF 32000 §12.5.4) drawn as Acrobat draws
 * them: curls of radius 4 × intensity + half the line width (4.75 ×
 * intensity for ellipses) whose centres lie on the path, 2·cos 34°·r apart,
 * each an arc from 12° past the backward direction (its "tail", inside the
 * curl before) round the outside to where it meets the next. Every polygon
 * edge has a curl at each corner and as many between them as fit, the
 * leading arcs adjusted so the curls fill the edge exactly; an ellipse has
 * evenly spaced curls round it.
 *
 *   cloudyRect(cs, left, bottom, right, top, intensity, lineWidth)
 *   cloudyEllipse(cs, left, bottom, right, top, intensity, lineWidth)
 *   cloudyPolygon(cs, points, intensity, lineWidth)
 *
 * Each writes one closed path (no paint operator). A polygon's points are
 * its /Vertices as given: unless the last point repeats the first, the
 * closing edge back to the first is drawn straight and the first vertex has
 * no corner curl, as Reader prints a Polygon.
 *
 * Ported from Apache PDFBox (pdfbox/.../annotation/handlers/CloudyBorder.java,
 * Apache License 2.0), whose geometry was deduced from Acrobat's appearance
 * streams.
 */

const DEG = Math.PI / 180;
const A34 = 34 * DEG, A30 = 30 * DEG, A12 = 12 * DEG, A90 = Math.PI / 2, A180 = Math.PI;
const K = Math.cos(A34);

class Path {
  constructor(cs) { this.cs = cs; this.started = false; }
  moveTo(x, y) { this.cs.moveTo(x, y); this.started = true; }
  curveTo(...p) { this.cs.curveTo(...p); }
  // one Bézier for an arc of at most 90° (either direction)
  segment(a, b, cx, cy, rx, ry, move = false) {
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const denom = Math.sin((b - a) / 2);
    if (move) this.moveTo(cx + rx * ca, cy + ry * sa);
    if (denom === 0) return;
    const bcp = 1.333333333 * (1 - Math.cos((b - a) / 2)) / denom;
    this.curveTo(cx + rx * (ca - bcp * sa), cy + ry * (sa + bcp * ca),
      cx + rx * (cb + bcp * sb), cy + ry * (sb - bcp * cb), cx + rx * cb, cy + ry * sb);
  }
  // an arc in the positive direction, in 90° pieces
  arc(a, b, rx, ry, cx, cy, move = false) {
    let todo = b - a;
    while (todo < 0) todo += 2 * Math.PI;
    const sweep = todo;
    let done = 0;
    if (move) this.moveTo(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    while (todo > A90) {
      this.segment(a + done, a + done + A90, cx, cy, rx, ry);
      done += A90;
      todo -= A90;
    }
    if (todo > 0) this.segment(a + done, a + sweep, cx, cy, rx, ry);
  }
  cornerCurl(anglePrev, angleCur, r, cx, cy, alpha, alphaPrev) {
    const a = anglePrev + A180 + alphaPrev;
    const b = a - 22 * DEG;
    this.segment(a, b, cx, cy, r, r, !this.started);
    this.arc(b, angleCur - alpha, r, r, cx, cy);
  }
}

const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

// n intermediate curls on an edge of this length, and the adjusted angle
// alpha and half-error dx of its adjustable arcs
function polygonParams(advInterm, advCorner, r, length) {
  if (length === 0) return { n: -1, alpha: A34, dx: 0 };
  const n = Math.ceil((length - 2 * advCorner) / advInterm);
  const dx = (length - (2 * advCorner + n * advInterm)) / 2;
  const arg = (K * r + dx) / r;
  return { n, alpha: arg < -1 || arg > 1 ? 0 : Math.acos(arg), dx };
}

function polygonCurls(path, input, r) {
  // drop zero-length edges (the last point may still repeat the first)
  const pts = [input[0]];
  for (let i = 1; i < input.length; i++) {
    if (Math.abs(input[i][0] - input[i - 1][0]) < 0.5 && Math.abs(input[i][1] - input[i - 1][1]) < 0.5) continue;
    pts.push(input[i]);
  }
  // counter-clockwise, so the outside is to the right of each edge
  let area = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - p[1] * q[0]; });
  if (area < 0) pts.reverse();
  const np = pts.length;
  if (np < 2) return;
  r = Math.max(0.5, r);
  const advInterm = 2 * K * r, advCorner = K * r;
  // Open (a Polygon's /Vertices, as Reader draws it): every vertex but the
  // first has a corner curl, the last one's turning towards the first; the
  // closing edge has no curls (the path's close draws it straight) and the
  // path starts with the first edge's first intermediate curl. Closed (a
  // rectangle, its last point the first): a corner curl at every vertex.
  const closed = np > 2 && dist(pts[0], pts[np - 1]) < 0.5;
  const ring = closed ? pts : [...pts, pts[0]];
  const nr = ring.length;
  const first = polygonParams(advInterm, advCorner, r, dist(ring[nr - 2], ring[0]));
  let alphaPrev = first.n === 0 ? first.alpha : A34;
  let anglePrev = 0;
  for (let j = 0; j + 1 < nr; j++) {
    const pt = ring[j], next = ring[j + 1];
    const length = dist(pt, next);
    if (length === 0) { alphaPrev = A34; continue; }
    const { n, alpha, dx } = polygonParams(advInterm, advCorner, r, length);
    if (n < 0) {
      if (!path.started) path.moveTo(...pt);
      continue;
    }
    const angleCur = Math.atan2(next[1] - pt[1], next[0] - pt[0]);
    if (j === 0) {
      const prev = ring[nr - 2];
      anglePrev = Math.atan2(pt[1] - prev[1], pt[0] - prev[0]);
    }
    const cos = (next[0] - pt[0]) / length, sin = (next[1] - pt[1]) / length;
    if (closed || j > 0) path.cornerCurl(anglePrev, angleCur, r, pt[0], pt[1], alpha, alphaPrev);
    if (!closed && j === nr - 2) break;
    // to the centre of the first intermediate curl
    const adv = 2 * K * r + 2 * dx;
    let x = pt[0] + adv * cos, y = pt[1] + adv * sin;
    let interm = n;
    const a = angleCur + A180;
    if (n >= 1) {
      path.segment(a + alpha, a + alpha - A30, x, y, r, r, !path.started);
      path.segment(a + alpha - A30, a + A90, x, y, r, r);
      path.segment(a + A90, a + A180 - A34, x, y, r, r);
      x += advInterm * cos;
      y += advInterm * sin;
      interm = n - 1;
    }
    for (let i = 0; i < interm; i++) {
      path.segment(a + A34, a + A12, x, y, r, r);
      path.segment(a + A12, a + A90, x, y, r, r);
      path.segment(a + A90, a + A180 - A34, x, y, r, r);
      x += advInterm * cos;
      y += advInterm * sin;
    }
    anglePrev = angleCur;
    alphaPrev = n === 0 ? alpha : A34;
  }
}

function ellipsePath(path, l, b, r, t) {
  const rx = Math.abs(r - l) / 2, ry = Math.abs(t - b) / 2;
  path.arc(0, 2 * Math.PI, rx, ry, (l + r) / 2, (b + t) / 2, true);
}

function rectCurls(path, l, b, r, t, radius) {
  const w = r - l, h = t - b;
  const poly = w < 1 ? [[l, b], [l, t], [l, b]]
    : h < 1 ? [[l, b], [r, b], [l, b]]
    : [[l, b], [r, b], [r, t], [l, t], [l, b]];
  polygonCurls(path, poly, radius);
}

/** A cloudy rectangle (a Square or FreeText's box less /RD) */
export function cloudyRect(cs, l, b, r, t, intensity, lineWidth) {
  if (intensity <= 0) { cs.rect(l, b, r - l, t - b); return; }
  const path = new Path(cs);
  rectCurls(path, l, b, r, t, 4 * intensity + 0.5 * lineWidth);
  if (path.started) cs.closePath();
}

/** A cloudy polygon: /Vertices as [[x, y], …] */
export function cloudyPolygon(cs, points, intensity, lineWidth) {
  const path = new Path(cs);
  if (intensity <= 0) {
    points.forEach((p, i) => (i ? cs.lineTo(...p) : cs.moveTo(...p)));
    cs.closePath();
    return;
  }
  polygonCurls(path, points, 4 * intensity + 0.5 * lineWidth);
  if (path.started) cs.closePath();
}

// the ellipse in the rectangle as a polygon, each Bézier quarter split
// until its control points are within 0.5 of its chord
function flattenEllipse(l, b, r, t) {
  const cx = (l + r) / 2, cy = (b + t) / 2, rx = (r - l) / 2, ry = (t - b) / 2, k = 0.5522847498;
  const out = [[cx + rx, cy]];
  const quarters = [
    [[cx + rx, cy], [cx + rx, cy + k * ry], [cx + k * rx, cy + ry], [cx, cy + ry]],
    [[cx, cy + ry], [cx - k * rx, cy + ry], [cx - rx, cy + k * ry], [cx - rx, cy]],
    [[cx - rx, cy], [cx - rx, cy - k * ry], [cx - k * rx, cy - ry], [cx, cy - ry]],
    [[cx, cy - ry], [cx + k * rx, cy - ry], [cx + rx, cy - k * ry], [cx + rx, cy]],
  ];
  const lineDist = (p, a, c) => {
    const dx = c[0] - a[0], dy = c[1] - a[1], len = Math.hypot(dx, dy);
    return len ? Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len : dist(p, a);
  };
  const split = (q, depth) => {
    if (depth >= 10 || Math.max(lineDist(q[1], q[0], q[3]), lineDist(q[2], q[0], q[3])) <= 0.5) { out.push(q[3]); return; }
    const mid = (a, c) => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    const ab = mid(q[0], q[1]), bc = mid(q[1], q[2]), cd = mid(q[2], q[3]), abc = mid(ab, bc), bcd = mid(bc, cd), m = mid(abc, bcd);
    split([q[0], ab, abc, m], depth + 1);
    split([m, bcd, cd, q[3]], depth + 1);
  };
  quarters.forEach(q => split(q, 0));
  return out;
}

/** A cloudy ellipse (a Circle's rectangle less /RD) */
export function cloudyEllipse(cs, l0, b0, r0, t0, intensity, lineWidth) {
  const path = new Path(cs);
  const basic = () => { ellipsePath(path, l0, b0, r0, t0); cs.closePath(); };
  if (intensity <= 0) return basic();
  let [l, b, r, t] = [l0, b0, r0, t0];
  const width = r - l, height = t - b;
  let radius = 4.75 * intensity + 0.5 * lineWidth;
  if (width < 0.5 * radius && height < 0.5 * radius) return basic();
  // very flat: a cloudy rectangle
  if ((width < 5 && height > 20) || (width > 20 && height < 5)) {
    rectCurls(path, l, b, r, t, radius);
    if (path.started) cs.closePath();
    return;
  }
  // the curls' tails just touch the ellipse
  const adj = Math.sin(A12) * radius - 1.5;
  if (width > 2 * adj) { l += adj; r -= adj; } else { const m = (l + r) / 2; l = m - 0.1; r = m + 0.1; }
  if (height > 2 * adj) { t -= adj; b += adj; } else { const m = (t + b) / 2; t = m + 0.1; b = m - 0.1; }
  const flat = flattenEllipse(l, b, r, t);
  let total = 0;
  for (let i = 1; i < flat.length; i++) total += dist(flat[i - 1], flat[i]);
  let advance = 2 * K * radius;
  const n = Math.ceil(total / advance);
  if (n < 2) return basic();
  advance = total / n;
  radius = advance / (2 * K);
  if (radius < 0.5) { radius = 0.5; advance = 2 * K * radius; } else if (radius < 3) return basic();
  // the curls' centres, every `advance` along the flattened ellipse
  const centres = [];
  let remain = 0;
  const toler = lineWidth * 0.1;
  for (let i = 0; i + 1 < flat.length; i++) {
    const p1 = flat[i], p2 = flat[i + 1];
    const length = dist(p1, p2);
    if (length === 0) continue;
    let todo = length + remain;
    if (todo >= advance - toler || i === flat.length - 2) {
      const cos = (p2[0] - p1[0]) / length, sin = (p2[1] - p1[1]) / length;
      let d = advance - remain;
      do {
        if (centres.length < n) centres.push([p1[0] + d * cos, p1[1] + d * sin]);
        todo -= advance;
        d += advance;
      } while (todo >= advance - toler);
      remain = Math.max(0, todo);
    } else remain += length;
  }
  const alphaOf = (p, q) => {
    const length = dist(p, q);
    if (length === 0) return A34;
    const arg = (advance / 2 + (length - advance) / 2) / radius;
    return arg < -1 || arg > 1 ? 0 : Math.acos(arg);
  };
  const m = centres.length;
  let anglePrev = 0, alphaPrev = 0;
  for (let i = 0; i < m; i++) {
    const pt = centres[i], next = centres[(i + 1) % m];
    if (i === 0) {
      const prev = centres[m - 1];
      anglePrev = Math.atan2(pt[1] - prev[1], pt[0] - prev[0]);
      alphaPrev = alphaOf(prev, pt);
    }
    const angleCur = Math.atan2(next[1] - pt[1], next[0] - pt[0]);
    const alpha = alphaOf(pt, next);
    path.cornerCurl(anglePrev, angleCur, radius, pt[0], pt[1], alpha, alphaPrev);
    anglePrev = angleCur;
    alphaPrev = alpha;
  }
  if (path.started) cs.closePath();
}

/** A rectangle less /RD ([left, top, right, bottom]), each side in by at least `min` (PDFBox applyRectDiff) */
export function rectLessDiff(rect, rd, min) {
  const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const [l = 0, t = 0, r = 0, b = 0] = rd ?? [];
  return [x0 + Math.max(l, min), y0 + Math.max(b, min), x1 - Math.max(r, min), y1 - Math.max(t, min)];
}
