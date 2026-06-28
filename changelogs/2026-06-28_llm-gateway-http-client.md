| feat | prd-api | 新增 HttpLlmGatewayClient（实现 Infrastructure+Core 两个 ILlmGateway）+ HttpLlmClient（ILLMClient 代理），把 MAP 自身 LLM 调用经 /gw/v1/* 跨进程打到独立 serving 网关 |
| feat | prd-api | LlmGateway__Mode 特性开关（inproc|http，默认 inproc）：http 时 DI 切到 HttpLlmGatewayClient，48 个注入点零改动，方法签名不变 |
| feat | prd-llmgw-serve | serving 网关新增 /gw/v1/client-stream 端点，承接 CreateClient 流式路径（SSE） |
