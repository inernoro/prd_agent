| feat | cds | P2 GitHub OAuth 认证：新增 `CDS_AUTH_MODE=github` 模式 + `/api/auth/github/*` 路由 + session middleware + `login-gh.html` 着陆页，默认 `disabled` 保留向下兼容 |
| feat | cds | 新增 `AuthStore` 接口 + `MemoryAuthStore` in-memory 实现（P3 将替换为 MongoDB 后端），定义 `CdsUser` / `CdsSession` / `CdsWorkspace` domain 类型 |
| feat | cds | 首登自举：第一个 OAuth 成功的用户自动成为 system owner 并获得 personal workspace |
| test | cds | 新增 33 条 P2 单测（memory-store 13 + auth-service 13 + routes 7），全量 `pnpm test` 298 → 331 零回归 |
| docs | cds | 更新 `doc/plan.cds-multi-project-phases.md` P2 交付清单，说明"MongoDB 延迟到 P3，P2 先走 in-memory 接口"的策略调整 |
