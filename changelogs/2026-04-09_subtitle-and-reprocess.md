| feat | prd-api | 知识库 Agent：一键生成字幕（音视频直译带时间戳字幕 + 图片 Vision 识别），输出为新 DocumentEntry `{原文件名}-字幕.md` |
| feat | prd-api | 知识库 Agent：文档再加工（4 个内置模板：摘要 / 会议纪要 / 技术博文 / 学习笔记 + 自定义 prompt），流式 LLM 输出到新 entry |
| feat | prd-api | 新增 `document_store_agent_runs` 集合 + DocumentStoreAgentWorker（BackgroundService，轮询 queued 任务，遵循服务器权威性：CancellationToken.None + Worker 关机标记失败） |
| feat | prd-api | DocumentStoreController 新增端点：`GET reprocess-templates`、`POST generate-subtitle`、`POST reprocess`、`GET agent-runs/{id}`、`GET entries/{id}/agent-runs/latest`、`GET agent-runs/{id}/stream`（SSE + afterSeq） |
| feat | prd-api | AppCallerRegistry 新增 `DocumentStoreAgent.Subtitle.Audio/Vision` 和 `DocumentStoreAgent.Reprocess.Generate` 三条调用标识 |
| feat | prd-admin | DocBrowser ContextMenu 新增"生成字幕"和"再加工"选项（按 entry contentType 显示） |
| feat | prd-admin | DocBrowser 预览顶栏对音视频/图片 entry 显示「✨ 生成字幕」按钮，对文字 entry 显示「🪄 再加工」按钮 |
| feat | prd-admin | 新增 SubtitleGenerationDrawer：状态卡 + 进度条 + 阶段指示 + SSE 实时刷新，完成后自动跳转到新生成的字幕文档 |
| feat | prd-admin | 新增 ReprocessDrawer：模板卡片选择 + 自定义 prompt 输入 + 流式 LLM 实时打字预览 + 完成后跳转 |
| ops | — | docker-compose.dev.yml 补上 ffmpeg / ffprobe volume 挂载（与生产 docker-compose.yml 对齐，用于视频抽音频） |
