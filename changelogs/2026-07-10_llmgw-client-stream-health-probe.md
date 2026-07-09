| fix | prd-api | 修复 LLM Gateway client-stream 健康探针标记在跨进程链路中丢失，避免发布 gate 把探针流量误判为用户流量 |
| feat | prd-api | LLM Gateway 请求上下文、日志与兼容入口补充 RunId 业务追踪字段 |
| polish | prd-llmgw-web | LLM Gateway 日志详情抽屉展示业务 RunId，便于从网关日志反查 MAP run |
| feat | prd-llmgw-web | LLM Gateway 日志列表、汇总、时间序列与会话视图支持按 RunId 精确过滤 |
| feat | prd-llmgw-web | LLM Gateway 日志列表、汇总、时间序列与会话视图支持按 RequestId 与 SessionId 精确过滤 |
