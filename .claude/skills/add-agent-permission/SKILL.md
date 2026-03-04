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

### Step 4: 更新规则文档

将新权限登记到 `doc/rule.agent-permissions.md` 的对应表格中。

### Step 5: 验证清单

完成后输出验证清单：

- [ ] `AdminPermissionCatalog.cs` — 常量 + All 列表
- [ ] `BuiltInSystemRoles.cs` — agent_tester / viewer / operator 已添加
- [ ] Controller — `[AdminController]` 属性正确
- [ ] `authzMenuMapping.ts` — menuList + allPermissions
- [ ] `App.tsx` — `RequirePermission` 使用正确权限
- [ ] `doc/rule.agent-permissions.md` — 已登记

## 禁止事项

- 禁止使用 `access` 作为 Agent 路由的权限检查（太宽松）
- 禁止前端路由权限与后端 Controller 权限不一致
- 禁止新增 Agent 而不更新 `agent_tester` 角色
- 禁止将 AI 应用的权限挂在非 agent 分类下（如 lab、settings）
