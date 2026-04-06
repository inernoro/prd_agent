| feat | prd-admin | Exchange 测试面板支持 doubao-asr-stream 流式模式，SSE 逐帧显示识别进度 |
| feat | prd-admin | Exchange 卡片新增「一键添加到模型池」按钮，预填模型类型和别名 |
| feat | prd-api | ExchangeController 新增 SSE 流式 ASR 测试端点 (带认证，替代 AllowAnonymous 端点) |
| feat | prd-api | TranscriptRunWorker 支持 doubao-asr-stream 流式 ASR 路径（自动检测 Exchange 类型） |
| fix | prd-api | 流式 ASR segment 去重，从最后一帧 utterances 提取带时间戳的精细分段 |
| feat | prd-admin | 转录工作台 UI 重构：双栏持久化布局（左栏素材+右栏编辑） |
| feat | prd-admin | 音频播放器组件（播放/暂停/进度/倍速/文字联动） |
| feat | prd-admin | 段落可编辑（点击即编辑，失焦自动保存） |
| feat | prd-admin | SSE 转录进度条组件（阶段+百分比+实时反馈） |
| feat | prd-admin | 拖拽上传组件 + 文案生成面板独立组件 |
| feat | prd-api | 新增 GET /transcript-agent/runs/{id}/progress SSE 端点 |
| docs | doc | guide.doubao-asr-relay.md 补充 AppCallerCode 接入指南和 Gateway 统一讨论 |
