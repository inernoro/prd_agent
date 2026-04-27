| feat | cds | 新增 cds/web-v2/ 工程（Vite + React + TS + Tailwind + shadcn/ui），挂载在 /v2/ 路径，老页面与复活接口零影响 |
| feat | cds | server.ts installSpaFallback 支持可选 v2DirOverride，缺失时 warn 不阻塞启动 |
| test | cds | server-integration 新增 2 个测试守卫 /v2 挂载边界 + POST /api/factory-reset 不被 shadow |
| docs | doc | 新增 plan.cds-web-v2-migration.md 含 Week 2-5 迁移路线图与交接说明 |
