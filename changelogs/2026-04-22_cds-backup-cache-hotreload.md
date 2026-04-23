| feat | prd-api | Dockerfile 改用 BuildKit cache mount（NuGet + pnpm），restore 换服务器后也能秒级复用 |
| feat | cds | 新增缓存诊断/修复/跨服务器迁移（Settings → 缓存诊断） |
| fix | cds | migrateCacheMounts 现在合并缺失的 NuGet/pnpm 挂载（老的 skip-if-any 逻辑会让混合 profile 永远拿不到 nuget） |
| feat | cds | 顶部新增 🔍 全局转发日志面板，专门排查「页面正常但 API 502 没日志」 |
| feat | cds | 新增配置快照系统 —— 每次 import-config 前自动拍 + 手动拍 + 一键回滚 |
| feat | cds | 新增破坏性操作审计 + 30 分钟内撤销窗口（顶部 🕐 按钮） |
| feat | cds | /api/import-config 新增 cleanMode (merge/replace-all) + branchPolicy (keep/restart-all/clean) |
| feat | cds | 数据库一键备份下载 + 上传恢复（mongodump / redis BGSAVE / tar） |
| feat | cds | BuildProfile.hotReload：容器里跑 dotnet watch / pnpm dev，改代码自动重编译不重启 |
| feat | cds | 遗留 default 项目迁移：banner 提醒 + /api/legacy-cleanup/rename-default |
| fix | cds | 新建项目禁止使用 id='default'（保留给迁移占位） |
