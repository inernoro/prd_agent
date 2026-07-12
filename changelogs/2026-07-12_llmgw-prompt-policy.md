| feat | prd-api | 为 appCaller 增加租户级版本化提示词策略并只在 chat/vision 入口应用 |
| feat | prd-llmgw | 新增提示词策略预览、乐观并发保存、版本回滚和脱敏审计 API |
| feat | prd-llmgw-web | 新增 appCaller 提示词策略编辑、预览和版本历史页面 |
| security | prd-api | 请求日志仅保存提示词策略 id、版本、hash 和字符数，不保存策略正文 |
| test | prd-api | 增加提示词合并顺序、禁用、变量、raw 隔离与租户索引合同测试 |
| fix | prd-api | 对齐控制台与 serving 的提示词策略团队索引方向，避免同名索引冲突导致启动失败 |
