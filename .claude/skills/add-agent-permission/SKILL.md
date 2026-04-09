---
name: add-agent-permission
description: 新增 Agent 权限。当需要为新功能添加权限时，自动判断分类并同步修改所有相关文件。触发词："加权限"、"新增权限"、"add permission"、"注册 agent"。
---

# Add Agent Permission - Agent 权限注册技能

为新功能自动注册权限，确保后端定义、前端映射、内置角色、路由守卫全部同步。

## 触发词

- "加权限"
- "新增权限"
- "add permission"
- "注册 agent"

## 执行流程

### Step 1: 读取规则文档

先读取 `doc/rule.agent-permissions.md`，理解权限分类决策树和命名规范。

### Step 2: 判断权限分类

根据决策树判定新功能属于哪个分类：

```
是否调用 LLM/AI? → YES → 有独立页面? → YES → Agent 权限
是否调用 LLM/AI? → NO  → 面向管理员? → YES → 基础设施权限
```

**关键判定依据**：
- 有 LLM 调用 + 独立页面 → `{key}-agent.use`（Agent 权限）
- 有管理/跨用户操作 → 追加 `{key}-agent.manage`
- 纯管理功能 → `{module}.read` / `{module}.write`

### Step 3: 同步修改文件（必须全部完成）

按以下顺序修改，缺一不可：

#### 3.1 后端权限定义
**文件**: `prd-api/src/PrdAgent.Core/Security/AdminPermissionCatalog.cs`

```csharp
// 1. 添加常量
public const string NewAgentUse = "new-agent.use";

// 2. 在 All 列表中注册
new(NewAgentUse, "新 Agent 名称", "功能描述"),
```

#### 3.2 后端内置角色
**文件**: `prd-api/src/PrdAgent.Core/Security/BuiltInSystemRoles.cs`

**规则**：
- Agent `.use` 权限 → 必须添加到 `agent_tester`、`viewer`、`operator`
- Agent `.manage` 权限 → 仅添加到 `operator`
- 基础设施 `.read` → 添加到 `viewer`、`operator`
- 基础设施 `.write` → 仅添加到 `operator`

#### 3.3 后端 Controller
**文件**: 对应的 Controller 文件

```csharp
[AdminController("new-agent", AdminPermissionCatalog.NewAgentUse)]
```

#### 3.4 前端权限菜单映射
**文件**: `prd-admin/src/lib/authzMenuMapping.ts`

```typescript
// menuList 中添加
{
  appKey: 'new-agent',
  label: '新 Agent',
  icon: 'IconName',
  permissions: ['new-agent.use'],
},

// allPermissions 中添加
{ key: 'new-agent.use', label: '新 Agent', description: '功能描述', category: 'use' },
```

#### 3.5 前端路由守卫
**文件**: `prd-admin/src/app/App.tsx`

```tsx
<Route path="new-agent" element={
  <RequirePermission perm="new-agent.use"><NewAgentPage /></RequirePermission>
} />
```

#### 3.6 百宝箱注册（默认必做，不可省略）
**文件**: `prd-admin/src/stores/toolboxStore.ts`

> 根据 `.claude/rules/navigation-registry.md`，任何新 Agent 默认入口就是百宝箱，不在这里出现就等于"用户找不到"。

在 `BUILTIN_TOOLS` 数组中追加条目：

```typescript
{
  id: 'builtin-new-agent',
  name: '新 Agent 名称',
  description: '一句话说明 Agent 做什么',
  icon: 'IconName',           // Lucide 图标名
  category: 'builtin',
  type: 'builtin',
  agentKey: 'new-agent',
  routePath: '/new-agent',    // 定制版才填；普通对话型可省略
  tags: ['标签1', '标签2'],
  usageCount: 0,
  createdAt: new Date().toISOString(),
},
```

**分区说明**：
- 有专门页面 → 放在"定制版 Agent"区（需要 `routePath`）
- 走统一对话界面 → 放在"普通版 Agent"区（需要 `systemPrompt`）

#### 3.7 左侧导航 / 首页快捷（仅当用户明确要求时追加）

**默认不做**。只有当用户在需求中写了"加到左侧导航"/"放到首页"时才执行：

- 左侧导航：`prd-api/src/PrdAgent.Core/Security/AdminMenuCatalog.cs`（后端权威定义）
- 首页快捷：`prd-admin/src/pages/home/MobileHomePage.tsx` 的 `QUICK_AGENTS` 数组 + `LandingPage.tsx` 的 `AgentShowcase`

三处同时注册时 `routePath` 必须一致，禁止分叉。

### Step 4: 更新规则文档

将新权限登记到 `doc/rule.agent-permissions.md` 的对应表格中。

### Step 5: 验证清单

完成后输出验证清单：

- [ ] `AdminPermissionCatalog.cs` — 常量 + All 列表
- [ ] `BuiltInSystemRoles.cs` — agent_tester / viewer / operator 已添加
- [ ] Controller — `[AdminController]` 属性正确
- [ ] `authzMenuMapping.ts` — menuList + allPermissions
- [ ] `App.tsx` — `RequirePermission` 使用正确权限
- [ ] **`toolboxStore.ts` — `BUILTIN_TOOLS` 已追加条目（默认必做）**
- [ ] 如用户要求：`AdminMenuCatalog.cs` / `QUICK_AGENTS` 已同步
- [ ] `doc/rule.agent-permissions.md` — 已登记

### Step 6: 向用户声明位置（必须）

完成后回复用户时，包含以下两行（严格格式）：

```
【位置】百宝箱（AI 百宝箱 → 搜索 "XXX"）/ 左侧导航"XX"菜单 / 首页快捷入口
【路径】登录后首页 → 1) 点击左侧【AI 百宝箱】 → 2) 搜索 "XXX" → 3) 打开
```

## 禁止事项

- 禁止使用 `access` 作为 Agent 路由的权限检查（太宽松）
- 禁止前端路由权限与后端 Controller 权限不一致
- 禁止新增 Agent 而不更新 `agent_tester` 角色
- 禁止将 AI 应用的权限挂在非 agent 分类下（如 lab、settings）
