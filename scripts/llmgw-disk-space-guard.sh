#!/usr/bin/env sh
set -eu

# Fail fast when a production LLM Gateway operation would write to a nearly
# full filesystem. The target path may not exist yet; df runs against the
# nearest existing parent.

target_path="${1:-}"
min_free_mb="${2:-}"
label="${3:-LLM Gateway disk guard}"

if [ -z "$(printf '%s' "$target_path" | xargs || true)" ]; then
  echo "ERROR: disk guard target path is required" >&2
  exit 1
fi
if ! printf '%s' "$min_free_mb" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: disk guard minimum free MB must be an integer; got: ${min_free_mb:-empty}" >&2
  exit 1
fi

probe_path="$target_path"
while [ ! -e "$probe_path" ]; do
  parent="$(dirname -- "$probe_path")"
  if [ "$parent" = "$probe_path" ]; then
    echo "ERROR: disk guard cannot find existing parent for: $target_path" >&2
    exit 1
  fi
  probe_path="$parent"
done

available_mb="$(df -Pm "$probe_path" | awk 'NR == 2 { print $4 }')"
mount_point="$(df -Pm "$probe_path" | awk 'NR == 2 { print $6 }')"
if ! printf '%s' "$available_mb" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: disk guard could not parse available space for: $target_path" >&2
  exit 1
fi

if [ "$available_mb" -lt "$min_free_mb" ]; then
  echo "ERROR: $label requires at least ${min_free_mb}MB free on $mount_point; available=${available_mb}MB target=$target_path" >&2
  echo "       Free disk space, move backups off the root volume, or point the operation at an external backup path before continuing." >&2
  exit 1
fi

echo "$label disk guard: OK available=${available_mb}MB required=${min_free_mb}MB mount=$mount_point target=$target_path"
