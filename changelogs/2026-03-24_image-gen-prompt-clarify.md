| feat | prd-api | 新增生图提示词澄清端点 POST /api/visual-agent/image-gen/clarify，自动将用户自由文本改写为明确的英文生图提示词 |
| feat | prd-admin | 视觉创作生图流程集成提示词澄清，直连模式下自动优化提示词，降低生图失败率 |
| fix | prd-api | 修复 Gemini 通过 OpenAI 兼容网关代理时生图响应解析失败：增加响应体 candidates 特征检测，不再仅依赖 platformType |
| fix | prd-api | 修复 Google 生图 COS 上传失败时错误被吞为"响应解析失败"：COS 异常不再阻断生图，回退 base64 内联返回 |
| fix | prd-admin | 修复 imageDone URL 为空时的幽灵状态：既不显示图片也不显示错误，现在明确报错并允许重试 |
