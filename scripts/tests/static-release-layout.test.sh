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

# Equal-length reproducible entries need fresh metadata for every switch,
# including failure recovery after current was already replaced.
python3 - "$repo_root" "$tmp_root" <<'PYCACHE'
import hashlib
import os
import subprocess
import sys
from pathlib import Path

repo, tmp = map(Path, sys.argv[1:])
root = tmp / 'cache-layout'
root.mkdir()
for version in ['A', 'B']:
    stage = root / f'.staging-{version}'
    stage.mkdir()
    (stage / 'index.html').write_text(f'<div>{version}</div>\n')
    (stage / 'manifest.json').write_text('{"immutable":true}\n')
    (stage / 'asset.js').write_text('immutable asset\n')
    for path in stage.iterdir():
        os.utime(path, (946656000, 946656000))
before = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.glob('*/*')}

def run(commands):
    subprocess.run(['sh', '-eu', '-c', '. "$1/scripts/lib/static-release.sh"; ' + commands, 'cache-test', str(repo), str(root)], check=True, stdout=subprocess.DEVNULL)

run('static_release_activate "$2/.staging-A" "$2" A')
a = root / '.releases/A/index.html'
a_time = a.stat().st_mtime
run('static_release_activate "$2/.staging-B" "$2" B')
b = root / '.releases/B/index.html'
b_time = b.stat().st_mtime
assert b_time > a_time
run('static_release_rollback "$2" .releases/A')
assert a.stat().st_mtime > b_time
for version in ['A', 'B']:
    for path in (root / f'.releases/{version}').iterdir():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == before[f'.staging-{version}/{path.name}']
        assert path.stat().st_mode & 0o777 == 0o644
        if path.name != 'index.html':
            assert path.stat().st_mtime == 946656000

stage = root / '.staging-fail'
stage.mkdir()
(stage / 'index.html').write_text('<div>C</div>\n')
# Simulate an interrupt/error reported after os.replace actually took effect.
run("""
static_release_atomic_link() {
  python3 - "$1" "$2" <<'PYLINK'
import os
import sys
link, target = sys.argv[1:]
next_link = link + '.test-next'
os.symlink(target, next_link)
os.replace(next_link, link)
PYLINK
  case "$2" in .releases/fail) return 1 ;; esac
}
if static_release_activate "$2/.staging-fail" "$2" fail; then exit 1; fi
""")
assert os.readlink(root / 'current') == '.releases/A'
assert a.stat().st_mtime > b_time + 1
assert not (root / '.releases/fail').exists()
PYCACHE

# Upgrade migration must retain more than just previous, preserve nested lazy
# chunks, and keep both directions usable even after old releases are removed.
python3 - "$repo_root" "$tmp_root" <<'PYRETAIN'
import shutil
import subprocess
import sys
from pathlib import Path
repo, tmp = map(Path, sys.argv[1:])
root = tmp / 'retention'
for version in ['A', 'B', 'C']:
    stage = root / f'.staging-{version}'
    (stage / 'assets/nested').mkdir(parents=True)
    (stage / 'index.html').write_text(f'<script src="/assets/{version}.js"></script>')
    (stage / f'assets/{version}.js').write_text(version)
    (stage / f'assets/nested/{version}.js').write_text(f'{version} chunk')
    (stage / 'assets/shared.js').write_text(version)
# Simulate releases made before retention was introduced (A absent from B).
(root / '.releases').mkdir()
shutil.move(str(root / '.staging-A'), root / '.releases/A')
shutil.move(str(root / '.staging-B'), root / '.releases/B')
(root / 'current').symlink_to('.releases/B')
def run(command):
    subprocess.run(['sh', '-eu', '-c', '. "$1/scripts/lib/static-release.sh"; ' + command, 'test', str(repo), str(root)], check=True, stdout=subprocess.DEVNULL)
run('static_release_activate "$2/.staging-C" "$2" C')
assert (root / 'current/assets/shared.js').read_text() == 'C'
for version in ['A', 'B', 'C']:
    assert (root / f'current/assets/{version}.js').read_text() == version
    assert (root / f'current/assets/nested/{version}.js').read_text() == f'{version} chunk'
shutil.rmtree(root / '.releases/A')
assert (root / 'current/assets/A.js').read_text() == 'A'
run('static_release_rollback "$2" .releases/B')
assert (root / 'current/assets/shared.js').read_text() == 'B'
assert (root / 'current/assets/C.js').read_text() == 'C'
assert (root / 'current/assets/nested/C.js').stat().st_mode & 0o777 == 0o644
# A malformed historical tree fails before changing the online pointer.
stage = root / '.staging-D'
stage.mkdir()
(stage / 'index.html').write_text('D')
(root / '.releases/C/assets/unsafe').symlink_to('/tmp')
result = subprocess.run(['sh', '-c', '. "$1/scripts/lib/static-release.sh"; static_release_activate "$2/.staging-D" "$2" D', 'test', str(repo), str(root)], capture_output=True)
assert result.returncode != 0
assert (root / 'current').readlink().as_posix() == '.releases/B'
# Recovery must not be blocked by optional compatibility work. The target's
# own files are already known-good and must remain intact.
def recover(setup=''):
    (root / 'current').unlink()
    (root / 'current').symlink_to('.releases/C')
    result = subprocess.run(['sh', '-eu', '-c', '. "$1/scripts/lib/static-release.sh"; ' + setup + '; static_release_rollback "$2" .releases/B', 'test', str(repo), str(root)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert (root / 'current').readlink().as_posix() == '.releases/B'
    assert (root / 'previous').readlink().as_posix() == '.releases/C'
    assert (root / 'current/index.html').read_text() == '<script src="/assets/B.js"></script>'
    assert (root / 'current/assets/B.js').read_text() == 'B'
    return result.stderr
assert 'continuing rollback' in recover(':')
(root / '.releases/C/assets/unsafe').unlink()
assert 'continuing rollback' in recover('static_release_retain_assets() { return 1; }')
assert 'continuing rollback' in recover('static_release_make_web_readable() { return 1; }')
PYRETAIN

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
