| fix | prd-api | **关键幽灵 bug**：RegisterAppSettings 缺少 SetIgnoreExtraElements(true)，导致 MongoDB 残留的 PrReviewPrismGitHubTokenEncrypted 字段反序列化 AppSettings 时抛 BSON 异常，被 LlmRequestLogWriter.StartAsync 的 silent catch 吞掉，表现为**所有 LLM 调用都不写 llmrequestlogs**（新旧功能都受影响） |
| fix | prd-api | LlmRequestLogWriter.StartAsync 的 catch 块日志级别从 Debug 提升到 Warning，避免类似"所有日志静默丢失"的幽灵故障难以排查 |
| feat | doc | 新增 rule.ai-model-visibility + .claude/rules/ai-model-visibility 原则：中大型 AI 功能必须在 UI 最顶部展示当前调用的模型名 {model} · {platform}，数据来自后端 Start chunk，禁止前端硬编码 |
| feat | prd-api | PrReviewModelInfoHolder（新）：服务层 → Controller 的模型信息传递载体，让 IAsyncEnumerable 流式方法能把 Start chunk 捕获到的 ActualModel / ActualPlatformName / ModelGroupName 带出来 |
| feat | prd-api | PrSummaryService / PrAlignmentService StreamXxxAsync 新增 modelInfo 参数，在 Gateway Start chunk 时填充 |
| feat | prd-api | PrReviewController 在 SSE 流中新增 model 事件（Start 捕获后立即推送），同时把模型名持久化到 AlignmentReport.Model / SummaryReport.Model 字段 |
| feat | prd-admin | AlignmentPanel + SummaryPanel 新增 ModelBadge 组件：顶部低饱和度小字展示 "● {model} · {platform}"，流式阶段从 SSE model 事件获取实时值，完成后从 Report.Model 获取缓存值 |
| fix | prd-api | 新增 StreamLlmWithHeartbeatAsync 心跳：LLM 首字延迟（qwen/deepseek 等推理模型可达 10~90s）期间每 2s 推送 phase=waiting 事件带 elapsed 秒数，首字到达时切换到 phase=streaming。彻底消除用户盯着静态文案等几十秒的"空白等待"体验 |
| feat | prd-api | 新增 GET /api/pr-review/items/{id}/raw 端点：返回 PR 完整原文（body 未截断 + files[] 含 diff patch），独立端点避免把 100KB 数据塞进列表接口 |
| feat | prd-admin | 新增 PrRawContentModal 组件 + PrItemCard"查看原文"按钮：完整展示 PR 描述、关联 issue、变更文件列表（可折叠 diff patch，diff 带 +/-/@@ 彩色高亮） |
| fix | prd-api | **根因**：PrSummaryService / PrAlignmentService 只处理 GatewayChunkType.Text，把 Thinking chunk（推理模型 reasoning_content）silently dropped，导致 qwen-thinking 50 秒思考被当成"空白等待"（日志 firstByteAt=1.8s 但 SSE 首字 52s）。新增 LlmStreamDelta record struct 区分 Thinking / Text，两个 service 都 yield 双类型 |
| feat | prd-api | StreamLlmWithHeartbeatAsync 新增 SSE thinking 事件推送 + phase=thinking/streaming 阶段区分 |
| feat | prd-admin | 新增 PrMarkdown 共享组件（ReactMarkdown + remarkGfm + remarkBreaks + 深色主题），用于 PR 面板所有 markdown 场景：oneLiner、keyChanges bullets、impact/reviewAdvice 章节、AlignmentPanel 三栏 bullets、PrRawContentModal 的 PR body 与 linkedIssueBody |
| feat | prd-admin | SummaryPanel + AlignmentPanel 新增 ThinkingBlock 组件：流式渲染推理模型思考过程，正文开始后自动折叠 |
| fix | prd-api | 心跳 phase 文案分三级：0-15s "AI 正在思考"；15-40s "上游首字延迟较高（{model}），已等待 20s"；40s+ "⚠️ 上游响应异常缓慢，建议中止重试"。根因是 qwen/qwen3.6-plus 走 OpenRouter 是 fake-streaming——chunk #1 @ 4.4s 只是 Start metadata，chunk #2 第一个真正的文本 token @ 52s |
| fix | prd-api | OpenRouter 不默认转发 reasoning 的根因修复：在 request body 里加 `include_reasoning: true` + `reasoning: {exclude: false}`，修复后 thinking 事件从 1.9s 开始流式到达（从前是 52s 空白）。同步 OpenAIGatewayAdapter 支持 `reasoning` 字段（OpenRouter 归一名）和 `reasoning_content`（上游原生名） |
| feat | doc | 新建 `doc/rule.llm-gateway.md` + 扩展 `.claude/rules/llm-gateway.md`，沉淀 5 个流式 LLM 陷阱：firstByteAt 指标歧义 / OpenRouter 必须显式开 reasoning / reasoning 字段名不统一 / fake streaming 只能 UX 降级 / 诊断 3 个信息源交叉验证。附 8 项 checklist |
| feat | prd-api | 新增 GET /api/pr-review/items/{id}/history 端点，并行拉取 6 个 GitHub REST API（commits / reviews / review-comments / issue-comments / timeline / check-runs），每个子请求失败不致命 |
| feat | prd-admin | PrItemCard 右上角新增"历史"悬浮按钮 + PrHistoryModal 弹窗（5 个 tab：时间线 / 提交 / 评审 / 评论 / CI 检查）。时间线 tab 支持 committed / reviewed / commented / labeled / assigned / merged / force_pushed / renamed / ready_for_review 等 20+ GitHub 事件类型，每种事件独立图标 + 颜色 + 中文描述 |
