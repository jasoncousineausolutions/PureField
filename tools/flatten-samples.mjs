// Flatten every PDF of a folder (default samples/xfa/) into an output folder
// (default out/flattened/). Node, uses @xmldom/xmldom.
//   node tools/flatten-samples.mjs [name-filter] [--in DIR] [--out DIR]
//   node tools/flatten-samples.mjs --in samples/xfa --out out/batch3
import '../test/node/setup.js';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenXfa } from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const dir = resolve(root, opt('--in') ?? 'samples/xfa');
const out = resolve(root, opt('--out') ?? 'out/flattened');
mkdirSync(out, { recursive: true });
const filter = args[0] ?? '';
// a folder's sources.json may give a file's password ({ "name": { "password": … } })
const sources = existsSync(join(dir, 'sources.json')) ? JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8')) : {};
const passwordOf = f => {
  const name = f.replace(/\.pdf$/, '');
  const entry = Array.isArray(sources) ? sources.find(s => s.file === name || s.name === name) : sources[name] ?? sources.files?.[name];
  return entry?.password ?? '';
};
for (const f of readdirSync(dir).filter(f => f.endsWith('.pdf') && f.includes(filter)).sort()) {
  try {
    const { pdf, pageCount, static: kept, log } = await flattenXfa(readFileSync(join(dir, f)), { password: passwordOf(f) });
    writeFileSync(join(out, f), pdf);
    const codes = {};
    for (const e of log.entries) codes[e.code] = (codes[e.code] || 0) + 1;
    console.log(f.padEnd(38), 'pages', pageCount, kept ? 'STATIC' : '', JSON.stringify(codes));
  } catch (e) {
    // no stale output from an earlier run
    rmSync(join(out, f), { force: true });
    console.log(f.padEnd(38), 'ERROR', e.message);
  }
}
