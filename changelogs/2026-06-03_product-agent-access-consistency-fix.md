| fix | prd-api | 修复产品管理列表/单产品访问与仪表盘范围不一致：ProductAgentAdmin 现为 ProductAgentManage 超集(统一 CanManage 判定)，管理员在产品/需求/功能列表与单产品视图可见全部，不再仪表盘有数而列表空 |
| fix | prd-api | UserNamesAsync/ProductNamesAsync 改去重安全写法，避免历史重复键导致 overview 列表端点 500(表现为列表空) |
