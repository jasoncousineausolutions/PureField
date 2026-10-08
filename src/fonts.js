/**
 * Purefield / fonts.js
 *
 * Loads the bundled faces used to embed Unicode text: Liberation Sans (SIL
 * OFL 1.1; metric-compatible with Helvetica/Arial) and Source Sans Pro
 * (SIL OFL 1.1; Adobe's humanist sans, close in shape and width to Myriad
 * Pro, Calibri and the Source Sans Pro forms declare). Works in browsers
 * (fetch relative to this module) and Node (file system).
 *
 * @returns {Promise<{ regular: Uint8Array, bold: Uint8Array,
 *   sourceSans: { regular: Uint8Array, bold: Uint8Array, italic: Uint8Array, boldItalic: Uint8Array } }>}
 */
export async function loadBundledFonts() {
  const names = ['LiberationSans-Regular', 'LiberationSans-Bold',
    'SourceSansPro-Regular', 'SourceSansPro-Bold', 'SourceSansPro-It', 'SourceSansPro-BoldIt'];
  const [regular, bold, sRegular, sBold, sItalic, sBoldItalic] = await Promise.all(names.map(loadBundledFont));
  return { regular, bold, sourceSans: { regular: sRegular, bold: sBold, italic: sItalic, boldItalic: sBoldItalic } };
}

/**
 * Gives faces the fonts for the writing systems some text uses: DejaVu
 * Sans (regular and bold, loaded now) for Arabic, Hebrew, Armenian and
 * Georgian. CJK needs nothing loaded (core/faces.js cjkFace).
 * @param {object|null} faces - from core/faces.js prepareFaces
 * @param {string} text - all the text that may be drawn
 * @param {(name: string) => Promise<Uint8Array>} [load]
 */
export async function addScriptFaces(faces, text, log, load = loadBundledFont) {
  if (!faces || !text) return;
  const { scriptsIn } = await import('./xfa/scripts.js');
  const need = scriptsIn(text);
  if (need.other && !faces.fallback) {
    try {
      const [r, b] = await Promise.all([load('DejaVuSans'), load('DejaVuSans-Bold')]);
      faces.addFallback(r, b);
      log?.info?.('FONT_SCRIPTS', 'text in Arabic, Hebrew or another alphabet the Latin faces lack: drawn with DejaVu Sans');
    } catch (e) {
      log?.warn?.('FONT_SCRIPTS', `no face for Arabic, Hebrew or other alphabets (${e.message})`);
    }
  }
  if (need.cjk && !faces.cjkEmbedded) {
    // a CJK TrueType font supplied as "CJK" (fonts/CJK.ttf, or load('CJK')) is embedded
    try { faces.addCjk(await load('CJK')); } catch { /* none: the standard CJK fonts */ }
    log?.once?.('info', 'FONT_CJK', 'cjk', faces.cjkEmbedded ? 'CJK text: drawn with the CJK font supplied, embedded'
      : 'CJK text: drawn with the standard Adobe CJK fonts, not embedded');
  }
}

/**
 * One bundled face by file name ("LiberationSerif-Bold"), loaded when first
 * needed: the faces that stand in for fonts a page does not embed
 * (core/substitute.js) are Liberation Sans, Serif and Mono in four styles
 * and Source Sans Pro.
 * @returns {Promise<Uint8Array>}
 */
export async function loadBundledFont(name) {
  const url = new URL(`../fonts/${name}.ttf`, import.meta.url);
  if (url.protocol === 'file:' && typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not load ${url}: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}
