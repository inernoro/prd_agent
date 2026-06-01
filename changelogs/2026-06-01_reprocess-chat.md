| feat | prd-admin | 知识库「文档再加工」升级为多轮 AI 对话抽屉：模板变快捷 chip + 流式回复 + 三种写回（替换原文 / 追加末尾 / 另存为新文档） |
| feat | prd-api | DocumentStoreAgentRun 新增 Messages 数组承载多轮对话；新增 reprocess/chat、reprocess/active-run、agent-runs/{id}/apply 三个端点 |
| refactor | prd-api | ContentReprocessProcessor 重构为按对话末尾 user 消息逐轮处理；新增 ContentReprocessApplyService 负责写回 |
