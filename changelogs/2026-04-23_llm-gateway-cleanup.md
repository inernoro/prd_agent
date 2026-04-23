| feat | prd-api | LiteraryAgentImageGenController 新增 GET resolve-model 端点，预查询生图调度模型（ILlmGateway.ResolveModelAsync） |
| feat | prd-admin | ArticleIllustrationEditorPage 无专属模型池时预解析并显示自动调度模型，解锁一键生图按钮 |
| refactor | prd-api | 清理 ResolverDebugController 废弃字段注入（_gateway 已无端点引用） |
| feat | prd-api | GatewayModelResolution 新增 ApiKey / ExchangeAuthScheme / ExchangeTransformerConfig 发送阶段字段 |
| feat | prd-api | LlmGateway 新增 SendRawWithResolutionAsync 跳过二次 Resolve，实现 compute-then-send 原则 |
| refactor | prd-api | OpenAIImageClient 改用 SendRawWithResolutionAsync 消除二次 Resolve |
| refactor | prd-api | 迁移剩余 6 处 SendRawAsync 调用并从接口彻底删除旧方法 |
| fix | prd-api | TranscriptRunWorker 修复 ModelResolutionResult → GatewayModelResolution 类型转换（.ToGatewayResolution()） |
| fix | prd-api | ImageGenModelAdapterConfig 新增 SupportsResponseFormat 标志，gpt-image-1.5/gpt-image-2-all 设为 false 修复 apiyi 平台 unknown_parameter 错误 |
| fix | prd-api | AppCallerRegistry 注册 prd-agent.guide::chat，修复 AppCallerCodeRegistryGuardTests 14 处失败 |
| fix | prd-api | ILlmGateway XML 注释示例改为已注册 code（prd-agent.skill-gen::chat），消除 guard test 扫描告警 |
