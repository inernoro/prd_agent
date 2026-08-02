#!/usr/bin/env bash
set -euo pipefail

base_url="${STABLE_SMOKE_BASE_URL:-}"
username="${STABLE_SMOKE_USER:-}"
return_url="/"
minutes="3"
open_page="false"

usage() {
  echo "用法: AI_ACCESS_KEY=... scripts/stable-smoke-login.sh --base <地址> --user <专用账号> [--return-url <站内路径>] [--minutes 1-5] [--open]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      base_url="${2:-}"
      shift 2
      ;;
    --user)
      username="${2:-}"
      shift 2
      ;;
    --return-url)
      return_url="${2:-}"
      shift 2
      ;;
    --minutes)
      minutes="${2:-}"
      shift 2
      ;;
    --open)
      open_page="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "无法识别的参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$base_url" || -z "$username" || -z "${AI_ACCESS_KEY:-}" ]]; then
  echo "缺少地址、专用账号或 AI_ACCESS_KEY，请补齐后重试。" >&2
  usage >&2
  exit 2
fi

if ! [[ "$minutes" =~ ^[1-5]$ ]]; then
  echo "入口有效期只能设置为 1 到 5 分钟。" >&2
  exit 2
fi

if [[ "$return_url" != /* || "$return_url" == //* || "$return_url" == *\\* ]]; then
  echo "目标页面必须是当前站点内的路径。" >&2
  exit 2
fi

base_url="${base_url%/}"
payload=$(jq -cn \
  --arg returnUrl "$return_url" \
  --argjson expiresInSeconds "$((minutes * 60))" \
  '{returnUrl:$returnUrl,expiresInSeconds:$expiresInSeconds}')
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

status=$(curl -sS \
  -o "$response_file" \
  -w '%{http_code}' \
  -X POST "$base_url/api/v1/auth/synthetic/ticket" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "X-AI-Impersonate: $username" \
  --data "$payload")

if [[ "$status" != "200" ]] || [[ "$(jq -r '.success // false' "$response_file")" != "true" ]]; then
  message=$(jq -r '.error.message // "无法生成一次性登录入口，请检查环境开关与账号白名单后重试。"' "$response_file")
  echo "$message" >&2
  exit 1
fi

relative_url=$(jq -r '.data.loginUrl' "$response_file")
login_url="$base_url$relative_url"
expires_at=$(jq -r '.data.expiresAt' "$response_file")
ticket_id=$(jq -r '.data.ticketId' "$response_file")

echo "入口编号: $ticket_id"
echo "失效时间: $expires_at"
echo "登录地址: $login_url"

if [[ "$open_page" == "true" ]]; then
  if command -v open >/dev/null 2>&1; then
    open "$login_url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$login_url"
  else
    echo "当前系统无法自动打开浏览器，请复制登录地址。" >&2
  fi
fi
