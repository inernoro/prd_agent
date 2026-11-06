#!/bin/sh
set -eu
.venv/bin/python -c 'from app.cds_runtime import validate_runtime_config; validate_runtime_config()'
.venv/bin/alembic upgrade head
exec .venv/bin/uvicorn app.cds_runtime:app --host 0.0.0.0 --port 8000 --workers 1
