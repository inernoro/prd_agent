| fix | prd-admin | 优化缺陷提交标题提取和列表标题展示，避免模板前缀或截图编号污染标题 |
| fix | prd-api | 强化缺陷 AI 润色提示词和标题清洗兜底，保证第一行可作为有效标题 |
| fix | prd-api | 修复缺陷评论和标记解决接口未启用 AI Access Key 直连认证的问题 |
| feat | prd-admin | 缺陷分享弹窗支持创建 1 天临时密钥，并把评论与标记修复接口写入提示词 |
| fix | prd-api | Agent API Key scope 白名单新增缺陷修复权限，支持缺陷分享临时授权 |
| fix | prd-api | 周报海报一键生成默认周次改为中国时区，并将单页生图保存改为原子更新避免并发覆盖 |
| fix | prd-admin | 周报海报一键生成默认周次按中国时区计算，并在批量生图后回读服务器最终状态 |
| fix | prd-admin | 将缺陷修复临时密钥入口补到批量分享缺陷弹窗，确保线上实际入口可见 |
| feat | prd-api | 新增 /api/v 与 /api/version 版本接口，便于确认线上发布的 commit 和构建信息 |
| fix | ci | main 分支推送时总是构建 Admin Dashboard 和 Web Latest，避免前端上次失败后被后续后端提交永久跳过 |
| fix | ci | main 分支推送时所有关键检查和发布构建全量运行，develop 与 PR 继续按路径跳过 |
| feat | prd-api | 周报海报批量背景图改用 ImageGenRunWorker 后台任务，生成完成后按页回填 ImageUrl |
| feat | prd-admin | 周报海报编辑器新增一键生成背景图按钮，创建服务端后台任务并轮询展示回填进度 |
| fix | prd-api | 兼容缺陷分享临时 AgentApiKey 通过 X-AI-Access-Key 或 Authorization 调用评论与标记完成接口 |
| fix | prd-admin | 缺陷分享提示词在创建临时密钥时改为输出可直接使用的 Authorization 认证头 |
| fix | prd-admin | 提交缺陷未选择提交用户时增加明确提示，避免点击提交后像无响应 |
| docs | doc | 新增缺陷管理标签体系设计，明确 AI 正在跟进等协作标签的枚举、权限、展示和桌面端同步方案 |
