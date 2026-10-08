// Flatten the sample PDFs in headless Chromium (src/index.js served over
// HTTP, fonts loaded by fetch, the browser's own DOMParser) and in Node, and
// compare the two outputs byte for byte. Needs Playwright and python3 (for
// the static server); neither is a dependency of the library.
//   node tools/browser-check.mjs [name-filter]
//   CHROMIUM=/path/to/chromium node tools/browser-check.mjs
import '../test/node/setup.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { flattenXfa } from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  // a global install (npm i -g playwright)
  const globalRoot = (await import('node:child_process')).execSync('npm root -g').toString().trim();
  ({ chromium } = require(`${globalRoot}/playwright`));
}
const PORT = 8000 + Math.floor(Math.random() * 1000);
// scripts see the same date in both runtimes
const NOW = '2026-01-15T12:00:00Z';
const filter = process.argv[2] ?? '';
const sets = ['samples/xfa', 'samples/nonxfa', 'samples/reader-tests'];
const files = [];
for (const s of sets) {
  if (!existsSync(`${root}/${s}`)) continue;
  const src = existsSync(`${root}/${s}/sources.json`) ? JSON.parse(readFileSync(`${root}/${s}/sources.json`, 'utf8')) : {};
  for (const f of readdirSync(`${root}/${s}`).filter(f => f.endsWith('.pdf') && f.includes(filter)).sort())
    files.push({ path: `${s}/${f}`, password: (Array.isArray(src) ? null : src[f.slice(0, -4)])?.password ?? '' });
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
for (let i = 0; ; i++) {
  try { await page.goto(`http://127.0.0.1:${PORT}/test/test.html`); break; } catch (e) {
    if (i > 20) throw e;
    await new Promise(r => setTimeout(r, 250));
  }
}
console.log('browser:', await page.evaluate(() => navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]));

let same = 0, diff = 0, fail = 0;
for (const { path, password } of files) {
  const b = await page.evaluate(async ({ path, password, NOW }) => {
    try {
      const { flattenXfa } = await import('/src/index.js');
      const buf = await (await fetch('/' + path)).arrayBuffer();
      const r = await flattenXfa(buf, { password, now: new Date(NOW) });
      const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', r.pdf))].map(x => x.toString(16).padStart(2, '0')).join('');
      return { h, pages: r.pageCount, n: r.pdf.length };
    } catch (e) { return { err: String(e?.message ?? e).slice(0, 200) }; }
  }, { path, password, NOW });
  let n;
  try {
    const r = await flattenXfa(readFileSync(`${root}/${path}`), { password, now: new Date(NOW) });
    n = { h: createHash('sha256').update(r.pdf).digest('hex'), pages: r.pageCount, n: r.pdf.length };
  } catch (e) { n = { err: String(e?.message ?? e).slice(0, 200) }; }
  const verdict = b.err ? (n.err ? 'both throw' : 'BROWSER THROWS') : n.err ? 'NODE THROWS' : b.h === n.h ? 'same' : 'DIFFERENT';
  if (verdict === 'same' || verdict === 'both throw') same++; else if (verdict === 'DIFFERENT') diff++; else fail++;
  if (verdict !== 'same') console.log(verdict.padEnd(15), path, b.err ?? `${b.pages}p ${b.n}B`, '|', n.err ?? `${n.pages}p ${n.n}B`);
}
console.log(`${files.length} files: ${same} identical, ${diff} different, ${fail} failing in one runtime only`);
if (errors.length) console.log('page errors:', errors);
await browser.close();
server.kill();
process.exit(diff || fail ? 1 : 0);
