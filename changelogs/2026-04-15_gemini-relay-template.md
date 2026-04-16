| feat | prd-api | ModelExchange 新增 ModelAliases 字段，支持一个中继承接多个模型（Provider 级别） |
| feat | prd-api | ModelExchange.TargetUrl 支持 {model} 占位符，LlmGateway 在调度时自动替换为实际模型 ID |
| feat | prd-api | 新增 GeminiNativeTransformer，支持 Google Gemini 原生协议（OpenAI↔Gemini 请求/响应互转 + 文本/图像双模态） |
| feat | prd-api | LlmGateway 认证方案新增 x-goog-api-key（Google Gemini 原生认证头） |
| feat | prd-api | ExchangeController 新增 Gemini 原生协议导入模板（预填 URL 模版 + 5 个 Gemini 模型别名） |
| feat | prd-api | ModelResolver Exchange 查找同时匹配 ModelAlias 与 ModelAliases 列表 |
| feat | prd-admin | Exchange 管理页新增「附加模型别名」输入框 + URL {model} 占位符提示 |
| feat | prd-admin | Exchange 卡片展示附加别名列表（可点击复制） |
