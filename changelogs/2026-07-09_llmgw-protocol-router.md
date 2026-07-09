| feat | prd-api | LLM Gateway 增加四类协议入口，统一进入 GW Request IR，并支持 appCaller 被动注册、auto/pool/pinned 路由语义与 provider attempts 观测 |
| feat | prd-llmgw | 新增 GW 配置权威接口，覆盖 appCaller、模型池、平台、模型、exchange、密钥健康、操作审计与 runtime gates |
| ops | docker | 为 llmgw 控制台挂载 rollout ledger 证据目录并显式配置读取路径，确保 runtime-gates 能读取生产台账 |
| polish | prd-llmgw-web | 控制台补齐日志、调用方、模型池、平台、模型、exchange、审计与 shadow 证据页面 |
| ops | scripts | 增加协议路由审计、配置权威备份/应用、生产发布 gate 和 inproc/shadow 回滚脚本 |
