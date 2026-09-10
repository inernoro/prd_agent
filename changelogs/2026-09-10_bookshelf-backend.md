| feat | prd-api | 藏书阁进度上后端：BookshelfProgress 实体 + 三个端点（我的进度读/写、团队看板），UserId 唯一索引 |
| feat | prd-admin | 新增团队看板：每卷通关人数、成员进度行、「全队最薄弱的一卷」结论 |
| refactor | prd-admin | 藏书阁进度改为服务端优先、本地兜底；拉不到时保留本地记录不清空 |
| rule | platform | 新增 visual-anchor-first 规则：没拿到视觉锚点前不许凭空赌品味，主观词要变成带实测数值的档位表 |
| docs | platform | debt.frontend.md 藏书阁条目：两条结清（进度上后端、团队看板），四条新增（并发合并、同步失败提示、看板分页、卷六偏理论） |
| fix | prd-admin | 藏书阁同步失败不再沉默：页面亮状态条 + 手动重试 + 网络恢复自动补发；连点合并为一次请求 |
| test | prd-admin | 新增同步层守卫 10 条（失败亮态/不回滚/完整快照重试/防抖），已过红绿闭环 |
