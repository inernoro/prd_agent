| feat | prd-api | 新增「智能体宇宙」能力契约 SSOT（AgentCapability + AgentCapabilityRegistry）与统一调用信封 AgentUniverseController（capabilities + invoke SSE），按 invokeMode 路由到适配器生图或网关聊天 |
| feat | prd-admin | 新增 agentUniverse 服务（拉契约 + 统一 invoke SSE，支持图片 artifact） |
| fix | prd-admin | 修复文档再加工「选中智能体即自动发送」，改为选中只聚焦输入框、用户输入后才触发 |
| feat | prd-admin | 文档再加工抽屉改为契约驱动：视觉创作走真实生图并可一键插入文档，各智能体按 invokeMode 渲染对应交互 |
| refactor | prd-api | 智能体宇宙改为「绝不仿冒」：invoke 一律路由到真实 IAgentAdapter，删除硬编码提示词的假聊天路径；注册表只登记有真实组件的 4 个智能体（视觉/文学/缺陷/PRD），找不到真实适配器明确报错 NO_REAL_AGENT |
