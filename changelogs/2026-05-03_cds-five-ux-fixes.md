| feat | cds-web | 项目设置「GitHub 关联」摘要新增「关闭/开启自动部署」inline 按钮 + 状态用绿点 chip 区分,不用再切到 GitHub tab 才能关掉自动部署(用户反复要求过) |
| fix | cds-web | 分支卡片预览(Eye, running)与部署(Play, 非 running)按钮颜色区分:预览走 secondary(蓝灰)被动语义,部署保持 default(主橙)主动语义,不再两个按钮都是橙色让用户分不清 |
| fix | cds-web | 分支卡片异常态布局简化:删掉旧的红色横幅 + [详情] [重置] 内嵌按钮(导致网格高度跳变 + 卡片对不齐),改为一行极简 hint「错误消息 · 点击查看详情」,操作入口统一收到详情抽屉 + BranchMoreMenu |
| fix | cds-web | DropdownMenu 改用 createPortal + 视口坐标定位,popover 渲染到 document.body,不再被外层 `overflow-hidden` 卡片裁剪("..."菜单只显示一截"问题); scroll/resize 时自动重算位置 |
| perf | cds | `GET /api/branches` 容器状态对账批量化 — 一次 `docker ps --format {{.Names}}` 拿到全部运行中容器,per-service 走 Set 成员检查;旧路径每个 (branch × service) 跑一次 `docker inspect` (~50–150ms),20 分支 × 5 服务 = 5+ 秒首屏阻塞,典型场景降到几百毫秒 |
