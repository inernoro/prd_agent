| feat | prd-admin | 知识库分享落地页(/s/lib/:token)改用深色极简阅读器 LibraryShareReader(窄/宽栏 + 卡片式 + 全屏 + 目录 TOC + 树内搜索 + KaTeX 数学 + 代码高亮),数据层沿用 main 的 token 门禁匿名端点,支持整库/单篇两种分享范围 |
| fix | prd-api | 修复知识库「文档再加工」进度卡死:Worker 启动兜底回收上一个容器残留的 Running 任务并标记失败,避免重新部署/崩溃后前端进度条永远卡在「调用 LLM N%」(server-authority #5) |
| fix | prd-api | 修复「文档再加工」LLM 调用未设 LlmRequestContext 导致用量/配额挂不到用户:在 ContentReprocessProcessor 调用前用 run.UserId 开 BeginScope(llm-gateway.md) |
