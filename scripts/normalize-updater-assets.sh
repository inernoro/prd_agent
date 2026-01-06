#!/usr/bin/env bash
set -euo pipefail

# Normalize updater release asset names to avoid spaces (use dot instead),
# and rewrite `latest-*.json` platforms[].url accordingly.
#
# Why:
# - GitHub assets with spaces require URL encoding (%20).
# - It's easy for CI/upload steps to rename files (space -> dot) but forget to update manifest,
#   resulting in updater download 404.
#
# Usage:
#   ./scripts/normalize-updater-assets.sh <assets_dir>
#
# Example (local build output after `pnpm tauri:build` on macOS):
#   ./scripts/normalize-updater-assets.sh prd-desktop/src-tauri/target/release/bundle/macos
#
# Example (CI artifacts dir before uploading to GitHub Release):
#   ./scripts/normalize-updater-assets.sh ./dist-assets

ASSETS_DIR="${1:-}"
if [[ -z "$ASSETS_DIR" ]]; then
  echo "[ERROR] assets_dir is required" >&2
  exit 1
fi
if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "[ERROR] assets_dir not found: $ASSETS_DIR" >&2
  exit 1
fi

echo "[INFO] Normalizing updater assets in: $ASSETS_DIR"

python3 - "$ASSETS_DIR" <<'PY'
import json
import os
import re
import sys
from pathlib import Path

assets_dir = Path(sys.argv[1])

def normalized_name(name: str) -> str:
    # Replace literal spaces in filenames with dots for consistency.
    # Keep the rest intact (we do not change underscores or hyphens).
    return name.replace("PRD Agent", "PRD.Agent")

def normalize_files():
    changed = []
    for p in sorted(assets_dir.glob("*")):
        if not p.is_file():
            continue
        new_name = normalized_name(p.name)
        if new_name == p.name:
            continue
        dst = p.with_name(new_name)
        if dst.exists():
            # If both exist, keep the dot version and remove the spaced one.
            # This avoids accidental overwrite in CI.
            p.unlink()
            changed.append((p.name, "(deleted; already has " + dst.name + ")"))
            continue
        p.rename(dst)
        changed.append((p.name, dst.name))
    return changed

def rewrite_manifest_urls():
    changed = []
    for p in sorted(assets_dir.glob("latest-*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue

        platforms = data.get("platforms")
        if not isinstance(platforms, dict):
            continue

        updated = False
        for _, info in platforms.items():
            if not isinstance(info, dict):
                continue
            url = info.get("url")
            if not isinstance(url, str) or not url:
                continue

            new_url = url.replace("PRD%20Agent", "PRD.Agent").replace("PRD Agent", "PRD.Agent")
            if new_url != url:
                info["url"] = new_url
                updated = True

        if updated:
            p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            changed.append(p.name)
    return changed

file_changes = normalize_files()
manifest_changes = rewrite_manifest_urls()

if file_changes:
    print("[OK] Renamed assets:")
    for src, dst in file_changes:
        print(f"  - {src} -> {dst}")
else:
    print("[OK] No asset renames needed.")

if manifest_changes:
    print("[OK] Rewrote manifest url(s) in:")
    for n in manifest_changes:
        print(f"  - {n}")
else:
    print("[OK] No manifest rewrites needed.")
PY

echo "[DONE] Normalize completed."


