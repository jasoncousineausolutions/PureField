// A minimal PDF writer for tests: objects given as source text by number
// (1 must be the catalog), streams written as { dict, stream } pairs
export function buildPdf(objects) {
  const enc = new TextEncoder();
  const parts = [enc.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
  let pos = parts[0].length;
  const offsets = [];
  const nums = Object.keys(objects).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    offsets[n] = pos;
    const o = objects[n];
    const body = typeof o === 'string' ? o
      : `${o.dict.replace(/>>\s*$/, '')} /Length ${enc.encode(o.stream).length} >>\nstream\n${o.stream}\nendstream`;
    const bytes = enc.encode(`${n} 0 obj\n${body}\nendobj\n`);
    parts.push(bytes);
    pos += bytes.length;
  }
  const size = nums.at(-1) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    xref += offsets[n] !== undefined ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
