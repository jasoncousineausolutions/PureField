// Print PDFs as Firefox's pdf.js renders them (XFA enabled), for tools/bench.py.
//
//   node tools/bench/pdfjs-print.mjs --in DIR --out DIR [--jobs N] [--timeout SEC] [--list FILE]
//
// Prints each DIR/<name>.pdf (or each name in --list, one per line) to
// OUT/<name>.pdf, skipping ones already printed, and appends one JSON line
// per file to OUT/status.jsonl: { file, pages, secs } or { file, error }.
// Needs Playwright with Chromium and pdfjs-dist, looked up in $PDFJS_DIR,
// out/bench-tools, out/pdfjs-tool, then node_modules (tools/bench/setup.sh
// installs both); neither is a dependency of Purefield.
//
// Pure XFA documents are drawn by pdf.js's XFA layer (HTML), as Firefox
// shows them; other documents by its canvas renderer with the form widgets
// painted, as Firefox prints them. Each page is shrunk to fit a Letter
// sheet, as Reader prints A4 forms.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1]; };
const samples = resolve(opt('--in', join(root, 'samples/xfa')));
const out = resolve(opt('--out', join(root, 'out/pdfjs')));
const jobs = Number(opt('--jobs', 4));
const timeout = Number(opt('--timeout', 120)) * 1000;
const list = opt('--list', null);
mkdirSync(out, { recursive: true });

const pdfjsDir = [process.env.PDFJS_DIR, join(root, 'out/bench-tools/node_modules/pdfjs-dist'), join(root, 'out/pdfjs-tool/node_modules/pdfjs-dist'), join(root, 'node_modules/pdfjs-dist')]
  .find(d => d && existsSync(join(d, 'legacy/build/pdf.mjs')));
if (!pdfjsDir) throw new Error('pdfjs-dist not found: run tools/bench/setup.sh');

async function loadPlaywright() {
  for (const dir of [join(root, 'out/bench-tools/node_modules/playwright/index.mjs')])
    if (existsSync(dir)) return import(pathToFileURL(dir).href);
  try { return await import('playwright'); } catch {}
  const globalRoot = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(join(globalRoot, 'playwright/index.mjs')).href);
}
const { chromium } = await loadPlaywright();

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf',
  '.json': 'application/json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ORIGIN = 'http://pdfjs.local';

// The page: renders the document into #pages, one Letter-sized sheet per page
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${ORIGIN}/pdfjs/legacy/web/pdf_viewer.css">
<style>
  @page { size: 8.5in 11in; margin: 0 }
  html, body { margin: 0; padding: 0; background: white }
  .sheet { position: relative; width: 816px; height: 1056px; overflow: hidden; break-after: page }
  .sheet > .xfaLayer, .sheet > canvas { position: absolute; top: 0; left: 0 }
</style></head><body><div id="pages"></div>
<script type="module">
  // the legacy build: the modern one needs newer JavaScript than
  // Playwright's Chromium has (Map.prototype.getOrInsertComputed)
  import * as pdfjs from '${ORIGIN}/pdfjs/legacy/build/pdf.mjs';
  import { SimpleLinkService } from '${ORIGIN}/pdfjs/legacy/web/pdf_viewer.mjs';
  pdfjs.GlobalWorkerOptions.workerSrc = '${ORIGIN}/pdfjs/legacy/build/pdf.worker.mjs';
  window.render = async name => {
    const doc = await pdfjs.getDocument({
      url: '${ORIGIN}/samples/' + encodeURIComponent(name), enableXfa: true,
      standardFontDataUrl: '${ORIGIN}/pdfjs/standard_fonts/', cMapUrl: '${ORIGIN}/pdfjs/cmaps/', cMapPacked: true,
      wasmUrl: '${ORIGIN}/pdfjs/wasm/', iccUrl: '${ORIGIN}/pdfjs/iccs/',
    }).promise;
    const pages = document.getElementById('pages');
    const css = 96 / 72; // CSS px per point
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(612 / base.width, 792 / base.height, 1);
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      pages.append(sheet);
      if (doc.isPureXfa) {
        const xfaHtml = await page.getXfa();
        const div = document.createElement('div');
        sheet.append(div);
        const viewport = page.getViewport({ scale: fit * css });
        pdfjs.XfaLayer.render({ viewport: viewport.clone({ dontFlip: true }), div, xfaHtml,
          annotationStorage: doc.annotationStorage, linkService: new SimpleLinkService(), intent: 'print' });
      } else {
        const viewport = page.getViewport({ scale: fit * css * 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = canvas.width / 2 + 'px';
        canvas.style.height = canvas.height / 2 + 'px';
        sheet.append(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print',
          annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
      }
    }
    await document.fonts.ready;
    await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
    return { pages: doc.numPages, pureXfa: doc.isPureXfa };
  };
  window.ready = true;
</script></body></html>`;

const names = (list ? readFileSync(list, 'utf8').split('\n') : readdirSync(samples))
  .map(f => f.trim()).filter(f => /\.pdf$/i.test(f) && !existsSync(join(out, f))).sort();
const status = join(out, 'status.jsonl');
const record = r => appendFileSync(status, JSON.stringify(r) + '\n');
const withTimeout = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`timed out (${what})`)), timeout))]);

async function printOne(browser, name) {
  const started = Date.now();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = path === '/' ? null
      : path.startsWith('/pdfjs/') ? join(pdfjsDir, path.slice(7))
      : path.startsWith('/samples/') ? join(samples, path.slice(9)) : null;
    if (!file) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  try {
    const pdf = await withTimeout((async () => {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction(() => window.ready === true);
      const info = await page.evaluate(n => window.render(n), name);
      await page.waitForTimeout(300); // let images and fonts settle
      return { info, bytes: await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }) };
    })(), 'pdf.js');
    writeFileSync(join(out, name), pdf.bytes);
    record({ file: name, pages: pdf.info.pages, secs: (Date.now() - started) / 1000 });
  } catch (e) {
    record({ file: name, error: [e.message.split('\n')[0], ...errors].join('; ').slice(0, 300), secs: (Date.now() - started) / 1000 });
  } finally {
    await page.close().catch(() => {});
  }
}

let browser = await chromium.launch();
let next = 0, done = 0;
const worker = async () => {
  while (next < names.length) {
    const name = names[next++];
    // a crashed browser is relaunched; the file that crashed it is recorded as an error
    if (!browser.isConnected()) browser = await chromium.launch();
    await printOne(browser, name);
    if (++done % 50 === 0) console.log(`pdf.js: ${done}/${names.length}`);
  }
};
try {
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
} finally {
  await browser.close().catch(() => {});
}
console.log(`pdf.js: printed ${done} file(s) into ${out}`);
