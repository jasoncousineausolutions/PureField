// Print every samples/xfa/*.pdf that has a Reader print to out/pdfjs/<name>.pdf
// as Firefox's pdf.js renders it (XFA enabled), for comparison with jcs-pdf.
//
//   npm install --prefix out/pdfjs-tool --no-save --no-package-lock pdfjs-dist@latest
//   node tools/pdfjs-render.mjs [name-filter]
//   python3 tools/score.py out/pdfjs
//
// Needs Playwright with Chromium (resolved locally or from the global npm
// root). pdfjs-dist is looked up in $PDFJS_DIR, out/pdfjs-tool, then
// node_modules; it is a temporary tool, not a dependency of jcs-pdf.
//
// Pure XFA documents are drawn by pdf.js's XFA layer (HTML), as Firefox
// shows them; static XFA documents by its canvas renderer with the form
// widgets painted, as Firefox prints them. Each page is shrunk to fit a
// Letter sheet, as Reader printed the A4 forms.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const samples = join(root, 'samples/xfa');
const prints = join(samples, 'acrobat');
const out = join(root, 'out/pdfjs');
mkdirSync(out, { recursive: true });

const pdfjsDir = [process.env.PDFJS_DIR, join(root, 'out/pdfjs-tool/node_modules/pdfjs-dist'), join(root, 'node_modules/pdfjs-dist')]
  .find(d => d && existsSync(join(d, 'legacy/build/pdf.mjs')));
if (!pdfjsDir) throw new Error('pdfjs-dist not found: npm install --prefix out/pdfjs-tool --no-save --no-package-lock pdfjs-dist@latest');

async function loadPlaywright() {
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

const filter = process.argv[2] ?? '';
const names = readdirSync(prints).filter(f => f.endsWith('.pdf') && f.includes(filter) && existsSync(join(samples, f))).sort();

const browser = await chromium.launch();
try {
  for (const name of names) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (process.env.DEBUG) page.on('console', m => console.error('  console:', m.text()));
    await page.route(`${ORIGIN}/**`, route => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname);
      const file = path === '/' ? null
        : path.startsWith('/pdfjs/') ? join(pdfjsDir, path.slice(7))
        : path.startsWith('/samples/') ? join(samples, path.slice(9)) : null;
      if (!file) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    });
    try {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction(() => window.ready === true);
      const info = await page.evaluate(n => window.render(n), name);
      await page.waitForTimeout(300); // let images and fonts settle
      writeFileSync(join(out, name), await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
      console.log(name.padEnd(38), 'pages', info.pages, info.pureXfa ? 'XFA' : 'static', errors.length ? `errors: ${errors.join('; ')}` : '');
    } catch (e) {
      console.log(name.padEnd(38), 'ERROR', e.message.split('\n')[0], errors.join('; '));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
