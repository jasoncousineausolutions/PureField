"""Compare Purefield and other PDF renderers with Adobe Reader prints, at scale.

    tools/bench/setup.sh                              # once: installs the renderers
    python3 tools/bench.py "DIR"                      # DIR/*.pdf vs DIR/acrobat/*.pdf
    python3 tools/bench.py "DIR" --engines purefield,pdfium --jobs 8 --limit 50

Every DIR/<name>.pdf with a Reader print DIR/acrobat/<name>.pdf is drawn by
each engine and scored against that print with tools/score.py's measure
(0-100% per page, missing or extra pages 0, averaged per file):

    purefield  this library's flattened output (Node)
    pdfjs      Firefox's pdf.js, XFA enabled, printed from headless Chromium
    pdfium     Chrome's PDFium (pypdfium2), form fields drawn
    mupdf      MuPDF (PyMuPDF), annotations and widgets drawn
    poppler    Poppler's pdftoppm (Evince, Okular, most Linux viewers)

Results go to DIR/bench/ (or --out):
    results.csv   one row per file: score, page count, status and seconds per engine
    summary.txt   averages, wins, failures, and Purefield's worst files and
                  biggest losses against the best other engine
    worst/        side-by-side PNGs (Reader | Purefield | best other engine) of
                  the worst page of Purefield's 50 worst files

The run saves after every file, so stopping it (Ctrl+C) and running the same
command again carries on where it left off; delete results.csv to start over.
Each file runs in its own process with a time limit (--timeout, seconds per
engine), so a file that hangs or crashes one engine is recorded and skipped.
A reference-notes.json in DIR, as in samples/xfa, is honoured: files
marked "skip" or "excluded" are left out, "rotated" prints are turned first.
A passwords.json in DIR ({"name": "password"}) supplies passwords (or a
sources.json as in samples/nonxfa).
"""
import csv, glob, json, os, subprocess, sys, tempfile, time, warnings
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from score import ink, f1  # noqa: E402

ENGINES = ['purefield', 'pdfjs', 'pdfium', 'mupdf', 'poppler']
DPI = 60  # score.py's resolution


def opt(args, name, default):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default


def pdftoppm(pdf, d, tag, password=''):
    pw = ['-upw', password] if password else []
    subprocess.run(['pdftoppm', '-r', str(DPI), '-gray', '-png', *pw, pdf, f'{d}/{tag}'], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return [Image.open(p) for p in sorted(glob.glob(f'{d}/{tag}-*.png'), key=lambda p: int(p.rsplit('-', 1)[1][:-4]))]


def render_pdfium(pdf, password):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf, password=password or None)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')  # XFA forms: this PDFium build draws their AcroForm layer
            doc.init_forms()
    except Exception:
        pass
    out = []
    for i in range(len(doc)):
        page = doc[i]
        out.append(page.render(scale=DPI / 72, may_draw_forms=True).to_pil().convert('L'))
    return out


def render_mupdf(pdf, password):
    import pymupdf
    doc = pymupdf.open(pdf)
    if doc.needs_pass and not doc.authenticate(password or ''):
        raise RuntimeError('password required')
    out = []
    for page in doc:
        pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY, annots=True)
        out.append(Image.frombytes('L', (pix.width, pix.height), pix.samples))
    return out


def score_pages(ours, ref, rotated):
    n = max(len(ours), len(ref))
    if n == 0:
        return 0.0, None, []
    s = [f1(ink(ours[i]), ink(ref[i], rotated)) if i < len(ours) and i < len(ref) else 0 for i in range(n)]
    return sum(s) / n, min(range(n), key=lambda i: s[i]), s


def one(args):
    """Child process: score one file with each engine, one JSON line per engine."""
    src, ref_pdf, out_dir, engines, rotated, password = args[0], args[1], args[2], args[3].split(','), args[4] == '1', args[5]
    name = os.path.basename(src)
    with tempfile.TemporaryDirectory() as d:
        ref = pdftoppm(ref_pdf, d, 'ref')
        print(json.dumps({'engine': 'ref', 'pages': len(ref)}), flush=True)
        for engine in engines:
            started = time.time()
            r = {'engine': engine}
            try:
                if engine == 'purefield':
                    flat = os.path.join(d, 'purefield.pdf')
                    res = subprocess.run(['node', os.path.join(HERE, 'bench', 'flatten-one.mjs'), src, flat, password],
                                         capture_output=True, text=True)
                    info = json.loads((res.stdout.strip().splitlines() or ['{}'])[-1] or '{}')
                    if 'error' in info or not os.path.exists(flat):
                        raise RuntimeError(info.get('error') or res.stderr.strip().splitlines()[-1:] or 'no output')
                    pages = pdftoppm(flat, d, 'purefield')
                elif engine == 'pdfjs':
                    printed = os.path.join(out_dir, 'pdfjs', name)
                    if not os.path.exists(printed):
                        raise RuntimeError(pdfjs_error(out_dir, name))
                    pages = pdftoppm(printed, d, 'pdfjs')
                elif engine == 'pdfium':
                    pages = render_pdfium(src, password)
                elif engine == 'mupdf':
                    pages = render_mupdf(src, password)
                elif engine == 'poppler':
                    pages = pdftoppm(src, d, 'poppler', password)
                score, worst, _ = score_pages(pages, ref, rotated)
                r.update(score=round(score * 100, 1), pages=len(pages), worst_page=(worst or 0) + 1, status='ok')
            except Exception as e:
                r.update(status='error', error=str(e).replace('\n', ' ')[:200])
            r['secs'] = round(time.time() - started, 1)
            print(json.dumps(r), flush=True)


def pdfjs_error(out_dir, name):
    status = os.path.join(out_dir, 'pdfjs', 'status.jsonl')
    if os.path.exists(status):
        for line in open(status, encoding='utf8'):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('file') == name and r.get('error'):
                return 'pdf.js: ' + r['error']
    return 'pdf.js printed nothing'


def run_one(src, ref, out_dir, engines, rotated, password, timeout):
    """Parent side: runs one() in a child with a time limit; returns {engine: result}."""
    cmd = [sys.executable, os.path.abspath(__file__), '--one', src, ref, out_dir, ','.join(engines), '1' if rotated else '0', password or '']
    results, limit = {}, timeout * (len(engines) + 1)
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=limit)
        out = res.stdout
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
    for line in out.splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        results[r.pop('engine')] = r
    hung = next((e for e in engines if e not in results), None)
    for engine in engines:
        if engine not in results:
            # the engine running when the time ran out (or the child crashed);
            # the engines after it never ran
            if 'ref' not in results:
                results[engine] = {'status': 'error', 'error': 'Reader print could not be read'}
            elif engine == hung:
                results[engine] = {'status': 'timeout', 'error': 'timed out or crashed'}
            else:
                results[engine] = {'status': 'not run', 'error': f'not run: {hung} timed out first'}
    return results


def side_by_side(src, ref_pdf, out_dir, engines, best_other, page, rotated, password, dest):
    with tempfile.TemporaryDirectory() as d:
        ref = pdftoppm(ref_pdf, d, 'ref')
        cols = [('Adobe Reader', ref)]
        for engine in ['purefield', best_other]:
            if not engine:
                continue
            try:
                if engine == 'purefield':
                    flat = os.path.join(d, 'pf.pdf')
                    subprocess.run(['node', os.path.join(HERE, 'bench', 'flatten-one.mjs'), src, flat, password or ''], capture_output=True)
                    imgs = pdftoppm(flat, d, 'pf')
                elif engine == 'pdfjs':
                    imgs = pdftoppm(os.path.join(out_dir, 'pdfjs', os.path.basename(src)), d, 'pj')
                elif engine == 'pdfium':
                    imgs = render_pdfium(src, password)
                elif engine == 'mupdf':
                    imgs = render_mupdf(src, password)
                else:
                    imgs = pdftoppm(src, d, 'pp', password)
            except Exception:
                imgs = []
            cols.append((engine, imgs))
        h = 800
        tiles = []
        for _, imgs in cols:
            im = imgs[page - 1].convert('L') if page - 1 < len(imgs) else Image.new('L', (618, 800), 200)
            if rotated and imgs is ref:
                im = im.rotate(-90, expand=True, fillcolor=255)
            tiles.append(im.resize((max(1, int(im.width * h / im.height)), h)))
        sheet = Image.new('L', (sum(t.width for t in tiles) + 10 * (len(tiles) - 1), h + 24), 128)
        draw = ImageDraw.Draw(sheet)
        x = 0
        for (label, _), t in zip(cols, tiles):
            sheet.paste(t, (x, 24)); draw.text((x + 6, 6), label, fill=255); x += t.width + 10
        sheet.save(dest)


def main():
    args = sys.argv[1:]
    if args and args[0] == '--one':
        return one(args[1:])
    engines = opt(args, '--engines', ','.join(ENGINES)).split(',')
    unknown = [e for e in engines if e not in ENGINES]
    if unknown:
        sys.exit(f'unknown engine(s): {", ".join(unknown)}; choose from {", ".join(ENGINES)}')
    jobs = int(opt(args, '--jobs', max(1, (os.cpu_count() or 2) - 1)))
    timeout = int(opt(args, '--timeout', 120))
    limit = int(opt(args, '--limit', 0))
    if not args:
        sys.exit(__doc__)
    src_dir = os.path.abspath(os.path.expanduser(args[0]))
    ref_dir = os.path.abspath(os.path.expanduser(opt(args, '--ref', os.path.join(src_dir, 'acrobat'))))
    out_dir = os.path.abspath(os.path.expanduser(opt(args, '--out', os.path.join(src_dir, 'bench'))))
    os.makedirs(out_dir, exist_ok=True)

    notes_path = os.path.join(src_dir, 'reference-notes.json')
    notes = json.load(open(notes_path)) if os.path.exists(notes_path) else {}
    pw_path = os.path.join(src_dir, 'passwords.json')
    passwords = json.load(open(pw_path)) if os.path.exists(pw_path) else {}
    sources_path = os.path.join(src_dir, 'sources.json')  # as in samples/nonxfa: { name: { password } }
    if os.path.exists(sources_path):
        sources = json.load(open(sources_path))
        entries = sources.items() if isinstance(sources, dict) else ((e.get('file') or e.get('name'), e) for e in sources)
        for k, v in entries:
            if isinstance(v, dict) and v.get('password'):
                passwords.setdefault(k, v['password'])

    refs = {f.lower(): os.path.join(ref_dir, f) for f in os.listdir(ref_dir) if f.lower().endswith('.pdf')}
    files, no_ref, skipped = [], [], []
    for f in sorted(os.listdir(src_dir)):
        if not f.lower().endswith('.pdf'):
            continue
        note = notes.get(f[:-4], {})
        if note.get('skip') or note.get('excluded'):
            skipped.append(f); continue
        if f.lower() in refs:
            files.append(f)
        else:
            no_ref.append(f)
    if limit:
        files = files[:limit]

    csv_path = os.path.join(out_dir, 'results.csv')
    cols = ['file', 'reader_pages'] + [f'{e}_{k}' for e in engines for k in ('score', 'pages', 'status', 'secs')] + ['purefield_worst_page', 'errors']
    done = set()
    if os.path.exists(csv_path):
        with open(csv_path, newline='', encoding='utf8') as fh:
            rows = list(csv.DictReader(fh))
        if rows and list(rows[0].keys()) != cols:
            sys.exit(f'{csv_path} was made with other engines; delete it or pass the same --engines')
        done = {r['file'] for r in rows}
    todo = [f for f in files if f not in done]
    print(f'{len(files)} PDFs with a Reader print ({len(done)} already scored, {len(todo)} to go); '
          f'{len(no_ref)} without one; {len(skipped)} skipped by reference-notes.json. Engines: {", ".join(engines)}')

    if 'pdfjs' in engines and todo:
        lst = os.path.join(out_dir, 'pdfjs-todo.txt')
        open(lst, 'w', encoding='utf8').write('\n'.join(todo))
        print('pdf.js: printing (resumable)...')
        res = subprocess.run(['node', os.path.join(HERE, 'bench', 'pdfjs-print.mjs'), '--in', src_dir, '--out', os.path.join(out_dir, 'pdfjs'),
                              '--jobs', str(jobs), '--timeout', str(timeout), '--list', lst])
        if res.returncode != 0:
            sys.exit('pdf.js could not run (see the error above). Run tools/bench/setup.sh, '
                     'or leave pdf.js out with --engines purefield,pdfium,mupdf,poppler')

    new_file = not os.path.exists(csv_path)
    fh = open(csv_path, 'a', newline='', encoding='utf8')
    writer = csv.DictWriter(fh, fieldnames=cols)
    if new_file:
        writer.writeheader()
    started, count = time.time(), 0

    def task(f):
        return f, run_one(os.path.join(src_dir, f), refs[f.lower()], out_dir, engines,
                          bool(notes.get(f[:-4], {}).get('rotated')), passwords.get(f[:-4], passwords.get(f, '')), timeout)

    try:
        with ThreadPoolExecutor(jobs) as pool:
            for f, res in pool.map(task, todo):
                row = {'file': f, 'reader_pages': res.get('ref', {}).get('pages', '')}
                errs = []
                for e in engines:
                    r = res[e]
                    row.update({f'{e}_score': r.get('score', 0 if r['status'] != 'ok' else ''), f'{e}_pages': r.get('pages', ''),
                                f'{e}_status': r['status'], f'{e}_secs': r.get('secs', '')})
                    if r.get('error'):
                        errs.append(f'{e}: {r["error"]}')
                row['purefield_worst_page'] = res.get('purefield', {}).get('worst_page', '')
                row['errors'] = ' | '.join(errs)[:500]
                writer.writerow(row); fh.flush()
                count += 1
                if count % 25 == 0 or count == len(todo):
                    rate = (time.time() - started) / count
                    print(f'{count}/{len(todo)} scored, about {int(rate * (len(todo) - count) / 60)} min left', flush=True)
    except KeyboardInterrupt:
        print('\nStopped; run the same command again to carry on.')
        fh.close()
        return
    fh.close()
    summarize(csv_path, engines, out_dir, src_dir, refs, notes, passwords, no_ref, skipped)


def summarize(csv_path, engines, out_dir, src_dir, refs, notes, passwords, no_ref, skipped):
    with open(csv_path, newline='', encoding='utf8') as fh:
        rows = list(csv.DictReader(fh))
    num = lambda r, e: float(r[f'{e}_score'] or 0)
    ok = lambda r, e: r[f'{e}_status'] == 'ok'
    lines = [f'{len(rows)} PDFs scored against their Adobe Reader prints ({len(no_ref)} had no print, {len(skipped)} skipped).', '']
    lines.append('Average score per engine (a failed render counts as 0):')
    lines.append(f'  {"engine":10} {"average":>8} {">=90%":>7} {"70-90%":>7} {"<70%":>7} {"failed":>7} {"timeout":>8} {"pages match":>12}')
    for e in engines:
        s = [num(r, e) for r in rows]
        lines.append(f'  {e:10} {sum(s) / max(len(s), 1):7.1f}% {sum(x >= 90 for x in s):7} {sum(70 <= x < 90 for x in s):7} '
                     f'{sum(x < 70 for x in s):7} {sum(r[e + "_status"] == "error" for r in rows):7} '
                     f'{sum(r[e + "_status"] == "timeout" for r in rows):8} '
                     f'{sum(ok(r, e) and r[e + "_pages"] == r["reader_pages"] for r in rows):12}')
    both = [r for r in rows if all(ok(r, e) for e in engines)]
    if both and len(engines) > 1:
        lines += ['', f'Only the {len(both)} PDFs every engine rendered:']
        for e in engines:
            lines.append(f'  {e:10} {sum(num(r, e) for r in both) / len(both):7.1f}%')
    if len(engines) > 1:
        wins, ties = {e: 0 for e in engines}, 0
        for r in rows:
            top = max(num(r, e) for e in engines)
            best = [e for e in engines if num(r, e) == top]
            if len(best) == 1:
                wins[best[0]] += 1
            else:
                ties += 1
        lines += ['', 'Closest to Reader (files where each engine alone scores best): '
                  + ', '.join(f'{e} {n}' for e, n in wins.items()) + f'; tied {ties}']
    worst_dir = os.path.join(out_dir, 'worst')
    if 'purefield' in engines:
        others = [e for e in engines if e != 'purefield']
        best_other = lambda r: max(others, key=lambda e: num(r, e)) if others else None
        worst = sorted(rows, key=lambda r: num(r, 'purefield'))[:50]
        lines += ['', "Purefield's 50 lowest scores:", f'  {"score":>6}  {"best other":18}  file  (status/error)']
        for r in worst:
            b = best_other(r)
            lines.append(f'  {num(r, "purefield"):5.1f}%  {(f"{b} {num(r, b):.1f}%" if b else ""):18}  {r["file"]}'
                         + (f'  ({r["errors"][:120]})' if r['purefield_status'] != 'ok' else ''))
        if others:
            losses = sorted(rows, key=lambda r: num(r, 'purefield') - num(r, best_other(r)))[:50]
            lines += ['', 'Biggest losses to the best other engine (fix these first):', f'  {"gap":>6}  {"purefield":>9}  {"best other":18}  file']
            for r in losses:
                b = best_other(r); gap = num(r, b) - num(r, 'purefield')
                if gap <= 0:
                    break
                lines.append(f'  {gap:5.1f}  {num(r, "purefield"):8.1f}%  {f"{b} {num(r, b):.1f}%":18}  {r["file"]}')
        os.makedirs(worst_dir, exist_ok=True)
        for f in glob.glob(os.path.join(worst_dir, '*.png')):
            os.remove(f)
        for i, r in enumerate(worst, 1):
            if r['purefield_status'] != 'ok':
                continue
            f = r['file']
            try:
                side_by_side(os.path.join(src_dir, f), refs[f.lower()], out_dir, engines, best_other(r), int(r['purefield_worst_page'] or 1),
                             bool(notes.get(f[:-4], {}).get('rotated')), passwords.get(f[:-4], passwords.get(f, '')),
                             os.path.join(worst_dir, f'{i:02d}-{f[:-4]}-p{r["purefield_worst_page"]}.png'))
            except Exception:
                pass
        lines += ['', f'Side-by-sides (Reader | purefield | best other) of the worst page of each: {worst_dir}']
    if no_ref:
        lines += ['', f'{len(no_ref)} PDFs have no Reader print in the acrobat folder (first 20): ' + ', '.join(no_ref[:20])]
    text = '\n'.join(lines) + '\n'
    open(os.path.join(out_dir, 'summary.txt'), 'w', encoding='utf8').write(text)
    print(text)
    print(f'Results: {csv_path}\nSummary: {os.path.join(out_dir, "summary.txt")}')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nStopped; run the same command again to carry on.')
