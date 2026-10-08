#!/usr/bin/env bash
# One-time setup for tools/bench.py on Linux (Ubuntu/Debian). Safe to re-run.
#   tools/bench/setup.sh
# Installs Poppler (system package), Pillow, PyMuPDF and pypdfium2 (Python,
# into a private virtual environment at out/bench-venv), and Playwright with
# Chromium plus pdfjs-dist (Node, into out/bench-tools). Nothing here becomes
# a dependency of Purefield.
set -euo pipefail
cd "$(dirname "$0")/../.."

need=()
command -v pdftoppm >/dev/null || need+=(poppler-utils)
python3 -c 'import venv, ensurepip' 2>/dev/null || need+=(python3-venv)
if [ ${#need[@]} -gt 0 ]; then
  echo "Installing ${need[*]} (asks for your password)"
  sudo apt-get update -qq && sudo apt-get install -y "${need[@]}"
fi
command -v node >/dev/null || { echo "Node.js is needed (it already runs Purefield's tests)"; exit 1; }

[ -d out/bench-venv ] || python3 -m venv out/bench-venv
out/bench-venv/bin/pip install -q --upgrade pip
out/bench-venv/bin/pip install -q pillow pymupdf pypdfium2

npm install --silent --prefix out/bench-tools --no-save --no-package-lock playwright pdfjs-dist@latest
(cd out/bench-tools && npx --yes playwright install chromium)
npm install --silent   # Purefield's own (dev) dependency, @xmldom/xmldom

echo
echo "Ready. Run:  tools/bench/run.sh \"\$HOME/ClaudeCode/3000 pdfs\""
