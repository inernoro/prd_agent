#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
. "$repo_root/scripts/lib/static-release.sh"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "$tmp_root"; }
trap cleanup EXIT

static_root="$tmp_root/web/dist"
mkdir -p "$static_root/assets"
printf '<div>old</div>\n' > "$static_root/index.html"
printf 'old\n' > "$static_root/assets/app.js"

staging="$static_root/.staging-sha-test"
mkdir -p "$staging/assets"
printf '<script src="/assets/app.js"></script>\n' > "$staging/index.html"
printf 'new\n' > "$staging/assets/app.js"

activation="$(static_release_activate "$staging" "$static_root" "sha-test")"
printf '%s\n' "$activation" | grep -F 'STATIC_RELEASE_TARGET=.releases/sha-test' >/dev/null
printf '%s\n' "$activation" | grep -F 'STATIC_RELEASE_ROLLBACK_TARGET=.releases/legacy-sha-test' >/dev/null
test "$(readlink "$static_root/current")" = ".releases/sha-test"
test "$(readlink "$static_root/previous")" = ".releases/legacy-sha-test"
grep -F 'new' "$static_root/current/assets/app.js" >/dev/null
grep -F 'old' "$static_root/index.html" >/dev/null

static_release_rollback "$static_root" ".releases/legacy-sha-test"
test "$(readlink "$static_root/current")" = ".releases/legacy-sha-test"
test "$(readlink "$static_root/previous")" = ".releases/sha-test"
grep -F 'old' "$static_root/current/assets/app.js" >/dev/null

interrupt_root="$tmp_root/interrupt-web/dist"
mkdir -p "$interrupt_root/assets" "$interrupt_root/.staging-interrupt/assets"
printf 'old\n' > "$interrupt_root/index.html"
printf 'old\n' > "$interrupt_root/assets/app.js"
printf 'new\n' > "$interrupt_root/.staging-interrupt/index.html"
printf 'new\n' > "$interrupt_root/.staging-interrupt/assets/app.js"
static_release_activate "$interrupt_root/.staging-interrupt" "$interrupt_root" "interrupt" >/dev/null
test "$STATIC_RELEASE_SWITCH_PERFORMED" = "1"
test "$STATIC_RELEASE_ROLLBACK_TARGET" = ".releases/legacy-interrupt"
static_release_rollback "$interrupt_root" "$STATIC_RELEASE_ROLLBACK_TARGET"
grep -F 'old' "$interrupt_root/current/assets/app.js" >/dev/null

missing="$static_root/.staging-missing"
mkdir -p "$missing"
if static_release_activate "$missing" "$static_root" "missing" >"$tmp_root/missing.log" 2>&1; then
  echo "expected incomplete static staging activation to fail" >&2
  exit 1
fi
grep -F 'static release staging directory is incomplete' "$tmp_root/missing.log" >/dev/null

failure_root="$tmp_root/failure-web/dist"
mkdir -p "$failure_root/assets" "$failure_root/.staging-failure/assets"
printf 'old\n' > "$failure_root/index.html"
printf 'old\n' > "$failure_root/assets/app.js"
printf 'new\n' > "$failure_root/.staging-failure/index.html"
printf 'new\n' > "$failure_root/.staging-failure/assets/app.js"
(
  static_release_atomic_link() {
    case "$1" in
      */current) return 1 ;;
    esac
    link_path="$1"
    link_target="$2"
    rm -f "$link_path"
    ln -s "$link_target" "$link_path"
  }
  if static_release_activate "$failure_root/.staging-failure" "$failure_root" "failure" >"$tmp_root/failure.log" 2>&1; then
    echo "expected injected atomic switch failure" >&2
    exit 1
  fi
)
test -d "$failure_root"
test ! -L "$failure_root/current"
grep -F 'old' "$failure_root/assets/app.js" >/dev/null
grep -F 'restoring the original layout' "$tmp_root/failure.log" >/dev/null

echo "Static release layout test: PASS"
