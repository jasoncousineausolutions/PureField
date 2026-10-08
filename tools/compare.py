"""Side-by-side PNGs: Purefield output (left) vs the Adobe Reader print (right).

    node tools/flatten-samples.mjs
    python3 tools/compare.py [name-filter]      # needs pdftoppm (poppler) and Pillow
    python3 tools/compare.py [name-filter] --ours out/batch3 --ref samples/xfa/acrobat --out out/compare-b3

Writes out/compare/<name>-p<N>.png, one per page, both sides scaled to the
same height (A4 forms were printed on Letter, so compare them scaled), and
prints the pages most different first: the mean grey-level difference of
the two sides, each cropped to its ink and blurred (0 = identical; text
rendering alone leaves a few points).
"""
import glob, os, subprocess, sys
from PIL import Image, ImageChops, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OURS = os.path.join(ROOT, 'out', 'flattened')
REF = os.path.join(ROOT, 'test', 'samples', 'acrobat')
OUT = os.path.join(ROOT, 'out', 'compare')
H = 1000

def render(pdf, prefix):
    for f in glob.glob(prefix + '-*.png'):
        os.remove(f)
    subprocess.run(['pdftoppm', '-r', '90', '-png', pdf, prefix], check=True)
    return sorted(glob.glob(prefix + '-*.png'), key=lambda p: int(p.rsplit('-', 1)[1][:-4]))

def score(a, b):
    def norm(im):
        g = im.convert('L')
        box = ImageOps.invert(g).point(lambda v: 255 if v > 40 else 0).getbbox()
        if box:
            g = g.crop(box)
        return g.resize((600, 780)).filter(ImageFilter.GaussianBlur(2))
    d = ImageChops.difference(norm(a), norm(b))
    return sum(d.histogram()[i] * i for i in range(256)) / (600 * 780)

def main():
    global OURS, REF, OUT
    args = sys.argv[1:]
    for flag in ('--ours', '--ref', '--out'):
        if flag in args:
            i = args.index(flag)
            path = os.path.abspath(args[i + 1])
            del args[i:i + 2]
            if flag == '--ours': OURS = path
            elif flag == '--ref': REF = path
            else: OUT = path
    os.makedirs(OUT, exist_ok=True)
    flt = args[0] if args else ''
    scores = []
    for ref in sorted(glob.glob(os.path.join(REF, '*.pdf'))):
        name = os.path.basename(ref)[:-4]
        ours = os.path.join(OURS, name + '.pdf')
        if flt not in name or not os.path.exists(ours):
            continue
        for f in glob.glob(os.path.join(OUT, f'{name}-p*.png')):
            os.remove(f)  # pages left over from an earlier, longer run
        a = render(ours, os.path.join(OUT, '_o_' + name))
        b = render(ref, os.path.join(OUT, '_r_' + name))
        for i in range(max(len(a), len(b))):
            ims = []
            for lst in (a, b):
                if i < len(lst):
                    im = Image.open(lst[i]).convert('RGB')
                    im = im.resize((int(im.width * H / im.height), H))
                else:
                    im = Image.new('RGB', (int(H * 0.77), H), (220, 220, 220))
                ims.append(im)
            out = Image.new('RGB', (ims[0].width + ims[1].width + 10, H), (255, 0, 0))
            out.paste(ims[0], (0, 0))
            out.paste(ims[1], (ims[0].width + 10, 0))
            out.save(os.path.join(OUT, f'{name}-p{i + 1}.png'))
            if i < len(a) and i < len(b):
                scores.append((score(Image.open(a[i]), Image.open(b[i])), f'{name}-p{i + 1}'))
        for f in glob.glob(os.path.join(OUT, '_*.png')):
            os.remove(f)
        print(f'{name}: ours {len(a)} page(s), Reader {len(b)}')
    print('\nMost different first:')
    for sc, page in sorted(scores, reverse=True)[:20]:
        print(f'{sc:7.2f}  {page}')

main()
