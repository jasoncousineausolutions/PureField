// Small PDFs of the features no Reader print checks yet, to print from
// Acrobat Reader into samples/reader-tests/acrobat/ and score:
//   node tools/reader-tests.mjs                     # writes samples/reader-tests/*.pdf
//   node tools/flatten-samples.mjs --in samples/reader-tests --out out/reader-tests
//   python3 tools/score.py out/reader-tests --ref samples/reader-tests/acrobat
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPdf } from '../test/node/pdfbuild.js';

const out = fileURLToPath(new URL('../samples/reader-tests/', import.meta.url));
mkdirSync(out, { recursive: true });
const save = (name, objects) => { writeFileSync(out + name, buildPdf(objects)); console.log(name); };

// a PDF text string in UTF-16BE, as hex
const u16 = s => '<FEFF' + [...s].map(ch => {
  const cp = ch.codePointAt(0);
  if (cp < 0x10000) return cp.toString(16).padStart(4, '0');
  const v = cp - 0x10000;
  return (0xD800 + (v >> 10)).toString(16) + (0xDC00 + (v & 0x3FF)).toString(16);
}).join('').toUpperCase() + '>';
const lit = s => `(${s.replace(/[\\()]/g, c => '\\' + c)})`;

// ---------------------------------------------------------------------------
// 1. barcodes.pdf: an XFA form with one field of each newly drawn type
// ---------------------------------------------------------------------------
const barcodes = [
  ['aztec', 'Hello Aztec 12345'], ['aztec', 'jcs-pdf Aztec test: The quick brown fox jumps over the lazy dog 0123456789'],
  ['rss14', '0950110153001'], ['rss14Truncated', '0950110153001'], ['rss14Stacked', '0950110153001'],
  ['rss14StackedOmni', '0950110153001'], ['rss14Limited', '1501234567890'], ['rss14Expanded', '(01)98898765432106(3202)012345(15)991231'],
  ['postAUSStandard', '39987520'], ['postAUSReplyPaid', '12345678'], ['postAUSCust2', '3998752012'], ['postAUSCust3', '39987520AB12'],
  ['code2Of5Matrix', '87654321'],
  ['ean13add2', '9771384524017+12'], ['ean13add5', '9780877799306+54321'], ['ean8add2', '1234567+12'], ['ean8add5', '1234567+12345'],
  ['upcAadd2', '01234567890+24'], ['upcAadd5', '61414123441+12345'], ['upcEadd2', '1234567+12'], ['upcEadd5', '1234567+12345'],
  ['upcean2', '12'], ['upcean5', '54321'],
];
const bcFields = barcodes.map(([type, value], i) =>
  `<subform name="row${i}" layout="tb" w="7.5in"><draw name="label${i}" w="7.5in" h="14pt"><font typeface="Arial" size="9pt"/><value><text>${i + 1}. ${type}: ${value.replace(/&/g, '&amp;')}</text></value></draw>
   <field name="b${i}" w="${type.startsWith('aztec') ? '1.5in' : '4in'}" h="${type.startsWith('aztec') ? '1.5in' : '0.8in'}"><ui><barcode type="${type}"/></ui><font typeface="Arial" size="8pt"/><value><text>${value.replace(/&/g, '&amp;')}</text></value></field>
   <draw name="gap${i}" w="7.5in" h="12pt"/></subform>`).join('\n');
const bcTemplate = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb" locale="en_US">
  <pageSet><pageArea name="P1"><contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/><medium stock="letter" short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="body" layout="tb" w="7.5in"><draw name="title" w="7.5in" h="20pt"><font typeface="Arial" size="12pt" weight="bold"/><value><text>jcs-pdf reader test: barcodes</text></value></draw>
  ${bcFields}</subform></subform></template>`;
// packaged as Designer packages a dynamic form: an XDP envelope, a config
// asking for dynamic rendering and an empty datasets packet (with the
// template alone Reader printed the empty shell page)
const xdpPackets = template => ({
  preamble: '<?xml version="1.0" encoding="UTF-8"?>\n<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">',
  config: '<config xmlns="http://www.xfa.org/schema/xci/3.0/"><present><pdf><version>1.7</version><adobeExtensionLevel>8</adobeExtensionLevel>'
    + '<renderPolicy>client</renderPolicy><scriptModel>XFA</scriptModel><interactive>1</interactive></pdf></present>'
    + '<acrobat><acrobat7><dynamicRender>required</dynamicRender></acrobat7></acrobat></config>',
  template: template.replace('<subform name="form1"', '<?formServer defaultPDFRenderFormat acrobat10.0dynamic?><subform name="form1"'),
  datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>',
  postamble: '</xdp:xdp>\n',
});
const xfaObjects = (template, first) => {
  const packets = Object.entries(xdpPackets(template));
  const objs = {};
  packets.forEach(([, text], i) => { objs[first + i] = { dict: '<< >>', stream: text }; });
  return { array: packets.map(([name], i) => `(${name}) ${first + i} 0 R`).join(' '), objs };
};
const bcXfa = xfaObjects(bcTemplate, 6);
save('barcodes.pdf', {
  1: `<< /Type /Catalog /Pages 2 0 R /NeedsRendering true /Extensions << /ADBE << /BaseVersion /1.7 /ExtensionLevel 8 >> >> /AcroForm << /Fields [] /XFA [${bcXfa.array}] >> >>`,
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ...bcXfa.objs,
});

// ---------------------------------------------------------------------------
// 2. annotations.pdf: standard stamps and cloudy borders, no appearances
// ---------------------------------------------------------------------------
const stamps = ['Approved', 'Experimental', 'NotApproved', 'AsIs', 'Expired', 'NotForPublicRelease', 'Confidential',
  'Final', 'Sold', 'Departmental', 'ForComment', 'TopSecret', 'Draft', 'ForPublicRelease'];
const annObjs = {}, annRefs = [];
let num = 10;
stamps.forEach((name, i) => {
  const x = 40 + (i % 3) * 180, y = 700 - Math.floor(i / 3) * 70;
  annObjs[num] = `<< /Type /Annot /Subtype /Stamp /F 4 /Name /${name} /Rect [${x} ${y} ${x + 160} ${y + 50}] /C [1 0 0] >>`;
  annRefs.push(`${num++} 0 R`);
});
const clouds = [
  `/Subtype /Square /Rect [40 260 200 340] /C [0 0 1] /BE << /S /C /I 1 >> /BS << /W 1 >>`,
  `/Subtype /Circle /Rect [230 260 390 340] /C [0 0.5 0] /IC [0.9 1 0.9] /BE << /S /C /I 2 >> /BS << /W 1 >>`,
  `/Subtype /Polygon /Rect [420 250 580 350] /Vertices [430 260 570 270 540 340 450 330] /C [0.6 0 0.6] /BE << /S /C /I 1 >> /BS << /W 1 >>`,
  `/Subtype /FreeText /Rect [40 120 300 220] /DA (/Helv 12 Tf 0 0 1 rg) /Contents ${lit('Free text with a cloudy border, intensity 1')} /BE << /S /C /I 1 >> /BS << /W 1 >>`,
  `/Subtype /FreeText /Rect [330 120 580 220] /DA (/Helv 11 Tf 0 g) /Contents ${u16('نص عربي في تعليق: الإنترنت العالمي المفتوح')} /BS << /W 0 >>`,
];
for (const c of clouds) { annObjs[num] = `<< /Type /Annot /F 4 ${c} >>`; annRefs.push(`${num++} 0 R`); }
save('annotations.pdf', {
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> /Annots [${annRefs.join(' ')}] >>`,
  4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  5: { dict: '<< >>', stream: 'BT /F1 12 Tf 40 760 Td (jcs-pdf reader test: standard stamps and cloudy borders, generated by Reader) Tj ET' },
  ...annObjs,
});

// ---------------------------------------------------------------------------
// 3. fields.pdf: rich text, push-button icons, an unsigned signature field,
//    Arabic, Hebrew and CJK values (NeedAppearances: Reader draws them all)
// ---------------------------------------------------------------------------
const fieldDefs = [];
const fObjs = {};
let fn = 20;
const widget = body => { fObjs[fn] = `<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R ${body} >>`; fieldDefs.push(`${fn} 0 R`); return fn++; };
widget(`/FT /Tx /T (rich) /Ff ${1 << 25 | 1 << 12} /Rect [40 640 300 720] /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> /V (Bold red then plain) `
  + `/RV ${lit('<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2"><p><b><span style="color:#FF0000">Bold red</span></b> then plain</p><p style="font-size:9pt"><i>a smaller italic line</i></p></body>')}`);
widget(`/FT /Tx /T (arabic) /Rect [330 680 580 710] /DA (/Helv 12 Tf 0 g) /Q 2 /MK << /BC [0 0 0] >> /V ${u16('مرحبا بالعالم 123')}`);
widget(`/FT /Tx /T (hebrew) /Rect [330 640 580 670] /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> /V ${u16('שלום עולם (test)')}`);
widget(`/FT /Tx /T (japanese) /Rect [40 590 300 620] /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> /V ${u16('日本語のテキスト')}`);
widget(`/FT /Tx /T (chinese) /Rect [330 590 580 620] /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> /V ${u16('中文文本测试')}`);
widget(`/FT /Tx /T (korean) /Rect [40 550 300 580] /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> /V ${u16('한국어 텍스트')}`);
// push buttons: an icon (a form XObject) placed by /TP 0-6
fObjs[90] = { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 40 40] >>', stream: '0 0.5 1 rg 0 0 40 40 re f 1 1 0 rg 10 10 20 20 re f' };
for (let tp = 0; tp <= 6; tp++) {
  const x = 40 + tp * 78;
  widget(`/FT /Btn /Ff ${1 << 16} /T (button${tp}) /Rect [${x} 440 ${x + 70} 520] /DA (/Helv 9 Tf 0 g) /MK << /BC [0 0 0] /BG [0.9 0.9 0.9] /CA (TP ${tp}) /I 90 0 R /TP ${tp} >>`);
}
widget('/FT /Sig /T (signature) /Rect [40 330 300 400] /MK << /BC [0 0 1] /BG [0.95 0.95 1] >>');
save('fields.pdf', {
  1: `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${fieldDefs.join(' ')}] /NeedAppearances true /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >> >>`,
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> /Annots [${fieldDefs.join(' ')}] >>`,
  4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  5: { dict: '<< >>', stream: 'BT /F1 12 Tf 40 760 Td (jcs-pdf reader test: field appearances Reader generates) Tj 0 -20 Td /F1 9 Tf (rich text; Arabic, Hebrew; Japanese, Chinese, Korean; push buttons TP 0-6 with an icon; an unsigned signature field) Tj ET' },
  ...fObjs,
});

// ---------------------------------------------------------------------------
// 4. cjk-page-fonts.pdf: page text in CJK fonts the file does not embed
// ---------------------------------------------------------------------------
const cjkFont = (n, base, enc, ordering, sup, dw = 1000) => ({
  [n]: `<< /Type /Font /Subtype /Type0 /BaseFont /${base}-${enc} /Encoding /${enc} /DescendantFonts [${n + 1} 0 R] >>`,
  [n + 1]: `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement ${sup} >> /FontDescriptor ${n + 2} 0 R /DW ${dw} >>`,
  [n + 2]: `<< /Type /FontDescriptor /FontName /${base} /Flags 6 /FontBBox [-170 -331 1024 903] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>`,
});
const hex = bytes => '<' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase() + '>';
const sjis = [0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA, 0x82, 0xCC, 0x83, 0x65, 0x83, 0x4C, 0x83, 0x58, 0x83, 0x67];          // 日本語のテキスト
const gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xCE, 0xC4, 0xB1, 0xBE, 0xB2, 0xE2, 0xCA, 0xD4];                                  // 中文文本测试
const big5 = [0xA4, 0xA4, 0xA4, 0xE5, 0xA4, 0xE5, 0xA5, 0xBB];                                                        // 中文文本
const uhc = [0xC7, 0xD1, 0xB1, 0xB9, 0xBE, 0xEE, 0x20, 0xC5, 0xD8, 0xBD, 0xBA, 0xC6, 0xAE];                            // 한국어 텍스트
const ucs2 = s => [...s].flatMap(ch => { const c = ch.charCodeAt(0); return [c >> 8, c & 0xFF]; });
save('cjk-page-fonts.pdf', {
  1: '<< /Type /Catalog /Pages 2 0 R >>',
  2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R /J 10 0 R /G 20 0 R /B 30 0 R /K 40 0 R /U 50 0 R >> >> >>',
  4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  5: { dict: '<< >>', stream: [
    'BT /F1 12 Tf 40 750 Td (jcs-pdf reader test: CJK text in fonts the file does not embed) Tj ET',
    'BT /F1 9 Tf 40 700 Td (Ryumin-Light, 90ms-RKSJ-H:) Tj ET', `BT /J 24 Tf 220 700 Td ${hex([0x28, 0x35, 0x37, 0x29, ...sjis])} Tj ET`,
    'BT /F1 9 Tf 40 650 Td (STSong-Light, GBK-EUC-H:) Tj ET', `BT /G 24 Tf 220 650 Td ${hex(gbk)} Tj ET`,
    'BT /F1 9 Tf 40 600 Td (MSung-Light, ETen-B5-H:) Tj ET', `BT /B 24 Tf 220 600 Td ${hex(big5)} Tj ET`,
    'BT /F1 9 Tf 40 550 Td (HYSMyeongJo-Medium, KSCms-UHC-H:) Tj ET', `BT /K 24 Tf 220 550 Td ${hex(uhc)} Tj ET`,
    'BT /F1 9 Tf 40 500 Td (KozMinPr6N-Regular, UniJIS-UCS2-H:) Tj ET', `BT /U 24 Tf 220 500 Td ${hex(ucs2('日本語のテキスト'))} Tj ET`,
  ].join('\n') },
  ...cjkFont(10, 'Ryumin-Light', '90ms-RKSJ-H', 'Japan1', 2),
  ...cjkFont(20, 'STSong-Light', 'GBK-EUC-H', 'GB1', 2),
  ...cjkFont(30, 'MSung-Light', 'ETen-B5-H', 'CNS1', 0),
  ...cjkFont(40, 'HYSMyeongJo-Medium', 'KSCms-UHC-H', 'Korea1', 1),
  ...cjkFont(50, 'KozMinPr6N-Regular', 'UniJIS-UCS2-H', 'Japan1', 6),
});
