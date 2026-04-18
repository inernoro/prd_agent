| fix | cds | 分支列表 UI 遍历 service 时过滤掉不在当前项目 buildProfiles 里的条目，防止跨项目或已删 profile 画出鬼影 chip |
| feat | cds | `/api/cleanup-orphans` 支持 `?project=<id>` 或不传 → 按项目逐个 fetch remote 对比本项目分支，不再把 fork 的 main 当孤儿误删 |
| feat | cds | `/api/prune-stale-branches` 同样项目化，每个项目用自己的 repoPath + 自己的已部署分支集合，cloneStatus 未 ready 的项目自动跳过 |
