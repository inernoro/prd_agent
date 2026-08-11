| feat | prd-admin | 词云补词典三层：说话人名零配置自动进、系统级全局表、个人补充，合并在后端做 |
| feat | prd-api | UserPreferences/AppSettings 新增转录词典字段，配套合并读端点与个人/系统两个写端点 |
| feat | prd-admin | 词云正下方给补词入口，管理员多一个「加入系统词典」（无权限不显示，不给点了会 403 的入口） |
| test | prd-admin | 词典用例钉住「能捞回人名」「只做加不做猜不冒半截词」「长词优先」 |
| docs | prd-agent | 词云召回欠账记为已落地，列出剩余的批量导入与屏蔽入口 |
