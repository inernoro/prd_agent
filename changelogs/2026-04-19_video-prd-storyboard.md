| feat | prd-api | 视频 Agent 分镜模式新增 PRD 输入源：CreateVideoGenRunRequest 扩展 inputSourceType + attachmentIds 字段，空 articleMarkdown 时自动从附件 ExtractedText 拼接 markdown |
| feat | prd-api | VideoGenRunWorker Scripting 阶段针对 PRD 输入使用专用 prompt（痛点→方案→功能演示→收益 8-12 镜结构），与技术文章拆分镜模板区分 |
| feat | prd-admin | 视频 Agent 分镜模式输入区新增双通道：Markdown 文章 / PRD 文档，PRD 模式支持 PDF/Word/Markdown 多文件上传，经 /api/v1/attachments 提取文本，附件 chip 展示与移除 |
| feat | prd-admin | 视频 Agent 直出模式模型选择器重构为三档卡片（经济 Wan 2.6 / 平衡 Seedance 2.0 / 顶配 Veo 3.1）+ 折叠「高级」按钮展开 OpenRouter 全量 7 个模型，默认推荐自动档 |
