| feat | prd-api | CDS Agent 工作台优雅降级：新增 Lite 只读审查 runtime 适配器（GatewayReviewRuntimeAdapter），R1 未闭合/官方 sidecar 不可用时不再硬卡报错，改走现有 LLM Gateway 产出只读代码审查 |
| feat | prd-admin | CDS Agent 简单视图新增「Lite 预览 / 官方 SDK」模式徽章与说明横幅；Lite 可用时不再阻塞发起任务 |
| fix | prd-api | InfraAgentSessionService 会话创建/发消息在 lite 兜底可用时不再因 profile 不兼容硬拒绝；运行时按 official/lite/unavailable 三态选择适配器 |
