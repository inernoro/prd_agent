| feat | prd-api | 需求导入无外部 ID 时自动分配纯数字 RequirementNo 并同步 ExternalId，同批导入全局递增 |
| fix | prd-api | 需求编号改为全库全局递增（不再按产品隔离），与 TAPD/设计理念一致 |
| fix | prd-api | 缺陷编号改为全库 DefectReports 单表全局递增；T/V 版本编码全库全局递增 |
| refactor | prd-api | 功能编号按正式版本清单（OfficialReleaseId）递增；抽取 ProductEntityNumbering SSOT |
| fix | prd-admin | CSV 空需求 ID 列解析为未提供，交由后端自动编号 |
