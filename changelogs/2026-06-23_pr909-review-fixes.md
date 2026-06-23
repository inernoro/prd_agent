| security | cds | 项目迁移收紧为系统级 admin-only:guard() 拒绝项目级 Agent Key,防止其新增攻击者控制 baseUrl 的 peer 诱导服务端外泄 bootstrap AI_ACCESS_KEY、或看/删别项目的全局迁移目标(PR #909 Codex P1 / Bugbot) |
| fix | cds | 项目迁移移除远端 replace-all(全局破坏会清掉目标其它项目配置),强制 merge 纯新增/更新;UI 同步去掉「替换全部」高级项 |
| fix | prd-admin | 更新中心 counts/timeline reducer 内层 day.entries/fragment.entries 补空值保护(?.length ?? 0),补齐上轮遗漏的崩溃点(PR #909 Bugbot) |
