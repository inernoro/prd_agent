# CDS 多项目改造 7 期交付计划

> **版本**：v0.1 | **日期**：2026-04-12 | **类型**：plan | **状态**：草案
>
> 把 CDS v3.2（单项目）到 v4（多项目）的改造拆成 P0-P6 共 7 期。每期独立交付、独立验收、独立回滚，避免"一次性重构、中间不可用"。
>
> **文档导航**：
>
> - 主设计稿：`doc/design.cds-multi-project.md`
> - 数据字典：`doc/spec.cds-project-model.md`
> - 迁移规范：`doc/rule.cds-mongo-migration.md`

---

## 1. 总览表

| 期 | 代号 | 目标 | 用户可见变化 | 内部变化 | 前置依赖 | 回滚策略 | 预估 session |
|---|---|---|---|---|---|---|---|
| P0 | design-docs | 4 份设计文档 | 无 | 无 | 无 | 删文件 | 1 |
| P1 | project-shell | 项目列表外壳 | 首页变为项目列表（单项目兼容） | 前端新增两层路由 + 旧 API 中间件注入默认 projectId | P0 审过 | 回滚前端路由 | 2-3 |
| P2 | github-auth | GitHub OAuth + Org 白名单 | 必须登录才能访问 | 新增 `users`/`sessions` 集合 + 认证中间件 + OAuth 流程 | P1 | `CDS_AUTH_MODE=disabled` | 3-4 |
| P3 | mongo-migrate | 数据层迁移到 MongoDB | 无感 | 三阶段双写切换 state.json → mongo | P2 | `CDS_STORAGE_MODE=json` | 4-5 |
| P4 | multi-project | 多项目真落地 | "+ New Project" 能建第二个项目 | 每项目独立 docker network + 全 API 带 projectId filter | P3 | 禁用多项目创建 UI | 3-4 |
| P5 | team-workspace | 团队 workspace + 成员 | 可创建团队 workspace，按 GitHub Org 同步成员 | `workspaces` + `workspace_members` + RBAC | P4 | 隐藏团队功能 UI | 2-3 |
| P6 | deploy-automation | 手动项目 + webhook + 自动部署 | 真正"部署"能力 | webhook endpoint + dirty tracking + deploy 策略 | P5 | 关闭 webhook 接收 | 2-3 |

**总估算**：17-22 session；**关键风险期**：P3（迁移）、P4（多项目隔离）。

---

## 2. 关键里程碑

- **P1 完成 = "项目列表可见"**：最早的用户可见变化，证明外壳路线通
- **P2 完成 = "登录可用"**：MongoDB 首次进场（仅 users/sessions 两个集合）
- **P3 完成 = "mongo 迁移完成"**：风险最大的一期，此后 state.json 降级为冷备
- **P4 完成 = "第二个项目可建"**：真正的多项目能力落地
- **P6 完成 = "CDS v4 GA"**：手动项目 + 自动部署 = v4 全量能力

---

## 3. P0：设计文档（本期）

### 目标

把多项目架构的"为什么 / 是什么 / 怎么做 / 风险"写成可审阅的 4 份文档，作为后续 6 期的蓝图。

### 前置依赖

- 对现有 CDS v3.2 架构（`doc/design.cds.md`）的深入理解
- 对 `state.json` 数据结构的熟悉
- 对 GitHub OAuth 流程的了解

### 交付清单

- [ ] `doc/design.cds-multi-project.md` — 主设计稿（管理摘要 + 架构 + API + 风险）
- [ ] `doc/spec.cds-project-model.md` — 10 个集合的数据字典
- [ ] `doc/plan.cds-multi-project-phases.md` — 本文档
- [ ] `doc/rule.cds-mongo-migration.md` — 迁移与回滚规范

### 验收标准

- [ ] 4 份文档互相引用一致
- [ ] design 文档第一节是管理摘要
- [ ] 4 份文档前缀符合 `.claude/rules/doc-types.md`
- [ ] 文档通过人工评审（至少 1 名 reviewer）

### 回滚策略

删除 4 个文件即可。

### 风险

无代码改动风险。唯一风险是"设计方案有盲点，P1 开工后才发现"——通过评审缓解。

---

## 4. P1：项目列表外壳

### 目标

**外表先变，内部不动**。让用户首次进入 CDS 时看到"项目列表"页面（虽然里面只有 1 个"默认项目"卡），并能点进去看到和 v3.2 完全一样的 dashboard。

这一期不动任何数据层代码，所有 API 仍然走 `state.json`，通过一个 implicit project resolver 中间件自动把 `projectId = "default"` 注入旧路径。

### 前置依赖

- P0 审完
- 现有 dashboard UI 可以被包裹进一层路由

### 交付清单（已落地 ✓）

**后端**：

- [x] 新增 `cds/src/routes/projects.ts`：提供 4 个端点
  - `GET /api/projects` → 返回固定的 `[{ id: 'default', name: '<repo-basename>', legacyFlag: true, branchCount: ..., ... }]`
  - `GET /api/projects/:id` → id 为 `default` 返回详情，其他返回 404
  - `POST /api/projects` → 返回 501，指向 P4
  - `DELETE /api/projects/:id` → 返回 501
- [x] `cds/src/server.ts`：
  - 注册 `createProjectsRouter` 到 `/api`
  - 在 `installSpaFallback` 里加 `GET /` 302 到 `/projects.html`
- [x] `cds/tests/routes/projects.test.ts`：6 条单测覆盖所有端点
- **未做（延后到 P2/P4）**：implicit-project 中间件。P1 阶段 `projectId` 完全从旧 API 中缺席，直到 P4 才在所有路径里带 projectId filter。P1 保留旧 API 形状以零侵入兼容现有 Dashboard

**前端**（纯 HTML + 原生 JS，不是 React）：

- [x] 新增 `cds/web/projects.html`：项目列表着陆页，内嵌 CSS（消费现有 `style.css` 的变量），与 Dashboard 主题一致
- [x] 新增 `cds/web/projects.js`：fetch `/api/projects`，渲染卡片，点击跳转 `index.html?project=<id>`
- [x] 修改 `cds/web/index.html`：header 左侧加 "← 项目" 返回链接
- [x] "+ New Project" 按钮点击 toast "创建新项目将在 P4 上线"

### 验收标准

- [x] 访问 `/` 自动 302 到 `/projects.html`
- [x] `/projects.html` 显示 1 张项目卡（显示 repo basename + 分支数）
- [x] 点卡片跳转到 `index.html?project=default`，看到完整 Dashboard（与 v3.2 一致）
- [x] Dashboard header 左侧 "← 项目" 链接可返回列表
- [x] 所有原有分支操作正常（tests 298/298 通过）
- [x] `pnpm build` 零错误，`pnpm test` 全绿
- [x] `.cds.env` 不需要任何新变量

### 回滚策略

- Revert 新增的前端路由文件（`projects-list.tsx`、`workspace-switcher.tsx`）
- 移除 `implicit-project` 中间件
- `App.tsx` 恢复单页 Dashboard 入口

### 风险

- **R1**：前端路由改造破坏现有 Dashboard 状态管理 → 缓解：外层 wrapper 不改 Dashboard 内部
- **R2**：旧 API 没覆盖全 → 缓解：grep `/api/` 前缀清点所有路由

### 预估工作量

2-3 session。

---

## 5. P2：GitHub OAuth + Org 白名单（已落地 ✓ 2026-04-13）

### 目标

让 CDS 从"无登录裸跑"变成"必须 GitHub 登录 + Org 校验"。

**实现策略调整**：MongoDB 延迟到 P3 才引入。P2 使用 **in-memory AuthStore** 作为过渡实现，对外暴露稳定的 `AuthStore` 接口。P3 时用 MongoDB-backed 实现替换，所有消费代码零改动。这样 P2 可以在没有 mongo 容器的前提下完整跑 CI + 单机开发。

### 前置依赖

- P1 完成，`/projects` 已成为首屏
- GitHub OAuth App 已申请，拿到 client_id / client_secret
- CDS 容器里的 MongoDB 可用（P1 未启用，P2 首次使用）

### 交付清单（已落地 ✓）

**配置**：

- [x] 环境变量：`CDS_AUTH_MODE` (`disabled` / `basic` / `github`)、`CDS_GITHUB_CLIENT_ID`、`CDS_GITHUB_CLIENT_SECRET`、`CDS_ALLOWED_ORGS`、`CDS_PUBLIC_BASE_URL`
- [ ] **未做**：`cds/exec_cds.sh init` 向导字段收集（P2.5 或 P5 再做，需先有真实 OAuth App）

**后端**：

- [x] `cds/src/domain/auth.ts`：`CdsUser` / `CdsSession` / `CdsWorkspace` / `UpsertUserInput` 类型
- [x] `cds/src/infra/auth-store/memory-store.ts`：`AuthStore` 接口 + `MemoryAuthStore` 实现（in-memory，P3 替换为 mongo）
- [x] `cds/src/services/github-oauth-client.ts`：GitHub OAuth HTTP 客户端（可注入 fetch，便于测试）
- [x] `cds/src/services/auth-service.ts`：完整 OAuth 编排（startLogin → handleCallback → 首登自举 → validateSession）+ CSRF state store
- [x] `cds/src/routes/auth.ts`：`/api/auth/github/login`、`/api/auth/github/callback`、`/api/auth/logout`、`/api/me`
- [x] `cds/src/middleware/github-auth.ts`：session 校验 + 公开路径白名单 + HTML/JSON 差异化响应
- [x] `cds/src/server.ts`：按 `CDS_AUTH_MODE` 分发三种模式，github 模式挂载 router + middleware

**前端**：

- [x] `cds/web/login-gh.html`：GitHub 登录着陆页（支持 `?redirect=` 透传，错误信息内联展示）
- [x] Middleware 未登录 HTML 请求 302 到 `/login-gh.html?redirect=<original-url>`
- [ ] **未做**：Dashboard header 显示用户头像 + 登出按钮（P2.5 UI 完善）

### 测试覆盖（新增 33 条单测）

- [x] `tests/infra/memory-store.test.ts` — 13 条（upsertUser、sessions、workspaces、TTL 过期）
- [x] `tests/services/auth-service.test.ts` — 13 条（完整 OAuth 流程 + 首登自举 + CSRF state + 错误映射）
- [x] `tests/routes/auth.test.ts` — 7 条（login/callback/me/logout 端到端 HTTP 测试）
- [x] 全量 `pnpm test` 从 298 → 331，零回归

### 验收标准

- [x] `CDS_AUTH_MODE=disabled` (默认) 时行为与 v3.2 完全一致，零回归
- [x] `CDS_AUTH_MODE=basic` 时沿用 v3.2 的 `CDS_USERNAME/CDS_PASSWORD` cookie 登录
- [x] `CDS_AUTH_MODE=github` + 环境变量齐全时启动成功
- [x] Missing GitHub client id/secret 时抛出明确错误，不静默启动
- [x] 首登用户变为 system owner，自动创建 personal workspace
- [x] `CDS_ALLOWED_ORGS` 不匹配的账号被拒绝
- [x] CSRF state token 只可使用一次
- [x] Session TTL 到期后 lazily prune
- [ ] **未验证**：真实 GitHub OAuth App 的端到端登录（需用户提供 client_id/client_secret 后在 preview 环境验证）

### 回滚策略

- `.cds.env` 设 `CDS_AUTH_MODE=disabled`，立即恢复裸跑
- 无需回滚代码（`disabled` 分支在中间件里是显式 bypass）
- `users` / `sessions` 集合可保留也可 drop

### 风险

- **R1**：OAuth 回调 URL 配错 → 缓解：`exec_cds.sh init` 里明确提示在 GitHub App 设置里填哪个 URL
- **R2**：GitHub API 限流 → 缓解：session 长效 + org 快照 1h 复用
- **R3**：首登自举出错导致 legacy project 丢失归属 → 缓解：自举用事务（MongoDB 4.0+ 支持单集合事务，跨集合用幂等重试）

### 预估工作量

3-4 session。

---

## 6. P3：MongoDB 数据层迁移（**Part 1 ✓ 2026-04-13**, **Part 2 ✓ 2026-04-14 via Phase D.1-D.3**, Part 3 待办）

### 目标

把 `state.json` 承载的所有业务数据迁到 MongoDB。**这是整个 v4 里风险最大的一期**。

采用三阶段双写策略（详见 `doc/rule.cds-mongo-migration.md`），任何阶段都可通过 `CDS_STORAGE_MODE` 回滚。

### 为什么拆成 Part 1 / Part 2 / Part 3

P3 全量在一个 session 里落地违反规则 8（完成标准）——mongo 接入既需要引入新运行时依赖，又需要活的 mongo 实例做验证。拆分原则：

- **Part 1（已落地 2026-04-13）**:纯重构。抽出 `StateBackingStore` 接口，用 `JsonStateBackingStore` 包住现有的 atomic write + `.bak.*` 恢复逻辑。`StateService` 改成通过 `backingStore` 委托持久化。**零行为变化，340 个测试全绿**。这样后续 Part 2/3 都只需要新增一个 backing store 实现，不需要再动 StateService 或任何业务层消费者
- **Part 2（已落地 2026-04-14，作为 Phase D.1-D.3 交付）**:引入 `mongodb` npm 依赖 + `MongoStateBackingStore` 实现 + 运行时 JSON↔Mongo 切换 + auto-fallback + seed-from-json 一次性导入。详见 `report.cds-phase-b-e-handoff-2026-04-14.md` §5 Phase D 章节
- **Part 3（Part 2 稳定后，待办）**:`DualWriteStateBackingStore` + 一致性校验脚本 + 迁移脚本 `migrate-state-to-mongo.ts --dry-run/--execute`。这是 P3a/P3b/P3c 三阶段切换的真正落地

### 前置依赖

- P2 完成，users / sessions 集合已在 MongoDB 稳定运行 ≥ 3 天
- `state.json` 做过完整冷备份 `state.json.premigration-YYYYMMDD.bak`
- 准备好停机窗口（至少 30 分钟，用于 P3c 切换）

### Part 1 交付清单（已落地 ✓）

**配置**：

- [x] `CDS_STORAGE_MODE` 环境变量已接入 `index.ts`，默认 `json`；`mongo`/`dual` 值会在启动时抛出明确错误指向 Part 2/3

**后端**：

- [x] `cds/src/infra/state-store/backing-store.ts`：`StateBackingStore` 接口（`load()` / `save()` / `kind`）
- [x] `cds/src/infra/state-store/json-backing-store.ts`：`JsonStateBackingStore` 提取现有 atomic write + `.bak.*` rotation + recovery 逻辑
- [x] `cds/src/services/state.ts`：构造器新增可选 `backingStore` 参数，默认实例化 `JsonStateBackingStore`；`load()`/`save()` 改为委托；删除了内联的 `tryLoadStateFile()` / `rollBackups()`
- [x] `cds/src/index.ts`：启动时按 `CDS_STORAGE_MODE` 校验
- [x] `cds/tests/infra/json-backing-store.test.ts`：9 条直接测 backing store（load/save/recovery/rotation/kind tag）
- [x] 全量测试 331 → 340 零回归

### Part 2 交付清单（已落地 ✓ 作为 Phase D.1-D.3）

- [x] `cds/src/infra/state-store/mongo-backing-store.ts`:MongoDB 实现
- [x] `cds/package.json` 引入 `mongodb` 运行时依赖
- [x] 改造 `index.ts`:按 `CDS_STORAGE_MODE` 分发 backing store (`json` / `mongo`)
- [x] auto-fallback 机制:mongo 连接失败自动回退 json
- [x] seed-from-json:从现有 state.json 一次性导入 mongo 的启动命令

### Part 3 剩余工作（待办）

- [ ] 新增 `cds/src/infra/state-store/dual-write-backing-store.ts`:双写 + 一致性校验
- [ ] 改造 `index.ts`:新增 `CDS_STORAGE_MODE=dual` 模式
- [ ] 新增 `cds/scripts/migrate-state-to-mongo.ts`:一次性迁移脚本(支持 `--dry-run`)
- [ ] 新增 `cds/scripts/verify-state-consistency.ts`:对比 state.json 和 mongo 一致性的工具
- [ ] P3c 阶段:新增 `cds/scripts/seal-state-json.ts`:重命名 state.json 为 legacy

**验收脚本**：

- [ ] 迁移前：`verify-state-consistency.ts --source=state.json` 输出基线
- [ ] 迁移中：每日跑一次 `verify-state-consistency.ts --mode=compare` 对比双方
- [ ] 迁移后：`verify-state-consistency.ts --source=mongo` 与基线对比

### 验收标准

**P3a（双写）**：

- [ ] 所有写操作同时进 state.json 和 mongo
- [ ] 读仍走 state.json
- [ ] 一致性校验连续 3 天无告警
- [ ] 可通过 `CDS_STORAGE_MODE=json` 回到纯 state.json 模式

**P3b（mongo 读）**：

- [ ] 读切到 mongo
- [ ] 写仍双写
- [ ] 一致性校验连续 3 天无告警
- [ ] 可通过切换读源环境变量回到 state.json 读

**P3c（封存 state.json）**：

- [ ] state.json 重命名为 `state.json.legacy-YYYYMMDD`
- [ ] 写只进 mongo
- [ ] legacy 文件保留 2 周
- [ ] 2 周后确认无回滚需求，移入冷备归档

### 回滚策略

- **任意阶段**：`CDS_STORAGE_MODE=json` → 立即切回纯 JSON 模式（P3c 之前 state.json 一直双写，回滚无数据损失）
- **P3c 之后回滚**：需要 `cds/scripts/mongo-to-state.ts`（反向迁移脚本）→ 这种场景通常不发生，若发生是最严重的事故

### 风险

见 `doc/rule.cds-mongo-migration.md` 的风险章节。核心：**任何一致性告警都要立即停 P3 推进，查根因**。

### 预估工作量

4-5 session（其中 1 session 专门做演练）。

---

## 7. P4：多项目真落地（**Part 1 + 2 + 3a + 3b 全部已落地 ✓ 2026-04-13**）

### 目标

让"+ New Project"按钮从 P1 的"coming soon"变成真正可用。用户可以在一个 CDS 实例里创建第二个、第三个项目，每个项目有独立的 Docker 网络、独立的 branches / profiles / infra / routing。

### 为什么拆成 Part 1 / Part 2 / Part 3

P4 分三个 Part 渐进落地，每个 Part 独立可交付、可回滚、可验收：

- **Part 1（已落地）**：数据模型。给 `CdsState` 加 `projects: Project[]` 字段，`StateService` 补充 CRUD + 启动时 migrate 自动创建一个 legacy 默认项目。`/api/projects` 路由改为读真实 state，删除 P1 时代的硬编码。**零行为变化**（用户仍然只看到一个项目，但数据链路真实了）。附带 P2.5 Dashboard 头部的 user avatar + logout 小组件
- **Part 2（已落地）**：真正的创建/删除。`POST /api/projects` 调 `docker network create` + `StateService.addProject()`（带 rollback）；`DELETE /api/projects/:id` 调 `docker network rm` + `StateService.removeProject()`；前端 `+ New Project` 按钮打开创建对话框；卡片 hover 出现删除按钮。**用户可见**：第一次能真正创建第二个项目
- **Part 3a（已落地）**：数据层 project scoping。给 `BranchEntry` / `BuildProfile` / `InfraService` / `RoutingRule` 加 `projectId?: string` 字段；`StateService.migrateProjectScoping()` 在 load 时把 pre-P4 entries 全部标为 `'default'`；新增 `getBranchesForProject / getBuildProfilesForProject / getInfraServicesForProject / getRoutingRulesForProject` helper；`addBranch / addBuildProfile / addInfraService / addRoutingRule` 在 projectId 缺失时自动填 `'default'`。**零行为变化**，所有现有 API 依然工作，仅数据链路多了可用的 scope key
- **Part 3b（已落地）**：routing + frontend scoping。`/api/branches` / `/api/routing-rules` / `/api/build-profiles` / `/api/infra` 新增 `?project=<id>` 查询过滤；`POST /api/branches` 接受 `projectId` 并校验项目存在；Dashboard 的 `api()` helper 自动把 `CURRENT_PROJECT_ID`（从 URL 读）注入 scoped GET 请求；顶栏"项目"链接显示当前项目名

### 前置依赖

- **Part 1**：P1 shell 已落地（零前置依赖于 mongo；P3 Part 2/3 挪到最后）
- **Part 2**：Part 1 已落地 + 用户授权引入 Docker network 创建操作
- **Part 3**：Part 2 已落地

### Part 1 交付清单（已落地 ✓）

**后端**：

- [x] `cds/src/types.ts`：新增 `Project` 接口 + `CdsState.projects?: Project[]` 可选字段
- [x] `cds/src/services/state.ts`：
  - 新增 `getProjects() / getProject(id) / getLegacyProject() / addProject(p) / removeProject(id) / updateProject(id, patch)`
  - 新增 `migrateProjects()` 私有方法，`load()` 流程尾部调用：如果 `projects` 为空则创建一个 `{ id: 'default', slug: projectSlug, legacyFlag: true, kind: 'git' }`
  - `addProject` 拒绝重复 id / 重复 slug；`removeProject` 拒绝删除 legacy 项目；两者都会调 `save()` 持久化
- [x] `cds/src/routes/projects.ts`：
  - 删除 P1 时代的 `buildLegacyProject()` 硬编码
  - `GET /api/projects` 改为读 `stateService.getProjects()`，每条带 `branchCount` 衍生字段
  - `GET /api/projects/:id` 从 `stateService.getProject()` 查询
  - `POST / DELETE` 保留 501，`availablePhase` 更新为 `'P4 Part 2'`

**前端（P2.5 补丁）**：

- [x] `cds/web/index.html`：header 加 `#cdsAuthWidget` 徽章（avatar + login + 登出按钮），默认 hidden
- [x] `cds/web/app.js`：新增 `bootstrapAuthWidget()`，`init()` 里 fire-and-forget 地探测 `/api/me`；200 时显示徽章并填充 github login + avatar；401（disabled/basic 模式）时保持隐藏
- [x] 新增 `cdsLogout()`：POST `/api/auth/logout` 后跳转 `/login-gh.html`

**测试**：

- [x] `cds/tests/services/state-projects.test.ts`（新）：13 条测 migration、getProject/getLegacyProject、addProject（含重复校验）、removeProject（含 legacy 保护）、updateProject
- [x] `cds/tests/routes/projects.test.ts`（改）：6 条更新为 P4 Part 1 语义——slug 来自 projectSlug 而非硬编码、`availablePhase: 'P4 Part 2'`
- [x] 全量 `pnpm test` 340 → **353（零回归）**

### 验收标准（Part 1）

- [x] 冷启动时 state.json 里自动出现一个 `projects[0]` 条目，legacyFlag=true
- [x] 把 state.json 备份回 v3.2 时代（删掉 projects 字段），重新启动后 projects 自动迁移
- [x] `GET /api/projects` 返回真实数据，不再是硬编码
- [x] `CDS_AUTH_MODE=github` 时 Dashboard header 显示用户 avatar + 登出
- [x] `CDS_AUTH_MODE=basic` 或 `disabled` 时 Dashboard 外观零变化（widget 隐藏）
- [ ] **真实 GitHub OAuth 端到端**：需要 client_id/secret，待用户提供

### Part 2 交付清单（已落地 ✓）

**后端**：

- [x] `cds/src/types.ts`：`Project` 新增 `dockerNetwork?: string` 字段
- [x] `cds/src/routes/projects.ts`：
  - `POST /api/projects` 接受 `{ name, slug?, description?, gitRepoUrl? }`，校验后生成 id + slug，调用 `docker network create cds-proj-<id>`（幂等：inspect 先于 create），调 `StateService.addProject()` 持久化；state 保存失败自动回滚已创建的网络
  - `DELETE /api/projects/:id` 拒绝 legacy 项目（403），调 `docker network rm` 再调 `StateService.removeProject()`；网络删除失败不阻塞 state 删除（best-effort 日志）
- [x] `cds/src/server.ts`：`createProjectsRouter` 新增 `shell` + `config` 依赖注入

**前端**：

- [x] `cds/web/projects.html`：新增 `.modal-backdrop` + `.modal-dialog` CSS；新增 `#createProjectModal` 创建对话框（name / slug / gitRepoUrl / description 四字段 + 内联错误展示）
- [x] `cds/web/projects.js`：
  - `openCreateProjectModal()` / `closeCreateProjectModal()` / `handleCreateProjectSubmit()`
  - POST 结果按状态分发：201 关闭 + toast + 刷新列表；4xx/5xx 内联错误
  - ESC 键关闭
  - 卡片 hover 显示 `.project-card-delete` 按钮（legacy 项目除外）
  - `handleDeleteProject()` 弹 `confirm()` 后 DELETE → toast + 刷新
  - 列表排序：legacy 项目永远排在第一位

**测试（9 条新增，340 → 362）**：

- [x] POST 成功路径：shell 被调用 inspect + create；state 持久化；后续 GET 返回 2 个项目
- [x] POST 显式 slug 校验
- [x] POST 空 name / 超长 name / 非法 slug 三档 400 验证
- [x] POST duplicate slug 409
- [x] POST docker 失败 500 + 不持久化（回滚证据）
- [x] POST 已存在网络的幂等路径（inspect=0 时跳过 create）
- [x] DELETE 成功：shell 被调用 rm；state 清理
- [x] DELETE legacy 项目 403
- [x] DELETE 未知 id 404
- [x] 测试辅助：`mockDockerNetworkHappyPath(shell)` 实现状态化网络 mock（跟踪 existing set）

### Part 3a 交付清单（已落地 ✓）

**后端**：

- [x] `cds/src/types.ts`：`BranchEntry` / `BuildProfile` / `InfraService` / `RoutingRule` 四个接口各加 `projectId?: string` 字段
- [x] `cds/src/services/state.ts`：
  - `migrateProjectScoping()` 私有方法：遍历所有 branches / build profiles / infra services / routing rules，缺失 projectId 的全部填 `'default'`
  - `load()` 流程尾部调用，idempotent（已有 projectId 的不动）
  - `addBranch / addBuildProfile / addInfraService / addRoutingRule` 在 projectId 为空时自动填 `'default'`，保证运行时数据的不变量：**每个 entry 必有 projectId**
  - 新增四个 read-only helpers：`getBranchesForProject(id)` / `getBuildProfilesForProject(id)` / `getInfraServicesForProject(id)` / `getRoutingRulesForProject(id)`，defensive fallback：缺 projectId 的 entry 按 'default' 对待

**测试（13 条新增，362 → 375）**：

- [x] `tests/services/state-project-scoping.test.ts`：迁移 + add*() 自动填充 + helpers 过滤 + defensive fallback

### Part 3b 交付清单（已落地 ✓）

**后端**：

- [x] `cds/src/routes/branches.ts`：
  - `GET /api/branches` 接受 `?project=<id>` 过滤分支列表
  - `GET /api/routing-rules` 同上（委托 `getRoutingRulesForProject`）
  - `GET /api/build-profiles` 同上
  - `GET /api/infra` 同上
  - `POST /api/branches` 接受 `projectId` 入参：缺失默认 `'default'`，校验项目存在（不存在返回 400），创建时 stamp 到 `BranchEntry`

**前端**：

- [x] `cds/web/app.js`：
  - 顶部常量 `CURRENT_PROJECT_ID` 从 `location.search` 读（默认 `'default'`）
  - `api()` helper 新增 `isProjectScopedPath()` 白名单 + 自动给 scoped GET 请求 append `?project=<id>`
  - 写请求（POST/PUT/PATCH/DELETE）不注入，避免影响现有单分支操作端点
  - `addBranch(name)` 在 POST body 里传 `projectId: CURRENT_PROJECT_ID`
  - `bootstrapCurrentProjectLabel()` 在 init 时从 `/api/projects/:id` 拉项目名填充 header 链接文案
- [x] `cds/web/index.html`：header "项目" 链接改为 `<span id="cdsCurrentProjectLabel">`，由 JS 动态填充项目名

**测试（3 条新增，375 → 378）**：

- [x] `tests/routes/branches.test.ts`：
  - `?project=default` / `?project=alt` / 无过滤 三种返回结果正确分离
  - POST unknown projectId → 400
  - POST default projectId → 201 + `branch.projectId === 'default'`

### P4 完成意义

- 用户可以从 `/projects.html` 看到所有项目（至少包含 legacy default）
- 点击 "+ New Project" 真正创建一个新项目（带独立 Docker 网络）
- 点击新项目卡片进入 `/index.html?project=<id>`，Dashboard 的分支/配置/基础设施全部按该项目过滤
- 在该项目里创建的分支自动被 stamp 上项目 id，不会和其他项目的分支混淆
- 切换项目只需回到 `/projects.html` 选另一张卡片
- 删除非 legacy 项目时 `docker network rm` + 清理 state
- **P4 这一大期宣告完成**，整个多项目能力已经端到端可用

### 风险

- **R1**：Docker 网络命名冲突 → 缓解：`docker network inspect` 前置检测
- **R2**：项目删除时没清干净容器 → 缓解：删除流程幂等 + `docker ps --filter label=cds-project=<id>` 双重确认
- **R3**：Service 层签名变更引入 bug → 缓解：逐个 service 改 + 全量单测回归

---

## 8. P5：团队 workspace + 成员同步

### 目标

支持多人协作场景：一个 team workspace 绑定到一个 GitHub Org，成员按 Org 成员关系自动同步，RBAC 三档（owner / member / viewer）。

### 前置依赖

- P4 完成，多项目创建已稳定
- GitHub OAuth 的 scope 包含 `read:org`

### 交付清单

**后端**：

- [ ] `workspaces-controller.ts`：`POST /api/workspaces` 支持创建 team workspace
  - 校验创建者是目标 GitHub Org 的 owner 或 member
  - 写入 `workspaces` 集合，`kind = 'team'`
  - 创建 `workspace_members` 记录（创建者为 owner）
- [ ] 新增 `cds/src/services/org-sync-service.ts`：定时从 GitHub `/orgs/:org/members` 拉取成员
  - 每 1 小时执行一次（cron 或 interval）
  - 新增成员：`workspace_members` 插入，`role = 'member'`，`syncSource = 'github-org'`
  - 移除成员：软删除 `workspace_members`
- [ ] 新增 `cds/src/middleware/rbac.ts`：按角色校验操作权限
- [ ] 所有写操作 API 加 RBAC 校验（创建分支、启停分支、改配置需 member+；删项目需 owner）

**前端**：

- [ ] `workspace-switcher.tsx` 下拉显示所有 workspace（个人 + 团队）
- [ ] 新增 "+ Create Team Workspace" 入口（在下拉框底部）
- [ ] 团队 workspace 下的项目卡片显示 "Team" badge
- [ ] 项目成员页：显示所有成员 + 角色 + 最近同步时间

### 验收标准

- [ ] 可创建团队 workspace 绑定到 GitHub Org
- [ ] GitHub Org 新成员加入后，1 小时内在 CDS 看到他
- [ ] GitHub Org 成员被移除后，1 小时内在 CDS 失去访问权限
- [ ] viewer 角色用户无法启停分支（403）
- [ ] owner 角色用户可删除项目，member 不能

### 回滚策略

- 隐藏 "+ Create Team Workspace" 入口
- 禁用 org-sync-service 定时器（环境变量开关）
- 已创建的 team workspace 仍可读，但不再同步成员

### 风险

- **R1**：GitHub Org 成员列表需要 `read:org` scope，之前授权的用户没授权过 → 缓解：强制重新登录以重新授权
- **R2**：同步频率过高触发限流 → 缓解：每 workspace 独立节流，避免集中打点

### 预估工作量

2-3 session。

---

## 9. P6：手动项目 + webhook + 自动部署

### 目标

支持"非 Git 仓库的项目"（如手动上传 Dockerfile 或 compose 的项目），以及真正的"自动部署"能力：GitHub push / PR 事件触发分支自动重建。

### 前置依赖

- P5 完成，团队协作已稳定
- GitHub App 或 webhook token 已配置

### 交付清单

**后端**：

- [ ] `projects` 集合新增字段：`kind = 'manual'`、`webhookSecret`、`autoDeployStrategy`
- [ ] `branches` 集合新增字段：`dirtyFlag`、`lastCommitSha`
- [ ] 新增 `cds/src/controllers/webhook-controller.ts`：`POST /api/webhooks/github`
  - 校验 `X-Hub-Signature-256`
  - 解析 push / pull_request 事件
  - 按 `autoDeployStrategy` 触发分支重建
- [ ] 新增 `cds/src/services/dirty-tracker.ts`：检测分支 Git HEAD 与 `lastCommitSha` 不一致时标记 dirty
- [ ] 新增"部署"动作：把 dirty 分支重建为"已部署"状态
- [ ] 创建手动项目时提供"自定义 compose"入口

**前端**：

- [ ] 项目创建对话框新增 "Manual Project" 选项
- [ ] 分支卡片显示 dirty badge（未部署的变更）
- [ ] 项目设置页新增 webhook URL 展示 + secret 管理

### 验收标准

- [ ] 可创建 manual 类型项目
- [ ] GitHub webhook 推送 `push` 事件后，匹配分支自动重建
- [ ] GitHub webhook 推送 `pull_request` 事件后创建新分支
- [ ] 分支 Git HEAD 与已部署 commit 不一致时显示 dirty
- [ ] 点 "Deploy" 按钮后 dirty 清除

### 回滚策略

- webhook endpoint 返回 503（不处理事件）
- 前端隐藏 Manual Project 入口和 dirty badge
- 已标记 dirty 的分支数据保留，手动启停仍正常

### 风险

- **R1**：webhook 签名校验漏洞 → 缓解：使用标准库 `crypto.timingSafeEqual`
- **R2**：自动部署陷入循环（部署后 Git 更新触发新部署）→ 缓解：部署完成后记录 `lastDeployedCommitSha`，与 webhook commit 比较

### 预估工作量

2-3 session。

---

## 10. 跨期验收矩阵

以下测试每期都要跑，确保前期成果不被后期破坏。

| 测试项 | P1 | P2 | P3 | P4 | P5 | P6 |
|---|---|---|---|---|---|---|
| 创建分支 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 启停分支 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 查看日志 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 修改 profile override | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 无登录裸跑 | ✅ | ❌(必须登录) | ❌ | ❌ | ❌ | ❌ |
| 读数据源 | state.json | state.json | P3a state.json / P3b mongo | mongo | mongo | mongo |
| 多项目创建 | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| 团队 workspace | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| webhook 触发 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

每期只专有测试项：

- **P1 专有**：`/projects` 路由存在 + legacy project 卡片显示
- **P2 专有**：OAuth 流程 + 首登自举 + `users`/`sessions` 集合
- **P3 专有**：一致性校验 + `CDS_STORAGE_MODE` 回滚
- **P4 专有**：多项目 Docker 网络隔离 + 删项目清容器
- **P5 专有**：GitHub Org 成员同步 + RBAC 三档
- **P6 专有**：webhook 签名校验 + dirty 标记

---

## 11. 风险对齐到期次

| 风险代号 | 描述 | 主要出现期 | 监控手段 |
|---|---|---|---|
| R1 | MongoDB 迁移期间双写不一致 | P3 | 一致性校验脚本每日运行 |
| R2 | GitHub API 限流 | P2, P5 | log 里记录 rate-limit-remaining |
| R3 | 单机 MongoDB 故障 | P2+ | healthcheck + alert |
| R4 | Docker 网络命名冲突 | P4 | 创建前 `docker network inspect` |
| R5 | 迁移导致老数据丢失 | P3 | 冷备份 + `--dry-run` 演练 |
| R6 | GitHub Org 白名单死锁 | P2 | `CDS_SUPERADMIN_EMAIL` 应急通道 |
| R7 | 前端改造与现有功能耦合 | P1, P4 | 外壳 wrapper 模式 |

