| fix | prd-api | 视频模型目录改读 LLMGW 权威池，消除旧 MAP 健康状态误判 |
| test | e2e | 网关 Offering 不可变替换后显式启用恢复版本，避免稳定冒烟破坏路由 |
| fix | prd-api | 适配 OpenAI 转写模型与 GPT Image 2 的真实请求参数约束 |
| refactor | prd-api | ASR multipart 参数收口为公共策略并禁止业务 Worker 重复手写 |
| fix | prd-admin | 选中图片的快捷操作栏同时约束横纵边界，避免下载按钮落在视口外 |
| test | e2e | 固化 OpenRouter 视频动态端点守卫，禁止固定路径覆盖轮询与下载地址 |
| fix | prd-api | 多图任务发送前直接选中 OpenAI 回退时重建为图片编辑表单，禁止复用 OpenRouter 请求体 |
| fix | prd-api | 统一重建直连 OpenAI 单图与多图请求，避免健康路由切换后沿用 OpenRouter 协议 |
