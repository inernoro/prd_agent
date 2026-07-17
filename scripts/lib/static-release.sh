#!/usr/bin/env sh

STATIC_RELEASE_SWITCH_PERFORMED="${STATIC_RELEASE_SWITCH_PERFORMED:-0}"
STATIC_RELEASE_TARGET="${STATIC_RELEASE_TARGET:-}"
STATIC_RELEASE_ROLLBACK_TARGET="${STATIC_RELEASE_ROLLBACK_TARGET:-}"

static_release_atomic_link() {
  link_path="$1"
  link_target="$2"
  next_link="${link_path}.next.$$"

  rm -f "$next_link"
  ln -s "$link_target" "$next_link"
  python3 - "$next_link" "$link_path" <<'PY'
import os
import sys

os.replace(sys.argv[1], sys.argv[2])
PY
}

static_release_activate() {
  staging_dir="$1"
  static_root="$2"
  release_id="$3"

  case "$release_id" in
    ''|*[!A-Za-z0-9._-]*)
      echo "ERROR: static release id contains unsupported characters: $release_id" >&2
      return 1
      ;;
  esac
  if [ ! -d "$staging_dir" ] || [ ! -s "$staging_dir/index.html" ]; then
    echo "ERROR: static release staging directory is incomplete: $staging_dir" >&2
    return 1
  fi

  releases_dir="$static_root/.releases"
  release_target=".releases/$release_id"
  release_dir="$static_root/$release_target"
  if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
    echo "ERROR: static release target already exists: $release_dir" >&2
    return 1
  fi
  mkdir -p "$releases_dir"

  original_current_target="$(readlink "$static_root/current" 2>/dev/null || true)"
  original_previous_target="$(readlink "$static_root/previous" 2>/dev/null || true)"
  rollback_target="$original_current_target"
  legacy_target=""
  if [ -z "$rollback_target" ] && [ -s "$static_root/index.html" ]; then
    legacy_target=".releases/legacy-$release_id"
    legacy_dir="$static_root/$legacy_target"
    if [ -e "$legacy_dir" ] || [ -L "$legacy_dir" ]; then
      echo "ERROR: legacy static release target already exists: $legacy_dir" >&2
      return 1
    fi
    mkdir -p "$legacy_dir"
    find "$static_root" -mindepth 1 -maxdepth 1 \
      ! -name '.releases' \
      ! -name 'current' \
      ! -name 'previous' \
      ! -name '.staging-*' \
      -exec cp -a {} "$legacy_dir/" \;
    if [ ! -s "$legacy_dir/index.html" ]; then
      echo "ERROR: existing static root could not be copied into a rollback release" >&2
      rm -rf "$legacy_dir"
      return 1
    fi
    rollback_target="$legacy_target"
  fi

  mv "$staging_dir" "$release_dir"

  STATIC_RELEASE_TARGET="$release_target"
  STATIC_RELEASE_ROLLBACK_TARGET="$rollback_target"
  # Mark before link mutation so the caller can recover if interrupted between
  # the two atomic replacements. The failure branch clears this marker again.
  STATIC_RELEASE_SWITCH_PERFORMED=1
  activation_failed=0
  if [ -n "$rollback_target" ]; then
    static_release_atomic_link "$static_root/previous" "$rollback_target" || activation_failed=1
  elif ! rm -f "$static_root/previous"; then
    activation_failed=1
  fi
  if [ "$activation_failed" = "0" ]; then
    static_release_atomic_link "$static_root/current" "$release_target" || activation_failed=1
  fi

  if [ "$activation_failed" != "0" ]; then
    echo "ERROR: static release link switch failed; restoring the original layout" >&2
    if [ -n "$original_current_target" ]; then
      static_release_atomic_link "$static_root/current" "$original_current_target" || true
    else
      rm -f "$static_root/current"
    fi
    if [ -n "$original_previous_target" ]; then
      static_release_atomic_link "$static_root/previous" "$original_previous_target" || true
    else
      rm -f "$static_root/previous"
    fi
    rm -rf "$release_dir"
    if [ -n "$legacy_target" ]; then
      rm -rf "$static_root/$legacy_target"
    fi
    STATIC_RELEASE_SWITCH_PERFORMED=0
    STATIC_RELEASE_TARGET=""
    STATIC_RELEASE_ROLLBACK_TARGET=""
    return 1
  fi

  printf 'STATIC_RELEASE_TARGET=%s\n' "$release_target"
  printf 'STATIC_RELEASE_ROLLBACK_TARGET=%s\n' "$rollback_target"
}

static_release_rollback() {
  static_root="$1"
  rollback_target="$2"

  if [ -z "$rollback_target" ]; then
    echo "ERROR: no previous static release is available for rollback" >&2
    return 1
  fi
  case "$rollback_target" in
    /*) rollback_path="$rollback_target" ;;
    *) rollback_path="$static_root/$rollback_target" ;;
  esac
  if [ ! -e "$rollback_path" ]; then
    echo "ERROR: previous static release target is missing: $rollback_path" >&2
    return 1
  fi

  failed_target="$(readlink "$static_root/current" 2>/dev/null || true)"
  static_release_atomic_link "$static_root/current" "$rollback_target"
  if [ -n "$failed_target" ]; then
    static_release_atomic_link "$static_root/previous" "$failed_target"
  fi
  STATIC_RELEASE_SWITCH_PERFORMED=0
}
