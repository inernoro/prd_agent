| perf | cds | self-update / force-sync drain wait 默认从 180s 砍到 5s,且超时后不再 deferred 而是直接 restart——docker 容器归 daemon 管,cds-master 重启不影响在跑容器,断掉的 deploy SSE 由 webhook/UI auto-reconnect 兜底。"我没动其他容器但 self-update 要 3 分钟"根因 |
| refactor | cds | container.test.ts 同步移除 `--cpus` 残留断言,与"关闭所有容器资源限制"政策对齐 |
