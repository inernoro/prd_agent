| feat | prd-api | 新增 /api/healthz/deep 深度自检：真跑一次 Mongo 往返，加进程级异常与流量计数，每条 check 自报怎么监控 |
| refactor | platform | 滚动计数口径搬进 PrdAgent.Core 由 llmgw 与 prd-api 共用，不再两份几乎一样的实现各自漂移 |
| feat | cds | 自发现契约守卫覆盖两个端点，新增端点必须登记 |
