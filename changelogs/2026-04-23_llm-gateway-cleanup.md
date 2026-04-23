| refactor | prd-api | 清理 ResolverDebugController 废弃字段注入（_gateway 已无端点引用） |
| feat | prd-api | GatewayModelResolution 新增 ApiKey / ExchangeAuthScheme / ExchangeTransformerConfig 发送阶段字段 |
| feat | prd-api | LlmGateway 新增 SendRawWithResolutionAsync 跳过二次 Resolve，实现 compute-then-send 原则 |
| refactor | prd-api | OpenAIImageClient 改用 SendRawWithResolutionAsync 消除二次 Resolve |
| refactor | prd-api | 迁移剩余 6 处 SendRawAsync 调用并从接口彻底删除旧方法 |
