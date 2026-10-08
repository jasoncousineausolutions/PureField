// Flatten one PDF with Purefield for tools/bench.py.
//   node tools/bench/flatten-one.mjs IN.pdf OUT.pdf [password]
// Prints one JSON line: { pages } on success, { error } on failure.
import '../../test/node/setup.js';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { flattenXfa } from '../../src/index.js';

const [input, output, password = ''] = process.argv.slice(2);
try {
  const { pdf, pageCount } = await flattenXfa(readFileSync(input), { password });
  writeFileSync(output, pdf);
  console.log(JSON.stringify({ pages: pageCount }));
} catch (e) {
  rmSync(output, { force: true });
  console.log(JSON.stringify({ error: String(e?.message ?? e).split('\n')[0] }));
}
