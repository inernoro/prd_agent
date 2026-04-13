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

## 5. P2：GitHub OAuth + Org 白名单

### 目标

让 CDS 从"无登录裸跑"变成"必须 GitHub 登录 + Org 校验"。

同时第一次让 MongoDB 进场——只新增 `users` 和 `sessions` 两个集合，不触碰 state.json 的业务数据。为 P3 大迁移铺路。

### 前置依赖

- P1 完成，`/projects` 已成为首屏
- GitHub OAuth App 已申请，拿到 client_id / client_secret
- CDS 容器里的 MongoDB 可用（P1 未启用，P2 首次使用）

### 交付清单

**配置**：

- [ ] `.cds.env` 新增：`CDS_AUTH_MODE`、`CDS_GITHUB_CLIENT_ID`、`CDS_GITHUB_CLIENT_SECRET`、`CDS_ALLOWED_ORGS`、`CDS_SUPERADMIN_EMAIL`
- [ ] `cds/exec_cds.sh init` 向导新增 OAuth 字段收集

**后端**：

- [ ] 新增 `cds/src/infra/mongo/client.ts`：MongoDB 连接封装
- [ ] 新增 `cds/src/infra/mongo/collections.ts`：集合注册表（先注册 users、sessions）
- [ ] 新增 `cds/src/domain/user.ts`、`cds/src/domain/session.ts`：实体类型
- [ ] 新增 `cds/src/services/auth-service.ts`：OAuth 流程
- [ ] 新增 `cds/src/controllers/auth-controller.ts`：`/api/auth/github/login`、`/api/auth/github/callback`、`/api/auth/logout`、`/api/me`
- [ ] 新增 `cds/src/middleware/auth.ts`：session 校验 + orgs 刷新
- [ ] 新增 `cds/src/services/bootstrap-service.ts`：首登自举（创建 system owner 的 workspace + 转交 legacy project）

**前端**：

- [ ] 新增 `cds/web/src/pages/login.tsx`：登录页
- [ ] 改造 `App.tsx`：未登录时路由到 `/login`
- [ ] 顶部导航栏显示用户头像 + 登出按钮

### 验收标准

- [ ] 未登录访问 CDS 302 到 `/login`
- [ ] 点击 "Login with GitHub" 跳转到 github.com 授权页
- [ ] 授权后回调成功，进入 `/projects`
- [ ] `users` 集合里有一条记录
- [ ] `sessions` 集合里有一条记录，`expiresAt` 为 30 天后
- [ ] 被移出 `CDS_ALLOWED_ORGS` 后刷新页面被踢回 `/login`
- [ ] 首登用户自动成为 system owner，legacy project 从 System Workspace 转到其个人 workspace
- [ ] `CDS_AUTH_MODE=disabled` 时所有认证中间件直通（本地开发兼容）

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

## 6. P3：MongoDB 数据层迁移

### 目标

把 `state.json` 承载的所有业务数据迁到 MongoDB。**这是整个 v4 里风险最大的一期**。

采用三阶段双写策略（详见 `doc/rule.cds-mongo-migration.md`），任何阶段都可通过 `CDS_STORAGE_MODE` 回滚。

### 前置依赖

- P2 完成，users / sessions 集合已在 MongoDB 稳定运行 ≥ 3 天
- `state.json` 做过完整冷备份 `state.json.premigration-YYYYMMDD.bak`
- 准备好停机窗口（至少 30 分钟，用于 P3c 切换）

### 交付清单

**配置**：

- [ ] `.cds.env` 新增 `CDS_STORAGE_MODE`（`json` / `dual` / `mongo`）
- [ ] 默认值：P3a 阶段设为 `dual`，P3b 也是 `dual`（读切换通过单独的 `CDS_STORAGE_READ_FROM` 控制），P3c 设为 `mongo`

**后端**：

- [ ] 新增 `cds/src/infra/storage/storage-adapter.ts`：抽象 Storage 接口
- [ ] 新增 `cds/src/infra/storage/json-storage.ts`：现有 JSON 实现封装
- [ ] 新增 `cds/src/infra/storage/mongo-storage.ts`：MongoDB 实现（8 个集合：projects / environments / branches / build_profiles / infra_services / routing_rules + 已有 users / sessions）
- [ ] 新增 `cds/src/infra/storage/dual-write-storage.ts`：双写 + 一致性校验
- [ ] 改造所有 Service 层：从直接操作 `stateStore` 改为通过 `storageAdapter`
- [ ] 新增 `cds/scripts/migrate-state-to-mongo.ts`：一次性迁移脚本（支持 `--dry-run`）
- [ ] 新增 `cds/scripts/verify-state-consistency.ts`：对比 state.json 和 mongo 一致性的工具
- [ ] P3c 阶段：新增 `cds/scripts/seal-state-json.ts`：重命名 state.json 为 legacy

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

## 7. P4：多项目真落地

### 目标

让"+ New Project"按钮从 P1 的"coming soon"变成真正可用。用户可以在一个 CDS 实例里创建第二个、第三个项目，每个项目有独立的 Docker 网络、独立的 branches / profiles / infra / routing。

### 前置依赖

- P3 完成，所有业务数据已在 MongoDB
- 所有 Service 层查询都带 `projectId` filter（通过中间件统一注入）

### 交付清单

**后端**：

- [ ] `projects-controller.ts` 把 `POST /api/projects` 从 501 改为真实创建
- [ ] 创建项目时：
  - 生成 UUID _id
  - 计算 `dockerNetwork = cds-proj-<id 前 8 位>`
  - 调 `docker network create`（幂等）
  - 写入 `projects` 集合
  - 自动创建两个 environment（default + production）
  - `workspaces.projectCount` +1
- [ ] 新增 `projects-controller.ts` 的 `DELETE /api/projects/:pid`：软删除 + 停止所有关联容器 + 删除 docker network
- [ ] `implicit-project` 中间件去掉，所有旧 API 路径强制使用 `/api/projects/:pid/...`
- [ ] 所有 Service 层方法签名加 `projectId` 参数，所有 mongo 查询带 `{ projectId }` filter
- [ ] 新增 `cds/src/middleware/project-scope.ts`：从 URL `:pid` 读 projectId，校验用户权限后注入 `req.project`

**前端**：

- [ ] `projects-list.tsx` 的 "+ New Project" 按钮打开创建对话框（名称 / Git URL / 默认分支 / 描述）
- [ ] 创建成功后跳转到 `/projects/<new-id>`
- [ ] 项目卡片显示分支数、infra 数、最近活跃时间
- [ ] 项目详情页标题变为 `{workspace.name} / {project.name}`
- [ ] 所有 API 调用改为 `/api/projects/:pid/...` 前缀

### 验收标准

- [ ] 可创建第二个项目，拿到独立 docker network
- [ ] 项目 A 的分支和项目 B 的分支完全隔离（list API 不会串）
- [ ] 删除项目 A 不影响项目 B
- [ ] 同一个 branch name 在两个项目里可以并存（因为 slug 只在项目内唯一）
- [ ] P1 创建的 legacy project 仍然正常运行
- [ ] 旧前端代码（仍用旧 API 路径）彻底被替换

### 回滚策略

- **前端回滚**：隐藏 "+ New Project" 按钮（改回 toast "coming soon"）
- **后端回滚**：`POST /api/projects` 改回 501
- 已创建的多项目数据**不删除**，后续修复后可继续使用

### 风险

- **R1**：Docker 网络命名冲突 → 缓解：`docker network inspect` 前置检测
- **R2**：项目删除时没清干净容器 → 缓解：删除流程幂等 + `docker ps --filter label=cds-project=<id>` 双重确认
- **R3**：所有 Service 层签名变更引入 bug → 缓解：逐个 service 加 projectId 参数 + 全量单测回归

### 预估工作量

3-4 session。

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

