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

restricted_root="$tmp_root/restricted-web/dist"
mkdir -p "$restricted_root/assets" "$restricted_root/.staging-restricted/assets"
printf 'old\n' > "$restricted_root/index.html"
printf 'old\n' > "$restricted_root/assets/app.js"
printf '<script src="/assets/app.js"></script>\n' > "$restricted_root/.staging-restricted/index.html"
printf 'new\n' > "$restricted_root/.staging-restricted/assets/app.js"
chmod 700 "$restricted_root" "$restricted_root/assets" "$restricted_root/.staging-restricted" "$restricted_root/.staging-restricted/assets"
chmod 600 "$restricted_root/index.html" "$restricted_root/assets/app.js" "$restricted_root/.staging-restricted/index.html" "$restricted_root/.staging-restricted/assets/app.js"
(
  umask 077
  static_release_activate "$restricted_root/.staging-restricted" "$restricted_root" "restricted" >/dev/null
)
test "$(stat -c '%a' "$restricted_root/.releases" 2>/dev/null || stat -f '%Lp' "$restricted_root/.releases")" = "755"
test "$(stat -c '%a' "$restricted_root/.releases/restricted" 2>/dev/null || stat -f '%Lp' "$restricted_root/.releases/restricted")" = "755"
test "$(stat -c '%a' "$restricted_root/.releases/restricted/assets" 2>/dev/null || stat -f '%Lp' "$restricted_root/.releases/restricted/assets")" = "755"
test "$(stat -c '%a' "$restricted_root/.releases/restricted/index.html" 2>/dev/null || stat -f '%Lp' "$restricted_root/.releases/restricted/index.html")" = "644"
test "$(stat -c '%a' "$restricted_root/.releases/restricted/assets/app.js" 2>/dev/null || stat -f '%Lp' "$restricted_root/.releases/restricted/assets/app.js")" = "644"
test -r "$restricted_root/current/index.html"
test -r "$restricted_root/current/assets/app.js"
find "$restricted_root/.releases/restricted" -type d -exec test -x {} \;
find "$restricted_root/.releases/restricted" -type f -exec test -r {} \;

python3 - "$repo_root/exec_dep.sh" <<'PY'
import sys
from pathlib import Path

deploy = Path(sys.argv[1]).read_text(encoding="utf-8")

required = (
    'PRD_AGENT_STATIC_ONLY_COMMIT',
    'static-only release requires LLMGW_VERIFY_ONLY=1 and SKIP_API_PULL=1',
    'static-only release requires an audited DIST_URL and DIST_SHA256',
    'static-only release requires the fast.sh intent',
    'static-only release cannot reuse the existing static distribution',
    'static-only release refuses to overwrite a different active nginx configuration',
    'static_release_id="${static_artifact_tag}-',
    '--expect-static-commit "$smoke_static_commit" --expect-runtime-commit "$smoke_runtime_commit"',
    'run_public_surface_smoke "$rollback_smoke_json" 6 "$rollback_static_commit" "$rollback_runtime_commit"',
    '"commandSemantics": "static-only-rollback"',
    '"releaseFailure": read_optional(os.environ["FAILED_SMOKE"])',
    '"rollbackVerification": read_optional(os.environ["ROLLBACK_SMOKE"])',
    'Static-only runtime identity: all six containers preserved',
)
for marker in required:
    assert marker in deploy, marker

verify_start = deploy.index('if [ "$LLMGW_VERIFY_ONLY" = "1" ]; then')
verify_end = deploy.index('\nelse\n  release_failure_stage="compose-update"', verify_start)
verify_block = deploy[verify_start:verify_end]
assert verify_block.index('wait_for_llmgw_serving_readiness') < verify_block.index('wait_for_design_runtime_readiness')
assert verify_block.index('wait_for_design_runtime_readiness') < verify_block.index('run_asset_storage_readiness')
assert verify_block.index('run_asset_storage_readiness') < verify_block.index('activate_pending_static_release')
assert 'compose_run up' not in verify_block
assert 'sync_active_gateway_nginx_config' not in verify_block

assert deploy.index('capture_runtime_identity "$runtime_identity_before_file"') < deploy.index('activate_pending_static_release')
assert deploy.index('activate_pending_static_release', verify_start) < deploy.index('capture_runtime_identity "$runtime_identity_after_file"')
PY

runtime_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
static_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
mkdir -p "$tmp_root/production-root"
: > "$tmp_root/production.env"
if env \
  PRD_AGENT_STATIC_ONLY_COMMIT="$static_sha" \
  LLMGW_VERIFY_ONLY=1 \
  SKIP_API_PULL=1 \
  DIST_URL="https://example.test/static.zip" \
  DIST_SHA256="invalid" \
  PRD_AGENT_DOTENV_FILE="$tmp_root/production.env" \
  PRD_AGENT_COMPOSE_PROJECT_DIRECTORY="$tmp_root/production-root" \
  PRD_AGENT_RELEASE_INTENT_FILE="$tmp_root/missing-intent.env" \
  sh "$repo_root/exec_dep.sh" --commit "$runtime_sha" >"$tmp_root/invalid-checksum.log" 2>&1; then
  echo "expected invalid static-only checksum to fail before deployment" >&2
  exit 1
fi
grep -F 'static-only DIST_SHA256 must contain exactly 64 hexadecimal characters' "$tmp_root/invalid-checksum.log" >/dev/null

if env \
  PRD_AGENT_STATIC_ONLY_COMMIT="$static_sha" \
  LLMGW_VERIFY_ONLY=1 \
  SKIP_API_PULL=1 \
  DIST_URL="https://example.test/static.zip" \
  DIST_SHA256="$(printf '%064d' 0 | tr '0' 'c')" \
  PRD_AGENT_DOTENV_FILE="$tmp_root/production.env" \
  PRD_AGENT_COMPOSE_PROJECT_DIRECTORY="$tmp_root/production-root" \
  PRD_AGENT_RELEASE_INTENT_FILE="$tmp_root/missing-intent.env" \
  sh "$repo_root/exec_dep.sh" --commit "$runtime_sha" >"$tmp_root/missing-intent.log" 2>&1; then
  echo "expected missing runtime fast intent to fail before deployment" >&2
  exit 1
fi
grep -F 'static-only release requires the fast.sh intent' "$tmp_root/missing-intent.log" >/dev/null

echo "Static release layout test: PASS"
