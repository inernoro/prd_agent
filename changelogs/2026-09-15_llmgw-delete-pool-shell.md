| refactor | llmgw | 删壳第二层：console-api 删掉模型池的 11 个写入端点与 `/gw/pool-types/ensure`，连带清掉随之变孤儿的 7 个辅助函数与 12 个请求/结果 DTO，Program.cs 净减 1419 行、Dtos.cs 减 94 行 |
| refactor | llmgw | 保留三个只读/搬迁入口：`GET /gw/pool-types`、`GET /gw/pools`（调用方页的池筛选、实体详情的池展示仍在读）、`POST /gw/pools/migrate-to-models`（正式环境的存量池尚未搬迁，删了就再也搬不了） |
| refactor | llmgw | 前端删掉最后一个孤儿池接口 `removePoolModel` 与随之未用的 `ModelPool` 类型导入 |
| test | prd-api | `GatewayLegacySweepGuardTests` 改为池退场的反向守卫：钉住三个保留入口仍在、12 个已删路由不许回来（红绿闭环验证过），并清掉 `GatewayDataDomainGuardTests` 里 16 条锁死已删实现的断言 |
| chore | prd-api | 协议路由审计脚本去掉两条指向已删池写入端点的静态断言 |
| fix | llmgw | 删壳后跟上文案：首页不再说学习中心讲「模型池」、学习中心那条卡片改指 `/logical-models`（原先指向已删的 `/pools`）、排查指引改说「对外模型 / 线路」 |
