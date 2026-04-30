| perf | cds | BranchListPage refresh 拆分:已跟踪分支 + 项目 + 配置先到 ok 状态(几十毫秒),远程分支独立 lazy load,首次走 `?nofetch=true` 拿后端 cache,空时再 force fetch。彻底根治"加载分支与远程引用"卡 30 秒的首屏体验 |
| feat | cds | BranchSearchDropdown 在远程分支加载中时显示「远程分支加载中…」chip,主链路不再等远程引用 |
