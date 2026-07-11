| fix | prd-llmgw | runtime gates 统计当前 commit transport 证据时排除 GW smoke health probe，避免 D 层冒烟日志污染 full-http 门禁 |
| fix | scripts | gw-smoke 的 send/stream/client-stream/canary 请求显式标记 IsHealthProbe |
| test | prd-api | 增加 GW smoke health probe 与 runtime gates 排除逻辑静态守卫 |
