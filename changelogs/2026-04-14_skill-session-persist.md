| feat | prd-api | SkillAgent 会话（Messages/Intent/SkillDraft/CurrentStage/SavedSkillKey）现在持久化到 MongoDB `skill_agent_sessions` 集合：进程重启 / 2h 空闲 / 用户刷新都能恢复中间态 |
| feat | prd-api | 新增 ISkillAgentSessionStore（内存 miss 时 DB 兜底加载 + upsert 持久化 + 用户隔离过滤），Controller 的 SendMessage/AutoTest/Save/Get/Delete/ExportMd/ExportZip 全部改走 ResolveSessionAsync |
| feat | prd-api | SkillAgentSession + SkillAgentMessage 迁移到 PrdAgent.Core.Models（避免 Core 层接口反向依赖 Infrastructure） |
| feat | prd-admin | 技能创建页把 sessionId 存入 sessionStorage，页面打开时优先恢复上次会话；handleReset 会清 sessionStorage |
| docs | doc | 新增 `skill_agent_sessions` 集合的 MongoDB 索引建议（UserId+LastActiveAt 复合 + 7 天 TTL） |
