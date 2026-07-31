# CDS 多项目数据字典 · 规格

> **版本**：v0.1 | **日期**：2026-04-12 | **状态**：已落地

**一句话**：云开发套件多项目版的数据字典：十个集合各存什么、字段什么含义、约束与索引意图。
**谁该读**：写数据访问代码的后端工程师；照表建索引的数据库管理员。
**读完能做什么**：按字段表实现读写逻辑，并按索引意图表建立正确的约束与索引。

---

> 本文档定义 CDS v4 引入的 10 个 MongoDB 集合的完整字段表、约束、索引与关系。
> **受众**：后端工程师（写 Mongoose / Mongo 原生 schema 时直接参照），DBA（对照索引汇总建索引）。
> **文档导航**：
> - 主设计稿：[doc/design.cds.multi-project.md](./design.cds.multi-project.md)
> - 7 期交付计划：[doc/plan.cds.multi-project-phases.md](./plan.cds.multi-project-phases.md)
> - 迁移规范：[doc/rule.cds.mongo-migration.md](./rule.cds.mongo-migration.md)


## 1. 集合清单

| # | 集合 | 主键 | 一句话定位 |
|---|---|---|---|
| 1 | `users` | `_id`（UUID） | 登录身份，GitHub 用户档案 |
| 2 | `sessions` | `_id`（token） | 登录会话，带 TTL 过期 |
| 3 | `workspaces` | `_id`（UUID） | 项目归属容器（个人 / 团队） |
| 4 | `workspace_members` | `_id`（UUID） | User × Workspace 成员关系 |
| 5 | `projects` | `_id`（UUID） | 一个 Git 仓库的 CDS 承载 |
| 6 | `environments` | `_id`（UUID） | 项目内环境分层（preview/staging/prod） |
| 7 | `branches` | `_id`（UUID） | 一条 Git 分支对应的容器集合 |
| 8 | `build_profiles` | `_id`（UUID） | 每分支独立的应用服务定义 |
| 9 | `infra_services` | `_id`（UUID） | 项目共享的基础设施服务 |
| 10 | `routing_rules` | `_id`（UUID） | Header/Domain/Pattern 请求分发规则 |

---

## 2. 字段命名约定

- **ID 类型**：所有 `_id` 使用 UUID v4 字符串（32 hex，无连字符），除 `sessions._id` 为 64-char URL-safe token
- **命名风格**：camelCase（如 `createdAt`、`githubOrgLogin`）
- **时间戳**：全部用 ISO 8601 UTC 字符串（如 `2026-04-12T09:30:00Z`），不用 Unix 毫秒
- **外键引用**：字段名 = `<被引用实体>Id`（如 `workspaceId`、`projectId`）
- **布尔**：正向命名（`isActive`、`isPublic`，避免 `isNotActive`）
- **软删除**：统一用 `deletedAt` 字段（null = 未删除），禁止物理删除业务数据
- **必填**：schema 用 `required: true` 显式声明，禁止运行时填默认值

---

## 3. users 集合

登录身份，来自 GitHub OAuth。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4（CDS 内部 ID，与 GitHub ID 解耦） |
| `githubId` | number | 是 | unique | GitHub 数字 ID（来自 `/user` 接口） |
| `githubLogin` | string | 是 | — | GitHub 用户名（可变，用 `githubId` 作为稳定 key） |
| `email` | string | — | sparse | GitHub primary email，可能为空 |
| `name` | string | — | — | 显示名 |
| `avatarUrl` | string | — | — | 头像 URL |
| `orgs` | string[] | 是 | — | 最近一次登录时的 GitHub Org 列表快照 |
| `orgsCheckedAt` | string | 是 | — | orgs 快照时间戳 |
| `isSystemOwner` | boolean | — | — | 是否为首登用户（系统所有者） |
| `status` | enum | 是 | — | `active` \| `disabled`（被踢出 Allowed Orgs 时） |
| `lastLoginAt` | string | — | — | 最近登录时间 |
| `createdAt` | string | 是 | — | 首次注册时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除标记 |

**索引**：

```
{ githubId: 1 }                                unique
{ email: 1 }                                   sparse
{ status: 1, deletedAt: 1 }                    查找活跃用户
```

---

## 4. sessions 集合

登录会话，带 MongoDB TTL 自动过期。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | 64-char URL-safe token（crypto.randomBytes(48).toString('base64url')） |
| `userId` | string | 是 | — | 指向 `users._id` |
| `createdAt` | string | 是 | — | 会话创建时间 |
| `expiresAt` | Date | 是 | TTL | MongoDB TTL 字段，到期自动删除 |
| `lastSeenAt` | string | 是 | — | 最近一次请求时间 |
| `orgsCheckedAt` | string | 是 | — | 用于"超过 1 小时刷新 orgs"的判定 |
| `userAgent` | string | — | — | User-Agent 快照 |
| `ipAddress` | string | — | — | 登录时 IP（审计用） |

**索引**：

```
{ userId: 1 }                                  查用户的所有会话
{ expiresAt: 1 }                               TTL index（expireAfterSeconds: 0）
```

**TTL 说明**：写入时 `expiresAt = now + 30d`。MongoDB 后台每 60 秒扫描一次，到期文档自动删除，无需应用端清理。

---

## 5. workspaces 集合

项目归属容器。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `slug` | string | 是 | unique | URL 友好的唯一标识（如 `alice-personal`、`inernoro`） |
| `name` | string | 是 | — | 显示名（如 `Alice 的个人空间`、`Inernoro 团队`） |
| `kind` | enum | 是 | — | `personal` \| `team` |
| `ownerId` | string | 是 | — | 指向 `users._id`，workspace 所有者 |
| `githubOrgLogin` | string | — | sparse | team 类型时对应的 GitHub Org login |
| `githubOrgId` | number | — | sparse | GitHub Org 数字 ID |
| `description` | string | — | — | 可选描述 |
| `projectCount` | number | 是 | — | 当前项目数（冗余字段，删项目时 -1） |
| `createdAt` | string | 是 | — | 创建时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除标记 |

**索引**：

```
{ slug: 1 }                                    unique
{ kind: 1, ownerId: 1 }                        查某用户的个人空间
{ githubOrgLogin: 1 }                          sparse，team 类型专用
```

**约束**：

- `kind == 'personal'` 时：`githubOrgLogin` 必须为空，`ownerId` = 对应 user
- `kind == 'team'` 时：`githubOrgLogin` 必须非空，`ownerId` = 创建者
- `slug` 首登自举时为 `{login}-personal`；团队时建议 `{org-login}`

---

## 6. workspace_members 集合

User × Workspace 的成员关系表。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `workspaceId` | string | 是 | — | 指向 `workspaces._id` |
| `userId` | string | 是 | — | 指向 `users._id` |
| `role` | enum | 是 | — | `owner` \| `member` \| `viewer` |
| `invitedBy` | string | — | — | 邀请人 userId（首登自举时为 null） |
| `joinedAt` | string | 是 | — | 加入时间 |
| `lastSyncedAt` | string | — | — | team 类型从 GitHub Org 同步成员的最近时间 |
| `syncSource` | enum | — | — | `manual` \| `github-org`（如何加入的） |
| `deletedAt` | string \| null | — | — | 软删除（退出 workspace） |

**索引**：

```
{ workspaceId: 1, userId: 1 }                  unique，防止重复加入
{ userId: 1 }                                  查用户所属的所有 workspace
{ workspaceId: 1, role: 1 }                    查 workspace 里某角色的成员
```

**角色定义**：

| 角色 | 读 | 写分支 | 写配置 | 删项目 | 管成员 |
|---|---|---|---|---|---|
| `owner` | 是 | 是 | 是 | 是 | 是 |
| `member` | 是 | 是 | 是 | 否 | 否 |
| `viewer` | 是 | 否 | 否 | 否 | 否 |

---

## 7. projects 集合

一个 Git 仓库在 CDS 中的表示。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `workspaceId` | string | 是 | — | 指向 `workspaces._id` |
| `slug` | string | 是 | — | workspace 内唯一（如 `prd-agent`） |
| `name` | string | 是 | — | 显示名（如 `PRD Agent`） |
| `description` | string | — | — | 可选描述 |
| `kind` | enum | 是 | — | `git` \| `manual`（P6 增加 manual） |
| `gitRepoUrl` | string | — | — | Git 仓库 URL（`git` kind 必填） |
| `gitDefaultBranch` | string | — | — | 默认分支（如 `main`），从 `gitRepoUrl` clone 时使用 |
| `dockerNetwork` | string | 是 | — | 独立 Docker 网络名（`cds-proj-<id 前 8 位>`） |
| `subdomainPrefix` | string | — | — | 项目级域名前缀（如 `prdagent`），可选 |
| `webhookSecret` | string | — | — | GitHub webhook 密钥（P6 加入） |
| `autoDeployStrategy` | enum | — | — | `manual` \| `on-push` \| `on-pr`（P6） |
| `branchCount` | number | 是 | — | 冗余：分支数（运行时维护） |
| `legacyFlag` | boolean | — | — | 是否为 P1 外壳阶段创建的"默认项目" |
| `createdBy` | string | 是 | — | 创建者 userId |
| `createdAt` | string | 是 | — | 创建时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除标记 |

**索引**：

```
{ workspaceId: 1, slug: 1 }                    unique（workspace 内 slug 唯一）
{ workspaceId: 1, deletedAt: 1 }               列表查询
{ dockerNetwork: 1 }                           unique（全局唯一，防止复用）
```

**约束**：

- `kind == 'git'` 时 `gitRepoUrl` 必填
- `dockerNetwork` 命名规则：`cds-proj-<_id 前 8 位>`，创建前必须 `docker network inspect` 检测不存在
- `legacyFlag == true` 的项目由 P1 自动创建，不允许用户删除

---

## 8. environments 集合

项目内的环境分层，每个 env 是一组分支的逻辑集合。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `projectId` | string | 是 | — | 指向 `projects._id` |
| `name` | string | 是 | — | 环境名（`default` / `preview` / `staging` / `production`） |
| `displayName` | string | 是 | — | 显示名（如"预览环境"） |
| `isDefault` | boolean | 是 | — | 是否为项目默认环境（每项目有且仅一个 default） |
| `isProtected` | boolean | 是 | — | 是否受保护（阻止非 owner 操作） |
| `branchCount` | number | 是 | — | 冗余字段，归属该 env 的分支数 |
| `createdAt` | string | 是 | — | 创建时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除（default env 禁止删除） |

**索引**：

```
{ projectId: 1, name: 1 }                      unique（项目内 env name 唯一）
{ projectId: 1, isDefault: 1 }                 查默认 env
```

**内置 environments**：

P4 创建新项目时自动生成两个 env：

```
{ name: 'default',    displayName: '默认',     isDefault: true,  isProtected: false }
{ name: 'production', displayName: '生产',     isDefault: false, isProtected: true  }
```

用户可手动创建 `preview` / `staging` 等。`default` 环境不能删除，`production` 环境受保护（需 owner 角色才能启停）。

---

## 9. branches 集合

一条 Git 分支对应的容器集合（v4 版本，在 v3.2 `BranchEntry` 基础上加多项目字段）。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `projectId` | string | 是 | — | 指向 `projects._id`（**新增**） |
| `environmentId` | string | 是 | — | 指向 `environments._id`（**新增**） |
| `branchId` | string | 是 | — | 短 ID，项目内唯一（原 v3.2 的 `id`） |
| `name` | string | 是 | — | Git 分支名 |
| `slug` | string | 是 | — | URL 友好名（用于子域名） |
| `worktreePath` | string | 是 | — | Git worktree 的绝对路径 |
| `status` | enum | 是 | — | `pending` \| `building` \| `running` \| `error` \| `stopped` |
| `heatState` | enum | — | — | `hot` \| `warm` \| `cold`（温池调度） |
| `profileOverrides` | object[] | — | — | 分支级配置覆盖（现有概念） |
| `subdomainAliases` | string[] | — | — | 分支级子域名别名（现有概念） |
| `deployMode` | enum | — | — | `dev` \| `static`（现有概念） |
| `dirtyFlag` | boolean | — | — | 是否有未部署变更（P6 增加） |
| `lastDeployAt` | string | — | — | 最近部署时间 |
| `lastCommitSha` | string | — | — | 最近 commit SHA |
| `createdBy` | string | 是 | — | 创建者 userId |
| `createdAt` | string | 是 | — | 创建时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除标记 |

**索引**：

```
{ projectId: 1, branchId: 1 }                  unique（项目内 branchId 唯一）
{ projectId: 1, slug: 1 }                      unique
{ projectId: 1, environmentId: 1, status: 1 }  按环境+状态查询
{ projectId: 1, heatState: 1 }                 温池调度扫描
{ name: 1 }                                    全局查（debug 用，非业务主路径）
```

**变更说明**：

v3.2 的 `BranchEntry` 用 `id` 作为短 ID 主键，v4 改为 UUID `_id` + 独立的 `branchId` 字段。迁移时原 `id` 写到 `branchId`，生成新 UUID 作为 `_id`。

---

## 10. build_profiles 集合

每分支独立的应用服务定义（v3.2 已存在，v4 加 projectId）。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `projectId` | string | 是 | — | 指向 `projects._id`（**新增**） |
| `profileId` | string | 是 | — | 短 ID（原 v3.2 `id`） |
| `name` | string | 是 | — | 显示名（如 `prd-api`） |
| `kind` | enum | 是 | — | `app` \| `static` \| `docker-compose` |
| `repoPath` | string | 是 | — | 相对 worktree 的子路径 |
| `buildCommand` | string | — | — | 构建命令 |
| `buildArgs` | string[] | — | — | 构建参数 |
| `env` | object | — | — | 环境变量 key-value |
| `ports` | number[] | — | — | 对外暴露端口 |
| `deployMode` | enum | 是 | — | `dev` \| `static` |
| `dockerImage` | string | — | — | 基础镜像 |
| `dockerfile` | string | — | — | Dockerfile 相对路径 |
| `createdAt` | string | 是 | — | 创建时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除标记 |

**索引**：

```
{ projectId: 1, profileId: 1 }                 unique
{ projectId: 1, deletedAt: 1 }                 列表查询
```

---

## 11. infra_services 集合

项目共享的基础设施服务（v3.2 已存在，v4 加 projectId）。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `projectId` | string | 是 | — | 指向 `projects._id`（**新增**） |
| `serviceId` | string | 是 | — | 短 ID |
| `name` | string | 是 | — | 显示名（如 `MongoDB`） |
| `kind` | enum | 是 | — | `mongodb` \| `redis` \| `postgres` \| `custom` |
| `image` | string | 是 | — | Docker 镜像 |
| `tag` | string | 是 | — | 镜像 tag |
| `volumes` | string[] | — | — | Docker named volume 列表 |
| `env` | object | — | — | 环境变量 |
| `ports` | number[] | — | — | 端口映射 |
| `containerId` | string | — | — | 当前运行容器 ID |
| `status` | enum | 是 | — | `stopped` \| `starting` \| `running` \| `error` |
| `createdAt` | string | 是 | — | 创建时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除标记 |

**索引**：

```
{ projectId: 1, serviceId: 1 }                 unique
{ projectId: 1, status: 1 }                    查运行中的服务
```

---

## 12. routing_rules 集合

Header / Domain / Pattern 路由（v3.2 已存在，v4 加 projectId）。

| 字段 | 类型 | 必填 | 索引 | 说明 |
|---|---|---|---|---|
| `_id` | string | 是 | 主键 | UUID v4 |
| `projectId` | string | 是 | — | 指向 `projects._id`（**新增**） |
| `priority` | number | 是 | — | 优先级，越小越先匹配 |
| `matchKind` | enum | 是 | — | `header` \| `domain` \| `pattern` |
| `matchKey` | string | 是 | — | 匹配 key（header 名 / domain / regex） |
| `matchValue` | string | — | — | 匹配 value |
| `targetBranchId` | string | — | — | 路由到的分支 `_id` |
| `targetProfileId` | string | — | — | 路由到的 profile `_id` |
| `isActive` | boolean | 是 | — | 是否启用 |
| `createdAt` | string | 是 | — | 创建时间 |
| `updatedAt` | string | 是 | — | 最近更新时间 |
| `deletedAt` | string \| null | — | — | 软删除标记 |

**索引**：

```
{ projectId: 1, priority: 1 }                  按优先级顺序扫描
{ projectId: 1, isActive: 1 }                  查启用规则
{ targetBranchId: 1 }                          反向查引用某分支的规则
```

---

## 13. 关系图（ASCII ER）

```
         users
          │ 1
          │
          │ *
    workspace_members
          │ *
          │
          │ 1
       workspaces
          │ 1
          │
          │ *
        projects ────────────────┐
          │ 1                    │ 1
          │                      │
          │ *                    │ *
      environments          infra_services
          │ 1
          │
          │ *
        branches ──┐
          │ 1      │ *
          │        │
          │ *      │
    build_profiles │
                   │
                   │
              routing_rules
              (targetBranchId 反向引用)

  sessions ──── userId ──→ users
```

---

## 14. 索引汇总（DBA 一次性建立）

| 集合 | 要支撑的查询 | 关键约束 |
|---|---|---|
| 用户 | 按 GitHub 账号登录、按邮箱找人、按状态筛活跃用户 | GitHub 账号唯一；邮箱可缺省 |
| 会话 | 按用户查会话 | 过期即自动清除（到期删除） |
| 工作区 | 按短名直达、按类型与归属人筛选、按 GitHub 组织关联 | 短名唯一；组织字段可缺省 |
| 工作区成员 | 查某人属于哪些工作区、查某工作区有哪些人及角色 | 同一工作区内一人一条 |
| 项目 | 工作区内按短名直达、列未删除项目 | 工作区内短名唯一；容器网络名全局唯一 |
| 环境 | 项目内按名字取环境、取默认环境 | 项目内环境名唯一 |
| 分支 | 项目内按分支标识或短名直达、按环境与状态筛、按冷热态回收、跨项目按名字找 | 项目内分支标识与短名各自唯一 |
| 构建档案 | 项目内按档案标识直达、列未删除档案 | 项目内档案标识唯一 |
| 基础设施服务 | 项目内按服务标识直达、按状态巡检 | 项目内服务标识唯一 |
| 路由规则 | 项目内按优先级排序命中、筛生效规则、反查某分支被哪些规则指向 | 无唯一约束，靠优先级决定先后 |

**为什么按这张表建**：唯一约束是数据正确性的最后一道防线（短名撞车会让两个项目抢同一个预览地址）；
到期自动删除只用在会话上，其余集合的清理走业务流程而不是数据库定时器。


**索引总数**：24 个（含 3 个 unique、1 个 TTL、2 个 sparse）。

> **注意**：遵循项目规则 `.claude/rules/no-auto-index.md`，应用启动时禁止自动创建索引。以上 `createIndex` 语句由 DBA 在迁移窗口一次性执行，不得写入 CDS 启动代码。

---

## 15. 参考与校验

- 新字段命名必须 grep 现有 CDS `cds/src/domain/` 下的 TypeScript 类型，保持 camelCase + 英文缩写风格一致
- 所有集合必须在 `cds/src/infra/mongo/collections.ts`（P3 新建）里集中注册，禁止散落在业务代码
- schema 校验建议使用 MongoDB `$jsonSchema` validator，避免应用端漏校验
