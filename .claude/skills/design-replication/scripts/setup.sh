#!/usr/bin/env bash
# 复刻取证环境自举：Playwright + 本地 React UMD 缓存 + 设计稿静态服务。
#
# 设计稿画布（.dc.html）在浏览器里从 unpkg 拉 React，容器直连拉不到；
# 而 file:// 下画布 runtime 会因为 CORS 取不到自己的源码。两个坑一起治：
# 先用 curl（走代理）把 React 抓到本地，再用 http 起一个静态服务。
set -euo pipefail

WORK="${1:?用法: setup.sh <工作目录> <设计稿目录> [端口]}"
DESIGN_DIR="${2:?}"
PORT="${3:-8899}"

mkdir -p "$WORK/vendor" "$WORK/shots/design" "$WORK/shots/impl" "$WORK/shots/pair"

# 装 playwright-core 而不是 playwright：后者会连带下载浏览器二进制，在这个容器里
# 要么很慢、要么被 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 跳过（装完也没浏览器可用）。
# 真正要用的浏览器是预装在 /opt/pw-browsers 的那个，脚本走 browser.mjs 找它。
if [ ! -d "$WORK/node_modules/playwright-core" ] && [ ! -d "$WORK/node_modules/playwright" ]; then
  (cd "$WORK" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright-core --no-save --silent)
fi

for u in "react@18.3.1/umd/react.production.min.js" \
         "react-dom@18.3.1/umd/react-dom.production.min.js"; do
  f="$WORK/vendor/$(basename "$u")"
  [ -s "$f" ] || curl -sS -L --max-time 60 "https://unpkg.com/$u" -o "$f"
done

# 画布文件名常含中文/特殊字符，走 http 时必须 URL 编码，别手拼。
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then
  (cd "$DESIGN_DIR" && nohup python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 2
fi
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && echo "设计稿服务已就绪：http://127.0.0.1:$PORT/"

echo "画布文件（复制编码后的名字用）："
python3 - "$DESIGN_DIR" "$PORT" <<'PY'
import os, sys, urllib.parse
d, port = sys.argv[1], sys.argv[2]
for f in sorted(os.listdir(d)):
    if f.endswith('.dc.html') or f.endswith('.html'):
        print(f"  http://127.0.0.1:{port}/{urllib.parse.quote(f)}   <- {f}")
PY
