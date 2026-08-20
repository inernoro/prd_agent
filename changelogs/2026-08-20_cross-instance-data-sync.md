| feat | prd-api | 新增跨 MAP 实例数据同步：动态授权（跳转源站、管理员当场勾选并同意、PKCE 换一次性导出令牌），只执行一次 |
| feat | prd-api | 新增导出白名单 DataSyncScope：270 个集合逐个分类，敏感字段在源站出口清空；CI 强制新集合必须分类 |
| feat | prd-admin | 新增数据同步三屏：源站同意页（默认全选、列出不会带走的集合）、回跳落地页、执行页（执行前对照表 + SSE 进度 + 待补密钥清单） |
| fix | prd-api | 同步进度的 SSE 与 GET 统一 camelCase 字段名，避免同步跑起来时前端读不到进度 |
| docs | doc | 新增 design.platform.cross-instance-data-sync 与 debt.platform.cross-instance-data-sync（含附件绝对地址待纠正项） |
| chore | prd-api | Core 的 MongoDB.Bson 从 2.25.0 对齐到 2.29.0，与 Infrastructure 的 Driver 版本一致 |
| fix | prd-api | 同步 API 前缀改为 api/instance-sync：原 api/data-sync 会被 AdminController("data") 的裸前缀匹配吃掉，匿名换票与导出端点在真实部署上返回 401 |
| fix | prd-admin | 同意页与回跳页自己应用明暗偏好：两页在 AppShell 之外，此前切浅色仍是暗的（真机取证发现） |
| fix | prd-admin | 数据同步入口归到「全部能力」的基础设施分组：百宝箱卡片网格要求每张卡有独占插画素材，它是运维入口不是智能体 |
