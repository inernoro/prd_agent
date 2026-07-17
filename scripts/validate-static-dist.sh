#!/usr/bin/env sh
set -eu

normalize=0
if [ "${1:-}" = "--normalize" ]; then
  normalize=1
  shift
fi

static_root="${1:-}"
if [ -z "$static_root" ] || [ "$#" -ne 1 ]; then
  echo "Usage: $0 [--normalize] <static-root>" >&2
  exit 2
fi

fail() {
  echo "ERROR: static dist validation failed: $1" >&2
  echo "RECOVERY: keep the current online static directory unchanged and provide a complete verified artifact." >&2
  exit 1
}

[ -d "$static_root" ] || fail "directory does not exist: $static_root"
static_root="$(CDPATH= cd -- "$static_root" && pwd -P)"
[ -s "$static_root/index.html" ] || fail "index.html is missing or empty: $static_root/index.html"

entry_asset_count="$(python3 - "$static_root" <<'PY'
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import sys


class EntryAssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets = []

    def handle_starttag(self, tag, attrs):
        values = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "script" and values.get("src"):
            self.assets.append(("js", values["src"]))
        if tag.lower() == "link" and values.get("href"):
            rel = {part.lower() for part in values.get("rel", "").split()}
            if "stylesheet" in rel:
                self.assets.append(("css", values["href"]))


root = Path(sys.argv[1]).resolve()
index = root / "index.html"
parser = EntryAssetParser()
parser.feed(index.read_text(encoding="utf-8"))

local_assets = []
for kind, raw_url in parser.assets:
    parsed = urlsplit(raw_url)
    if parsed.scheme or parsed.netloc or raw_url.startswith("//"):
        continue
    relative = unquote(parsed.path).lstrip("/")
    if not relative:
        continue
    asset = (root / relative).resolve()
    try:
        asset.relative_to(root)
    except ValueError:
        raise SystemExit(f"entry asset escapes static root: {raw_url}")
    local_assets.append((kind, raw_url, asset))

if not any(kind == "js" for kind, _, _ in local_assets):
    raise SystemExit("index.html does not reference a local JavaScript entry asset")

for _, raw_url, asset in local_assets:
    if not asset.is_file() or asset.stat().st_size <= 0:
        raise SystemExit(f"referenced entry asset is missing or empty: {raw_url}")

print(len(local_assets))
PY
)" || fail "index.html or its local entry assets are invalid"

if [ "$normalize" = "1" ]; then
  find "$static_root" -type d -exec chmod 755 {} +
  find "$static_root" -type f -exec chmod 644 {} +
  bad_dir="$(find "$static_root" -type d ! -perm 755 -print -quit)"
  [ -z "$bad_dir" ] || fail "directory mode is not 755: $bad_dir"
  bad_file="$(find "$static_root" -type f ! -perm 644 -print -quit)"
  [ -z "$bad_file" ] || fail "file mode is not 644: $bad_file"
fi

echo "Static dist validation: PASS root=$static_root entryAssets=$entry_asset_count normalized=$normalize"
