#!/bin/sh
# CI 镜像与 CDS managedBuild 共用的专用静态站构建入口。
set -eu
: "${CDS_COMMIT_SHA:?必须提供本次实际构建提交}"
test "${#CDS_COMMIT_SHA}" = 40
case "$CDS_COMMIT_SHA" in *[!a-f0-9]*) echo '构建提交必须为完整40位SHA' >&2; exit 1;; esac
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:-/www}
mkdir -p "$output"
sed "s/__CDS_COMMIT_SHA__/$CDS_COMMIT_SHA/g;s/__CDS_TARGET_ID__/source-preview/g" "$source_dir/payload.html" > "$output/index.html"
printf 'window.CDS_BATCH_ACCEPTANCE={"commitSha":"%s","targetId":"source-preview"};\n' "$CDS_COMMIT_SHA" > "$output/entry.js"
printf '{"status":"healthy","commitSha":"%s","targetId":"source-preview"}\n' "$CDS_COMMIT_SHA" > "$output/health"
chmod 0444 "$output/index.html" "$output/entry.js" "$output/health"
printf '专用验收站点构建完成：commit=%s\n' "$CDS_COMMIT_SHA"
