#!/bin/sh
# CDS admin static 模式入口：集中设置 Node 堆上限后再跑 vite build。
# 由 cds-compose admin profile 调用；VITE_BUILD_ID 会触发 vite.config 里的 CDS 降内存策略。
#
# 2026-06-22：UV_THREADPOOL_SIZE 从 2 放宽到 4（原来限 2 是怕共享主机多构建同时
# 跑挤爆 libuv 线程；现 CDS 有全局构建并发闸兜住同时构建数）。可用环境变量按主机
# 规模覆盖，小主机回到旧值即可。
set -e
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-4}"
export VITE_BUILD_ID="${VITE_BUILD_ID:-$(date +%Y%m%d%H%M%S)}"
exec pnpm exec vite build "$@"
