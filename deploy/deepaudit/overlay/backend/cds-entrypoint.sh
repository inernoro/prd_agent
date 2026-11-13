#!/bin/sh
set -eu
if [ "$(id -u)" -eq 0 ]; then
  install -d -m 0750 -o 10001 -g 10001 /app/uploads /app/data /app/.cache
  chown -hR 10001:10001 /app/uploads /app/data /app/.cache
  exec gosu 10001:10001 "$0" "$@"
fi
if [ "${1:-}" = check-storage ]; then
  exec .venv/bin/python -c 'import os,pathlib,tempfile; assert os.getuid() == 10001; paths=[pathlib.Path("/app/uploads/zip_files"),pathlib.Path("/app/data")]; [(p.mkdir(parents=True,exist_ok=True), tempfile.TemporaryFile(dir=p).close()) for p in paths]; print("Owned persistence writable as UID 10001")'
fi
.venv/bin/python -c 'from app.cds_runtime import validate_runtime_config; validate_runtime_config()'
.venv/bin/alembic upgrade head
exec .venv/bin/uvicorn app.cds_runtime:app --host 0.0.0.0 --port 8000 --workers 1
