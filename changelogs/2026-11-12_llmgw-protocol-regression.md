| test | llmgw | 新增四入口到 OpenAI/Claude 真实适配器的固定协议回放、语义对比及关键字段故障探测 |
| fix | llmgw | Gemini 流式工具调用按索引聚合参数后输出，避免将半截 JSON 当作完整函数参数；OpenAI/Claude 流式出口转换对方协议的结束枚举 |
| ci | llmgw | CI 接入协议模拟报告和独立真实供应商验证，真实失败参与总状态且禁止模拟兜底 |
