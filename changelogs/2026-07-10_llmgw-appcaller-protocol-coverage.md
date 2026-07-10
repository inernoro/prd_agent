| feat | prd-api | LLM Gateway appCaller 被动注册累计 ObservedIngressProtocols，支持同一 appCaller 被多入口协议复用 |
| feat | prd-llmgw | appCaller 列表和协议覆盖矩阵基于 ObservedIngressProtocols 判断注册证据，并兼容旧 IngressProtocol 单值 |
| polish | prd-llmgw-web | appCaller 控制台入口列展示已观察到的协议列表，避免被最后一次入口覆盖误导 |
| test | prd-api | 增加 ModelLab/Arena pinned 经 GW 调用的防退化守卫 |
| feat | prd-llmgw | runtime gates 增加 appCaller 入口协议注册覆盖阻塞项，防止只看日志忽略注册表证据 |
| polish | prd-llmgw-web | 概览页 runtime gate 为 appCaller 入口协议注册覆盖提供协议覆盖和调用方深链 |
