# Non-XFA corpus

106 PDFs (120 pages) that are not XFA forms, chosen for what Acrobat
Reader does that other viewers often skip. `sources.json` gives each
file's category, where it came from and, for four of them, the password
Reader will ask for.

| category | files | what it tests |
|---|---|---|
| `aes256` | 8 | AES-256 encryption (revisions 5 and 6); four need a password |
| `layers` | 16 | optional content: layers off by default, print-only and view-only content |
| `acroform-js` | 17 | form fields formatted and calculated by Acrobat JavaScript (AFNumber_Format, AFDate_FormatEx, util.printd …) |
| `annotations-no-appearance` | 21 | markup annotations Reader draws itself (highlight, ink, line, polygon, square, free text …) |
| `fonts-not-embedded` | 20 | page text in Arial, Times New Roman, Verdana, Tahoma, CJK and Arabic fonts that the file does not embed |
| `portfolio` | 1 | a PDF portfolio (/Collection) |
| `userunit` | 2 | pages with a /UserUnit scale |
| `viewer-rendering` | 21 | the PDF Association's pdf-differences cases (blend modes, dashing, colour spaces, Type 3, clipping …) |

Sources: the pdf.js test corpus (`pdfjs-*`), PDFium's test resources
(`pdfium-*`), Mozilla Bugzilla attachments that pdf.js tests link to
(`bugzilla-*`) and the PDF Association's pdf-differences repository
(`pdfdiff-*`).

## Printing in Reader

Print each file from Acrobat Reader the way `batch3/acrobat` was printed,
to a PDF of the same name in `acrobat/`. Print the forms as they open:
don't fill or click anything, so the open and calculate scripts are all
that ran. Where Reader prints something unusual (a password prompt you
cancelled, a portfolio cover only), say so in `reference-notes.json`
next to this file, as in `batch3`.

Score with:

    node tools/flatten-samples.mjs --in samples/nonxfa --out out/nonxfa
    python3 tools/score.py out/nonxfa --ref samples/nonxfa/acrobat
