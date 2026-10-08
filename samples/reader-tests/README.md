# Reader tests

Four small PDFs of features no Reader print checks yet, made by
`node tools/reader-tests.mjs`. Print each from Acrobat Reader, the same
way as the other sets, to a PDF of the same name in `acrobat/`, without
filling or clicking anything.

| file | what Reader draws itself |
|---|---|
| `barcodes.pdf` | an XFA form, one field of each barcode type Purefield added without a Reader reference: Aztec, GS1 DataBar (six kinds), Australia Post (four), 2 of 5 Matrix, EAN/UPC with 2- and 5-digit add-ons, and the add-ons alone |
| `annotations.pdf` | the 14 standard stamps and cloudy borders (square, circle, polygon, free text), and an Arabic free-text note, none with an appearance |
| `fields.pdf` | field appearances Reader generates (NeedAppearances): a rich-text value, Arabic, Hebrew, Japanese, Chinese and Korean values, push buttons with an icon in each of the seven icon/caption layouts, and an unsigned signature field |
| `cjk-page-fonts.pdf` | Japanese, simplified and traditional Chinese and Korean page text in fonts the file does not embed (Reader needs its Asian font pack, which it offers to download the first time) |

Score with:

    node tools/flatten-samples.mjs --in samples/reader-tests --out out/reader-tests
    python3 tools/score.py out/reader-tests --ref samples/reader-tests/acrobat

`cjk-page-fonts.pdf` scores against Purefield's substitute only when a CJK
font is supplied as `fonts/CJK.ttf`; without one the fonts are left for
the viewer, as Reader's print would show them.

Reader prints so far (Microsoft Print to PDF): annotations, fields and
cjk-page-fonts. They showed that Reader draws a stamp with no appearance
as a crossed box, draws Acrobat's cloud curls with a Polygon's closing
edge straight, prints a rich text field's plain /V, lays a field's
Hebrew out left to right, and advances CJK single bytes /DW with no /W.
The first barcodes.pdf (its template the only XFA packet) printed as
the empty shell page; packaged as Designer packages a dynamic form (XDP
envelope, config with dynamicRender required, datasets) it printed in
full. Reader draws Aztec, GS1 DataBar and upcean2/upcean5 as grey boxes,
leaves the EAN/UPC add-on fields out of the layout, and draws Australia
Post at a fixed size with its value under it; 2 of 5 Matrix as Purefield
does.
