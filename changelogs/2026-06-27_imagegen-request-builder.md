| refactor | prd-api | 新增 ImageGenRequestBuilder 收口"模型配置 → 上游请求体"转换（尺寸归一化/size·width-height·aspect_ratio·none 格式/参数重命名），OpenAIImageClient 退化为发送器+响应解析，加新生图模型只需在 ImageGenModelConfigs 加一条配置 |
