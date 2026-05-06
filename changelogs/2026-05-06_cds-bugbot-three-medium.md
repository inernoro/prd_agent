| fix | cds | exec_cds.sh master-run pnpm install 失败时 fail-fast(exit 78 EX_CONFIG)— Bugbot 982b38ca (Medium):lockfile 漂移 / pnpm store 损坏 / 磁盘满时不再静默继续启动 stale node_modules |
| fix | cds | self-force-sync doc-only fast-path 必须 irrelevantPaths > 0 — Bugbot da715c3c (Medium):空 diff(fromSha == newHead 但 .build-sha 缺失/不匹配)不再误命中 fast-path 写假 SHA,改走冷路径重新 build |
| fix | cds | self-status SSE 透传 activeSelfUpdate — Bugbot 59568cb0 (Medium):GlobalUpdateBadge 收到 SSE 后 dispatch CustomEvent,MaintenanceTab 监听后实时跨 tab 同步,不再依赖 30s 轮询 |
