#!/usr/bin/env bash
# 专用隔离验收项目脚本；不读取或操作仓库正式发布合同。
set -Eeuo pipefail
trap 'exit 130' HUP INT TERM PIPE
mode=${1:?请指定 check 或 deploy}
case "$mode" in check|deploy) ;; *) echo '仅支持 check/deploy' >&2; exit 64;; esac
: "${CDS_COMMIT_SHA:?}" "${CDS_TARGET_ID:?}" "${CDS_RELEASE_ID:?}"
[[ "$CDS_COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$CDS_TARGET_ID" =~ ^[a-zA-Z0-9_-]+$ ]]
[[ "$CDS_RELEASE_ID" =~ ^[a-zA-Z0-9_-]+$ ]]
test "$(git rev-parse HEAD)" = "$CDS_COMMIT_SHA"
command -v python3 >/dev/null
payload=acceptance/cds-batch/payload.html
test -f "$payload"
git cat-file -e "$CDS_COMMIT_SHA:$payload"
git diff --quiet -- "$payload" acceptance/cds-batch/cds-release.sh
if [ "$mode" = check ]; then
  printf '验收脚本 check 通过：commit=%s target=%s\n' "$CDS_COMMIT_SHA" "$CDS_TARGET_ID"
  exit 0
fi
common=$(git rev-parse --path-format=absolute --git-common-dir)
repo=$(dirname "$common")
site_root=${CDS_BATCH_SITE_ROOT:-$(dirname "$repo")/.cds-batch-sites}
site="$site_root/$CDS_TARGET_ID"
mkdir -p "$site/releases"
printf '%s %s\n' "$CDS_COMMIT_SHA" "$CDS_RELEASE_ID" >> "$site/attempts"
if [ -f "$site/hold" ]; then
  touch "$site/entered"
  for ((n=0;n<300;n++)); do
    [ -f "$site/hold" ] || break
    printf '等待隔离目标释放：target=%s tick=%s\n' "$CDS_TARGET_ID" "$n"
    sleep .1
  done
  test ! -f "$site/hold" || { echo '隔离等待达到30秒上限，拒绝继续' >&2; exit 75; }
fi
if [ -f "$site/fail-sha" ] && grep -qx "$CDS_COMMIT_SHA" "$site/fail-sha"; then
  echo '隔离验收目标按指定提交受控失败，当前入口未切换' >&2
  exit 17
fi
release="$site/releases/$CDS_RELEASE_ID"
mkdir -p "$release"
cp "$payload" "$release/index.html"
python3 - "$release" "$CDS_COMMIT_SHA" "$CDS_TARGET_ID" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); sha,target=sys.argv[2:]
payload=(root/'index.html').read_text(); (root/'index.html').write_text(payload.replace('__CDS_COMMIT_SHA__',sha).replace('__CDS_TARGET_ID__',target))
(root/'entry.js').write_text('window.CDS_BATCH_ACCEPTANCE='+json.dumps({'commitSha':sha,'targetId':target})+';\n')
(root/'health.json').write_text(json.dumps({'status':'healthy','commitSha':sha,'targetId':target}))
PY
printf '切换隔离入口：commit=%s target=%s\n' "$CDS_COMMIT_SHA" "$CDS_TARGET_ID"
ln -sfn "$release" "$site/current.next"
python3 - "$site/current.next" "$site/current" <<'PY'
import os,sys
os.replace(sys.argv[1],sys.argv[2])
PY
printf '%s' "$CDS_COMMIT_SHA" > "$site/running"
printf '验收脚本 deploy 完成：commit=%s target=%s release=%s\n' "$CDS_COMMIT_SHA" "$CDS_TARGET_ID" "$CDS_RELEASE_ID"
