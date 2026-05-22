| fix | prd-api | 修复 Bugbot Medium：MySharesController byType 改为基于全量统计（切 targetType filter 后 chip 计数不再错乱/消失）；items 单独按 targetType 内存过滤 |
| fix | prd-api | 修复 Codex P1：知识库分享同工作流——无可用 /library/share/:token SPA 路由，撤销 DocumentStoreController 的 ShortLink allocate，不暴露打不开的 /s/{seq}；移除未用 IShortLinkService 注入 |
| fix | prd-admin | 修复 Codex P1：ShortLinkRouter document_store case 从 Navigate（死路）改为 UnsupportedTargetError |
| fix | prd-admin | 修复 Bugbot Medium：MySharesPage load 加 try/finally（请求 reject 时 spinner 不再永久卡住，finally 中仅最新请求关 loading） |
| fix | prd-admin | 修复 Bugbot Medium：DesktopAssetsPage 加 useEffect 监听 URL ?tab= 变化（深链 /my-assets?tab=shares 在不 remount 时也能切到正确 tab） |
| fix | prd-admin | 修复 Bugbot Low：ShareLinkTesterPage handleResolve 加 try/finally（fetch 抛异常时按钮不再永久禁用）；LEGACY_PATH document_store 改 null 不显示死链 |
