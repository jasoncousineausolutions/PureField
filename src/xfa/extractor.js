/**
 * Purefield / xfa / extractor.js
 *
 * Pulls the XFA packets out of a parsed PDF document (spec §1,
 * docs/REDUCED_XFA_SPEC.txt).
 *
 * Catalog → AcroForm → /XFA. The entry is either:
 *   - an array of alternating name/stream pairs  ← most common
 *       /XFA [ (preamble) 3 0 R (config) 4 0 R (template) 5 0 R ... ]
 *   - one stream holding a whole XDP document     ← split into packets here
 *
 * Packet names are normalised (dataSets → datasets, localeset → localeSet).
 * We keep template (required), datasets, localeSet, config and the form
 * packet (the saved form state, see formstate.js). Everything else —
 * connectionSet, xmpmeta, signature, unknown packets — is discarded and
 * logged. preamble/postamble and the xdp:xdp wrappers are framing only.
 */

import { XfaLog } from './log.js';

// Packets we keep, by normalised name
const KEPT = new Set(['template', 'datasets', 'localeSet', 'config', 'form']);

// Framing fragments of the array form — not XML packets
const FRAMING = new Set(['preamble', 'postamble']);

const NAME_ALIASES = {
  datasets: 'datasets',
  dataSets: 'datasets',
  data:     'datasets',
  localeSet: 'localeSet',
  localeset: 'localeSet',
};

/**
 * Parse XML text as the XFA packets and rich text are parsed everywhere:
 * leading whitespace and BOM dropped, and line ends normalised as XML 1.1
 * does (CR LF, CR, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR to LF, which
 * @xmldom/xmldom does too). Browsers parse as XML 1.0 and would keep a
 * U+2029 that Reader breaks the line at. A document a stray '&' (one that
 * starts no reference) makes ill-formed is parsed again with it escaped:
 * Reader and @xmldom/xmldom read it as text, a browser rejects the packet.
 */
export function parseXmlText(text) {
  const src = xmlLineEnds(String(text).replace(/^[\s\uFEFF]+/, ''));
  const xml = new DOMParser().parseFromString(src, 'application/xml');
  if (xml && hasParseError(xml)) {
    const fixed = src.replace(STRAY_AMP, (m, keep) => keep ?? '&amp;');
    if (fixed !== src) {
      const again = new DOMParser().parseFromString(fixed, 'application/xml');
      if (again && !hasParseError(again)) return again;
    }
  }
  return xml;
}

// an '&' that starts no entity or character reference (CDATA sections and
// comments kept as they are)
const STRAY_AMP = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)|&(?!(?:[A-Za-z_][\w.-]*|#\d+|#x[\da-fA-F]+);)/g;

export function xmlLineEnds(text) {
  return text.replace(/\r[\n\u0085]/g, '\n').replace(/[\r\u0085\u2028\u2029]/g, '\n');
}

/** Strip a namespace prefix and map aliases to the canonical packet name. */
export function normalizePacketName(raw) {
  const local = String(raw).trim().split(':').pop();
  return NAME_ALIASES[local] ?? local;
}

/**
 * Extract the XFA packets from a PdfDocument.
 *
 * @param {PdfDocument} doc - from parsePdf()
 * @param {{ log?: XfaLog }} [opts]
 * @returns {Promise<XfaStreams|null>} - null if the PDF has no XFA
 * @throws if the PDF has XFA but no template packet, or a malformed /XFA array
 */
export async function extractXfa(doc, { log = new XfaLog() } = {}) {
  const catalog = await doc.catalog();
  if (!catalog) throw new Error('Could not read PDF catalog');
  const catalogDict = dictOf(catalog);

  const acroFormRef = catalogDict.AcroForm;
  if (!acroFormRef) return null; // No form at all

  const acroDict = dictOf(await resolveObj(doc, acroFormRef));
  let xfaVal = acroDict.XFA;
  if (!xfaVal) return null; // AcroForm exists but no XFA — regular AcroForm

  const raw = []; // [name, text] in file order

  // An indirect /XFA can point at either a stream or an array object
  let xfaStream = null;
  if (xfaVal.type === 'ref') {
    const obj = await doc.getObject(xfaVal.num);
    if (obj?.streamBytes) xfaStream = obj;
    else xfaVal = obj?.value ?? obj;
  }

  if (xfaStream) {
    splitXdp(decode(xfaStream.streamBytes), raw, log);
  } else if (xfaVal?.type === 'array') {
    const items = xfaVal.value;
    if (items.length % 2 !== 0) {
      throw new Error(`Malformed /XFA array: odd length ${items.length}`);
    }
    for (let i = 0; i < items.length; i += 2) {
      const nameItem = items[i];
      const refItem  = items[i + 1];
      const name = nameItem?.type === 'string' ? nameItem.value
                 : typeof nameItem === 'string' ? nameItem
                 : String(nameItem?.value ?? nameItem);

      if (refItem?.type !== 'ref') {
        log.warn('XFA_PACKET_UNREADABLE', `Packet "${name}" is not a stream reference`);
        continue;
      }
      const streamObj = await doc.getObject(refItem.num);
      if (!streamObj?.streamBytes) {
        log.warn('XFA_PACKET_UNREADABLE', `Packet "${name}" has no stream data`);
        continue;
      }
      raw.push([name, decode(streamObj.streamBytes)]);
    }
  } else {
    throw new Error('Malformed /XFA entry: expected a stream or an array');
  }

  // Normalise names, keep the four packets we use, log the rest.
  // Duplicate canonical packets keep the last one.
  const streams = {};
  const discarded = [];
  for (const [rawName, text] of raw) {
    const name = normalizePacketName(rawName);
    // the array form's first and last entries frame the XDP: "xdp:xdp", "</xdp:xdp>"
    if (FRAMING.has(name) || /^<?\/?xdp(:xdp)?>?$/.test(String(rawName).trim())) continue;
    if (KEPT.has(name)) streams[name] = text;
    else discarded.push(name);
  }
  if (discarded.length) {
    log.info('XFA_PACKET_DISCARDED', `Discarded packets: ${discarded.join(', ')}`);
  }

  if (!streams.template) throw new Error('XFA has no template packet');

  const needsRendering = catalogDict.NeedsRendering === true;
  const xfa = new XfaStreams(streams, { needsRendering, discarded, log });
  xfa.images = await readXfaImages(doc, catalogDict);
  return xfa;
}

/**
 * The images a template names by href, from the catalog's /Names
 * /XFAImages name tree (pdf.js reads it too): href → the image file's bytes
 * (itext-dataset-2page's logos, href=".\Resources\…png", live there).
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readXfaImages(doc, catalogDict) {
  const images = new Map();
  const names = dictOf(await resolveObj(doc, catalogDict.Names));
  if (!names.XFAImages) return images;
  const seen = new Set();
  const walk = async (ref, depth) => {
    if (depth > 32) return;
    if (ref?.type === 'ref') { if (seen.has(ref.num)) return; seen.add(ref.num); }
    const node = dictOf(await resolveObj(doc, ref));
    const kids = await resolveObj(doc, node.Kids);
    for (const k of arrayOf(kids)) await walk(k, depth + 1);
    const pairs = arrayOf(await resolveObj(doc, node.Names));
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const key = pairs[i]?.type === 'string' ? pairs[i].value : null;
      const val = pairs[i + 1];
      const obj = val?.type === 'ref' ? await doc.getObject(val.num) : null;
      if (key !== null && obj?.streamBytes && !images.has(key)) images.set(pdfText(key), obj.streamBytes);
    }
  };
  await walk(names.XFAImages, 0);
  return images;
}

function arrayOf(v) {
  const a = v?.value ?? v;
  return Array.isArray(a) ? a : a?.type === 'array' ? a.value : [];
}

// A PDF text string: UTF-16BE with a byte order mark, else bytes as is
function pdfText(s) {
  if (s.charCodeAt(0) === 0xFE && s.charCodeAt(1) === 0xFF) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  return s;
}

// Split a full XDP document into its packets: each element child of the
// <xdp:xdp> root is one packet, named by its local name.
function splitXdp(text, out, log) {
  const xml = parseXmlText(text);
  const root = xml.documentElement;
  if (!root || hasParseError(xml)) throw new Error('XFA stream is not a well-formed XDP document');

  for (const child of elementChildren(root)) {
    out.push([localName(child), serialize(child)]);
  }
  if (out.length === 0) log.warn('XFA_PACKET_UNREADABLE', 'XDP stream contains no packets');
}

export class XfaStreams {
  /**
   * @param {Object<string,string>} streams - normalised packet name → XML text
   * @param {{ needsRendering?: boolean, discarded?: string[], log?: XfaLog }} [meta]
   */
  constructor(streams, { needsRendering = false, discarded = [], log = new XfaLog() } = {}) {
    this._streams = streams;
    this._xml = new Map();
    /** Catalog /NeedsRendering — the primary dynamic-form signal (spec §9) */
    this.needsRendering = needsRendering;
    /** Names of packets dropped during extraction */
    this.discarded = discarded;
    this.log = log;
  }

  /** Names of the kept packets */
  get names() {
    return Object.keys(this._streams);
  }

  /** Raw XML string for a packet */
  get(name) {
    return this._streams[normalizePacketName(name)] ?? null;
  }

  /** Parse a packet as XML (cached), return a Document */
  parseXml(name) {
    const key = normalizePacketName(name);
    if (this._xml.has(key)) return this._xml.get(key);
    const text = this.get(key);
    const xml = text
      ? parseXmlText(text)
      : null;
    this._xml.set(key, xml);
    return xml;
  }

  /** Convenience: parse the template packet */
  get template() {
    return this.parseXml('template');
  }

  /** Convenience: parse the datasets packet */
  get datasets() {
    return this.parseXml('datasets');
  }

  /** Convenience: parse the localeSet packet */
  get localeSet() {
    return this.parseXml('localeSet');
  }

  /**
   * The data root: the first element child of xfa:data that is not itself in
   * the XFA data namespace. null if there is no data.
   * @returns {Element|null}
   */
  get dataRoot() {
    const ds = this.datasets;
    if (!ds?.documentElement || hasParseError(ds)) return null;
    let dataEl = findElement(ds.documentElement, el =>
      localName(el) === 'data' && isXfaDataNs(el));
    if (!dataEl) return null;
    // an xfa:data wrapped in another (itext-dataset-2page): Reader binds the
    // record inside
    for (;;) {
      const inner = elementChildren(dataEl).find(el => localName(el) === 'data' && isXfaDataNs(el));
      const record = elementChildren(dataEl).find(el => !isXfaDataNs(el) && localName(el) !== 'dataDescription');
      if (record || !inner) return record ?? null;
      dataEl = inner;
    }
  }

  /**
   * The thin slice of config the spec keeps (§1).
   * @returns {{ dynamicRender: string|null, pdfVersion: string|null, interactive: boolean|null }}
   */
  get config() {
    if (this._config) return this._config;
    const xml = this.parseXml('config');
    const root = xml && !hasParseError(xml) ? xml.documentElement : null;
    const text = name => {
      const el = root && findElement(root, e => localName(e) === name);
      return el ? el.textContent.trim() : null;
    };
    const pdfEl = root && findElement(root, e => localName(e) === 'pdf');
    const versionEl = pdfEl && findElement(pdfEl, e => localName(e) === 'version');
    const interactive = text('interactive');
    this._config = {
      dynamicRender: text('dynamicRender'),
      pdfVersion:    versionEl ? versionEl.textContent.trim() : null,
      interactive:   interactive === null ? null : interactive === '1',
    };
    return this._config;
  }

  /** True if the file must be reflowed from the template (spec §9) */
  get isDynamic() {
    return this.needsRendering || this.config.dynamicRender === 'required';
  }

  /** True if this PDF contains XFA */
  get hasXfa() {
    return this.names.length > 0;
  }

  /** True if the XFA has a template (form layout) */
  get hasTemplate() {
    return 'template' in this._streams;
  }

  /** True if the XFA has filled-in data */
  get hasDatasets() {
    return 'datasets' in this._streams;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function dictOf(obj) {
  return obj?.value?.value ?? obj?.dict ?? obj?.value ?? {};
}

async function resolveObj(doc, val) {
  return val?.type === 'ref' ? doc.getObject(val.num) : val;
}

function localName(el) {
  return el.localName || el.tagName.split(':').pop();
}

function elementChildren(el) {
  return Array.from(el.childNodes).filter(n => n.nodeType === 1);
}

// Match namespaces by prefix, not full URI: the data namespace is
// http://www.xfa.org/schema/xfa-data/<version>/
function isXfaDataNs(el) {
  return (el.namespaceURI || '').includes('xfa.org/schema/xfa-data');
}

function findElement(root, pred) {
  const stack = [root];
  while (stack.length) {
    const el = stack.shift();
    if (pred(el)) return el;
    stack.unshift(...elementChildren(el));
  }
  return null;
}

function hasParseError(xml) {
  return xml.getElementsByTagName('parsererror').length > 0;
}

function serialize(el) {
  if (typeof XMLSerializer !== 'undefined') return new XMLSerializer().serializeToString(el);
  return el.outerHTML ?? String(el);
}
