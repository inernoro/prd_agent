# 导航注册规则（新 Agent / 新路由必须自动出现在所有入口）

新加路由 / 新加智能体 / 新加菜单后，「设置→导航顺序」的「可添加」池 + Cmd+K 命令面板必须**自动同步**，不能让用户在某一处找不到。本规则保证这件事**通过程序强制**而不是靠人记。

---

## 0. 关键原则：单一数据源 (SSOT)

所有用户可见路由的元信息都集中在三个文件，下游消费者全部从这里读：

| 数据源 | 内容 | 谁消费 |
|---|---|---|
| `prd-admin/src/stores/agentSwitcherStore.ts` 的 `AGENT_DEFINITIONS` | 4 个核心智能体（视觉/文学/缺陷/视频） | launcherCatalog → AgentSwitcher / NavLayoutEditor |
| `prd-admin/src/stores/toolboxStore.ts` 的 `BUILTIN_TOOLS` | 百宝箱内置工具（含 `wip` 标记） | 同上 |
| `prd-admin/src/lib/launcherCatalog.ts` 的 `buildUtilityItems / buildInfraItems` | 实用工具 + 基础设施 | 同上 |

`getLauncherCatalog({menuCatalog})` 读完三个源 + 整合后端 `menuCatalog`（含「其他菜单」组）→ 返回**单一目录**。所有 UI 入口（侧边栏 / 设置页可添加池 / Cmd+K）都从这一份数据生成。

**结论：把新路由信息写到上述任一处，两个面板自动看见。**

---

## 1. 新增路由的注册流程

### 智能体（agent，5 个之内的核心 Agent）
1. `agentSwitcherStore.ts` 的 `AGENT_DEFINITIONS` 加条目
2. `App.tsx` 加 `<Route path="/xxx" .../>`
3. `lib/shortLabel.ts` 的 `SHORT_LABEL_MAP` 加 ≤4 字短标签
4. 后端如需后台管理菜单，参照 `AdminMenuCatalog.cs`

### 百宝箱工具（toolbox）
1. `toolboxStore.ts` 的 `BUILTIN_TOOLS` 加条目，**默认 `wip: true`**
2. `App.tsx` 加 Route
3. `shortLabel.ts` 加短标签
4. 通过 CLAUDE.md 规则 #8 完整验收后再删 `wip`

### 实用工具 / 基础设施（utility / infra）
1. `lib/launcherCatalog.ts` 的 `buildUtilityItems` 或 `buildInfraItems` 加条目
2. `App.tsx` 加 Route
3. `shortLabel.ts` 加短标签
4. 如有权限要求，填 `permission` 字段（与目标路由 `RequirePermission` 1:1）

### 后端菜单（admin / 特殊权限页）
1. `prd-api/.../AdminMenuCatalog.cs` 加条目（含 `appKey / path / label / icon / group / sortOrder`）
2. 前端零改动 —— `AgentSwitcher` 调用 `getLauncherCatalog({menuCatalog})` 时自动并入「其他菜单」分组
3. `shortLabel.ts` 补 ≤4 字短标签

---

## 2. 自动化护栏（CI 不通过就别想合并）

### 测试：`prd-admin/src/lib/__tests__/navCoverage.test.ts`

跑 `pnpm test` 时执行，两条规则：

#### 测试 1：用户路由必须注册
扫描 `App.tsx` 所有 `<Route path="X">`，每条路由必须满足之一：
- 在 `launcherCatalog` 注册（前端单一数据源）
- 在 `ALLOW_LIST` 显式豁免并注释原因（admin 后端注册 / 子路由 / redirect / 移动端等）
- 是参数化 / 通配 / 子路由（自动豁免）

未通过时打印精确修复指引。

#### 测试 2：launcherCatalog 中的 route 必须真实存在
扫描 `launcherCatalog` 的所有 route，必须能在 `App.tsx` 找到对应 `<Route>`。否则就是 phantom 路由（点击 404）。

历史教训：v0 之前 `infra:models` 写了 `/models`、`utility:prompts` 写了 `/prompts`，但 App.tsx 实际只有 `/mds` 没有 `/prompts`。点开就 404，没人发现。本测试根除此类 bug。

### 触发场景
- 本地：`pnpm test`
- CI：标准测试套件
- 修改 launcherCatalog 或 App.tsx 后：必须本地跑通才 push（CLAUDE.md 规则 #5.2）

---

## 3. 交付声明（不变）

新 Agent 交付时仍必须有【位置】+【路径】+【预览】三行（CLAUDE.md 规则 #9 / #11），但**不再需要**手工列出"是否同步到 Cmd+K / 设置页"——已通过测试保证。

---

## 4. 审计清单（PR 提交前）

- [ ] 新路由已写到 `App.tsx`
- [ ] 在 `agentSwitcherStore` / `toolboxStore` / `launcherCatalog` 任一处注册（按上面的分类决定哪个）
- [ ] `shortLabel.ts` 加 ≤4 字短标签
- [ ] `pnpm test src/lib/__tests__/navCoverage.test.ts` 全绿
- [ ] 交付消息含【位置】+【路径】+【预览】三行

如以上任一项 ❌，请回头修，禁止"先合后补"。

---

## 5. 历史背景

- 2026-04-26 用户反馈「网页托管/知识库/智识殿堂等找不到」——根因是 launcherCatalog `infra` 分组被 NavLayoutEditor 默默过滤、AgentSwitcher 和 menuCatalog 隔离
- 2026-04-27 重构为 SSOT 模型 + 增加 `navCoverage` 测试。从此「加路由忘了登记」变成 CI 不绿
