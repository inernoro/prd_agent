| security | prd-api | ResolveCredentialsAsync 拒绝非 active 状态的授权，expired/revoked 一律返回 null，避免工作流用已失效凭证静默失败 |
| security | prd-admin | 委员会月报 HTML 模板新增 esc/escUrl 函数，所有用户来源字段（TAPD标题/处理人/客户名/缺陷/CSV/LLM分析）HTML 转义，URL 属性限 http(s) 协议防 XSS |
| security | prd-api | TAPD/语雀 handler MaskCredentials 对短凭证也脱敏，不再因长度<=16/8 就完全回显明文 |
