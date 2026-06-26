| revert | prd-api | 删除所有催办：移除缺陷超时催办 DefectEscalationWorker 与项目逾期提醒 PmOverdueReminderWorker，清理 DefectReport 的 LastEscalatedAt/EscalationCount 字段及 Program.cs 注册（反复催办被持续忽略，干扰正常需求） |
| fix | prd-api | DefectReport 加 BsonIgnoreExtraElements：删除催办字段后兼容存量 defect_reports 文档残留字段，避免反序列化 FormatException 致缺陷列表/详情查询 500 |
| chore | prd-api | 一次性清理服务 EscalationNotificationCleanupService：上线时删除已移除催办 Worker 留下的存量提醒通知（pm-reminder / defect-escalation key 前缀），避免用户上线后仍看到最多 3 天的催办噪音；采用有界周期清扫（约 20 分钟窗口）覆盖滚动发布期旧实例迟插入的记录 |
