#!/bin/sh
# CDS admin static 模式入口：集中设置 Node 堆上限后再跑 vite build。
# 由 cds-compose admin profile 调用；VITE_BUILD_ID 会触发 vite.config 里的 CDS 降内存策略。
set -e
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-2}"
export VITE_BUILD_ID="${VITE_BUILD_ID:-$(date +%Y%m%d%H%M%S)}"
exec pnpm exec vite build "$@"
