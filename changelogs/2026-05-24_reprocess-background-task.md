| fix | prd-admin | 知识库文档再加工：任务状态上提到 reprocessRunStore，关闭抽屉后任务继续后台运行且可见（文件树"加工中 N%"chip + 右下角任务 pill），完成后自动刷新文件树并选中新文档 |
| feat | prd-admin | 知识库文档再加工支持刷新页面续传：runId 持久化到 sessionStorage，重进页面由 ReprocessRunHost 用 afterSeq=0 重连续传或补齐终态 |
