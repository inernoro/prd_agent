| refactor | cds | 大重命名：`cds/web/` 改为 React 工程（原 `web-v2/`），`cds/web-legacy/` 收纳老前端（原 `web/`），URL 不再带 `/v2/` 前缀 |
| refactor | cds | server.ts 重构 `installSpaFallback`：删 `/v2/*` 挂载，改为 `MIGRATED_REACT_ROUTES` 显式枚举已迁移路由（目前 `['/hello']`），其余请求 fall through 到 `cds/web-legacy/` |
| refactor | cds | `exec_cds.sh` `build_web_v2()` 重命名为 `build_web()`，构建输出从 `cds/web-v2-dist/` 改为 Vite 默认 `cds/web/dist/` |
| test | cds | 重写 server-integration 测试：守卫「React 仅服务已迁移路由 + `/api/factory-reset` 复活接口永远可达 + 未迁移路径 100% 走 legacy」三层契约 |
| docs | doc | `plan.cds-web-v2-migration.md` → `plan.cds-web-migration.md`，全文刷新去除 `/v2/` 表述，记录新架构「web/ + web-legacy/」 |
| docs | cds | `cds/CLAUDE.md` 目录结构段刷新：明示新栈 `cds/web/` 与老栈 `cds/web-legacy/` 并存；`scope-naming.md` 路径示例同步更新 |
