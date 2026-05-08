| fix | cds | 运维抽屉彻底去 useState toggle,直接显示运维内容 — 用户反馈"还是灰色"根因消除 |
| feat | cds | OpsDrawer 顶部加「清理孤儿」按钮 — 调 POST /api/cleanup-orphans 扫描 origin 远端,清掉本地有但远端已删的分支 worktree + 容器 + entry |
| fix | cds | Webhook 日志「忽略」chip 加 tooltip,详细解释 5 类 dispatchAction 含义;后端 dispatchReason 文案"未订阅"改成"不在 CDS 处理范围(只处理 push/pull_request 等 10 类)" |
