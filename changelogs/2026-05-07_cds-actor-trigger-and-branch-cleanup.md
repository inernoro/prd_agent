| feat | cds | actor-resolver 新增 X-CDS-Trigger header 识别(优先级最高) — 内部 webhook/slash 触发的 localhost 自调能自标 'system:webhook',前端 chip 区分手动 vs 自动部署 |
| fix | cds | GitHub branch delete event 现在同时返 stopRequest + branchDeleteRequest — webhook 主路由收到后 stop 容器 + 3s 延迟后 DELETE entry/worktree,根治"分支已删但 CDS 端没清理"+ 后续 deploy 拉不到 origin/<ref> 报 fatal |
| feat | cds | 项目活动日志 actor 改 chip 渲染:GitHub Webhook(蓝)/PR 指令(蓝)/AI(紫)/用户(绿)/系统(灰),原文 hover 提示 |
