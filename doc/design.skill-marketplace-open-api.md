# 海鲜市场技能开放接口设计 (Skill Marketplace Open API)

> **版本**：v1.0 | **日期**：2026-04-21 | **状态**：P1+P2 已实现；P3 基础设施已铺路，自动桥接待实现

## 一、管理摘要

- **解决什么问题**：AI / 外部 Agent 想浏览、下载、上传我们海鲜市场的技能，却没有程序化入口；用户无法让 Cursor/Claude Code 一键接通本平台
- **方案概述**：推出 `sk-ak-*` 长效 API Key（AgentApiKey）+ scope 白名单机制 + `/api/open/marketplace/skills/*` 开放接口 + 前端「接入 AI」弹窗一键生成 Key + 复制提示词给智能体；AI 装上官方 `findmapskills` 技能即全套接通
- **业务价值**：降低"外部 AI 接入本平台"的门槛从 0→1；沉淀一套可复用的"演示视频 / 官方技能 / 开放接口"基础设施，后续 Agent 开放接口（P3）复用同一套鉴权 + UI 模式
- **影响范围**：新增 2 个 MongoDB 集合、新增 5 个 Controller、新增 1 个前端弹窗 + 管理后台上传分区；对现有数据模型只扩展不破坏
- **预计风险**：低 — scope 白名单限定、默认 365 天 + 7 天宽限期、明文仅一次返回、只哈希不存

---

## 二、产品定位

### 2.1 目标用户

- **开发者 / AI 工作站使用者**：想在 Cursor / Claude Code / 其它 AI Agent 里直接调"找个做 X 的技能"、"发布这个技能到市场"
- **平台管理员**：需要控制"哪些 Agent 可以被外界调用"、"哪些 scope 可被授权"
- **未来的 Agent 作者**（P3/P4）：自己开放一个 HTTP API，走同一套鉴权被外界调用

### 2.2 场景 & 反直觉决策

| 场景 | 反直觉决策 | 原因 |
|---|---|---|
| 授权时长 | 默认 **1 年**、最长 3 年 | 用户反馈"不要动不动就 403"；AI Agent 跑在 CI/本地 shell，频繁重新授权成本极高 |
| 过期策略 | 过期后仍放行 **7 天宽限期** | 缓冲调用方发现"要续期"的时间窗；响应头 `X-AgentApiKey-Expiring` 提醒，不直接拒绝 |
| 明文一次性 | 创建后仅 UI 内一次完整显示，后端只存 SHA256 | 标准 API Key 安全做法；用户复制错了只能撤销重建 |
| 技能安装入口 | "智能体接入"默认推荐路径 + 提示词自动 export 到 `~/.zshrc`（不入仓库） | AI 粘贴即用；强化"Key 不应入 git 仓库"的安全习惯 |
| 官方技能注入 | `findmapskills` 虚拟注入到海鲜市场列表，不写 DB | 后端代码即真源，改代码立刻生效；无数据迁移负担 |

---

## 三、核心能力

### 3.1 AgentApiKey 鉴权（M2M 长效）

- Key 格式：`sk-ak-{32 hex}`（38 字符；`ak` 前缀用于与历史 `OpenPlatformApp` 的 `sk-{32}` 区分）
- Key 创建：用户 UI `/marketplace → 接入 AI → 新建 Key`（JWT 鉴权）或未来通过 API（暂未开放）
- Key 使用：调用开放接口时带 `Authorization: Bearer sk-ak-xxx` 头，后端 `ApiKeyAuthenticationHandler` 识别前缀走 AgentApiKey 路径
- Key 权限：通过 `Scopes: List<string>` 字段限定可调范围，endpoint 用 `[RequireScope(...)]` 过滤

### 3.2 Scope 契约

| Scope | 类别 | 用途 |
|---|---|---|
| `marketplace.skills:read` | 固定 | 浏览、下载（fork）海鲜市场技能；收藏 |
| `marketplace.skills:write` | 固定 | 向海鲜市场上传新 zip 技能包 |
| `agent.{agent-key}:call` | 动态（P3） | 调用某个 Agent 的开放接口（如 `agent.report-agent:call`）；必须已被某条 `AgentOpenEndpoint` 登记才能被用户勾选 |

### 3.3 海鲜市场开放接口

匿名端点（不需要 Key）：
- `GET /api/official-skills/{skillKey}/download` — 下发平台官方技能包 zip

需 `marketplace.skills:read`：
- `GET /api/open/marketplace/skills?keyword=&sort=hot|new&tag=&limit=` — 列表
- `GET /api/open/marketplace/skills/{id}` — 详情
- `GET /api/open/marketplace/skills/tags` — 所有标签
- `POST /api/open/marketplace/skills/{id}/fork` — 下载（+1 count）
- `POST /api/open/marketplace/skills/{id}/favorite` / `/unfavorite`

需 `marketplace.skills:write`：
- `POST /api/open/marketplace/skills/upload`（multipart zip + title + description + tags）

所有接口返回统一 `{success, data, error}` 格式。响应头约定：
- `X-AgentApiKey-ExpiringSoon: true` + `X-AgentApiKey-DaysLeft: N`（30 天内过期）
- `X-AgentApiKey-Expiring: true` + `X-AgentApiKey-ExpiredAt: ...`（已过期在宽限期内）

### 3.4 官方 findmapskills 技能

唯一下载入口：`/api/official-skills/findmapskills/download`（代码内嵌 SKILL.md + README，运行时替换 `{{BASE_URL}}` 占位符）。zip 同时自动**虚拟注入**到海鲜市场列表首位（`ownerUserId=official`），用户在 UI 或 AI 调接口都能看到并 fork。

---

## 四、架构

### 4.1 数据模型

- `AgentApiKey`（集合 `agent_api_keys`）—— scope-based M2M 鉴权凭据
- `AgentOpenEndpoint`（集合 `agent_open_endpoints`）—— P3 Agent 开放接口登记
- `MarketplaceSkill` 新增字段 —— `ReferenceType`（`zip` / `open-api-reference`）+ `ReferenceEndpointId` 为自动桥接铺路

详见 `doc/rule.data-dictionary.md`。

### 4.2 鉴权链路

```
外部 AI Agent
    │  Authorization: Bearer sk-ak-xxxxxxxx
    ▼
ApiKeyAuthenticationHandler（识别 sk-ak- 前缀）
    │  ─── sk-ak-* ───▶ AgentApiKeyService.LookupByPlaintextAsync
    │                       │ 校验：IsActive / RevokedAt / ExpiresAt + GracePeriodDays
    │                       │ 成功：设置 boundUserId + scope claim × N
    │                       │ 宽限期内：Response.Headers.X-AgentApiKey-Expiring=true
    │  ─── sk-*   ───▶ IOpenPlatformService.GetAppByApiKeyAsync（历史路径）
    ▼
[Authorize(AuthenticationSchemes = "ApiKey")]
    ▼
[RequireScope(...)] 过滤器检查 claim 是否满足端点要求
    ▼
Controller 方法用 User.FindFirst("boundUserId").Value 当 userId 执行业务
```

### 4.3 Scope 动态校验

`AgentApiKeysController.ValidateScopeAsync` 双轨逻辑：
1. 固定白名单 `FixedAllowedScopes`（硬编码 `marketplace.skills:read/write`）—— 永远放行
2. 动态：正则 `^agent\.{key}:{action}$` 且 scope 必须已被某条 `AgentOpenEndpoint.RequiredScopes` 引用才放行

这样防止"用户创建空头 scope"——所有动态 scope 必须先由管理员登记对应 Endpoint。

### 4.4 官方技能虚拟注入

`MarketplaceSkillsController.List` / `MarketplaceSkillsOpenApiController.List` 在返回结果前面预置一条虚拟官方条目（不入库，每次请求动态生成）：

```json
{
  "id": "official-findmapskills",
  "title": "findmapskills · 海鲜市场操作技能",
  "iconEmoji": "🛡️",
  "ownerUserId": "official",
  "ownerUserName": "PrdAgent 官方",
  "zipUrl": "{BASE_URL}/api/official-skills/findmapskills/download",
  ...
}
```

`Fork` 端点特判 `id = "official-findmapskills"`，返回官方下载 URL（不+1 count、不落库）。前端 `MarketplaceCard` 识别 `ownerUserId === "official"` 显示 🛡️ 官方 徽章。

---

## 五、数据设计

### 5.1 AgentApiKey 字段

见 `doc/rule.data-dictionary.md`。关键不变量：
- `ApiKeyHash` 只存 SHA256，**禁止**存明文
- `KeyPrefix` 前 12 字符仅 UI 识别用
- `ExpiresAt == null` 仅允许管理员创建
- `RevokedAt` 一旦非 null 立即失效、不可恢复

### 5.2 MarketplaceSkill.ReferenceType 语义

- `zip`（默认）：用户上传的 zip 包，`ZipUrl/ZipKey` 必填；`Fork` 返回 zip 下载 URL
- `open-api-reference`（P3 预留）：由 `AgentOpenEndpoint` 自动桥接出的引用条目，`Fork` 返回 Agent 接口调用示例而非 zip；需前端 `MarketplaceCard` 新增分支处理（本轮未做）

---

## 六、接口设计

### 6.1 用户管理 Key（JWT）

```
GET  /api/agent-api-keys          列表 + allowedScopes（固定 + 动态）+ agentEndpoints
POST /api/agent-api-keys          创建（返回明文，仅此一次）
PATCH /api/agent-api-keys/{id}    改 name/description/scopes/isActive
POST /api/agent-api-keys/{id}/renew   续期（默认 +365 天，基于 max(now, 原 expiresAt)）
POST /api/agent-api-keys/{id}/revoke  撤销（立即失效）
DELETE /api/agent-api-keys/{id}   删除
```

### 6.2 Agent 开放接口登记（admin）

```
GET    /api/admin/agent-open-endpoints
POST   /api/admin/agent-open-endpoints
PATCH  /api/admin/agent-open-endpoints/{id}
DELETE /api/admin/agent-open-endpoints/{id}
```

均需 `OpenPlatformManage` 权限。

### 6.3 官方技能分发（匿名）

```
GET /api/official-skills/findmapskills/download
    → 动态 zip：findmapskills/SKILL.md + findmapskills/README.md
    → Content-Type: application/zip
    → Cache-Control: no-store（保证永远拿到最新版）
```

---

## 七、前端集成

### 7.1 「接入 AI」弹窗 (`SkillOpenApiDialog`)

三 Tab 结构：
- **新建接入（落地页）**：两卡片 "智能体接入" / "手动接入" + 底部 3 步流程条
- **我的 Key**：列表 ↔ 内联新建表单同一页；顶部主 CTA「新建 Key」+ 次要「下载技能包」
- **使用指南**：curl / TypeScript / Python 代码样本 + 订阅/修改/续期说明

遵循原则：
- `.claude/rules/frontend-modal.md`（createPortal + inline style 高度 + min-h:0）
- 日式极简：一屏一个主 CTA；次要降为文字链

### 7.2 演示视频通用基础设施

- `homepageAssetSlots.DEMO_VIDEO_SLOTS` + `useDemoVideoUrl(id)` hook
- 复用 `HomepageAsset` 后端，无需新集合
- 任意模块登记 slot 后，管理员在「资源管理 → 演示视频」即可上传 MP4/WebM
- 首条已登记：`skill-openapi.agent-paste`（接入 AI 粘贴密钥给智能体）

详见 `.claude/rules/frontend-architecture.md` 注册表模式。

---

## 八、技能生命周期（findmapskills）

### 8.1 版本号机制

- 后端 `OfficialSkillTemplates.FindMapSkillsVersion` 常量定义当前版本
- SKILL.md 模板前端声明版本 + 更新日期
- 下载时版本号随 zip 一起下发；用户可对比版本号判断是否需要重装

### 8.2 更新流程

| 角色 | 操作 |
|---|---|
| 平台开发者 | 改 `OfficialSkillTemplates.FindMapSkillsSkillMd` + 撞 `FindMapSkillsVersion` + 部署 |
| 用户 | 在海鲜市场看到 `findmapskills` 永远指向最新版；重新 fork / 直接 curl `/api/official-skills/findmapskills/download` 即可更新 |
| AI Agent | 调 `/api/open/marketplace/skills?keyword=findmapskills` 发现新版本，提示用户重新装 |

### 8.3 同步约束

- 仓库内 `.claude/skills/findmapskills/SKILL.md`（本地 Claude Code 用）
- 后端 `OfficialSkillTemplates.FindMapSkillsSkillMd`（动态下发用）

**下次编辑必须同步修改**。不做自动单源是因为容器 WORKDIR 不含 `.claude` 目录（build artifact 不打包）。

---

## 九、P3 演进路线（待实现）

### 9.1 AgentOpenEndpoint → MarketplaceSkill 自动桥接

触发时机：`AgentOpenEndpointsController.Create/Update/Delete`

桥接逻辑：
- 创建 Endpoint → upsert 一条 `marketplace_skills` 条目（`ReferenceType='open-api-reference'` + `ReferenceEndpointId = endpoint.Id`）
- 更新 Endpoint（IsActive, Title, Description 等）→ 同步更新桥接条目
- 删除 Endpoint → 删除桥接条目

前端处理：
- `MarketplaceSkillsController.Fork` 检测 `ReferenceType=='open-api-reference'`，返回调用示例 JSON（含 method/path/scope/headers/body 样本）而非 zip URL
- `MarketplaceCard` 新增引用类型分支渲染（"HTTP 接口" 标签 + "复制调用示例" 按钮）

### 9.2 Admin UI

`/admin/agent-open-api`：表格化管理 Endpoints + 新建/编辑表单。复用既有 `AdminController` 权限体系。

### 9.3 P4（独立 PR）：Agent 自助权限

目标：Agent 创建者能自己往权限中心（`AdminPermissionCatalog`）注册权限，无需平台管理员介入。

改造范围：`AdminPermissionCatalog` 从硬编码 enum → 混合模型（硬编码基础 + 动态集合）。RBAC 层级改造风险高，建议独立 PR + `/risk` 评估后实施。

---

## 十、关联设计文档

- `doc/spec.marketplace.md` — 海鲜市场整体规格
- `doc/rule.data-dictionary.md` — 数据字典（含本 PR 两新集合）
- `.claude/rules/llm-gateway.md` — LLM 调用约束（本 PR 未触发）
- `.claude/rules/frontend-modal.md` — 弹窗物理约束
- `.claude/rules/server-authority.md` — 服务器权威性
- `.claude/rules/no-localstorage.md` — 客户端存储约束（本 PR 用 sessionStorage 标记首次下载）

---

## 十一、风险与回滚

| 风险 | 规避 | 回滚 |
|---|---|---|
| CDS 首次部署 .NET 编译失败 | `/cds-deploy` 远端编译兜底，本地无 SDK 必须走 CDS | 整体 revert 本分支所有 commit；两个新集合独立存在可手动清 |
| AgentApiKey scope 规则误拦截合法调用 | 首次部署后对所有端点跑 `/smoke` 自测 | 回退 `RequireScopeAttribute` 到仅记录日志不阻断模式 |
| 官方 findmapskills 虚拟注入与真实 ID 冲突 | 官方 ID 固定 `official-findmapskills` 前缀，用户上传 ID 是 32 位 hex，不会重名 | N/A |
| 宽限期逻辑导致已撤销 Key 仍被放行 | `RevokedAt != null` 最高优先级，覆盖任何 ExpiresAt + grace 逻辑 | N/A |
