| feat | prd-api | LiteraryAgentImageGenController 新增 GET resolve-model 端点，预查询生图调度模型（ILlmGateway.ResolveModelAsync） |
| feat | prd-admin | ArticleIllustrationEditorPage 无专属模型池时预解析并显示自动调度模型，解锁一键生图按钮 |
| feat | prd-api | LiteraryAgentImageGenController 新增 GET resolve-chat-model 端点，预查询提示词模型 |
| feat | prd-admin | ArticleIllustrationEditorPage 提示词模型无可用池时同样预解析并显示"自动: {model}"只读标签 |
| fix | prd-admin | 修复预解析触发条件：监听 enabledImageModels.length / enabledChatModels.length，覆盖全部模型不健康的场景 |
| refactor | prd-api | 清理 ResolverDebugController 废弃字段注入（_gateway 已无端点引用） |
| feat | prd-api | GatewayModelResolution 新增 ApiKey / ExchangeAuthScheme / ExchangeTransformerConfig 发送阶段字段 |
| feat | prd-api | LlmGateway 新增 SendRawWithResolutionAsync 跳过二次 Resolve，实现 compute-then-send 原则 |
| refactor | prd-api | OpenAIImageClient 改用 SendRawWithResolutionAsync 消除二次 Resolve |
| refactor | prd-api | 迁移剩余 6 处 SendRawAsync 调用并从接口彻底删除旧方法 |
| fix | prd-api | TranscriptRunWorker 修复 ModelResolutionResult → GatewayModelResolution 类型转换（.ToGatewayResolution()） |
| fix | prd-api | ImageGenModelAdapterConfig 新增 SupportsResponseFormat 标志，gpt-image-1.5/gpt-image-2-all 设为 false 修复 apiyi 平台 unknown_parameter 错误 |
| fix | prd-api | AppCallerRegistry 注册 prd-agent.guide::chat，修复 AppCallerCodeRegistryGuardTests 14 处失败 |
| fix | prd-api | ILlmGateway XML 注释示例改为已注册 code（prd-agent.skill-gen::chat），消除 guard test 扫描告警 |
| fix | prd-api | GatewayModelResolution 三个凭据字段加 [JsonIgnore]，阻止 ApiKey 序列化到外部 API 响应（P1 安全修复） |
| fix | prd-api | SendRawWithResolutionAsync round-trip 补全 OriginalPoolId / OriginalPoolName / OriginalModels，修复 llmrequestlogs 降级溯源丢失 |
| fix | prd-api | OpenRouterVideoClient.GetStatusAsync 缓存 SubmitAsync 解析结果，消除每次轮询重复查 DB |
| docs | prd-api | 新增 design.llm-gateway-refactor.md（compute-then-send 完整设计），更新 design.llm-gateway.md 补充两阶段调用规范，更新 codebase-snapshot 架构模式 |
