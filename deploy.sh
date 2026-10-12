#!/bin/sh
set -eu
umask 077

ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' "Install Docker Engine and the Docker Compose plugin first." >&2
    exit 1
fi
if [ ! -f .env ]; then
    printf '%s\n' "Create .env from .env.example and set your domain and certificate email." >&2
    exit 1
fi
docker compose config --quiet

backup_database() {
    mkdir -p backups
    backup="backups/app-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite3"
    if docker compose exec -T app python -c '
from contextlib import closing
import os
import sqlite3
import sys
import tempfile

descriptor, path = tempfile.mkstemp(suffix=".sqlite3")
os.close(descriptor)
try:
    with closing(sqlite3.connect("file:/app/data/app.sqlite3?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(path)) as destination:
            source.backup(destination)
    with open(path, "rb") as backup:
        while chunk := backup.read(1024 * 1024):
            sys.stdout.buffer.write(chunk)
finally:
    os.unlink(path)
' > "$backup"; then
        printf 'Backup created: %s\n' "$backup"
    else
        rm -f "$backup"
        printf '%s\n' "Backup failed; no deployment changes were made." >&2
        exit 1
    fi
}

case "${1:-up}" in
    up|update)
        if [ "${1:-up}" = update ] && docker compose ps --status running --services | grep -qx app; then
            backup_database
        fi
        docker compose pull proxy
        docker compose up --detach --build --force-recreate --wait --wait-timeout 180
        docker compose exec -T proxy sh -c 'printf "Stack started. Open https://%s:%s\n" "$APP_DOMAIN" "$HTTPS_PORT"'
        ;;
    backup)
        backup_database
        ;;
    down)
        docker compose down
        ;;
    logs)
        docker compose logs --follow --tail 100
        ;;
    status)
        docker compose ps
        ;;
    *)
        printf '%s\n' "Usage: sh deploy.sh [up|update|backup|down|logs|status]" >&2
        exit 1
        ;;
esac