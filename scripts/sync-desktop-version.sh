#!/usr/bin/env bash
set -euo pipefail

# Sync prd-desktop version across:
# - prd-desktop/src-tauri/tauri.conf.json (Tauri config)
# - prd-desktop/src-tauri/Cargo.toml      (Rust crate)
# - prd-desktop/package.json             (frontend package)
#
# Version source priority:
# 1) First CLI arg
# 2) GITHUB_REF_NAME (e.g. v1.2.4)
# 3) GITHUB_REF (e.g. refs/tags/v1.2.4)
# 4) git describe --tags --abbrev=0
#
# Notes:
# - Accepts "vX.Y.Z" or "X.Y.Z" (also allows pre-release/build suffix).
# - Does NOT create git commits/tags; it only edits files in-place.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

raw="${1:-}"
if [[ -z "$raw" ]]; then
  raw="${GITHUB_REF_NAME:-}"
fi
if [[ -z "$raw" ]]; then
  if [[ -n "${GITHUB_REF:-}" ]]; then
    raw="${GITHUB_REF##*/}"
  fi
fi
if [[ -z "$raw" ]]; then
  if command -v git >/dev/null 2>&1; then
    raw="$(git -C "$ROOT_DIR" describe --tags --abbrev=0 2>/dev/null || true)"
  fi
fi

if [[ -z "$raw" ]]; then
  echo "[ERROR] No version input. Provide a version, or set GITHUB_REF_NAME/GITHUB_REF, or ensure git tags exist." >&2
  exit 1
fi

# strip leading "v"
version="$raw"
if [[ "$version" == v* ]]; then
  version="${version:1}"
fi

# basic validation (semver-ish)
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([\-+][0-9A-Za-z\.\-]+)?$ ]]; then
  echo "[ERROR] Invalid version: '$raw' -> '$version' (expected like v1.2.3 / 1.2.3 / 1.2.3-beta.1)" >&2
  exit 1
fi

TAURI_CONF="$ROOT_DIR/prd-desktop/src-tauri/tauri.conf.json"
CARGO_TOML="$ROOT_DIR/prd-desktop/src-tauri/Cargo.toml"
PKG_JSON="$ROOT_DIR/prd-desktop/package.json"

for f in "$TAURI_CONF" "$CARGO_TOML" "$PKG_JSON"; do
  if [[ ! -f "$f" ]]; then
    echo "[ERROR] Missing file: $f" >&2
    exit 1
  fi
done

echo "[INFO] Syncing desktop version to: $version"

# 1) tauri.conf.json (json)
python3 - "$TAURI_CONF" "$version" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]

data = json.loads(path.read_text(encoding="utf-8"))
data["version"] = version

path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

# 2) package.json (json)
python3 - "$PKG_JSON" "$version" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]

data = json.loads(path.read_text(encoding="utf-8"))
data["version"] = version

path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

# 3) Cargo.toml (only [package].version)
python3 - "$CARGO_TOML" "$version" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]

lines = path.read_text(encoding="utf-8").splitlines(True)

in_package = False
done = False
out = []

for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        in_package = stripped == "[package]"
    if in_package and (not done) and re.match(r'^\s*version\s*=\s*".*"\s*$', line):
        out.append(re.sub(r'^\s*version\s*=\s*".*"\s*$', f'version = "{version}"', line).rstrip("\n") + "\n")
        done = True
    else:
        out.append(line)

if not done:
    raise SystemExit("[ERROR] Failed to update Cargo.toml: could not find [package].version")

path.write_text("".join(out), encoding="utf-8")
PY

echo "[OK] Updated:"
echo "  - $TAURI_CONF"
echo "  - $PKG_JSON"
echo "  - $CARGO_TOML"


