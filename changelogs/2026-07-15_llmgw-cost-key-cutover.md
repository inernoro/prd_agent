| feat | llmgw | 新增租户级供应商费用对账、价格证据哈希与上游请求编号 |
| security | llmgw | 固化密钥用途边界及 MAP legacy shared key 的逐后继密钥退场验证 |
| fix | llmgw | 使用版本化索引名兼容存量数据库的工作负载用途索引升级 |
| fix | llmgw | 修复独立控制台同源四协议请求被静态 nginx 返回 405，并禁止外部租户伪装 MAP 内部 key 用途 |
| docs | doc | 补充网关费用与 legacy key 持久化数据字典及 PR-10 执行证据 |
| fix | llmgw | 修复 legacy MAP 请求体身份解析、缺失供应商金额误记零和无密钥窗口覆盖误判 |
| fix | llmgw | 补齐本地开发 llmgw-serve 数据面，避免四协议同源入口返回 502 |
