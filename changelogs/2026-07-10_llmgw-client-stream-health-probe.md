| fix | prd-api | 修复 LLM Gateway client-stream 健康探针标记在跨进程链路中丢失，避免发布 gate 把探针流量误判为用户流量 |
| feat | prd-api | LLM Gateway 请求上下文、日志与兼容入口补充 RunId 业务追踪字段 |
| polish | prd-llmgw-web | LLM Gateway 日志详情抽屉展示业务 RunId，便于从网关日志反查 MAP run |
| feat | prd-llmgw-web | LLM Gateway 日志列表、汇总、时间序列与会话视图支持按 RunId 精确过滤 |
| feat | prd-llmgw-web | LLM Gateway 日志列表、汇总、时间序列与会话视图支持按 RequestId 与 SessionId 精确过滤 |
| feat | prd-llmgw-web | LLM Gateway appCaller 注册表记录最近请求追踪字段，并可跳转日志页按 requestId、sessionId、runId 反查 |
| security | prd-api | LLM Gateway serving 运行时按 GW appCaller 注册表状态拒绝 disabled/archived 调用方 |
| security | prd-llmgw | LLM Gateway 控制台禁止将未绑定 GW 权威模型池或使用 auto 策略的 appCaller 激活 |
| fix | prd-llmgw | LLM Gateway 配置权威自动绑池工具同步将 active appCaller 路由策略规范化为 pool |
| security | prd-llmgw | LLM Gateway 控制台激活 appCaller 前校验绑定池存在可解析成员，自动绑池跳过不可用默认池 |
