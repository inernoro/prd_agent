| feat | prd-api | 新增 LLM Gateway 五组件深度 readiness，并对公开失败摘要脱敏 |
| ops | deploy | 固化生产 Compose identity、serving 主备、就绪等待和拓扑 fail-fast preflight |
| fix | scripts | provider audit 改用 GW-owned 配置并区分生产绑定阻塞项与未绑定延后项 |
| test | prd-api | 增加 readiness、主备拓扑、发布配置和审计作用域防退化验证 |
