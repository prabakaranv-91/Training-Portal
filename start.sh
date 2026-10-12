#!/bin/sh

set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
VENV="$ROOT/.venv"
PYTHON="$VENV/bin/python"

if [ ! -x "$PYTHON" ]; then
    if command -v python3 >/dev/null 2>&1; then
        BOOTSTRAP=python3
    elif command -v python >/dev/null 2>&1; then
        BOOTSTRAP=python
    else
        printf '%s\n' "Python 3.10 or newer is required." >&2
        exit 1
    fi
    "$BOOTSTRAP" -m venv "$VENV"
fi

"$PYTHON" -c 'import sys; sys.version_info >= (3, 10) or sys.exit("Python 3.10 or newer is required.")'
"$PYTHON" -m pip install --quiet --upgrade pip
"$PYTHON" -m pip install --quiet -r "$ROOT/backend/requirements.txt"

cd "$ROOT"
PORT=$("$PYTHON" - <<'PY'
import socket

from backend.utils import app_db

port = max(1, int(app_db.get_setting("app_config", {}).get("port", 8000)))
while port <= 65535:
    with socket.socket() as listener:
        try:
            listener.bind(("127.0.0.1", port))
        except OSError:
            port += 1
        else:
            break
else:
    raise SystemExit("No available TCP port found.")

print(port)
PY
)

printf '\nStarting Fit Squad at http://127.0.0.1:%s\n\n' "$PORT"
exec "$PYTHON" -m uvicorn backend.main:app --host 127.0.0.1 --port "$PORT"