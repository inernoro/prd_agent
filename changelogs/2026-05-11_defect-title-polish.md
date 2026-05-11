| fix | prd-admin | 优化缺陷提交标题提取和列表标题展示，避免模板前缀或截图编号污染标题 |
| fix | prd-api | 强化缺陷 AI 润色提示词和标题清洗兜底，保证第一行可作为有效标题 |
| fix | prd-api | 修复缺陷评论和标记解决接口未启用 AI Access Key 直连认证的问题 |
| feat | prd-admin | 缺陷分享弹窗支持创建 1 天临时密钥，并把评论与标记修复接口写入提示词 |
| fix | prd-api | Agent API Key scope 白名单新增缺陷修复权限，支持缺陷分享临时授权 |
| fix | prd-api | 周报海报一键生成默认周次改为中国时区，并将单页生图保存改为原子更新避免并发覆盖 |
| fix | prd-admin | 周报海报一键生成默认周次按中国时区计算，并在批量生图后回读服务器最终状态 |
| fix | prd-admin | 将缺陷修复临时密钥入口补到批量分享缺陷弹窗，确保线上实际入口可见 |
| feat | prd-api | 新增 /api/v 与 /api/version 版本接口，便于确认线上发布的 commit 和构建信息 |
