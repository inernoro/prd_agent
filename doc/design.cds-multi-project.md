# CDS 多项目架构设计

> **版本**：v0.1 | **日期**：2026-04-12 | **状态**：草案，待审
>
> 主设计稿。配套文档：
>
> - `doc/spec.cds-project-model.md` — 数据字典
> - `doc/plan.cds-multi-project-phases.md` — 7 期交付计划
> - `doc/rule.cds-mongo-migration.md` — 迁移与回滚规范
>
> **基线**：`doc/design.cds.md` v3.2（现有单项目架构）

## 一、管理摘要

- **解决什么问题**：CDS 目前一个实例只能托管一个代码仓库；想管理多项目必须起多实例，无多用户、无团队协作、无权限隔离
- **方案概述**：引入 User / Workspace / Project / Environment / Branch 五层模型；数据从 `state.json` 迁入 MongoDB；前端从"单页仪表盘"升级为"项目列表 → 项目详情"两层 SPA；身份认证走 GitHub OAuth + Org 白名单
- **业务价值**：单实例可托管多仓库、多团队协作、个人/团队 workspace 隔离；为未来 PaaS 化（真正的"部署"而非仅"调试"）奠定基础
- **影响范围**：CDS 内部全部模块；对主业务 prd-agent 零侵入（CDS 是独立模块）
- **预计风险**：中 — 涉及数据迁移 + 认证引入 + 路由改造；采取 7 期渐进式交付，每期独立可回滚

---

## 二、产品定位

### 从"单租户调试工具"到"多项目 PaaS 前身"

**现在**：

```
CDS = 1 个 Dashboard 托管 1 个 Git 仓库的多分支预览环境
     ↑ 单机运行，无登录，所有数据在 state.json
```

**目标**：

```
CDS = 1 个实例托管 N 个项目的 Git 预览环境
     ↑ GitHub 登录 + 组织白名单
     ↑ 个人 / 团队 workspace 隔离
     ↑ 数据在 MongoDB
     ↑ 每项目独立 Docker 网络
     ↑ 为真正"部署"（production environment）铺路
```

### 三大设计原则

1. **外表先变，内部渐进**：先让用户看到"我的项目"列表页面，内部逻辑通过"默认项目"壳兼容；再分期替换内部（数据层、认证、多项目隔离）。避免"一次性重构、中间不可用"。
2. **MongoDB 优先**：放弃 `state.json` 的 JSON 文件模式，直接走 MongoDB（复用 CDS 自带的 infra mongo 容器），避免后续再迁一次。文档数据库的灵活 schema 也方便后续迭代。
3. **GitHub 原生身份**：用 GitHub OAuth + Org 白名单做权限，团队关系复用 GitHub Org 成员关系，不重复维护自建团队库。

### 和现有 CDS（v3.2）的差异

| 维度 | CDS v3.2（现在） | CDS v4（本设计） |
|---|---|---|
| 租户模型 | 单租户 | 多项目 / 多 workspace |
| 认证 | 无 | GitHub OAuth + Org 白名单 |
| 数据存储 | `state.json` + 滚动备份 | MongoDB 扁平化集合 |
| 首页 | 分支列表 | **项目列表** → 进入后才是分支列表 |
| Docker 网络 | 单个共享网络 | 每个项目独立网络 |
| 预览域名 | `<slug>.<rootDomain>` | `<slug>.<rootDomain>`（阶段 1-6 保持）；分支名全局唯一 |

---

## 三、用户场景

### Persona 1：个人开发者

- 用自己的个人 workspace，托管 2-3 个开源项目
- 每个项目独立的 branches / environments / 预览 URL
- 身份：GitHub 登录，workspace = `{login}-personal`

### Persona 2：小团队（2-5 人）

- 共享一个 team workspace，绑定到一个 GitHub Org
- 团队里每个项目可以被任一成员启停分支
- 身份：所有成员都是 GitHub Org member，workspace = `{org-name}`

### Persona 3：中型团队（多项目 + 多环境）

- 一个 team workspace 下 5-10 个项目
- 每个项目有 preview（每 PR 一个）/ staging / production 三个环境
- 需要部分权限：实习生只能操作 preview 环境，不能动 production

---

## 四、核心概念（五层模型）

```
User ──┬── 成员身份 ──┬── 个人 Workspace ──┬── Project A
       │              │                      │      ├── Environment: preview
       │              │                      │      │      ├── Branch: feat-login
       │              │                      │      │      └── Branch: feat-pay
       │              │                      │      ├── Environment: staging
       │              │                      │      └── Environment: production
       │              │                      └── Project B
       │              │
       │              └── Team Workspace ──── Project C, D, E
       │                  (= GitHub Org)         └── ...
```

### 层定义

| 层 | 作用 | 数据隔离边界 | MongoDB 集合 |
|---|---|---|---|
| **User** | 登录身份，GitHub 用户 | 全局共享 | `users` |
| **Workspace** | 项目归属容器（个人或团队） | workspace 级 | `workspaces` + `workspace_members` |
| **Project** | 一个 Git 仓库的 CDS 承载 | project 级（docker network + mongo filter） | `projects` |
| **Environment** | 项目内分支的集合（preview/staging/prod） | env 级（逻辑分组，非物理） | `environments` |
| **Branch** | 一个 Git 分支对应的容器集合 | branch 级（现有语义） | `branches` + 相关 |

### 概念保留

v4 保留 v3.2 的以下概念，只在它们上面加 `projectId`（及 `environmentId`）索引：

- **BuildProfile**：每分支独立的应用服务（用户填代码、CDS 构建）
- **InfraService**：项目共享的基础设施（MongoDB / Redis 等）
- **BranchEntry.profileOverrides**：分支级配置覆盖（P6 中已交付）
- **BranchEntry.subdomainAliases**：分支级子域名别名（P6 中已交付）
- **RoutingRule**：Header / Domain / Pattern 路由
- **DeployMode**：app 服务的部署模式（dev/static 等）

### 概念新增

- **Project**：项目实体。一个 Git 仓库或一组手动配置的服务
- **Environment**：项目内的环境层，例如 `preview` / `staging` / `production`。v4 里每个项目至少有一个 `default` environment；后续扩展
- **Workspace**：项目归属容器。`kind` 为 `personal` 或 `team`
- **Membership**：User × Workspace 的关系，含角色 `owner` / `member` / `viewer`

---

## 五、架构图

```
┌───────────────────────────────────────────────────────┐
│   Browser                                              │
│   ├── /login             (GitHub OAuth)                │
│   ├── /projects          (project list SPA view)       │
│   └── /projects/:pid     (existing dashboard, scoped)  │
└────────────────────────┬──────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────┐
│   CDS Master (port 9900)                                │
│   ├── Auth middleware (session cookie → user)           │
│   ├── Project routing middleware (:pid → scope filter)  │
│   └── Existing branches/proxy API (projectId-aware)     │
└─────┬───────────────┬───────────────┬──────────────────┘
      │               │               │
┌─────▼─────┐  ┌──────▼──────┐  ┌────▼─────────────┐
│ MongoDB   │  │ Docker      │  │ Proxy Service    │
│ (10 coll) │  │ Networks    │  │ (path-based +    │
│           │  │ cds-proj-A  │  │  subdomain-based)│
│           │  │ cds-proj-B  │  │                  │
│           │  │ ...         │  │                  │
└───────────┘  └─────────────┘  └──────────────────┘
```

### API 路径演进

| 旧 v3.2 路径 | 新 v4 路径 | 说明 |
|---|---|---|
| `GET /api/branches` | `GET /api/projects/:pid/branches` | 所有 branch API 加 projectId 前缀 |
| `GET /api/build-profiles` | `GET /api/projects/:pid/build-profiles` | 同上 |
| `GET /api/infra-services` | `GET /api/projects/:pid/infra-services` | 同上 |
| `GET /api/routing-rules` | `GET /api/projects/:pid/routing-rules` | 同上 |
| `PUT /api/branches/:id/profile-overrides/:profileId` | `PUT /api/projects/:pid/branches/:id/profile-overrides/:profileId` | 同上 |
| （新增） | `GET /api/projects` | 列出当前用户可见的所有项目 |
| （新增） | `POST /api/projects` | 创建项目 |
| （新增） | `GET /api/projects/:pid` | 项目详情（含统计） |
| （新增） | `GET /api/workspaces` | 当前用户所属的 workspace 列表 |
| （新增） | `POST /api/workspaces` | 创建团队 workspace |
| （新增） | `GET /api/me` | 当前登录用户 |
| （新增） | `POST /api/auth/github/login` | 启动 GitHub OAuth 流程 |
| （新增） | `GET /api/auth/github/callback` | OAuth 回调 |
| （新增） | `POST /api/auth/logout` | 登出 |

### 向后兼容策略

P1 阶段（外壳先变）旧 API 路径仍然可用，通过一个 **implicit project resolver** 中间件：

- 旧路径 `GET /api/branches` → 中间件自动填充 `projectId = "default"`（唯一已存在的项目）
- 前端调用旧路径时不需要任何改动
- 等 P4 真正多项目上线时，同步前端切到 `/api/projects/:pid/branches` 新路径

---

## 六、数据模型（MongoDB 扁平化）

详细字段定义见 `doc/spec.cds-project-model.md`。这里列集合总表：

### 集合清单

| 集合 | 主键 | 关键索引 | 估算规模 |
|---|---|---|---|
| `users` | `_id`（UUID） | `githubId`（唯一）, `email` | 10-100 |
| `workspaces` | `_id` | `slug`（唯一）, `kind`, `githubOrgLogin` | 10-50 |
| `workspace_members` | `_id` | 复合 `(workspaceId, userId)` 唯一 | 20-500 |
| `projects` | `_id` | `workspaceId`, 复合 `(workspaceId, slug)` 唯一 | 10-200 |
| `environments` | `_id` | 复合 `(projectId, name)` 唯一 | 30-600 |
| `branches` | `_id` | 复合 `(projectId, id)`，`status`，`heatState` | 100-5000 |
| `build_profiles` | `_id` | 复合 `(projectId, id)` 唯一 | 40-1000 |
| `infra_services` | `_id` | 复合 `(projectId, id)` 唯一 | 20-500 |
| `routing_rules` | `_id` | `projectId`, `priority` | 20-500 |
| `sessions` | `_id`（token） | `userId`, TTL index on `expiresAt` | 活跃用户数 |

### 扁平 vs 嵌套的选择

**选扁平**的理由：

- **MongoDB 文档 16MB 硬上限**：一个项目 300 分支 × 每分支 10 个 override = 3000 子文档嵌套，接近上限
- **写入并发**：分支状态变化（running / error）频繁，嵌套时每次都要 `$set` 整个项目文档，锁粒度过粗
- **查询灵活**：`findBranchByAlias` 这种跨分支查询在扁平模型下一次索引扫描即可，嵌套模型要遍历所有项目文档
- **便于 backup**：按集合导出比嵌套文档导出更标准化

**代价**：

- 需要在每次查询里加 `projectId` filter（中间件统一处理，不散在业务代码）
- 读一个项目的完整视图需要多次查询（可以用 `$lookup` 或应用层合并）

---

## 七、认证设计

### GitHub OAuth + Org 白名单

新增 `.cds.env` 变量：

```
CDS_AUTH_MODE=github             # github | disabled（disabled 仅用于本地开发）
CDS_GITHUB_CLIENT_ID=<your-oauth-app-client-id>
CDS_GITHUB_CLIENT_SECRET=<your-oauth-app-secret>
CDS_ALLOWED_ORGS=inernoro,miduo  # 逗号分隔，不在此列表的用户拒绝登录
CDS_SUPERADMIN_EMAIL=admin@...   # 应急通道，OAuth 失效时可用
```

### 登录流程

```
1. 用户访问 CDS → middleware 检测到未登录 → 302 到 /login
2. /login 展示"使用 GitHub 登录"按钮
3. 跳转到 https://github.com/login/oauth/authorize
     ?client_id=...
     &scope=read:user,read:org
     &state=<csrf-token>
4. GitHub 回调 /api/auth/github/callback?code=...&state=...
5. CDS 校验 state（防 CSRF）
6. 用 code 换 access_token
7. 拉 GitHub /user 和 /user/orgs
8. 校验 /user/orgs 至少一项在 CDS_ALLOWED_ORGS 里，否则 403
9. upsert 到 users 集合（下次登录直接更新 avatar / orgs）
10. 创建 session：写入 sessions 集合（MongoDB TTL = 30 天）
11. Set-Cookie: cds_session=<token>; HttpOnly; Secure; SameSite=Lax
12. 302 回首页
```

### 首登自举

首次启动时 `users` 集合为空。第一个 OAuth 成功的用户（前提：`orgs` 与 `CDS_ALLOWED_ORGS` 有交集）自动变成 **system owner**，并触发：

1. 创建个人 Workspace：`{login}-personal`，owner = 该用户
2. 把之前由 P1 阶段自动创建的 **Legacy Project**（名称 `prd_agent`）从 System Workspace 转交给这个新建的个人 Workspace
3. 发送 toast："欢迎 @{login}，已为你创建个人空间并迁移现有项目"

后续登录的用户只创建个人 Workspace，不做转交。

### Org 成员关系的更新

- 登录时的 `/user/orgs` 结果存在 `users.orgs` 字段，作为当时的快照
- 中间件每次请求检查 session，session 里带 `orgsCheckedAt` 时间戳
- 超过 1 小时未校验则后台异步刷新一次 orgs（避免每次都打 GitHub API）
- 如果用户被踢出所有 `CDS_ALLOWED_ORGS`，下次访问时 session 失效，强制重新登录并拒绝

---

## 八、迁移策略概要

详见 `doc/rule.cds-mongo-migration.md`。简要三阶段：

```
P3a: Dual-write
  - 新代码同时写入 state.json 和 MongoDB
  - 读仍走 state.json（MongoDB 只写不读）
  - 每次 save 后对比两边一致性，不一致则告警
  - 持续 3-7 天

P3b: Read-from-mongo
  - 读切到 MongoDB
  - 写仍然双写
  - state.json 作为热备份
  - 持续 3-7 天

P3c: Stop dual-write
  - 关闭 state.json 写入
  - 重命名 state.json → state.json.legacy-YYYYMMDD
  - 保留 state.json.bak.* 作为冷备份
```

任何阶段都可通过 `.cds.env` 的 `CDS_STORAGE_MODE=json|mongo` 快速回滚。

---

## 九、7 期实施路线图（概要）

详见 `doc/plan.cds-multi-project-phases.md`。

| 期 | 交付 | 用户可见变化 | 内部变化 |
|---|---|---|---|
| **P0** | 4 份设计文档 | 无 | 无，只画图纸 |
| **P1** | 项目列表外壳 | 首页变成项目列表（里面只有 1 个"默认项目"卡） + 左上角 workspace/project 下拉（单项）+ "+ New Project" 按钮点击提示"即将上线" | 零 — 所有 API 仍走老 state.json，中间件用 `projectId = "default"` 兼容旧路径 |
| **P2** | GitHub OAuth + Org 白名单 + 首登自举 | 必须登录才能访问 | 新增 `users`/`sessions` 集合（MongoDB 先进场） + 认证中间件 |
| **P3** | MongoDB 数据层迁移（state.json → mongo） | 无感 | 后台三阶段切换：dual-write → read-from-mongo → cleanup |
| **P4** | 多项目真落地 | "+ New Project" 真的能建第二个项目 | 每项目独立 docker network + mongo 查询全部带 projectId filter |
| **P5** | Team workspace + GitHub Org 绑定 + 成员邀请 | 可以创建团队 workspace，成员按 Org 同步 | `workspaces` + `workspace_members` + RBAC 中间件 |
| **P6** | 手动项目 + dirty 标记 + webhook + 自动部署策略 | "部署"真正派上用场 | webhook endpoint + branch dirty tracking + redeploy 策略 |

---

## 十、风险与权衡

### R1: MongoDB 迁移期间双写导致数据不一致

- **影响**：中
- **缓解**：P3a 跑 3-7 天，每次 save 后对比 mongo 和 state.json，不一致则 log 告警
- **回滚**：任何阶段都可通过 `CDS_STORAGE_MODE` 回到纯 state.json 模式

### R2: GitHub API 限流

- **影响**：低（`/user/orgs` 未登录每分钟 60 次，登录后 5000 次/小时）
- **缓解**：session 长效 30 天 + org 成员关系缓存 1 小时；避免每次请求都查 GitHub

### R3: 单机 MongoDB 故障

- **影响**：高 — CDS 整体不可用
- **缓解**：P3 迁移完成后保留 state.json 热备 2 周；mongo 故障时可临时切回 JSON 模式（需一次数据同步）
- **长期**：考虑 MongoDB replica set（超出本期范围）

### R4: 多项目 Docker 网络命名冲突

- **影响**：中 — 创建 project 时 `docker network create` 失败
- **缓解**：网络命名规则 `cds-proj-<projectId-前8位>`，创建前 `docker network inspect` 检测存在即复用

### R5: 迁移导致老数据丢失

- **影响**：高
- **缓解**：
  - 迁移前自动 `state.json → state.json.premigration-YYYYMMDD.bak` 冷备份
  - P3 上线前必须用真实生产 state.json 在本地演练一次
  - 迁移脚本带 `--dry-run` 模式

### R6: GitHub Org 白名单的"死锁"

- **影响**：中 — 如果管理员把自己从 Org 移除，所有人都登不进去
- **缓解**：`CDS_SUPERADMIN_EMAIL` 应急通道；OAuth 失败时仍可用该邮箱 + 短期 token 登录

### R7: v4 前端改造与现有 CDS 功能的耦合

- **影响**：中
- **缓解**：P1 外壳阶段前端不动核心 dashboard，只加一个外层 wrapper（项目列表 → dashboard 的两层路由）
- **原因**：避免"功能兼容两次"的维护成本

---

## 十一、非目标（本次不做的）

- **跨 CDS 实例的项目同步**（多 CDS 节点间数据一致性）
- **细粒度 RBAC**（role/permission 矩阵，只做 owner/member/viewer 三档）
- **SSO 以外的认证**（SAML / OIDC 企业 SSO 不做）
- **项目计费与配额**（暂时按信任模式运行）
- **K8s / 多机生产部署**（CDS 的定位仍是小团队单机 PaaS）
- **GitLab / Bitbucket 支持**（只支持 GitHub，其他 git 源等有人要再加）
- **移动端 UI**（Dashboard 继续桌面优先）

---

## 十二、关联文档

- `doc/spec.cds-project-model.md` — 数据字典（User / Workspace / Project / Environment 全字段表 + 索引）
- `doc/plan.cds-multi-project-phases.md` — 7 期详细交付计划 + 每期验收标准
- `doc/rule.cds-mongo-migration.md` — state.json → MongoDB 迁移与回滚操作规范
- `doc/design.cds.md` — 现有 v3.2 单项目架构（本文档的基线，仍然有效直到 P4）
- `doc/design.cds-resilience.md` — 温池 / 集群调度（P4 后需与 project 层集成）
- `doc/design.cds-onboarding.md` — 一键导入配置（P4 中需扩展支持多项目）
- `doc/design.cds-data-migration.md` — CDS 数据迁移（P3 时需同步思路）

---

## 附录 A：术语表

| 术语 | 含义 |
|---|---|
| Workspace | 项目归属容器，可以是个人或团队 |
| Project | 一个 Git 仓库或手动项目在 CDS 中的表示 |
| Environment | 项目内的一组分支的逻辑集合（preview/staging/production） |
| Branch | 一个 Git 分支对应的容器集合（现有概念） |
| BuildProfile | 每分支独立的应用服务定义（现有概念） |
| InfraService | 项目共享的基础设施服务（现有概念） |
| Legacy Project | P1 阶段为现有数据自动创建的默认项目，名为 `prd_agent` |
| System Workspace | 首登自举前 Legacy Project 的临时归属 |
| 首登自举 | 第一个 OAuth 成功的用户自动成为 system owner 的流程 |
