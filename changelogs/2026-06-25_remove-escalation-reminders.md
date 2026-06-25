| revert | prd-api | 删除所有催办：移除缺陷超时催办 DefectEscalationWorker 与项目逾期提醒 PmOverdueReminderWorker，清理 DefectReport 的 LastEscalatedAt/EscalationCount 字段及 Program.cs 注册（反复催办被持续忽略，干扰正常需求） |
| fix | prd-api | DefectReport 加 BsonIgnoreExtraElements：删除催办字段后兼容存量 defect_reports 文档残留字段，避免反序列化 FormatException 致缺陷列表/详情查询 500 |
