| feat | prd-admin | 知识库上传放开为任意类型，并新增「AI 转写设置」按钮一键配置 OpenRouter ASR |
| feat | prd-api | 知识库上传 MIME 推断补齐音频/视频/图片扩展名，单文件上限提升到 100 MB |
| feat | prd-api | SubtitleGenerationProcessor 拆分豆包流式 / OpenAI 兼容多模态 chat 双 ASR 路径，支持 OpenRouter Gemini 2.5 Flash 等多模态模型直接做转写 |
| feat | prd-api | 新增 /api/document-store/asr-setup 端点，幂等创建 OpenRouter 平台 + 模型 + 模型池 + AppCaller 绑定 |
| feat | prd-admin | SubtitleGenerationDrawer 增加 ETA 分级提示（15s/40s/90s）和错误时「去配置 ASR」引导按钮，避免空白等待 |
