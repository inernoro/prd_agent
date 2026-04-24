# 外部授权中心 · 设计

> **版本**：v1.0 | **日期**：2026-04-24 | **状态**：设计中

## 管理摘要

当前外部系统（TAPD / 语雀 / GitHub）的授权凭证散落在多个地方——TAPD Cookie 在每个工作流模板里手动粘贴、语雀没有任何集成、GitHub 分散在 CDS 和 PR 审查两套系统。用户无法知道自己授权了哪些系统、哪些快过期、哪些还在被使用。

本方案新增**个人级的「外部授权中心」**作为聚合视图，不改动各系统原生的授权机制（各自原样保留 Cookie/Token/OAuth），只把凭证的**存储、展示、撤销**收拢到一处。工作流可以通过下拉选择已授权的账号来引用凭证，取代粘贴。

**范围**：个人级 + 加密存储 + 过期标记 + 工作流引用。不做团队共享、不做 OAuth 自动刷新、不迁移老集成的内部逻辑。

---

## 产品定位

### 是什么

**一个**管理后台的**页面**，在「我的空间 → 外部授权」。功能有三件事：

1. **看**：列出我当前授权的所有外部系统，展示状态和过期时间
2. **加/改/撤**：新增授权、更新凭证、撤销授权
3. **引用**：工作流模板用 `auth-picker` 组件让用户下拉选择已授权的账号

### 不是什么

- ❌ 不是统一的 API 请求抽象层（不去包装 TAPD/Yuque/GitHub 的业务 API）
- ❌ 不是团队级凭证池（先做个人级）
- ❌ 不替换现有集成（GitHub OAuth Device Flow、CDS GitHub App 都不动）

### 解决什么痛点

| 现状 | 痛点 | 改善 |
|------|------|------|
| TAPD Cookie 每次创建工作流都要粘贴 | 过期后所有工作流失效，找不到源头 | 一处更新，所有工作流同步 |
| 语雀完全无集成 | 手动粘贴 CSV 文本 | 后续可扩展成 API 拉取 |
| 不知道自己授权了什么 | 撤销困难、安全盲区 | 统一视图 + 一键撤销 |

---

## 用户场景

### 场景一：首次授权 TAPD

```
用户: 我想用新的工作流模板，需要连接 TAPD
1. 点击头像 → 我的空间 → 外部授权
2. 点「+ 添加授权」→ 选「TAPD」
3. 填名称「生产账号」，粘贴 Cookie，输入工作空间 ID
4. 系统自动调 TAPD API 验证 → 显示「✅ 已验证」
5. 保存 → 列表出现一条
```

### 场景二：创建工作流时引用

```
用户: 新建「产品专业委员会月报」工作流
1. 点从模板创建 → 选月报模板
2. 表单里 TAPD 那栏是下拉框，不是 textarea
3. 下拉选「生产账号」→ 其他字段正常填
4. 运行 → 工作流引擎从凭证库取 Cookie 注入
```

### 场景三：Cookie 过期处理

```
用户: 工作流跑挂了，报 "TAPD 401 Unauthorized"
1. 打开外部授权 → 「生产账号」显示「⚠ 已过期」
2. 点「更新凭证」→ 粘贴新 Cookie
3. 所有引用这个授权的工作流自动恢复
```

### 场景四：查看 GitHub 授权

```
用户: 我想看看我给哪些仓库授权了
1. 打开外部授权 → 看到「GitHub - inernoro」条目（来自 PR 审查的 Device Flow）
2. 点详情 → 列出授权的仓库、授权时间、最近使用
3. 可以一键撤销（调 GitHub API 撤销 Token）
```

---

## 核心能力

### P0（必做）

| 能力 | 说明 |
|------|------|
| 凭证加密存储 | 用 .NET 的 `IDataProtector` 加密，DB 只存密文 |
| TAPD 类型 | Cookie + 工作空间 ID + 自动验证 |
| 语雀类型 | API Token + 账号信息 |
| GitHub 类型（只读映射） | 复用 `github_user_connections`，本中心只做视图 |
| 授权列表页 | 表格展示 + 状态图标 + 最近使用 |
| 添加/编辑/撤销 | 基本 CRUD |
| 工作流 `auth-picker` | 下拉选择组件 |
| 委员会月报模板改造 | 改用 auth-picker |
| 连接验证 | 每个类型有 `validate()` 方法 |
| 过期标记 | 列表页展示，不做主动通知 |

### P1（后续）

- 邮件/站内通知过期
- 团队/组织级共享
- OAuth 自动刷新
- 更多类型：Jira / Notion / 飞书 / Slack

---

## 架构设计

### 分层

```
┌────────────────────────────────────────────────┐
│  管理后台 UI                                    │
│  • 外部授权页面                                  │
│  • 添加/编辑弹窗（类型专属表单）                  │
│  • auth-picker 组件（供工作流模板使用）           │
└──────────────────┬─────────────────────────────┘
                   │ REST API
┌──────────────────┴─────────────────────────────┐
│  后端                                            │
│  • AuthorizationController（CRUD + 验证）        │
│  • AuthorizationService（加解密 + 业务逻辑）      │
│  • AuthTypeRegistry（类型注册表）                │
│    ├─ TapdAuthHandler                          │
│    ├─ YuqueAuthHandler                         │
│    └─ GitHubAuthHandler（只读，委托 github_*）   │
└──────────────────┬─────────────────────────────┘
                   │
          ┌────────┴─────────┐
          ▼                  ▼
    external_           github_user_
    authorizations      connections
    （加密存储）        （现有，只读映射）
```

### 类型注册表模式

后端用注册表存各类型的处理器（对齐前端 `CONFIG_TYPE_REGISTRY` 规则）：

```csharp
public interface IAuthTypeHandler
{
    string TypeKey { get; }
    Task<ValidationResult> ValidateAsync(Dictionary<string,string> credentials);
    Task<DateTime?> DetectExpiryAsync(Dictionary<string,string> credentials);
    object ExtractMetadata(Dictionary<string,string> credentials);
}
```

新增类型只要实现这个接口 + 注册到 DI 容器。

### 加密存储

- 使用 ASP.NET Core 内置的 `IDataProtector` + Persistent Key Ring
- 每个字段独立加密（支持部分更新）
- DB 只存密文，API 返回时**绝不下发**明文（除非用户点击"查看"二次确认）

---

## 数据设计

### 新集合 `external_authorizations`

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string (Guid N) | 主键 |
| UserId | string | 所属用户 |
| Type | string | `tapd` / `yuque` / `github` |
| Name | string | 用户自取名称 |
| CredentialsEncrypted | string | 加密后的凭证 JSON |
| Metadata | BsonDocument | 展示用元数据（工作空间、登录名等，非敏感） |
| Status | enum | `active` / `expired` / `revoked` |
| LastValidatedAt | DateTime? | 上次验证时间 |
| LastUsedAt | DateTime? | 上次被工作流引用时间 |
| ExpiresAt | DateTime? | 过期时间（Cookie 有，OAuth 没有） |
| CreatedAt | DateTime | |
| UpdatedAt | DateTime | |

### 索引

- `{ UserId: 1, Type: 1 }`
- `{ UserId: 1, Status: 1 }`

### 凭证结构（加密前）

```json
// TAPD
{ "cookie": "...", "workspaceIds": ["50116108", "66590626"] }

// 语雀
{ "apiToken": "...", "namespace": "user-xxx" }

// GitHub（引用模式，不落 credentials）
// 整条记录只存映射，credentials 指向 github_user_connections._id
```

---

## 接口设计

### Controller：`/api/authorizations`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/authorizations` | 当前用户的授权列表（credentials 不返回） |
| GET | `/api/authorizations/:id` | 详情（credentials 不返回） |
| POST | `/api/authorizations` | 新增（body 含 type + credentials） |
| PUT | `/api/authorizations/:id` | 更新（部分字段，credentials 可选） |
| DELETE | `/api/authorizations/:id` | 撤销（逻辑删除） |
| POST | `/api/authorizations/:id/validate` | 手动触发验证 |
| GET | `/api/authorizations/types` | 类型元信息（字段定义，供前端渲染表单） |
| POST | `/api/authorizations/:id/resolve` | **内部** 接口，工作流引擎用，返回解密后凭证 |

### 工作流侧变更

`requiredInputs` 新增类型：

```typescript
{
  key: 'tapd',
  type: 'auth-picker',   // 新增
  authType: 'tapd',      // 限定可选类型
  required: true
}
```

模板 `build()` 生成的节点 config 引用 `authId`：

```typescript
config: {
  authMode: 'stored',
  authId: inputs.tapd,     // 用户选的授权 ID
  workspaceId: ...         // 从 metadata 取
}
```

工作流执行时，`ExecuteTapdCollectorAsync` 读到 `authMode: 'stored'`，调 `/api/authorizations/:id/resolve` 取明文凭证注入。

---

## 关联文档

- `.claude/rules/marketplace.md` — 类型注册表模式参考
- `.claude/rules/frontend-architecture.md` — 前端 CONFIG_TYPE_REGISTRY 参考
- `doc/spec.srs.md` — 待更新，收录本模块
- `.claude/rules/codebase-snapshot.md` — 待更新，新增 `external_authorizations` 集合

---

## 风险

### 正确性

| 风险 | 影响 | 规避 |
|------|------|------|
| 加密密钥丢失导致全部凭证作废 | 高 | 用 ASP.NET Core 的 Persistent Key Ring，密钥落盘 + 多副本 |
| 工作流运行时 resolve 失败 | 中 | 增加 fallback：resolve 失败回退报错提示用户重新授权 |

### 安全

| 风险 | 影响 | 规避 |
|------|------|------|
| 凭证明文泄露（前端） | 高 | API 只返回脱敏版（Cookie 显示 `xxx...***...xxx`），明文仅在 resolve 时内部传 |
| 越权访问他人凭证 | 高 | 所有接口强制 `UserId == CurrentUser` 校验 |
| 审计缺失 | 中 | 记录 resolve 调用日志（谁调的、哪个工作流） |

### 体验

| 风险 | 影响 | 规避 |
|------|------|------|
| 用户不知道这个入口 | 低 | 工作流 auth-picker 下拉为空时引导跳转 |
| 授权过期没提示 | 中 | P0 在列表页标记，P1 补邮件/站内通知 |

### 迁移

- 老模板 `tapd-bug-collection` **保持原状**（继续用 textarea），新模板推荐 auth-picker
- GitHub Device Flow 的 `github_user_connections` 不改，本中心做**只读映射**展示

---

## 里程碑

| 阶段 | 内容 | 预估 |
|------|------|------|
| M1 | 后端：集合 + Controller + TAPD/Yuque Handler + 加密 | 0.5 天 |
| M2 | 前端：授权列表页 + 添加弹窗 + TAPD/Yuque 表单 | 0.5 天 |
| M3 | 工作流：auth-picker 组件 + 委员会月报模板改造 | 0.3 天 |
| M4 | GitHub 只读映射 + 联调 + 文档同步 | 0.2 天 |

**总计**：约 1.5 天
