| fix | prd-api | DoubaoStreamAsrService 新增 AsrDiagnostic：每次调用记录 wsUrl/resourceId/requestId/appKey 预览/accessKey 预览/audioInfo，握手失败时翻译 401/403/5xx 为人话 + 排查 checklist + wscat 等价命令 |
| fix | prd-api | SubtitleGenerationProcessor 取消硬编码 doubao-asr-stream 白名单，改为三路分发（doubao-asr-stream / doubao-asr / Whisper-via-Gateway），whisper-large-v3 等 OpenAI 兼容模型现在可直接用于字幕生成 |
| fix | prd-api | SubtitleAsrException 携带 diagnostic，DocumentStoreAgentWorker 透传到 SSE error 事件与 run.errorMessage，前端从两个路径都能拿到诊断 |
| fix | prd-api | ExchangeController.TestStreamAsrSse 的 SSE error/result 事件附带 diagnostic + exchange 元数据，控制器层异常也带异常类型与堆栈头部 |
| fix | prd-admin | SubtitleGenerationDrawer 失败时展示完整诊断块（wsUrl/headers/audioInfo/握手状态码/异常链/友好错误），含「复制 wscat 命令」「复制完整诊断 JSON」按钮 |
| fix | prd-admin | ExchangeTestPanel 测试结果 GlassCard 增加 ASR 诊断块，与字幕面板字段一致，wscat 一键复制即可在本地复现 WebSocket 握手 |
| fix | prd-api | SubtitleGenerationProcessor 调度策略改为通用「OpenAI 兼容优先」: 列举 ASR 池所有候选，按 PlatformId != "__exchange__" 自动选第一个 Healthy 模型作为 expectedModel —— 不再硬编码 whisper-large-v3，任何 whisper-1 / whisper-large-v3-turbo / 未来新平台模型都自动接入。池中无 OpenAI 兼容模型时降级默认调度，不破坏豆包用户 |
| fix | prd-api | SubtitleGenerationProcessor / ContentReprocessProcessor 创建 newEntry 时填 LastChangedAt = UtcNow，前端 DocBrowser 自动给新条目加「24 小时内更新」角标 |
| feat | prd-api | ContentReprocessProcessor 支持「模板 + 补充指令」组合：选模板时若 customPrompt 非空，自动拼到 systemPrompt 末尾作为额外用户指令，不再强制「模板 OR 自定义」二选一 |
| feat | prd-admin | ReprocessDrawer 补充指令输入框永远可见：选模板时作为「补充指令（可选）」叠加，选「自定义」时作为主 prompt（必填）；输入框 placeholder 文案随模式切换 |
| fix | prd-admin | ReprocessDrawer / SubtitleGenerationDrawer footer paddingBottom 加大到 80px，让主操作按钮避开屏幕右下角的全局通知/帮助气泡，避免被遮挡；按钮 size 从 xs 提升到 sm/md，主按钮视觉权重更醒目 |
| fix | prd-admin | DocumentStorePage 字幕生成 / 再加工 onDone 改为「立即刷新 + 1.5s 后兜底再刷一次」，兼容 DB 写入与列表读取间的微小延迟，确保新条目出现在左侧文件树 |
