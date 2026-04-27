| fix | prd-admin | /library 智识殿堂恢复为公开访问（refactor 前无守卫，匿名访客可看），不再被 fullscreenGuarded 强制要求登录+access 权限 |
| fix | prd-admin | v7 launcher ID 格式变化的兼容层：新增 migrateLegacyNavId 把旧前缀 ID（agent:visual-agent / utility:logs / infra:document-store 等）透明转换为新格式；findLauncherItem 自动 fallback 旧 ID；navOrderStore 加载时迁移 navOrder/navHidden 并落库；agentSwitcherStore 升级到 v3 + migrate hook 把 pinnedIds/recentVisits/usageCounts 一起迁移 |
| chore | prd-admin | 删除 dead code：navRegistry.tsx 的 getNavRegistryWithMeta 和 unifiedNavCatalog.ts 的 findNavItemByKey 都未被引用 |
