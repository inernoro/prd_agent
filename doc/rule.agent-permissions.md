# Agent 权限分类规则

> **版本**：v1.0 | **创建日期**：2026-03-04 | **最后更新**：2026-03-04

## 概述

本文档定义了权限分类的判定规则。当新增功能时，必须参照本规则确定权限归类，避免权限混乱。

---

## 一、权限分类体系

### 1.1 Agent 权限（`{app-key}.use`）

**判定标准**（满足任一即归类为 Agent）：
- 调用 LLM / AI 模型完成核心功能（不只是辅助）
- 具有独立的用户交互界面（独立页面或工作区）
- 消耗 Token / GPU 等计算资源
- 具有 Run/Worker 异步执行模式

**命名规则**：`{功能}-agent.use`

**已注册 Agent 权限**：

| Agent | 权限 Key | 说明 |
|-------|---------|------|
| PRD Agent | `prd-agent.use` | PRD 智能解读与问答 |
| 视觉创作 Agent | `visual-agent.use` | 高级视觉创作工作区 |
| 文学创作 Agent | `literary-agent.use` | 文章配图智能生成 |
| 缺陷管理 Agent | `defect-agent.use` | 提交和查看缺陷 |
| 视频 Agent | `video-agent.use` | 文章转视频教程生成 |
| 竞技场 Agent | `arena-agent.use` | 模型盲评对战 |
| AI 百宝箱 | `ai-toolbox.use` | 多 Agent 协同工具箱 |
| 周报 Agent | `report-agent.use` | 周报创建与管理 |
| 工作流引擎 | `workflow-agent.use` | 自动化工作流 |
| 数据迁移 Agent | `data-migration-agent.use` | 数据映射与迁移 |

### 1.2 Agent 管理权限（`{app-key}.manage`）

**判定标准**：在 Agent 基础使用之上，需要管理权限的场景：
- 管理模板、配置
- 管理团队、成员
- 查看所有用户的数据（跨用户）
- 删除/修改他人的资源

**命名规则**：`{功能}-agent.manage` 或 `{功能}-agent.{子域}.manage`

**已注册管理权限**：

| 权限 Key | 说明 |
|---------|------|
| `defect-agent.manage` | 缺陷模板、指派处理人 |
| `ai-toolbox.manage` | 百宝箱工作流配置 |
| `workflow-agent.manage` | 管理所有工作流 |
| `data-migration-agent.write` | 删除集合、修复数据 |
| `report-agent.template.manage` | 周报模板管理 |
| `report-agent.team.manage` | 周报团队管理 |
| `report-agent.view.all` | 查看所有团队周报 |
| `report-agent.datasource.manage` | 数据源配置 |

### 1.3 基础设施权限（`{module}.read` / `{module}.write`）

**判定标准**：
- 不涉及 AI/LLM 调用
- 属于系统管理、配置、运维类功能
- 面向管理员而非普通用户

**已注册基础设施权限**：

| 模块 | 读 | 写 |
|------|-----|-----|
| 用户管理 | `users.read` | `users.write` |
| 群组管理 | `groups.read` | `groups.write` |
| 模型管理 | `mds.read` | `mds.write` |
| 日志 | `logs.read` | — |
| 数据管理 | `data.read` | `data.write` |
| 资产管理 | `assets.read` | `assets.write` |
| 设置 | `settings.read` | `settings.write` |
| 提示词 | `prompts.read` | `prompts.write` |
| 技能 | `skills.read` | `skills.write` |
| 实验室 | `lab.read` | `lab.write` |
| 教程邮件 | `tutorial-email.read` | `tutorial-email.write` |
| 总裁面板 | `executive.read` | — |

### 1.4 平台权限（`{module}.manage`）

| 权限 Key | 说明 |
|---------|------|
| `open-platform.manage` | 开放平台 App 管理 |
| `authz.manage` | 权限角色管理 |
| `automations.manage` | 自动化规则管理 |

---

## 二、内置角色权限分配原则

### 2.1 角色定位

| 角色 | 定位 | Agent 权限 | 管理权限 | 基础设施权限 |
|------|------|-----------|---------|------------|
| **admin** | 全权管理员 | 全部 | 全部 | 全部 |
| **operator** | 运营/运维 | 全部 `.use` | 部分 `.manage` | 大部分读写 |
| **viewer** | 只读体验 | 全部 `.use`（不含工作流） | 无 | 仅读 |
| **agent_tester** | Agent 体验者 | **全部 `.use`** | 无 | 仅 `settings.read` |
| **none** | 无权限 | 无 | 无 | 无 |

### 2.2 关键规则

1. **agent_tester 必须包含所有 `*.use` 权限** — 这是大部分用户的角色，新增 Agent 后必须同步添加
2. **viewer 包含大部分 `*.use` 权限** — 只读用户也应能体验 Agent（消耗 Token 但不能管理）
3. **operator 包含所有 `*.use` + 部分 `*.manage`** — 运维需要管理能力
4. **新增 Agent 时的必做清单**：
   - `AdminPermissionCatalog.cs` 添加权限常量 + `All` 列表
   - `BuiltInSystemRoles.cs` 添加到 agent_tester / viewer / operator
   - `authzMenuMapping.ts` 添加 menuList + allPermissions
   - `App.tsx` 路由使用正确的 `RequirePermission`

---

## 三、分类决策树

```
新增功能 → 是否调用 LLM/AI?
  ├─ YES → 是否有独立页面?
  │   ├─ YES → Agent 权限 ({key}-agent.use)
  │   │   └─ 是否有管理/跨用户操作?
  │   │       ├─ YES → 追加管理权限 ({key}-agent.manage)
  │   │       └─ NO  → 仅 .use
  │   └─ NO  → 嵌入已有 Agent 的权限（如 LLM Gateway 不需要独立权限）
  └─ NO  → 面向管理员?
      ├─ YES → 基础设施权限 ({module}.read/.write)
      └─ NO  → 平台权限 ({module}.manage) 或 access 即可
```

---

## 四、变更文件清单

新增 Agent 权限时需同步修改的文件：

| # | 文件 | 操作 |
|---|------|------|
| 1 | `AdminPermissionCatalog.cs` | 添加 `const string` + `All` 列表条目 |
| 2 | `BuiltInSystemRoles.cs` | 添加到 admin/operator/viewer/agent_tester |
| 3 | `ArenaController.cs`（示例） | `[AdminController]` 属性绑定权限 |
| 4 | `authzMenuMapping.ts` → `menuList` | 添加菜单分组定义 |
| 5 | `authzMenuMapping.ts` → `allPermissions` | 添加权限条目定义 |
| 6 | `App.tsx` | `<RequirePermission perm="xxx">` |
| 7 | `CLAUDE.md` → 功能注册表 | 更新状态 |

---

## 五、反面案例（已修复）

| 问题 | 修复前 | 修复后 |
|------|--------|--------|
| 竞技场挂在 lab 权限下 | `[AdminController("lab", LabRead)]` | `[AdminController("arena-agent", ArenaAgentUse)]` |
| 百宝箱前端路由无门槛 | `RequirePermission perm="access"` | `RequirePermission perm="ai-toolbox.use"` |
| agent_tester 缺少新 Agent | 无 arena/report/workflow | 补齐全部 `.use` |
| 前端权限列表严重缺失 | 仅 4 个 Agent 权限 | 全部 21 个权限定义 |
