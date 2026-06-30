| feat | prd-api | LLM 日志黑洞可见：StartAsync 写日志失败时落一条 Status=blackhole 最小记录，让"未发出/未记录"也可在日志页查到 |
| feat | prd-api | LLM 日志内容一键还原：新增 GET /api/logs/llm/{id}/restore-text，把 answer/system/question/thinking 里的 [TEXT_COS] 占位符从 COS 取回原文 |
| feat | prd-api | LLM 日志按应用聚合：新增 GET /api/logs/llm/app-summary，按 appCallerCode 应用前缀+requestType 聚合请求数/成功率/中位时延 |
