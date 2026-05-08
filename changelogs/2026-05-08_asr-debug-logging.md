| fix | prd-api | DoubaoStreamAsrService 新增 AsrDiagnostic：每次调用记录 wsUrl/resourceId/requestId/appKey 预览/accessKey 预览/audioInfo，握手失败时翻译 401/403/5xx 为人话 + 排查 checklist + wscat 等价命令 |
| fix | prd-api | SubtitleGenerationProcessor 取消硬编码 doubao-asr-stream 白名单，改为三路分发（doubao-asr-stream / doubao-asr / Whisper-via-Gateway），whisper-large-v3 等 OpenAI 兼容模型现在可直接用于字幕生成 |
| fix | prd-api | SubtitleAsrException 携带 diagnostic，DocumentStoreAgentWorker 透传到 SSE error 事件与 run.errorMessage，前端从两个路径都能拿到诊断 |
| fix | prd-api | ExchangeController.TestStreamAsrSse 的 SSE error/result 事件附带 diagnostic + exchange 元数据，控制器层异常也带异常类型与堆栈头部 |
| fix | prd-admin | SubtitleGenerationDrawer 失败时展示完整诊断块（wsUrl/headers/audioInfo/握手状态码/异常链/友好错误），含「复制 wscat 命令」「复制完整诊断 JSON」按钮 |
| fix | prd-admin | ExchangeTestPanel 测试结果 GlassCard 增加 ASR 诊断块，与字幕面板字段一致，wscat 一键复制即可在本地复现 WebSocket 握手 |
