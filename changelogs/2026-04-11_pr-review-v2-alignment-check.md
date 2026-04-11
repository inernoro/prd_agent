| feat | prd-api | PR Review V2 档 3 对齐度检查：新增 PrAlignmentService，通过 ILlmGateway 流式调用 LLM，对比 PR 描述 vs 实际代码变更 + 关联 issue，输出 Markdown 对齐度报告（遵守 llm-gateway.md 规则） |
| feat | prd-api | GitHubPrClient 扩展：新增 files（前 80 个，每 patch 截断 4KB）+ body（截断 20KB）+ 关联 issue（Closes #N 解析，body 截断 8KB）的拉取，防 MongoDB 单文档膨胀与 LLM 上下文爆炸 |
| feat | prd-api | PrReviewItem + PrReviewSnapshot 新增 Body / Files / LinkedIssue* / AlignmentReport 字段，承载档 3 所需的 AI 上下文与结果 |
| feat | prd-api | PrReviewController 新增两个端点：GET /items/{id}/ai/alignment（读缓存）+ GET /items/{id}/ai/alignment/stream（SSE 流式，按 phase/typing/result/error 事件推送） |
| feat | prd-api | PrAlignmentService prompt 强约束 Markdown 输出结构（对齐度% + 总结 + 已落实 + 没提但动了 + 提了没见到 + 关联 Issue 对齐 + 架构师关注点），后端同时解析出 Score + Summary 落库 |
| feat | prd-admin | 新增 AlignmentPanel 组件：基于 useSseStream 订阅 SSE 流，四态切换（idle / running / done / error），支持中止、重新分析、缓存展示，打字机预览 + 阶段文案遵守 llm-visibility 规则 |
| feat | prd-admin | AlignmentPanel 结构化渲染：解析 markdown 章节为色彩化卡片（emerald/amber/red/violet 对应 已落实/没提但动了/提了没见到/架构师关注点），头部展示对齐度分数徽章 + 重跑按钮 |
| feat | prd-admin | prReview 服务层新增 getPrReviewAlignment / getPrReviewAlignmentStreamUrl；usePrReviewStore 新增 setAlignmentReport 方法同步流完成后的结果；PrItemCard 展开态嵌入 AlignmentPanel |
