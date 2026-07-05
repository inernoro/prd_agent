| test | prd-api | 新增跨进程 serving 网关集成自测 CrossProcessServingSelfTest（真 Kestrel + 真 HttpLlmGatewayClient + stub gateway），断言 resolve/send/stream/raw/pools/client-stream HTTP 往返 + ApiKey 不过线 + 密钥门 401 |
| refactor | prd-llmgw-serve | serving 端点抽成可复用扩展 MapGatewayServingEndpoints（SSOT，Program.cs 与自测共用同一份映射） |
