| feat | llmgw | 新增租户隔离的 Exchange 自助创建、映射编辑、版本冲突保护与审计定位 |
| security | llmgw | Exchange 创建与修改先写租户审计意图再写配置，避免出现有配置无审计 |
| security | llmgw | 强制 Exchange 通讯密钥只写加密，拒绝 URL 密钥和内网目标；外部 HTTP 使用安全出站连接，外部 WebSocket 首版拒绝执行 |
| test | prd-api | 新增 Exchange 归一化、租户数据域、密钥与审计边界守卫 |
| fix | llmgw | 修复新建 Exchange 初始状态误判为保存中，以及修改表单后仍残留旧校验错误的问题 |
