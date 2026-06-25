| refactor | prd-api | LLM 网关 P1 协议下沉：LLMModel/ModelGroupItem 新增可空 Protocol 字段，resolver 按 item??model??platform 计算并透传到 Resolution，全向后兼容（null⇒平台 PlatformType，路由不变） |
| feat | prd-api | LlmRequestLog 新增 Protocol/ResolutionReason 字段（仅追加），解析协议与原因可观测 |
| test | prd-api | 新增注册表黄金快照护栏（反射 153 个 appCallerCode + ModelTypes，新增/改名即红）+ 解析黄金集成测试（Category=Integration，比对 153 code 解析底片） |
| fix | prd-api | 止血：deepseek-v4-flash chat 默认池陈旧 Unavailable 健康标记已重置为 Healthy，53 个 chat code 停止静默 fallback |
