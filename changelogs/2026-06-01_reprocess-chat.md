| feat | prd-admin | 知识库「文档再加工」升级为多轮 AI 对话抽屉：模板变快捷 chip + 流式回复 + 三种写回（替换原文 / 追加末尾 / 另存为新文档） |
| feat | prd-api | DocumentStoreAgentRun 新增 Messages 数组承载多轮对话；新增 reprocess/chat、reprocess/active-run、agent-runs/{id}/apply 三个端点 |
| refactor | prd-api | ContentReprocessProcessor 重构为按对话末尾 user 消息逐轮处理；新增 ContentReprocessApplyService 负责写回 |
| feat | prd-api | 新增 reprocess_agents 集合 + ReprocessAgentSeeder：内置 4 个智能体（文学创作 / 产品评审员 / 周报助手 / 缺陷分析员），支持用户自建个人智能体 |
| feat | prd-api | DocumentStoreController 新增 reprocess-agents CRUD 端点（list / create / delete），processor 按 key 反查智能体的 system prompt |
| feat | prd-admin | 文档再加工抽屉首屏新增「智能体」chip 行 + 「新建智能体」浮层，可直接调用本系统内置智能体或创建专属智能体 |
