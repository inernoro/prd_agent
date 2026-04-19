| fix | cds | 项目列表卡片 GitHub chip 渲染为大蓝圆修复: 原本是 `<a>` 嵌套在 `<a class="cds-project-card">` 里 (HTML 非法),浏览器自动关外层 `<a>` 导致布局崩。改用 `<span onclick>` 打开新窗口 |
| fix | cds | 高危: webhook branchName 和 commitSha 接入 shell 前强制校验(HIGH + MEDIUM) — isSafeGitRef 严格白名单 `[A-Za-z0-9._/-]` + 长度/`..`/尾字符检查;commit SHA 必须 7-40 hex。覆盖 push/PR/delete/self-update/self-force-sync 5 个注入面 |
| fix | cds | defaultLocalhostDeploy 把 commitSha 透传到 /deploy body (MEDIUM),并行 push 之间的 entry.githubCommitSha 竞态因此消除。deploy 路由按「body → entry → worktree HEAD」三级回退 |
| fix | cds | 删 shouldDispatchDeploy / renderGithubBadge 两个死代码(LOW),清理重复注释 |
| feat | cds | CheckRunRunner.reconcileOrphans(): CDS 启动时扫描所有带 checkRunId 但不在 building 的分支,PATCH 到 conclusion=neutral + 清 id,修复 self-update/restart 打断后 GitHub commit 常年「准备状态」的 bug |
| feat | cds | 新增 POST /api/github/webhook/self-test 自测端点: 传 {eventName, payload} 直跑 dispatcher,返回「如果真实 webhook 这么来」会触发什么 side-effect。用于确认 Issue comment 事件是不是真到达 CDS,无需 GitHub 真实发送 |
