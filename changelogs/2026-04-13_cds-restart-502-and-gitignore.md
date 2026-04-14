| fix | cds | 修复 Auto-Update 重启后 5 秒硬超时直接 `location.reload()` 导致 502 的缺陷：新增 `waitForCdsHealthy` 轮询 `/healthz`（每秒一次、最长 120s、先等 down 再等 up），替换 `setTimeout(reload, 5000)` |
| chore | repo | `.gitignore` 补齐 CDS 运行时产物：`/.cds/`、`/.cds-worktrees/`、`cds/.cds.env.bak`、`cds/.cds.env.*.bak`，消除 `git status` 的无用噪声 |
