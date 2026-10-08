"""Similarity score per sample against the Adobe Reader prints.

    node tools/flatten-samples.mjs
    python3 tools/score.py [out/flattened]     # needs pdftoppm and Pillow
    python3 tools/score.py OUT_DIR --ref samples/xfa/acrobat

A reference-notes.json next to the reference folder flags Reader prints
that are not a fair target: "skip"/"excluded" ones are left out (listed
at the end), "rotated" ones are turned to our orientation first, and a
page that is blank on both sides counts as a match.

Each page of ours and of the Reader print is rendered in greyscale,
binarised, cropped to its ink bounding box (A4 forms were printed shrunk
onto Letter) and scaled to a fixed width. The page score is the F1 of
dark pixels that have a counterpart within about 2px on the other side;
missing or extra pages score 0. Each side is cropped twice, to all its
ink and to its solid ink only, and the best-aligned pairing counts, so a
faint header or footer line on one side doesn't misalign the whole page.
A rough progress measure, not a proof: a stray dark mark that changes
the bounding box can still sink a page.
"""
import glob, json, os, subprocess, sys, tempfile
from PIL import Image, ImageFilter, ImageChops
REF = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'test', 'samples', 'acrobat')
W = 700
def pages(pdf, d, tag):
    subprocess.run(['pdftoppm', '-r', '60', '-gray', '-png', pdf, f'{d}/{tag}'], check=True)
    return sorted(glob.glob(f'{d}/{tag}-*.png'), key=lambda p: int(p.rsplit('-',1)[1][:-4]))
def ink(path, rotate=False):
    # normalise scale/offset (A4 forms were printed shrunk onto Letter):
    # crop to the page's ink bounding box, then scale to a fixed width. Two
    # boxes: all ink, and solid ink only (v < 100), so a faint header or
    # footer line on one side alone doesn't shift and rescale the whole page;
    # the ink compared is the same (v < 160) either way
    g = (path if isinstance(path, Image.Image) else Image.open(path)).convert('L')
    if rotate: g = g.rotate(-90, expand=True, fillcolor=255)
    im = g.point(lambda v: 255 if v < 160 else 0)
    boxes = [im.getbbox(), g.point(lambda v: 255 if v < 100 else 0).getbbox()]
    if boxes[0] is None: return None
    out = []
    for box in dict.fromkeys(b for b in boxes if b):
        c = im.crop(box)
        out.append(c.resize((W, max(1, int(c.height * W / c.width)))))
    return out
def cnt(im): return im.width * im.height - im.histogram()[0]
def f1(a, b):
    # the better of the crop pairings, the one that lines the pages up; a
    # solid-ink crop only where both crops come out the same shape (else a
    # band of dark header text stretched to full width can line up with
    # anything)
    if a is None or b is None: return 1.0 if a is b else 0.0
    return max(f1_one(x, y) for i, x in enumerate(a) for j, y in enumerate(b)
               if i == j == 0 or abs(x.height - y.height) <= 0.05 * max(x.height, y.height))
def f1_one(a, b):
    h = min(a.height, b.height); a = a.crop((0,0,W,h)); b = b.crop((0,0,W,h))
    da = a.filter(ImageFilter.MaxFilter(5)); db = b.filter(ImageFilter.MaxFilter(5))
    na, nb = cnt(a), cnt(b)
    if na + nb == 0: return 1.0
    pa = cnt(ImageChops.multiply(a, db)) / max(na, 1)   # our ink near Reader ink
    pb = cnt(ImageChops.multiply(b, da)) / max(nb, 1)   # Reader ink near ours
    return 2 * pa * pb / (pa + pb) if pa + pb else 0.0
def main():
    global REF
    args = sys.argv[1:]
    if '--ref' in args:
        i = args.index('--ref'); REF = os.path.abspath(args[i + 1]); del args[i:i + 2]
    notes_path = os.path.join(os.path.dirname(REF), 'reference-notes.json')
    notes = json.load(open(notes_path)) if os.path.exists(notes_path) else {}
    out_dir = args[0] if args else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'out', 'flattened')
    tot, skipped = [], []
    for ref in sorted(glob.glob(f'{REF}/*.pdf')):
        name = os.path.basename(ref)
        note = notes.get(name[:-4], {})
        if note.get('skip') or note.get('excluded'): skipped.append(name[:-4]); continue
        ours = os.path.join(out_dir, name)
        if not os.path.exists(ours): continue
        with tempfile.TemporaryDirectory() as d:
            a, b = pages(ours, d, 'o'), pages(ref, d, 'r')
            n = max(len(a), len(b))
            s = [f1(ink(a[i]), ink(b[i], note.get('rotated'))) if i < len(a) and i < len(b) else 0 for i in range(n)]
        score = sum(s) / n
        tot.append(score)
        print(f'{name[:-4][:34]:34} {score*100:5.1f}%')
    print(f'{"AVERAGE":34} {sum(tot)/len(tot)*100:5.1f}%  ({len(tot)} samples)')
    if skipped: print('not scored (reference-notes.json):', ', '.join(skipped))

if __name__ == '__main__':
    main()
