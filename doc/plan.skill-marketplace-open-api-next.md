# 海鲜市场技能开放接口 — 下一程交接 · 计划

> **版本**: v1.0 | **日期**: 2026-04-22 | **状态**: 交接中
> **基于分支**: `claude/skill-platform-open-api-GkAFy`（12 commits · 43 files · +4507/-12 lines）
> **关联文档**: [`design.skill-marketplace-open-api.md`](design.skill-marketplace-open-api.md) · [`rule.data-dictionary.md`](rule.data-dictionary.md)
> **前一位 Agent**: Claude Code（本 session）

---

## 一、30 秒速读

当前分支已完成**海鲜市场技能开放接口 P1 + P2 + P3 基础设施**，下一程要做的是：

1. **录一个演示视频**上传（已建好 upload slot）—— 30 分钟级
2. **P3 自动桥接** `AgentOpenEndpoint → MarketplaceSkill` 引用条目 —— 半天
3. **P3 Admin UI** `/admin/agent-open-api` —— 半天
4. **P3 前端渲染** `ReferenceType='open-api-reference'` 的 MarketplaceCard 分支 —— 1-2 小时
5. **P4 Agent 自助权限**（RBAC 改造）—— **建议独立 PR、先跑 `/risk`**

全部改动都在本分支上继续、**不要开新分支**（下次再合并时冲突最少）。

---

## 二、当前状态快照

### 2.1 分支 & 部署

| 项 | 值 |
|---|---|
| 分支 | `claude/skill-platform-open-api-GkAFy` |
| Commits | 12（见 `git log --oneline main..HEAD`） |
| CDS 预览 | https://claude-skill-platform-open-api-gkafy.miduo.org/ |
| 自测脚本 | `scripts/smoke-skill-marketplace.sh` |
| 自测结果 | 8/8 PASS（2026-04-22 07:40） |

### 2.2 已完成能力

| 模块 | 位置 | 状态 |
|---|---|---|
| AgentApiKey 模型 + 服务 | `prd-api/src/PrdAgent.Core/Models/AgentApiKey.cs`<br>`prd-api/src/PrdAgent.Infrastructure/Services/AgentApiKeyService.cs` | ✅ |
| RequireScopeAttribute | `prd-api/src/PrdAgent.Api/Authorization/RequireScopeAttribute.cs` | ✅ |
| ApiKeyAuthenticationHandler 扩展（支持 sk-ak-*） | `prd-api/src/PrdAgent.Api/Authentication/ApiKeyAuthenticationHandler.cs` | ✅ |
| 海鲜市场开放接口 | `MarketplaceSkillsOpenApiController.cs` | ✅ |
| Key 管理 UI | `prd-admin/src/pages/marketplace/SkillOpenApiDialog.tsx` + `skillOpenApi/*` | ✅ |
| 官方技能包下载 | `OfficialSkillsController.cs` + `OfficialSkillTemplates.cs`（v1.0.0） | ✅ |
| 官方技能虚拟注入海鲜市场 | `OfficialMarketplaceSkillInjector.cs` | ✅ |
| 官方徽章 🛡️ | `prd-admin/src/components/marketplace/MarketplaceCard.tsx` | ✅ |
| 演示视频通用基础设施 | `homepageAssetSlots.DEMO_VIDEO_SLOTS` + `useDemoVideoUrl()` | ✅ |
| AgentOpenEndpoint 模型 + Admin CRUD | `AgentOpenEndpointsController.cs` | ✅（无 UI） |
| Scope 动态校验（`agent.{key}:call`） | `AgentApiKeysController.ValidateScopeAsync` | ✅ |
| **自动桥接 Endpoint → MarketplaceSkill** | — | ❌ **待你做** |
| **AgentOpenEndpoint Admin UI** | — | ❌ **待你做** |
| **MarketplaceCard 渲染 open-api-reference** | — | ❌ **待你做** |
| **Agent 自助权限（RBAC）** | — | ❌ **待你做（独立 PR）** |

### 2.3 2 个新集合

均已在 `doc/rule.data-dictionary.md` 登记：
- `agent_api_keys`（AgentApiKey）
- `agent_open_endpoints`（AgentOpenEndpoint）

### 2.4 已知限制

- 演示视频 slot `skill-openapi.agent-paste` 还没有视频；前端显示虚线占位卡
- `MarketplaceSkill.ReferenceType` 字段已加但前端还没识别 `open-api-reference` 分支（Fork 会返回乱结果）
- P4（Agent 自助注册权限到 `AdminPermissionCatalog`）完全没动

---

## 三、剩余任务清单（按优先级）

### P2.1 · 录制并上传第一个演示视频（最简单，30 分钟）

**目标**：让「接入 AI」弹窗的明文态不再是虚线占位，而是一段自动循环的实操录屏。

**执行步骤**：
1. 录一段 10-30 秒录屏：打开海鲜市场 → 接入 AI → 智能体接入 → 创建 Key → 点「复制给智能体使用」 → 粘贴到 Claude Code（本地演示即可） → AI 自动跑 curl 下载 findmapskills
2. MP4 / WebM，≤ 20 MB，16:9
3. 登录 admin → 访问 `/assets` → 滚到底部「演示视频」分区 → 点「接入 AI · 粘贴密钥给智能体」卡片上传
4. 回到海鲜市场 → 接入 AI → 新建 Key → 创建成功态应该看到视频自动播放

**验收标志**：
- AssetsManagePage 该分区的上传卡片变为"已上传 · 可删除"状态
- `GET /api/homepage-assets/public` 返回中包含 `demo.skill-openapi.agent-paste.video` slot
- CreateKeyTab 的明文态渲染出 `<video autoplay muted loop>` 不再是虚线占位

**踩坑提醒**：
- `HomepageSlotTile` 上传组件支持 video/* MIME，但浏览器原生 `<input accept>` 不会过滤大文件，后端 `uploadHomepageAsset` 的 MaxBytes 是多少没查过，先试小文件再试大的
- 视频别太长；明文态用户只会瞥一眼

---

### P2.2 · AgentOpenEndpoint → MarketplaceSkill 自动桥接（半天）

**目标**：管理员登记了一条 `agent_open_endpoints` 之后，海鲜市场自动出现一条"引用类技能"条目，用户点 Fork 不下载 zip，而是返回调用示例（curl / TS / Python）。

**前置已做**：
- `MarketplaceSkill` Model 已加字段 `ReferenceType`（`"zip"` / `"open-api-reference"`）+ `ReferenceEndpointId`
- `AgentOpenEndpoint` Model 已有 `LinkedMarketplaceSkillId`（占位）

**执行步骤**：
1. 新建 `prd-api/src/PrdAgent.Infrastructure/Services/AgentOpenEndpointBridgeService.cs`（单文件即可），提供 3 个方法：
   - `Task UpsertLinkedSkillAsync(AgentOpenEndpoint endpoint)` — 同步创建 / 更新 `marketplace_skills` 引用条目；把结果 ID 回写到 `endpoint.LinkedMarketplaceSkillId`
   - `Task DeleteLinkedSkillAsync(string endpointId)` — Endpoint 停用 / 删除时清
   - 字段映射：
     ```
     MarketplaceSkill.Id          = guid
     .Title                       = endpoint.Title
     .Description                 = endpoint.Description
     .ReferenceType               = "open-api-reference"
     .ReferenceEndpointId         = endpoint.Id
     .OwnerUserId                 = "agent-endpoint"  // 伪用户，和 "official" 区分
     .AuthorName                  = $"{endpoint.AgentKey} 开放接口"
     .IconEmoji                   = "🔌"
     .Tags                        = ["开放接口", endpoint.AgentKey, ...endpoint.RequiredScopes]
     .ZipUrl                      = ""（空，Fork 时按 ReferenceType 走不同分支）
     .IsPublic                    = endpoint.IsActive
     ```
2. 在 `AgentOpenEndpointsController` 的 `Create / Update / Delete` 尾部调桥接
3. 注册到 DI（`Program.cs` 的 `AddScoped<AgentOpenEndpointBridgeService>`）
4. 更新 `doc/design.skill-marketplace-open-api.md` 第 9.1 节状态从「待实现」改为「已实现」

**验收命令**：
```bash
# 登记一个 endpoint（要 JWT + OpenPlatformManage 权限）
curl -sS -X POST "$PRD_AGENT_BASE/api/admin/agent-open-endpoints" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"agentKey":"report-agent","title":"周报生成","description":"...","httpMethod":"POST","path":"/api/reports/generate","requiredScopes":["agent.report-agent:call"]}' \
  | jq '.data.item.id'

# 应在海鲜市场看到新条目（带 🔌 图标 + "开放接口" tag）
curl -sS -H "Authorization: Bearer $KEY" "$PRD_AGENT_BASE/api/open/marketplace/skills?tag=开放接口" \
  | jq '.data.items[] | select(.iconEmoji=="🔌")'
```

**踩坑提醒**：
- 桥接失败不能阻断 Endpoint CRUD 主流程 —— 用 try/catch 包 + log warning
- `LinkedMarketplaceSkillId` 要回写到 Endpoint；Delete 时先读再清理
- 跨 Controller 引用 marketplace_skills 集合：直接 `_db.MarketplaceSkills` 即可（已在 `MongoDbContext`）

---

### P2.3 · AgentOpenEndpoint Admin UI（半天）

**目标**：admin 后台表格化管理 Endpoints，而不是用 curl。

**执行步骤**：
1. 前端新页面 `prd-admin/src/pages/admin/AgentOpenApiPage.tsx`
   - 列表：agentKey / title / httpMethod+path / requiredScopes / isActive / actions
   - 编辑 Modal：表单覆盖 `UpsertRequest` 所有字段
   - 遵循 `frontend-modal.md`（createPortal + inline height + min-h:0）
2. 路由 `/admin/agent-open-api` 挂到 `App.tsx`
3. 左侧导航加菜单项（`AdminMenuCatalog.cs` + `authzMenuMapping.ts`）
   - appKey 建议 `agent-open-api`
   - 权限：复用 `OpenPlatformManage`
4. 前端 service 层：`services/contracts/agentOpenEndpoints.ts` + `services/real/agentOpenEndpoints.ts` + `services/index.ts` 导出
5. 百宝箱加条目（wip: true）`builtin-agent-open-api-admin`

**验收标志**：
- 管理员登录后能看到「Agent 开放接口」菜单 → 列表页 → 新建 / 编辑 / 删除正常
- 非管理员看不到（`OpenPlatformManage` 权限守卫生效）

**参考现有页面**：`prd-admin/src/pages/admin/OpenPlatformAppsPage.tsx`（结构最像）

---

### P2.4 · MarketplaceCard 渲染 open-api-reference（1-2 小时）

**目标**：用户在海鲜市场点「拿来吧」时，不是下载 zip，而是弹一个 Modal 显示该开放接口的调用示例（curl / TS / Python）+ 需要哪个 scope + 复制按钮。

**执行步骤**：
1. 修改 `MarketplaceCard.tsx`：`item.data.referenceType === 'open-api-reference'` 时按钮文案改为「查看调用示例」而非「拿来吧」，图标换 `Code2`
2. `MarketplaceSkillsController.Fork` 对 `ReferenceType=='open-api-reference'` 的条目返回 `{ referenceType, endpoint: {...} }` 而非 `{ downloadUrl, fileName }`
3. 前端 `forkMarketplaceSkillReal` service 检测响应里有 `referenceType` 就弹 `OpenApiReferenceDialog` 而非触发浏览器下载
4. 新建 `OpenApiReferenceDialog.tsx`：标题 + method + path + required scopes + 3 语言代码样本（复用现有 `codeSnippets.ts` 格式）

**验收**：P2.2 桥接完成后，海鲜市场上有 🔌 图标的条目，点「拿来吧」弹调用示例 Modal，而不是乱下载一个 0 字节 zip。

---

### P3 · Agent 自助权限（RBAC 改造，独立 PR）

**目标**：Agent 创建者能自己往 `AdminPermissionCatalog` 登记权限（无需平台管理员介入）。

**为什么独立 PR**：RBAC 是全站基础设施，改错了整个权限矩阵就乱了。本分支已经太大（12 commits · 4500+ 行），合进去再改 RBAC 会让 review 爆炸。

**必做前置**：
1. 跑 `/risk` 对本需求做风险评估
2. 跑 `/validate` 验证需求是否足够明确（"自助"到什么程度？需要审批流吗？）
3. 开新分支 `claude/agent-self-permission-XXX`

**初步思路**（仅供参考，别直接抄）：
- `AdminPermissionCatalog` 从硬编码 enum 改为混合模型（`Static` + `Dynamic`）
- 新集合 `agent_declared_permissions`（由 Agent 作者创建）
- 新端点 `/api/agent-permissions/declare`（创建者可提交，审批后生效）
- `system_roles` 的权限列表改为从两个来源合并

---

## 四、真人 UAT 清单（全套，没跑过）

本分支改动太大，前一位 Agent 来不及做完整 UAT。你接手后 **强烈建议第一步就跑这 10 条**。

预览地址：https://claude-skill-platform-open-api-gkafy.miduo.org/

### Web UI（浏览器）

- [ ] **U1**：登录 → `/marketplace` 右上角应有「⚡ 接入 AI」按钮
- [ ] **U2**：点开 Dialog → 默认 Tab 是「新建接入」→ 看到 2 个大卡片（智能体接入推荐 / 手动接入）+ 底部 3 步流程条
- [ ] **U3**：点「智能体接入」→ 切到「我的 Key」Tab + 自动展开新建表单
- [ ] **U4**：表单应有：**随机 Key 名称**（「接入 2026-04-21 HH:MM · xxxx」）+ 🎲 换一个链接 · **无备注字段** · 权限范围是 **2 列卡片**（不是长条）
- [ ] **U5**：勾选「浏览 & 下载技能」→ 点全宽青蓝渐变「创建 Key」
- [ ] **U6**：明文态应有：Key 代码块 → 演示视频 / 虚线占位（如 P2.1 做完就是视频） → 紫色全宽「复制给智能体使用」主 CTA → 下方 3 个灰文字链
- [ ] **U7**：点「复制给智能体使用」→ 打开文本编辑器粘贴 → prompt 应只有 3 步（export / curl / 读 SKILL.md），不超 500 字
- [ ] **U8**：切到「使用指南」Tab → 第 0 步显眼 CTA「下载 findmapskills.zip」
- [ ] **U9**：海鲜市场技能 Tab 首位应是 **🛡️ 官方 findmapskills** 卡片，点「拿来吧」应触发浏览器下载 zip
- [ ] **U10**：`/assets` 滚到底 → 看到「演示视频」分区 + 登记好的 1 个上传卡

### 端到端（AI Agent 实装）

- [ ] **E1**：用 U5 生成的 Key `sk-ak-xxx` 执行：
  ```bash
  curl -sS -H "Authorization: Bearer sk-ak-xxx" \
    "$BASE/api/open/marketplace/skills?limit=5" | jq '.data.items[0] | {id,ownerUserId,title}'
  ```
  期望 `items[0].id == "official-findmapskills"` + `ownerUserId == "official"`

- [ ] **E2**：Fork 官方条目：
  ```bash
  curl -sS -X POST -H "Authorization: Bearer sk-ak-xxx" \
    "$BASE/api/open/marketplace/skills/official-findmapskills/fork" -H "Content-Type: application/json" -d '{}' \
    | jq '.data.downloadUrl'
  ```
  期望返回 `$BASE/api/official-skills/findmapskills/download`

---

## 五、环境准备

### 5.1 本地开发

- 前端：`cd prd-admin && pnpm install && pnpm dev` → localhost:8000
- 后端：**当前环境没 .NET SDK**。两条路：
  - a) 本地装 SDK：`.NET 8`，然后 `cd prd-api && dotnet watch run --project src/PrdAgent.Api`
  - b) 直接用 CDS 预览域名做调试（改代码 → push → 2-5 分钟自动部署）

### 5.2 CDS 部署流程

本分支已 link GitHub，`git push` 后 CDS 会自动触发：
1. `git push` → GitHub webhook → CDS 开始构建
2. 预览域名 2-5 分钟内重新上线（中间会短暂 503）
3. 打开 `https://claude-skill-platform-open-api-gkafy.miduo.org/` 确认 HTTP 200

如果预览 5 分钟仍 503，查：
- GitHub PR Checks 面板看 `CDS Deploy` 状态
- `.claude/rules/cds-auto-deploy.md` 看调试手册

### 5.3 自测脚本

```bash
bash scripts/smoke-skill-marketplace.sh [preview-url]
# 不给 url 默认用 claude-skill-platform-open-api-gkafy.miduo.org
```

8 条匿名可达性检查 + 3 条需手动跑的带 Key 测试场景（脚本会打印命令）。

---

## 六、代码里的约定

- **官方 ID 前缀**：`OfficialMarketplaceSkillInjector.OfficialIdPrefix = "official-"` —— 未来加第二个官方技能沿用这个
- **虚拟注入筛选条件**：`ShouldInject(keyword, tag)` —— 默认情况永远首位；加新的注入条件到这里
- **版本号来源**：`OfficialSkillTemplates.FindMapSkillsVersion` —— 改 SKILL.md 内容时**必须同步**：① 后端常量 ② 本文件 header 版本 ③ 仓库 `.claude/skills/findmapskills/SKILL.md`
- **`ResolveBaseUrl` 优先级**：X-Client-Base-Url > Origin > X-Forwarded-Host + X-Forwarded-Proto > Request.Scheme+Host
- **演示视频 slot 命名**：`demo.{id}.video`，`id` 用 kebab-case 分层（如 `skill-openapi.agent-paste`）

---

## 七、交接联系

- 本文档作者（前一位 Agent）：Claude Code · session `01GWGo9dgX5wamQrKY7P7Xxb`
- 遇到前一位 Agent 留下的疑问：直接在本文档加 `> **[下一位 Agent 提问]** ...` 段落，用户会看到

祝顺利 —— 这是一次基础设施密度较高的交接，以后很多功能都会复用演示视频 slot + AgentApiKey + 官方技能虚拟注入这三套底座。
