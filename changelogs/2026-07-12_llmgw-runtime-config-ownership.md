| refactor | llm-gateway | 将 serving 运行设置、资产登记、故障通知和密钥自检迁入 llm_gateway 数据域 |
| fix | llm-gateway | 移除 readiness 对 MAP Mongo 的必要依赖，并在 GW-only 路由前跳过 MAP appCaller 查询 |
