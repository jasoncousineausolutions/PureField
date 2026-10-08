# Purefield

A dependency-free JavaScript library that flattens **XFA PDF forms** (Adobe LiveCycle / Designer forms) into ordinary PDFs that any viewer can display. You don't need Acrobat, a server or a plugin. It runs in the browser or in Node.

XFA forms only render in Adobe Acrobat/Reader and, partly, in Firefox. In every other viewer, including most phones, they show a "please wait…" page or blank boxes. Purefield reads the form definition and data out of the PDF, lays the form out and writes a plain PDF with the filled-in values.

Ordinary AcroForm PDFs (no XFA) are flattened too: each widget's appearance is stamped onto its page, and appearances the file lacks are generated from the field values, so filled forms print the same in every viewer.

The behaviour follows a reduced XFA spec, [`docs/REDUCED_XFA_SPEC.txt`](docs/REDUCED_XFA_SPEC.txt), with long-form notes in [`docs/REDUCED_XFA_SPEC_DETAIL.txt`](docs/REDUCED_XFA_SPEC_DETAIL.txt). Rules have been checked against Firefox's pdf.js XFA engine.

## Usage

### Browser

```html
<script type="module">
  import { flattenXfa } from './src/index.js';

  const file = document.querySelector('input[type=file]').files[0];
  const { pdf, log, pageCount, dynamic, static: keptPages } = await flattenXfa(await file.arrayBuffer());

  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  window.open(url);
  console.table(log.entries); // what was skipped or substituted, as XFA_* codes
</script>
```

Serve the folder over HTTP, for example with `npx serve .` or `python3 -m http.server`. Browsers block module imports from `file://`.

The browser and Node give byte-identical output for every sample in the repository. `tools/browser-check.mjs` checks this in headless Chromium.

[`test/test.html`](test/test.html) is a ready-made drop-a-PDF page that shows a preview, a download link and the log.

### Node (18+)

Node has no `DOMParser`, so supply one first. `@xmldom/xmldom` works and is what the tests use:

```js
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

import { readFileSync, writeFileSync } from 'node:fs';
import { flattenXfa } from './src/index.js';

const { pdf } = await flattenXfa(readFileSync('form.pdf'));
writeFileSync('form-flat.pdf', pdf);
```

### API

`flattenXfa(input, options?)` → `Promise<{ pdf, log, pageCount, dynamic, static, acroForm? }>`

A PDF without XFA is flattened through its AcroForm instead: each printable widget (and other annotation) is stamped onto its page from its appearance, appearances the file lacks (or that `/NeedAppearances` asks for) are generated from the field's value, `/DA`, `/Q`, `/MK` and flags, comments and markup without an appearance (highlights, underlines, lines, shapes, ink, free text, notes, stamps, cloudy borders) are drawn from their dictionaries, and the AcroForm is dropped (spec §12).

| | |
|---|---|
| `input` | `ArrayBuffer` or `Uint8Array` holding the PDF. Encrypted files (RC4, AES-128, AES-256) open as Reader opens them: without a password when the user password is empty, or when only attachments are encrypted |
| `options.password` | the user or owner password of a file that asks for one. A wrong or missing password throws a `PasswordError`; certificate security (`Adobe.PubSec`) and other security handlers throw an `UnsupportedEncryptionError` |
| `options.scripts` | `true` (default): run the form's FormCalc and JavaScript load and print events (initialize, calculate, ready, docReady, prePrint) in a sandboxed interpreter, as Acrobat does on opening and printing. For an AcroForm (no XFA): document scripts, every field's format action, the open, page-open and will-print actions, and the calculations (in `/CO` order) when those change a value. `false`: skip them. |
| `options.now` | the `Date` that scripts see as now (`Date()`, `new Date()`); default the time of flattening |
| `options.xfa` | `true` (default). `false`: flatten the AcroForm widgets even when the file carries XFA |
| `options.annotations` | `true` (default): print the annotations that aren't form fields (highlights, ink, shapes, stamps, note icons, links) from their appearances, as Reader does. `false`: leave them out; form fields still print |
| `options.barcodes` | `'reader'` (default): barcode fields print as Reader prints them: Aztec, GS1 DataBar and the standalone `upcean2`/`upcean5` as a grey box, and EAN/UPC fields with an add-on not at all (they leave the layout). `'all'`: draw every type Purefield encodes, as a scannable symbol |
| `options.images` | `null` (default). `async href => Uint8Array \| null`: the bytes of an image an XFA form names by an external href (a file or URL beside the form), as Reader loads it; without it such images print nothing. Data URIs and the PDF's own `/XFAImages` need nothing |
| `options.labelFields` | `false` (default). `true` or `{ color, minSize, maxSize, name }`: replace every form field with its name, in place of its value, on one line at the largest size from `maxSize` (12) down to `minSize` (5) that fits the field; a name still too long is cut off at the field's edge. `color` is `'#rrggbb'` or `[r, g, b]` (0–255), red by default. `name: 'full'` (default) prints the fully qualified field name, `form1[0].page1[0].LastName[0]`; `'short'` prints the partial field name, `LastName` (the PDF standard's terms, ISO 32000 §12.7.3.2). Radio buttons sharing a name add their value (`choice=yes`). Captions and the rest of the page stay; hidden fields are left out |
| `options.fonts` | `'bundled'` (default): embed subsets of the bundled Liberation Sans for Helvetica-class text and for any character the standard fonts can't encode, and of Source Sans Pro for Myriad Pro and declared faces it fits better; and give every font a page uses without embedding it a substitute at its own widths (Liberation Sans, Serif or Mono, or Source Sans Pro), as Acrobat does. `{ regular, bold, sourceSans?, load? }`: your own TrueType bytes (`sourceSans` is `{ regular, bold, italic, boldItalic }`; `load(name)` returns the bytes of a bundled face by file name, such as `'LiberationSerif-Bold'`, for page fonts). Text in other writing systems is drawn too: Arabic (joined) and Hebrew right to left, with DejaVu Sans loaded when some text needs it, and CJK with Adobe's standard CJK fonts (not embedded; a TrueType font supplied as `fonts/CJK.ttf` or `load('CJK')` is embedded instead, and then also stands in for the Chinese, Japanese and Korean fonts pages use without embedding them, which viewers without those fonts print blank). `null`: standard PDF fonts only, and page fonts left as they are. Output is smaller, but text is limited to Western European characters. |
| `pdf` | `Uint8Array`, the flattened PDF |
| `log` | `XfaLog`; `log.entries` is `{ level, code, message }[]` |
| `pageCount` | pages in the output |
| `dynamic` | the form is dynamic (NeedsRendering, or `dynamicRender="required"`), so pages were synthesised from the template |
| `static` | the form is static, so its original pages were kept and only the values painted on top |
| `acroForm` | `true` when the file had no XFA (or `xfa: false`): the pages were kept and their widgets flattened |
| `portfolio` | for a PDF Portfolio, how many of its PDF files were flattened and printed (in place of its cover sheet) |

It throws if the file isn't a PDF or has no XFA. A form whose template can't be used (not well-formed, no root subform) prints its own PDF pages, as Reader does.

`loadBundledFonts()` returns the bundled `{ regular, bold, sourceSans }` font bytes, if you want to load them once and pass them in yourself.

`inspectPdf(input, { password })` reads a file without flattening it, so a caller can offer only the options that apply: its page count, whether it was encrypted or is a portfolio, its XFA form (dynamic or static, fields, filled values, scripts, and each barcode type with how Reader prints it: `'drawn'`, `'box'` or `'dropped'`), its AcroForm fields (by type, filled ones, JavaScript actions, `NeedAppearances`), the comments and markup that print (by type), text beyond Latin (`otherScripts`, `cjk`) and CJK page fonts the file does not embed. It throws as `flattenXfa` does; `PasswordError` and `UnsupportedEncryptionError` are exported for telling the cases apart. A file with neither XFA nor AcroForm fields has nothing to flatten but its markup (it may have been flattened already).

## How it works

```
parsePdf ─► extractXfa ─► parseTemplateModel ─► bindData ─► formatValues ─► layoutForm ─► paintPages ─► PdfWriter
 (core)      packets        template model       instance     picture        boxes on      content       PDF bytes
                                                 tree          clauses        pages         streams
```

| Module | Spec | Role |
|---|---|---|
| `src/core/parser.js`, `crypto.js` | — | PDF objects, xref tables/streams, incremental updates, damaged-xref recovery, RC4, AES-128 and AES-256 (revisions 2–6) decryption, user and owner passwords |
| `src/xfa/extractor.js` | §1 | XFA packets (array or single XDP stream), name normalisation, config, data root |
| `src/core/units.js` | §2 | measurements → points, page sizes |
| `src/xfa/model.js` | — | template packet → plain-object model (geometry, layout, borders, captions, ui, fonts, binds, occur, pageSets) |
| `src/xfa/bind.js` | §5 | data binding: `once` / `dataRef` / `global` / `none`, occur, SOM refs |
| `src/xfa/picture.js`, `format.js` | §6 | picture clauses (date, time, num, text, null, zero, locale patterns), display values |
| `src/xfa/flow.js` | §3 | layout: position, tb, lr-tb, table/row, rotation, pagination, page boilerplate |
| `src/xfa/text.js`, `rich.js` | §4, §10 | fonts, substitution, measurement, rich text runs |
| `src/xfa/paint.js` | §7, §8, §9 | borders, captions, widgets, check marks, comb fields, lines, arcs, images, static-page overlay |
| `src/xfa/barcodes.js`, `src/core/barcode.js`, `barcode1d.js`, `imb.js`, `auspost.js`, `databar.js`, `pdf417.js`, `qr.js`, `datamatrix.js`, `maxicode.js`, `aztec.js` | §7 | barcode fields: payload, placement, and the linear, postal, GS1 DataBar, PDF417, QR Code, Data Matrix, MaxiCode and Aztec Code encoders |
| `src/xfa/script/run.js`, `dom.js`, `formcalc.js`, `js.js` | §11 | scripts: event order, the XFA object model, FormCalc and JavaScript interpreters (no eval) |
| `src/acroform.js`, `appearance.js`, `annotations.js`, `acroscript.js`, `src/core/widgets.js`, `optional.js` | §12 | AcroForm flattening: widget and annotation appearances stamped or generated, form JavaScript, layers that do not print |
| `src/xfa/scripts.js` | §4 | Arabic joining, bidirectional order, CJK collections |
| `src/core/substitute.js`, `outline.js`, `encodings.js`, `glyphmaps.js`, `cjk.js`, `content.js` | — | fonts pages do not embed: substitute programs built glyph by glyph at the font's widths, base encodings, Windows core font glyph orders, the predefined CJK CMaps' code spaces and encodings, the text each font shows |
| `src/core/writer.js`, `importer.js`, `images.js`, `ttf.js`, `embed.js`, `formfonts.js`, `faces.js` | — | PDF output, copying static shell pages, JPEG/PNG/GIF/BMP/TIFF images, TrueType subsetting, form-declared font widths, choice of bundled glyphs |

Form scripts run in interpreters written for this library: form code never reaches the host JavaScript engine (no `eval`, no `Function`), it sees only the XFA object model and an allow-list of built-ins, and a step budget stops runaway loops. Page-number scripts (`xfa.layout.page(this)` / `pageCount()`) are painted per page instead.

## Log codes

| Code | Meaning |
|---|---|
| `XFA_PACKET_DISCARDED` | packets not needed for flattening (connectionSet, xmpmeta, …) |
| `XFA_PACKET_UNREADABLE` | a packet entry could not be read |
| `XFA_TEMPLATE_UNKNOWN` | template element not modelled |
| `XFA_USE_SKIPPED` | `use`/`usehref` prototype reference not resolved |
| `XFA_UNIT_INVALID`, `XFA_UNIT_UNKNOWN` | malformed measurement or unit, read as 0 |
| `XFA_LAYOUT_UNKNOWN` | unknown layout value, treated as `position` |
| `XFA_BIND_DANGLING` | a `dataRef` that resolves to nothing |
| `XFA_BIND_SCRIPT_SKIPPED` | value would come from a script; template default used until the script runs |
| `XFA_SCRIPTS` | how many scripts ran and how many failed |
| `XFA_SCRIPT_FAILED` | a script stopped: an error, or something the object model lacks (adding subform instances, layout queries); what it did before stays |
| `XFA_SCRIPT_PROPERTY_IGNORED` | a script set a property that does not change the print |
| `XFA_PICTURE_UNSUPPORTED` | picture symbol outside the reduced set; raw value shown |
| `XFA_METRIC_SUBSTITUTE` | typeface measured and drawn with a substitute |
| `XFA_FONT_UNAVAILABLE` | embedded fonts couldn't be loaded; standard fonts used |
| `XFA_UI_OPAQUE`, `XFA_SIGNATURES` | an unsigned signature field prints its border alone, as in Reader; signed signatures of a dynamic form were printed from their widget appearances |
| `XFA_BARCODE_EMPTY`, `XFA_BARCODE_UNSUPPORTED`, `XFA_BARCODE_CHAR`, `XFA_BARCODE_DATA`, `XFA_BARCODE_ENCODING` | barcode field with no value; a symbology not drawn (Code 49, Telepen, FIM and the other XFA types not listed below); a character the symbology cannot encode, skipped; too much data for the symbol; a charEncoding other than UTF-8, ISO-8859-1 or UTF-16 |
| `XFA_IMAGE_EXTERNAL`, `XFA_IMAGE_UNSUPPORTED` | external image href with no `options.images` to load it, or an image format that can't be decoded here (e.g. a multi-strip fax TIFF) |
| `XFA_KEEP_BROKEN` | keep-intact block taller than a page was split |
| `XFA_OVERFLOW_UNRESOLVED`, `XFA_OVERFLOW_LEADER`, `XFA_OVERFLOW_TRAILER` | an overflow leader or trailer names nothing in its container; a leader taller than the content area, or a trailer with no room left, was left out |
| `XFA_TABLE_SPAN_COLUMN` | table column made only of spanning cells |
| `XFA_TEMPLATE_UNUSABLE` | the template is not well-formed or has no root subform: the PDF's own pages are printed, as Reader does |
| `ACRO_OC_HIDDEN`, `ACRO_OC_UNFILTERED` | layers (optional content) that do not print were taken out of the pages; a content stream with a filter other than Flate was kept whole, hidden layers included |
| `ACRO_SCRIPTS`, `ACRO_SCRIPT_FAILED` | how many AcroForm scripts ran and failed; a failed one is named with its error |
| `ACRO_FLATTENED` | how many widgets and annotations of an AcroForm were stamped from their appearances, and how many appearances were generated |
| `ACRO_ANNOT_NO_APPEARANCE`, `ACRO_FREETEXT_ROTATED` | file attachments, sounds or redactions without an appearance were not printed; a free text's `/Rotate` was not applied |
| `ACRO_NO_DA` | a text or choice field has no `/DA`, its own or the AcroForm's: it prints its background and border without its value, as Reader does |
| `FONT_SUBSTITUTED`, `FONT_GLYPH_ORDER`, `FONT_NOT_SUBSTITUTED`, `FONT_SUBSTITUTE_FAILED`, `FONT_CJK_NOT_EMBEDDED` | a font the pages use without embedding it was given a substitute at its widths; a CID font without `/ToUnicode` was read in the Windows font's glyph order; a symbol font, or a CID font whose glyphs cannot be identified, was left as it is; a substitute could not be built; a Chinese, Japanese or Korean font was left as it is because no CJK font was supplied (`fonts/CJK.ttf`) |
| `FONT_SCRIPTS`, `FONT_CJK` | text in Arabic, Hebrew or another alphabet the Latin faces lack was drawn with DejaVu Sans (or no face could be loaded); CJK text was drawn with the standard CJK fonts or the CJK font supplied |
| `XFA_RELAYOUT`, `XFA_LAST_PAGE_AREA` | scripts asked the layout, so the form was laid out twice; a last page did not fit its pagePosition="last" page area |
| `ACRO_PORTFOLIO`, `ACRO_PORTFOLIO_FILE_FAILED` | a PDF Portfolio printed its PDF files; one of them could not be flattened |
| `XFA_STATIC_EMPTY`, `XFA_STATIC_PAGE_MISMATCH` | static form whose shell pages can't be reused; pages synthesised instead |

## Known limits

These are by design, per the spec:
- Scripts run once per event, before layout. Scripts may add, insert, move and remove subform instances (`addInstance`, `insertInstance`, `moveInstance`, `removeInstance`, `setInstances`, `count`); a script that asks the layout (`xfa.layout.page()`, `pageCount()`, `h()`…) gets the answers of a first layout, the form being laid out a second time with them, so a table of contents can show the pages its entries land on. Click, change and other user events run only when another script fires them.
- Bookends work when they name the container's own children. Repeated table headers (overflow leaders) and footers (trailers) follow Reader's rules but are checked against one Reader print only (ro-pos-cce-application), the one sample whose tables continue onto another page in this layout.
- An unsigned signature field prints its border alone; a signed one prints its signature appearance (on a dynamic form, stamped in the field's laid-out place). Barcode fields print Code 39 (and LOGMARS), Code 128, Codabar, 2 of 5 (interleaved, industrial, matrix), Code 93, Code 11, MSI, EAN-8, EAN-13, UPC-A, UPC-E (also with 2 or 5-digit add-ons, or the add-on alone), POSTNET, Intelligent Mail, Royal Mail 4-state, Australia Post 4-state, GS1 DataBar (RSS: Omnidirectional, Truncated, Stacked, Stacked Omnidirectional, Limited, Expanded), PDF417, QR Code, Data Matrix, MaxiCode and Aztec Code symbols; other types (Code 49, Telepen, FIM…) print nothing. By default the types Reader does not draw print as it prints them (`options.barcodes`), and Australia Post symbols at Reader's fixed size.
- Fonts a page uses without embedding them are embedded as substitutes: Liberation or Source Sans glyphs stretched to each character's declared width, as Acrobat stretches its multiple-master fonts, so lines keep their length but letter shapes are the substitute's. Symbol fonts (Wingdings, Symbol, Dingbats), CJK fonts with predefined CMaps, and fonts named in another script are left to the viewer.
- Arabic is joined from Unicode's presentation forms and right-to-left text is ordered by a reduced bidirectional algorithm, so complex Arabic typography (stacked ligatures, kashida) is not reproduced. Thai and the Indic scripts are drawn character by character, without the reordering and mark positioning they need. CJK text needs a viewer with Adobe's CJK CMaps (Reader, Chrome and pdf.js have them; poppler needs poppler-data), unless a CJK font is supplied.
- Typefaces that aren't available are substituted. Myriad Pro is drawn with Source Sans Pro glyphs at Myriad Pro widths (pdf.js uses Liberation Sans), and Times is measured with Times widths. Wrapping can still differ slightly from Acrobat.
- Page sets follow document order, or for `simplexPaginated` and `duplexPaginated` sets whose page areas set them, `pagePosition` (first, rest, last, only) and `oddOrEven`; a last page that does not fit its last page area keeps the one it had. `blankOrNotBlank` is ignored.
- AcroForm scripts run on Acrobat's object model as far as printing needs it (fields' values, display, colours and check states; `util`, `color`, `display` and the `AF` format and calculate functions); keystroke and validate actions, and anything needing a user, do not run.
- AcroForms: generated appearances cover text (a rich text field shows its plain `/V`, as Reader prints it), choice, check box, radio and push button fields (captions and `/MK` icons) and unsigned signature fields (background and border); of annotations without an appearance, file attachments, sounds and redactions print nothing (links never print), and a stamp is Reader's crossed-box placeholder. Generated annotations follow the PDF specification and pdf.js's geometry, cloudy borders Acrobat's (by way of PDFBox); Reader's own note icons, highlight ends and ink smoothing may differ in detail.

## Development

```sh
npm install   # @xmldom/xmldom, used by the Node tests only
npm test      # node:test suite in test/node/
```

- `test/fixtures/` holds one encrypted sample form, and in `crypto/` two small RC4 files from PDFium's tests.
- `samples/` holds public XFA forms (`xfa/`), non-XFA PDFs (`nonxfa/`) and generated Reader tests (`reader-tests/`), each with Adobe Reader prints in `acrobat/` (see `samples/README.md`). `node tools/flatten-samples.mjs` flattens `samples/xfa/` into `out/flattened/`, `python3 tools/score.py out/flattened` scores the output against the prints, and `python3 tools/compare.py [filter]` (needs poppler's `pdftoppm` and Pillow) writes side-by-side images to `out/compare/`, the pages most different from Reader first.
- `python3 tools/viewers.py out/nonxfa --also samples/nonxfa` (needs `pip install pypdfium2`) measures how alike poppler and PDFium (Chrome) print each output, beside the originals: the output should print the same in every viewer.
- `test/test.html` is the in-browser harness.
- `tools/bench.py` compares Purefield with pdf.js, PDFium, MuPDF and Poppler on any folder of PDFs that has Adobe Reader prints in an `acrobat/` subfolder, scaled to thousands of files: run `tools/bench/setup.sh` once, then `tools/bench/run.sh "DIR"`. It works in parallel, resumes after a stop, and writes `DIR/bench/results.csv`, `summary.txt` and side-by-sides of Purefield's worst pages. See the top of `tools/bench.py`.

## License

Copyright 2026 Jason Cousineau. Purefield is licensed under the [Apache License 2.0](LICENSE). The PDFs in `samples/` are public forms and test files from their publishers (listed in `samples/README.md`) and are not covered by this license; the fonts and ported code below keep their own licenses.

## Third-party data

- `fonts/Liberation*.ttf`: Liberation Sans, Serif and Mono, SIL Open Font License 1.1 (`fonts/Liberation-LICENSE.txt`). Substitute fonts built from their glyphs are named PurefieldSubstitute, as the licence reserves the name.
- `fonts/DejaVuSans*.ttf`: DejaVu Sans, Bitstream Vera licence with public-domain DejaVu changes (`fonts/DejaVu-LICENSE.txt`).
- `fonts/SourceSansPro-*.ttf`: Source Sans Pro 2.045 by Adobe, SIL Open Font License 1.1 (`fonts/SourceSansPro-LICENSE.txt`).
- `src/core/pdf417table.js`: the PDF417 codeword patterns from [ZXing](https://github.com/zxing/zxing) (`pdf417/encoder/PDF417.java`), Apache License 2.0.
- `src/core/maxicode.js`, `src/core/imb.js`, `src/core/auspost.js` and `src/core/databar.js`: ported from [zint](https://github.com/zint/zint) (`backend/maxicode.c`, `maxicode.h`, `imail.c`, `auspost.c`, `rss.c`, `rss.h`, `general_field.c`), BSD 3-Clause License, Copyright (C) 2008-2026 Robin Stuart; the MaxiCode module grid and code set tables are ISO/IEC 16023's, the Intelligent Mail bar map USPS-B-3200's, the Australia Post N and C tables its Customer Barcoding Technical Specifications', the DataBar tables and width routines (combins, getRSSwidths) ISO/IEC 24724's.
- `src/core/cloudy.js`: ported from [Apache PDFBox](https://pdfbox.apache.org/) (`CloudyBorder.java`), Apache License 2.0, whose cloud geometry was deduced from Acrobat's appearance streams.
- `src/core/aztec.js`: ported from [zint](https://github.com/zint/zint) (`backend/aztec.c`, `aztec.h`, `reedsol.c`), BSD 3-Clause License, Copyright (C) 2009-2026 Robin Stuart; its encodation search is zint's adaptation of [ZXing](https://github.com/zxing/zxing)'s Aztec high-level encoder (Apache License 2.0, Copyright 2013 ZXing authors) by way of [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) (Copyright 2016 Huy Cuong Nguyen); the capacity tables are ISO/IEC 24778's.
- `src/core/qr.js`: QR Code block tables and penalty rules after [Project Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library), MIT License.
- `src/annotations.js`: the underline, squiggly and strike-out geometry follows [pdf.js](https://github.com/mozilla/pdf.js) (`src/core/annotation.js`), Apache License 2.0.
- `src/core/encodings.js` and `src/core/glyphmaps.js`: the base encodings and the Windows core fonts' glyph orders from [pdf.js](https://github.com/mozilla/pdf.js) (`encodings.js`, `standard_fonts.js`), Apache License 2.0.
- `src/core/times.js` and `src/core/myriad.js`: width tables derived from [pdf.js](https://github.com/mozilla/pdf.js) (`metrics.js`, `myriadpro_factors.js`, `liberationsans_widths.js`), Apache License 2.0. The Times widths are the Adobe Core 14 AFM metrics.
