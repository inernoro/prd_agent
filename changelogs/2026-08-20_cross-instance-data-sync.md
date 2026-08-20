| feat | prd-api | 新增跨 MAP 实例数据同步：动态授权（跳转源站、管理员当场勾选并同意、PKCE 换一次性导出令牌），只执行一次 |
| feat | prd-api | 新增导出白名单 DataSyncScope：270 个集合逐个分类，敏感字段在源站出口清空；CI 强制新集合必须分类 |
| feat | prd-admin | 新增数据同步三屏：源站同意页（默认全选、列出不会带走的集合）、回跳落地页、执行页（执行前对照表 + SSE 进度 + 待补密钥清单） |
| fix | prd-api | 同步进度的 SSE 与 GET 统一 camelCase 字段名，避免同步跑起来时前端读不到进度 |
| docs | doc | 新增 design.platform.cross-instance-data-sync 与 debt.platform.cross-instance-data-sync（含附件绝对地址待纠正项） |
| chore | prd-api | Core 的 MongoDB.Bson 从 2.25.0 对齐到 2.29.0，与 Infrastructure 的 Driver 版本一致 |
| fix | prd-api | 同步 API 前缀改为 api/instance-sync：原 api/data-sync 会被 AdminController("data") 的裸前缀匹配吃掉，匿名换票与导出端点在真实部署上返回 401 |
| fix | prd-admin | 同意页与回跳页自己应用明暗偏好：两页在 AppShell 之外，此前切浅色仍是暗的（真机取证发现） |
| fix | prd-admin | 数据同步入口归到「全部能力」的基础设施分组：百宝箱卡片网格要求每张卡有独占插画素材，它是运维入口不是智能体 |
| fix | prd-admin | 数据同步补进 buildStaticInfra：「全部能力」页的基础设施分组读的是这份手写清单而非 NAV_REGISTRY，只登记后者会导致真人在页面上找不到入口 |
| test | prd-admin | 新增 launcherInfraCoverage 棘轮：NAV_REGISTRY 的 infra 入口若没同步接进 buildStaticInfra 即 CI 红，已知未接的 5 条只许减不许增 |
| feat | prd-admin | 数据同步起始屏补历史列表：接上一直没人调用的 GET /api/instance-sync/runs，可回看任意一次同步、一键复用上次的源站地址；空态改为讲清四步流程而非留白 |
| security | prd-api | 同步消费方的 plan/start/get/list/stream 补判管理员：此前只有 prepare/callback 判了，任何登录用户拿到 pending 的 runId 就能带 overwrite=true 把数据写进共享库；新增守卫测试逐个 action 钉死 |
| security | prd-api | 源站 scope-catalog 补判真人管理员：此前只写了 [Authorize]，任何登录用户都能拿到全站集合清单与逐集合条数；守卫测试扩到源站，带 [Authorize] 的端点必须调 ResolveAdminIdentityAsync |
