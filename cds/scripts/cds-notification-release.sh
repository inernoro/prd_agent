#!/usr/bin/env bash
set -Eeuo pipefail
: "${CDS_COMMIT_SHA:?缺少固定提交}" "${CDS_RELEASE_ID:?缺少发布记录}"
case "${1:-}" in
  check|deploy) exec python3 "$(dirname "$0")/release-notification-runtime.py" "$1" ;;
  *) printf '仅支持 check 或 deploy\n' >&2; exit 2 ;;
esac
