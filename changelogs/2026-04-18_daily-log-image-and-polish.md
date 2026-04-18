| feat | prd-admin | 周报日常记录：单行 input → 多行 textarea + 粘贴图片自动压缩上传（markdown 内联）+ 折叠态/编辑态/快速添加均渲染图片预览 + 每条 ✨ AI 润色按钮（流式预览浮层 + 接受/放弃 + 模型可见） |
| feat | prd-api | 新增 POST /api/report-agent/daily-logs/upload-image（图片上传，复用 IAssetStorage + Attachment）+ POST /api/report-agent/daily-logs/polish（SSE 流式润色：phase/model/thinking/typing/done/error 事件 + 心跳 + CancellationToken.None 服务器权威） |
| chore | prd-admin | 抽取通用图片压缩工具到 src/lib/imageCompress.ts，与 ReportEditor 共用 |
