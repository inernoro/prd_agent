| feat | prd-api | 新增 AiStreamingHelpers (Services/Streaming) — 通用 AI SSE 写出器, 一次封装 phase/model/thinking/typing/done/error + 心跳 + writeLock |
| feat | prd-api | 新增 DefectPolishService — 缺陷描述润色 SSE 流式服务 (与 DefectAgentController 共享 prompt) |
| feat | prd-api | 新端点 POST /api/defect-agent/defects/polish/stream — 与 useAiPreviewStream + AiPreviewModal 配对; 旧 /defects/polish 保留 6 个月做向后兼容 |
| feat | prd-api | AppCallerRegistry 新增 DefectAgent.Polish.Stream = "defect-agent.polish-stream::chat" |
| feat | prd-admin | 新增 useAiPreviewStream hook — 一次性 AI 端点流式升级的统一前端入口 (text/thinking/model/streaming/start/apply/regenerate/cancel) |
| feat | prd-admin | 新增 AiPreviewModal — 通用 AI 预览弹窗 (createPortal + 80vh inline + StreamingText + MapCursor + ESC) |
| feat | prd-admin | DefectSubmitPanel AI 润色切换到流式版 (Blur focus 词级动画 + 思考过程展示 + 重新生成) |
| refactor | prd-admin | DailyLogPolishPopover 收编到 AiPreviewModal — 从 234 行降到 65 行薄壳, 复用通用 modal |
| docs | doc | rule.streaming-text.md 新增"把一次性 AI 端点升级为流式"完整 Migration 手册 (后端 Service + Registry + Helper, 前端 hook + modal, 兼容期 6 月) |
