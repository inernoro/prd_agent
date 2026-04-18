| feat | prd-api | LLM Gateway 对 OpenRouter 上游自动注入 `HTTP-Referer` + `X-Title` header，把 AppCallerCode 映射到 OpenRouter Dashboard 的应用归属维度；按 ApiUrl 域名隔离，不影响 DeepSeek / 通义 / Claude 等其他上游 |
| fix | prd-api | LLM Gateway 流式请求的传输层异常（HttpClient 超时、连接失败、流中途断连）现在会落 llmrequestlogs 的 statusCode + error，不再被 Watchdog 5 分钟兜底成 `error="TIMEOUT" / dur=300000` 的观测黑洞 |
| fix | prd-api | LLM Gateway 流式请求上游返回 401/4xx 时，先写日志再 yield Fail chunk；避免 caller 收到 Error chunk 立即 return 释放迭代器，导致 MarkError 被跳过、日志滞留 running 最终被 Watchdog 盖成 TIMEOUT |
