---
name: scope-check
description: |
  分支受控检查：分析当前分支所有变更，自动识别开发的 Agent，逐文件分类为 owned/shared/foreign，
  检测越界修改和 append-only 违规。用于提交前或交接时的边界审计。
  触发词: "/scope-check", "边界检查", "检查边界", "受控检查"
allowed-tools: Read Bash Glob Grep
---

# 分支受控检查 — 提交前的安检门

## 核心理念

开发时自由创作，完成时安全检查。不限制过程，只审计结果。

**本技能的工作**：
1. 扫描当前分支相对于 main 的全部变更
2. 自动推断正在开发哪个 Agent
3. 逐文件判定：属于该 Agent（owned）、共享注册文件（shared）、还是越界（foreign）
4. 对 shared 文件做 append-only 检查（只允许新增，不允许删改已有内容）
5. 输出结构化审计报告

## 执行流程

### 步骤 1：收集分支变更

```bash
# 获取当前分支相对于 main 的所有变更文件
git diff --name-only main...HEAD

# 获取详细 diff（用于 append-only 检查）
git diff main...HEAD --stat
```

如果 `main...HEAD` 无差异，尝试 `git diff --name-only HEAD~5`（取最近 5 个 commit）并告知用户。

### 步骤 2：自动推断 Agent 身份

从变更文件中推断正在开发的 Agent，匹配优先级：

1. **前端页面目录**：`prd-admin/src/pages/{agent-name}/` → 提取 `{agent-name}`
2. **后端 Controller**：`Controllers/Api/{AgentName}Controller.cs` → 转换为 kebab-case
3. **Store 文件**：`stores/{agentName}Store.ts` → 转换为 kebab-case
4. **Service 文件**：`services/real/{agentName}.ts` → 转换为 kebab-case
5. **文档文件**：`doc/*.{agent-name}.*` → 提取 `{agent-name}`

取出现频次最高的 agent-name 作为推断结果。

**如果无法推断**（变更文件没有明显的 agent 模式）：
- 直接询问用户："你在开发哪个 Agent？"
- 或提示："变更文件分散，无法自动识别目标 Agent，以下是完整文件列表"

### 步骤 3：文件分类

以推断出的 `{agent-name}` 为基准（示例用 `review-agent`，PascalCase 为 `ReviewAgent`，camelCase 为 `reviewAgent`）：

#### ✅ owned — 属于该 Agent 的文件

```
prd-api/src/PrdAgent.Api/Controllers/Api/ReviewAgent*.cs
prd-api/src/PrdAgent.Api/Services/ReviewAgent/**
prd-api/src/PrdAgent.Core/Models/ReviewAgent*.cs
prd-api/src/PrdAgent.Core/Models/*Review*.cs（含 agent 名称的 Model）
prd-api/src/PrdAgent.Core/Interfaces/IReviewAgent*.cs
prd-api/src/PrdAgent.Infrastructure/Services/ReviewAgent*.cs
prd-admin/src/pages/review-agent/**
prd-admin/src/stores/reviewAgentStore.ts
prd-admin/src/services/contracts/reviewAgent.ts
prd-admin/src/services/real/reviewAgent.ts
doc/*review-agent*
changelogs/*
.agent-workspace/review-agent/**
```

**判定规则**：文件路径中包含 `{agent-name}`（kebab）或 `{AgentName}`（Pascal）或 `{agentName}`（camel）。

#### 🔶 shared — 共享注册文件（需要 append-only 检查）

> 这些文件被所有 Agent 共享。新 Agent 通常**只在末尾追加**自己的注册条目，禁止删改已有内容。

**后端注册文件**：

```
prd-api/src/PrdAgent.Core/Security/AdminPermissionCatalog.cs
prd-api/src/PrdAgent.Core/Security/AdminMenuCatalog.cs
prd-api/src/PrdAgent.Core/Security/AdminControllerAttribute.cs
prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs
prd-api/src/PrdAgent.Core/Models/CapsuleTypeRegistry.cs
prd-api/src/PrdAgent.Core/Attributes/AppOwnershipAttribute.cs   # AppNames 常量也在此文件
prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs  # 注意：是 Database/ 不是 Data/
prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs            # CLI Agent 执行器分发表
```

**前端注册文件**：

```
prd-admin/src/services/api.ts                  # API 端点路由表
prd-admin/src/app/App.tsx                      # React 路由表
prd-admin/src/stores/toolboxStore.ts           # 百宝箱 BUILTIN_TOOLS（导航铁律入口）
prd-admin/src/lib/authzMenuMapping.ts          # 左侧导航权限映射
prd-admin/src/lib/marketplaceTypes.tsx         # 海鲜市场 CONFIG_TYPE_REGISTRY
prd-admin/src/lib/fileTypeRegistry.ts          # 文件类型 FILE_TYPE_REGISTRY
prd-admin/src/pages/MobileHomePage.tsx              # QUICK_AGENTS_BASE（移动端首页快捷）
prd-admin/src/pages/home/sections/AgentGrid.tsx     # VISUAL_META（PC 端首页 /home 的 Agent 网格）
```

**项目级配置文件**：

```
CLAUDE.md
doc/index.yml
doc/guide.list.directory.md
.gitignore
changelogs/                                    # 碎片目录，新增碎片 = owned，禁止删改他人碎片
```

**注意**：`changelogs/` 下的文件属于"每 PR 一个碎片"模式——你只能新增自己的碎片文件，禁止删改他人 PR 留下的碎片（除非你跑了 `bash scripts/assemble-changelog.sh` 合并发版）。

#### ❌ foreign — 其他所有文件

不属于以上两类的文件，均为越界。

### 步骤 4：append-only 检查

对每个 shared 文件执行：

```bash
git diff main...HEAD -- {文件路径}
```

分析 diff 输出：
- **只有 `+` 行（新增）**→ ✅ append 合规
- **有 `-` 行（删除或修改已有内容）**→ ⚠️ append 违规，需人工审核

特别关注：

**后端注册**：
- `AdminPermissionCatalog.cs`：是否只新增了 const 和 All 列表条目？
- `AdminMenuCatalog.cs`：是否只新增了菜单项？是否在末尾追加而非插入中间？
- `AdminControllerAttribute.cs`：通常不应被修改（它是 attribute 定义本身）
- `AppCallerRegistry.cs`：是否只新增了 AppCallerCode const？
- `AppOwnershipAttribute.cs`：是否只在 `AppNames` 静态类末尾新增了 `XxxAgent` / `XxxAgentDisplay` 常量？
- `CapsuleTypeRegistry.cs`：是否只新增了胶囊类型，没改已有类型 schema？
- `CapsuleExecutor.cs`：是否只新增了一个 `ExecuteCliAgent_XxxAsync` 方法 + 在 switch 表中追加一个 case？删改已有 case = 越界
- `MongoDbContext.cs`：是否只新增了 `IMongoCollection<>` 属性？

**前端注册**：
- `App.tsx`：是否只新增了 Route？是否删除或修改了已有路由？
- `api.ts`：是否只新增了 API 路由定义？
- `toolboxStore.ts`：是否只在 `BUILTIN_TOOLS` 数组末尾追加了新条目？**关键**：见步骤 4.5 的 `wip: true` 检查
- `authzMenuMapping.ts`：是否只在 `menuList` / `allPermissions` 末尾追加？
- `marketplaceTypes.tsx`：是否只在 `CONFIG_TYPE_REGISTRY` 末尾新增了 key？
- `MobileHomePage.tsx`：是否只在 `QUICK_AGENTS_BASE` 末尾追加了 quick agent 项？
- `pages/home/sections/AgentGrid.tsx`：是否只在 `VISUAL_META` Record 末尾追加了新 key？删改已有 key（visual / literary / prd / video / defect / report / arena / workflow / shortcuts / review / transcript / code-review / translator / summarizer / data-analyst）= 越界

### 步骤 4.5：导航注册铁律检查（仅当 toolboxStore.ts 改动时触发）

如果 `prd-admin/src/stores/toolboxStore.ts` 在变更列表中：

```bash
git diff main...HEAD -- prd-admin/src/stores/toolboxStore.ts
```

**检查 1：是否在 `BUILTIN_TOOLS` 数组中追加了新条目**

寻找 diff 中以 `+` 开头的连续块，包含 `id: 'builtin-{agent-name}'` 模式。如果找到，说明这是一个新 Agent 注册。

**检查 2：新条目是否带 `wip: true`**

对每个新追加的 BUILTIN_TOOLS 条目，扫描其内部是否包含 `wip: true`：

```bash
git diff main...HEAD -- prd-admin/src/stores/toolboxStore.ts \
  | grep -E "^\+" | grep -E "id:\s*'builtin-|wip:\s*true"
```

判定规则：
- ✅ **合规**：每个新 `id: 'builtin-xxx'` 块内都有 `wip: true`
- ❌ **违规**：新条目缺 `wip: true` → 违反 `.claude/rules/navigation-registry.md` 铁律 #1

**检查 3：是否同时改了左侧导航 / 首页快捷**

如果 `AdminMenuCatalog.cs` / `authzMenuMapping.ts` / `MobileHomePage.tsx` / `pages/home/sections/AgentGrid.tsx` 任一被改动，说明用户在做"升级到左侧/首页"的操作。此时：
- 该 Agent 在 `toolboxStore.ts` 中**不应该**还带 `wip: true`（已经转正了）
- 多处注册的 `routePath` 必须一致（如 toolboxStore 的 `/review-agent` 和 menu catalog 的 `/review-agent`）

**输出**：在报告的"导航注册检查"小节明确写出：
- 推断的新 Agent 名（如 `builtin-review-agent`）
- 是否带 `wip: true`
- 是否多处注册一致

> 详细规则见 `.claude/rules/navigation-registry.md`。

### 步骤 5：输出报告

## 输出模板

```markdown
# 🔍 分支受控检查报告

**分支**: {branch-name}
**推断 Agent**: {agent-name}
**变更文件数**: {total} 个
**检查时间**: {YYYY-MM-DD HH:MM}

## 文件分类

### ✅ owned ({count} 个)
| 文件 | 变更类型 |
|------|---------|
| prd-admin/src/pages/review-agent/ReviewAgentPage.tsx | 新增 |
| prd-admin/src/stores/reviewAgentStore.ts | 新增 |
| ... | ... |

### 🔶 shared ({count} 个)
| 文件 | append-only 检查 | 详情 |
|------|-----------------|------|
| AdminPermissionCatalog.cs | ✅ 仅新增 | +2 行 |
| toolboxStore.ts | ✅ 仅新增 | +14 行（新增 BUILTIN_TOOLS 条目）|
| App.tsx | ⚠️ 有删改 | 删除了 1 行原有路由 |
| ... | ... | ... |

### ❌ foreign ({count} 个)
| 文件 | 风险说明 |
|------|---------|
| prd-admin/src/components/GlassCard.tsx | 共享 UI 组件，可能影响其他页面 |
| prd-api/src/.../LlmGateway.cs | 核心基础设施，影响所有 Agent |
| ... | ... |

## 导航注册检查（仅当 toolboxStore.ts 改动时输出）

| 检查项 | 结果 | 详情 |
|--------|------|------|
| 新增 BUILTIN_TOOLS 条目 | ✅ 1 个 / ➖ 无 | `id: 'builtin-review-agent'` |
| `wip: true` 标记 | ✅ 已带 / ❌ 缺失 | 见 `.claude/rules/navigation-registry.md` 铁律 #1 |
| 多处注册 routePath 一致 | ✅ 一致 / ⚠️ 不一致 / ➖ 仅百宝箱 | toolboxStore=`/review-agent`, menuCatalog=`/review-agent` |

## 结论

{根据以下规则输出}
```

### 结论判定规则

| 条件 | 结论 |
|------|------|
| foreign = 0 且 append 违规 = 0 且导航注册合规 | ✅ **边界合规**，可安全提交 |
| foreign = 0 且 append 违规 > 0 | ⚠️ **需人工审核**：shared 文件有非追加修改 |
| 新 BUILTIN_TOOLS 条目缺 `wip: true`（且未同时改 menu/QUICK_AGENTS）| ❌ **导航铁律违规**：新 Agent 必须默认 `wip: true`，验收通过后才转正 |
| 多处注册 routePath 不一致 | ❌ **路由分叉**：toolboxStore / menu / QUICK_AGENTS 之间的 routePath 必须完全一致 |
| foreign > 0 且均为文档/配置 | ⚠️ **轻度越界**：涉及非 Agent 文件，建议确认必要性 |
| foreign > 0 且包含核心代码 | ❌ **越界警告**：修改了核心基础设施或其他 Agent 代码 |

### foreign 文件风险标注

自动标注风险级别：

| 文件路径模式 | 风险 | 说明 |
|-------------|------|------|
| `*/Controllers/Api/*Agent*.cs`（其他 Agent） | 🔴 高 | 修改了其他 Agent 的 Controller |
| `*/Services/*Agent*`（其他 Agent） | 🔴 高 | 修改了其他 Agent 的服务 |
| `*/pages/*-agent/*`（其他 Agent） | 🔴 高 | 修改了其他 Agent 的前端页面 |
| `*/LlmGateway*`, `*/ModelResolver*` | 🔴 高 | 核心 AI 网关 |
| `*/Security/AdminAuth*`, `*/Middleware/*` | 🔴 高 | 认证/权限中间件 |
| `*/components/*` (共享组件) | 🟡 中 | 可能影响其他页面 |
| `*/lib/*`, `*/utils/*` | 🟡 中 | 共享工具库 |
| `doc/*`（非本 Agent） | 🟢 低 | 文档修改 |
| `scripts/*` | 🟢 低 | 构建脚本 |

## 特殊情况处理

### 用户是项目负责人

如果用户表示自己不是受限开发者（如"我是负责人"、"这是我自己的项目"）：
- 仍然输出报告（信息有价值）
- 但结论改为信息提示而非警告
- 不阻止任何操作

### 多 Agent 同时开发

如果变更涉及多个 Agent（如 `review-agent` 和 `defect-agent` 的文件都有改动）：
- 在报告中列出所有检测到的 Agent
- 分别按各自的 owned 范围分类
- 提示"本次变更涉及多个 Agent，建议拆分为独立分支"

### 纯文档/配置变更

如果变更全是文档或配置文件，没有代码文件：
- 跳过 Agent 推断
- 直接列出所有变更文件
- 结论为"非代码变更，无需边界检查"

## 关键约束

1. **只读不改** — 本技能只审计，不修改任何文件
2. **不阻断** — 报告越界但不阻止提交，决策权在人
3. **自动推断** — 尽量不问用户技术问题，从文件模式推断
4. **诚实报告** — 不确定的文件标记为"需人工确认"，不自作主张归类
