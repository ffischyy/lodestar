#!/usr/bin/env bash
# Lodestar launcher for macOS / Linux.
set -euo pipefail
cd "$(dirname "$0")"
PY=""
for v in python3.12 python3.13 python3.11 python3; do
  if command -v "$v" >/dev/null && "$v" -c 'import sys; sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,13) else 1)'; then PY="$v"; break; fi
done
[ -z "$PY" ] && { echo "Lodestar needs Python 3.11-3.13."; exit 1; }
[ -x .venv/bin/python ] || "$PY" -m venv .venv
if ! cmp -s backend/requirements.txt .venv/requirements.stamp; then
  .venv/bin/python -m pip install --upgrade pip -q
  .venv/bin/python -m pip install -r backend/requirements.txt
  cp backend/requirements.txt .venv/requirements.stamp
fi
[ -f .env ] || cp .env.example .env
cd backend
LODESTAR_OPEN_BROWSER=1 ../.venv/bin/python -m lodestar.main
