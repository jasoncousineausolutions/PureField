#!/usr/bin/env bash
# Run tools/bench.py with the Python set up by tools/bench/setup.sh.
#   tools/bench/run.sh "DIR" [--engines purefield,pdfjs,pdfium,mupdf,poppler] [--jobs N] [--limit N]
cd "$(dirname "$0")/../.."
exec out/bench-venv/bin/python tools/bench.py "$@"
