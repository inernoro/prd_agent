| fix | prd-admin | migrateLegacyNavId 加 LEGACY_SLUG_REMAP 表：旧 'infra:models' 剥前缀后是 'models' 但实际路由是 /mds，旧 'infra:teams' → 'users'。修复后存量用户旧偏好里的「模型」「团队」不再丢 |
| fix | prd-admin | agentSwitcherStore 持久化版本 bump 到 v4，已迁移到 v3 的用户重新触发一次 migrateLegacyNavId（这次包含 slug remap） |
| refactor | prd-admin | LauncherItem 加 shortLabel 必填字段，由 buildFromRegistry 直接从 navRegistry.NavMeta.shortLabel 注入；后端 menu items 仍走 getShortLabel 兜底；unifiedNavCatalog 和 AppShell 优先用 LauncherItem.shortLabel，让 navRegistry 真正成为 SSOT |
