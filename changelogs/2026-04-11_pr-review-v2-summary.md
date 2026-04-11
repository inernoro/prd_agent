| feat | prd-api | PR Review V2 档 1 变更摘要：新增 PrSummaryService，通过 ILlmGateway 流式生成"一句话/关键改动/主要影响/审查建议"四段式 Markdown，AppCallerCode=pr-review.summary::chat |
| feat | prd-api | PrReviewItem 新增 SummaryReport 字段，存 markdown + headline + 耗时 + error |
| feat | prd-api | PrReviewController 新增 GET /items/{id}/ai/summary（读缓存）+ GET /items/{id}/ai/summary/stream（SSE 流式，复用与 alignment 相同的 phase/typing/result/error 事件协议） |
| refactor | prd-api | 抽出 EnsureSnapshotReadyAsync + PrepareSseHeaders 私有 helper，alignment 与 summary 两个 SSE 端点共享快照刷新与响应头设置，消除重复 |
| feat | prd-admin | 新增 SummaryPanel 组件：四态 SSE 生命周期（idle/running/done/error），空态按钮 / 打字机预览 / 结构化渲染（关键改动 · 主要影响 · 审查建议） |
| feat | prd-admin | PrItemCard 展开态依次嵌入 SummaryPanel（档 1，sky 色调）+ AlignmentPanel（档 3，violet 色调），摘要在前因为运行更快更适合先看 |
| feat | prd-admin | prReview 服务层新增 PrSummaryReportDto 类型、getPrReviewSummary / getPrReviewSummaryStreamUrl；usePrReviewStore 新增 setSummaryReport 方法 |
