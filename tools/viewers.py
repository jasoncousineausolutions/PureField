"""How alike two viewers print each PDF: poppler (pdftoppm) against PDFium,
Chrome's renderer (pypdfium2). Purefield's aim is output that prints the same
everywhere, so a page the two viewers draw differently is a page some
viewer gets wrong.

    pip install pypdfium2 Pillow     # and poppler's pdftoppm
    python3 tools/viewers.py out/nonxfa                       # our output
    python3 tools/viewers.py out/nonxfa --also samples/nonxfa  # and the originals beside it

Each page is rendered at 60 dpi in greyscale by both, binarised, cropped to
its ink and scaled to a fixed width, and scored as tools/score.py scores a
page against Reader's print: the F1 of dark pixels with a counterpart
within about 2px in the other render. The worst files come first.
"""
import glob, os, subprocess, sys, tempfile
from PIL import Image, ImageFilter, ImageChops

W = 700
DPI = 60


def poppler_pages(pdf, d, password=''):
    cmd = ['pdftoppm', '-r', str(DPI), '-gray', '-png']
    if password:
        cmd += ['-upw', password]
    subprocess.run(cmd + [pdf, f'{d}/p'], check=True, capture_output=True)
    return [Image.open(p).convert('L') for p in sorted(glob.glob(f'{d}/p-*.png'), key=lambda p: int(p.rsplit('-', 1)[1][:-4]))]


def pdfium_pages(pdf, password=''):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf, password=password or None)
    out = []
    try:
        for i in range(len(doc)):
            page = doc[i]
            out.append(page.render(scale=DPI / 72, grayscale=True, may_draw_forms=True).to_pil().convert('L'))
            page.close()
    finally:
        doc.close()
    return out


def ink(im):
    im = im.point(lambda v: 255 if v < 160 else 0)
    box = im.getbbox()
    if box is None:
        return None
    im = im.crop(box)
    return im.resize((W, max(1, int(im.height * W / im.width))))


def f1(a, b):
    if a is None or b is None:
        return 1.0 if a is b else 0.0
    h = min(a.height, b.height)
    a, b = a.crop((0, 0, W, h)), b.crop((0, 0, W, h))
    da, db = a.filter(ImageFilter.MaxFilter(5)), b.filter(ImageFilter.MaxFilter(5))
    cnt = lambda im: sum(1 for v in im.getdata() if v)
    na, nb = cnt(a), cnt(b)
    if na + nb == 0:
        return 1.0
    pa = cnt(ImageChops.multiply(a, db)) / max(na, 1)
    pb = cnt(ImageChops.multiply(b, da)) / max(nb, 1)
    return 2 * pa * pb / (pa + pb) if pa + pb else 0.0


def agreement(pdf, password=''):
    with tempfile.TemporaryDirectory() as d:
        try:
            a = poppler_pages(pdf, d, password)
            b = pdfium_pages(pdf, password)
        except Exception as e:  # a viewer that cannot open the file
            return None, str(e).splitlines()[0][:80]
    n = max(len(a), len(b))
    if n == 0:
        return 1.0, ''
    scores = [f1(ink(a[i]) if i < len(a) else None, ink(b[i]) if i < len(b) else None) if i < len(a) and i < len(b) else 0.0
              for i in range(n)]
    return sum(scores) / n, '' if len(a) == len(b) else f'pages {len(a)} vs {len(b)}'


def passwords(folder):
    import json
    p = os.path.join(folder, 'sources.json')
    if not os.path.exists(p):
        return {}
    src = json.load(open(p))
    return {k: v.get('password', '') for k, v in src.items()} if isinstance(src, dict) else {}


args = sys.argv[1:]
also = None
if '--also' in args:
    i = args.index('--also')
    also = args[i + 1]
    del args[i:i + 2]
folder = args[0] if args else 'out/flattened'
pw = passwords(also) if also else {}
rows = []
for pdf in sorted(glob.glob(f'{folder}/*.pdf')):
    name = os.path.basename(pdf)[:-4]
    ours, note = agreement(pdf)
    theirs = None
    if also and os.path.exists(os.path.join(also, name + '.pdf')):
        theirs, _ = agreement(os.path.join(also, name + '.pdf'), pw.get(name, ''))
    rows.append((name, ours, theirs, note))
rows.sort(key=lambda r: (r[1] if r[1] is not None else -1))
fmt = lambda v: '  n/a ' if v is None else f'{100 * v:5.1f}%'
print(f"{'file':<48} {'ours':>7}" + (f" {'original':>9}" if also else ''))
for name, ours, theirs, note in rows:
    print(f'{name[:48]:<48} {fmt(ours):>7}' + (f' {fmt(theirs):>9}' if also else '') + (f'  {note}' if note else ''))
vals = [r[1] for r in rows if r[1] is not None]
if vals:
    line = f"{'AVERAGE':<48} {fmt(sum(vals) / len(vals)):>7}"
    if also:
        tv = [r[2] for r in rows if r[2] is not None]
        line += f' {fmt(sum(tv) / len(tv)) if tv else "":>9}'
    print(line + f'  ({len(vals)} files)')
