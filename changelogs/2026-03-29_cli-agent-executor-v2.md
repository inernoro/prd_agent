| refactor | prd-api | 重构 CLI Agent 执行器为多执行器分发架构（builtin-llm/docker/api/script），支持自由扩展新执行器类型 |
| feat | prd-api | 新增 builtin-llm 执行器，无需 Docker 直接调用 LLM Gateway 生成页面，支持多轮迭代修改 |
| feat | prd-api | 新增 api 执行器，支持调用外部 HTTP API（OpenHands/Bolt 等）生成页面 |
| feat | prd-api | 注册 page-agent.generate::chat AppCallerCode |
| feat | prd-api | 新增 create-executor 技能，引导创建和接入新的执行器类型 |
