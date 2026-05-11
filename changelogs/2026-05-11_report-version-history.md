| feat | prd-admin | 周报详情页右栏新增「版本记录」卡，按时间倒序展示提交/审阅通过/退回/编辑事件，仅显示时间不含变更内容 |
| feat | prd-api | WeeklyReport 模型新增 VersionHistory 数组；SubmitReport / ReviewReport / ReturnReport 三个端点写入对应事件；UpdateReport 在已提交状态下被再次编辑也记入 edited 事件 |
