| feat | llmgw | 新增跨团队、接入密钥与 appCaller 的租户总月预算原子预占和总 RPM 硬限制 |
| feat | llmgw | 预算与用量页新增租户硬限制配置、实时预占与分钟用量，并同步分层治理教程 |
| test | llmgw | 新增租户预算与速率并发、跨 appCaller、跨租户隔离及双层响应头测试 |
| fix | llmgw | 新增租户与成员 provisioning 硬退出恢复操作，按精确对象 ID 回滚半成品并周期接管过期修复 |
| security | llmgw | 将最后 owner 保护改为租户权威集合与原子 fencing generation，移除可过期的进程锁 |
| test | llmgw | 新增 provisioning 硬退出、修复器接管、并发 owner 移除和 owner 变更收口测试 |
