| fix | cds | self-update / self-force-sync 路由顶层补 finally,Bugbot 31da8d97 (HIGH):recordFailure 自身抛错时 activeSelfUpdate 标记不再卡住 — 所有 tab 不再看到永久"自更新中"幽灵态。新增 `stateService.clearSelfUpdateActive()` 幂等清空 |
| perf | cds | self-force-sync 改动全是文档/changelogs 时改走 doc-only fast-path,Bugbot 7749d6f8 (Medium):写新 commit 的 .build-sha 后直接 return,跳过 validate + esbuild + tsc + atomic swap + restart(节省 ~70-95s) |
