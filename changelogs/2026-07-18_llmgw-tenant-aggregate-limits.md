| feat | llmgw | 新增跨团队、接入密钥与 appCaller 的租户总月预算原子预占和总 RPM 硬限制 |
| feat | llmgw | 预算与用量页新增租户硬限制配置、实时预占与分钟用量，并同步分层治理教程 |
| test | llmgw | 新增租户预算与速率并发、跨 appCaller、跨租户隔离及双层响应头测试 |
| fix | llmgw | 新增租户与成员 provisioning 硬退出恢复操作，按精确对象 ID 回滚半成品并周期接管过期修复 |
| fix | llmgw | 将 provisioning 修复异常隔离到单次 tick，Mongo 瞬时故障后下一轮仍会继续接管 |
| security | llmgw | 将最后 owner 保护改为租户权威集合与原子 fencing generation，移除可过期的进程锁 |
| test | llmgw | 新增 provisioning 硬退出、修复器接管、并发 owner 移除和 owner 变更收口测试 |
| security | llmgw | 外部租户 Exchange 安全开放 WSS，运行时固定已验证公网地址并校验证书主机名，拒绝明文 WS、私网、代理和跳转 |
| fix | llmgw | 强制外部 Exchange transport 与转换类型匹配，阻止 WSS 配给非流式转换器或流式 ASR 误配 HTTP |
| docs | llmgw | 同步 Exchange WSS 教程，并新增每日页面到章节漂移巡检、告警报告和更新提醒草稿 |
