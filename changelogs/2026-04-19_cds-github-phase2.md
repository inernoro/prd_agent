| feat | cds | Check run 阶段性 PATCH: pull/每层 layer 启动时推送进度到 GitHub, PR Checks 面板实时显示"构建第 X/Y 层 (services...)"而不是全程一条不变的"Deploying to CDS…" |
| feat | cds | Check run finalize 注入 output.text 日志尾部: 部署最后 80 条事件拼成 markdown code block,GitHub Checks 面板「Show more」展开后可直接看失败原因,不用再切回 CDS |
| feat | cds | pull_request.opened/reopened 事件 → bot 自动在 PR 贴 Railway 风格预览地址评论(📋 Preview / Branch / Dashboard 三项 + 分支 SHA),后续 push 触发的 deploy 会原地 PATCH 同条评论,不污染 PR 时间线 |
| feat | cds | pull_request.closed (merged or not) 事件 → 自动 POST /api/branches/:id/stop 停掉预览容器,节省资源 |
| feat | cds | GitHubAppClient 新增 createIssueComment + updateIssueComment 方法(PR comments 走 issues API) |
| feat | cds | BranchEntry 加 githubPrNumber + githubPreviewCommentId 两字段,让 webhook dispatcher 能关联 PR + 复用 bot 评论 id |
