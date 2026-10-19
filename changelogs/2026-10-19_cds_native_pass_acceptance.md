| fix | cds | 保留有效数据库通行证时不再被较新的撤销记录误导，恢复复制和放行操作的成功提示 |
| fix | cds | CDS CLI 自更新流未完成时拒绝复用历史 not_required 成功状态，技能同步至 0.16.10 |
| test | cds | 内网 MySQL、PostgreSQL、MongoDB 通过原生工具与 DbGate 实测临时通行证、白名单、只读隔离、审计及自然 30 分钟回收；源数据保持一致 |
| fix | cds | 修复 Review 指出的预留端口抢占、MySQL 回环证书身份误判和网关证书到期轮换，保留已签发凭据一致性 |
| fix | cds | MySQL 回收复用 TLS 并正确处理显式空 root 密码；旧外链替换失败时持久化关闭状态，避免返回失效连接信息 |
| fix | cds | 按 MySQL 方言与字符串模式检查只读脚本；通行证网关绑定三库 TLS、账号和目标库；拒绝连接审计限流汇总并滚动保留 |
| fix | cds | MongoDB 握手兼容驱动的 none 压缩标记，保留拒绝压缩报文策略；隔离联调中 MySQL 与 MongoDB 均成功读取专用验收库 |
| fix | cds | 收紧 MongoDB SCRAM 字段及 nonce 边界，禁止认证命令歧义；MySQL 登录成功后清除握手超时，保持客户端空闲连接可用 |
