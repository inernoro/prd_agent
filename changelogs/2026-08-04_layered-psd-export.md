| feat | prd-admin | 视觉创作支持将生成图片语义分层并导出 PSD |
| feat | prd-admin | 语义图层可持久化到画布 Frame，支持单层编辑、重复使用与免重算导出 PSD |
| fix | prd-admin | 约束图片快捷工具条在可见画布内，避免 AI 分层入口被右侧面板遮挡 |
| feat | prd-api | 新增 fal.ai Qwen Image Layered 网关转换器与配置模板 |
| feat | llmgw | 模型网关控制台支持图片分层转换器配置 |
| feat | llmgw | 支持一次录入 fal.ai Key 自动接入图片分层 Exchange、专用模型池和 MAP 调用身份 |
| refactor | prd-api | 图片分层改用专用 appCaller 自动解析模型，不再要求业务用户手工选择平台 |
| fix | prd-admin | PSD 默认显示 AI 图层合成结果并将原图降为隐藏参考层 |
