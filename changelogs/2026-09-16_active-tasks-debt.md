| feat | prd-api | 债务接进任务台：稳定标识 + 幂等同步端点 + 认领/转成任务/放回/了结 |
| feat | prd-api | 开放接口与 MCP 新增 map_debt_list / map_debt_sync 两个工具 |
| feat | prd-admin | 任务台下半屏新增「欠着的」：折叠展示、展开看现状与补的条件、一键转成我的活 |
| feat | prd-agent | 新增 scripts/sync-debt-ledger.py，把 doc/debt.*.md 的主表解析成同步载荷 |
| test | prd-agent | 补债务台账解析器守卫（标识唯一性/格式同源/一份台账一张主表）与后端纯函数判据 |
| docs | prd-agent | 设计文档补「下半屏：我们欠着什么」，指南补用法，台账第 15 条收口并开 16/17 两条边界 |
| fix | prd-admin | 债务区挪到「做完的」之前——能动手的东西不该排在存档后面 |
| fix | prd-api | 放回认领与认领走同一个状态判定源，不再出现「还没人管」配「已转成 1 条活」 |
| fix | prd-agent | 同步脚本带上 User-Agent，绕开 CDN 对默认 Python-urllib 的 403 |
