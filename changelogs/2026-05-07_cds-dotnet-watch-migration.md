| fix | cds | 一次性启动迁移：扫描所有 BuildProfile，hotReload.mode === 'dotnet-watch' 全部升级为 'dotnet-run'，根治"worker 跑 24h 前旧字节码"问题（举报报告所述） |
| fix | cds | 修复 POST /api/build-profiles/:id/hot-reload 的 type union 漏 dotnet-run / dotnet-restart 选项，前端 dropdown 现在能合法提交这两个模式 |
