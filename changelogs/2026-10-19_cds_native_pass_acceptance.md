| fix | cds | 保留有效数据库通行证时不再被较新的撤销记录误导，恢复复制和放行操作的成功提示 |
| fix | cds | CDS CLI 自更新流未完成时拒绝复用历史 not_required 成功状态，技能同步至 0.16.10 |
| test | cds | 内网 MySQL、PostgreSQL、MongoDB 通过原生工具与 DbGate 实测临时通行证、白名单、只读隔离、审计及自然 30 分钟回收；源数据保持一致 |
