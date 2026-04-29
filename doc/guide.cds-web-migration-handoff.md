# CDS Web 迁移交接 · 指南

> **版本**：v1.1 | **日期**：2026-04-29 | **状态**：Week 4.6 视觉重构进行中

## 总览

当前分支：`claude/review-migration-planning-tulFY`（接棒 codex/migrate-cds-settings 的工作，进入 Week 4.6 视觉重构）

## 关键转折（2026-04-29）

路由迁移已经达到 90%，但用户验收明确表态满意度只有 50%——"看起来大气，但实际比旧版臃肿、破碎感强、心智负担重"。继续往 Week 5 删 legacy 等于把"50% 满意度"定型，因此**新增 Week 4.6 视觉与主链路重构阶段**插在 Week 4.5 与 Week 5 之间。详见 `doc/plan.cds-web-migration.md` Week 4.6 章节。

Week 4.6 第一刀：抽出 `AppShell / TopBar / Workspace / Crumb` 共享布局组件 + 引入 surface 三档（base/raised/sunken）+ hairline 边框 token；用 ProjectListPage 做完整切片验证（hero 表单收敛 + 项目卡极简化 + 工具入口折叠）。后续切片按顺序推进 BranchListPage → BranchDetailPage → 设置页 → 拓扑页 → 全局视觉残留清理。

本轮目标是把 CDS 从 legacy HTML/JS 迁到 React，同时围绕用户核心诉求收敛产品复杂度：

1. 快速操作：粘贴仓库即可创建项目、clone、自动识别 profile。
2. 快速预览：进入项目后粘贴或选择分支即可创建、部署并打开预览。
3. 自动操作：Agent import、全局/项目 Agent Key、GitHub webhook 和事件策略进入 React 管理。
4. 多项目：fresh install 不再出现空 `default` 项目；legacy default 只作为旧数据兼容存在。
5. 默认 MongoDB：新初始化走 `mongo-split`，生产运行不再静默退回单文件 `state.json`。

旧前端 `cds/web-legacy/` 仍保留作为功能 reference。用户已经明确要求：删除旧代码必须再次确认。

## 必读维护文档

这份 handoff 不是唯一交接材料。下一个 agent 必须同时阅读并维护下面两个文档，它们是本次迁移交接包的一部分：

| 文档 | 必读原因 | 什么时候更新 |
|------|----------|--------------|
| `doc/guide.cds-web-migration-runbook.md` | 维护手册。记录当前可执行命令、本地验收方式、防遗忘机制、视觉/交互约束、当前下一步和测试注意事项。 | 每次改变本地启动、测试、验收、浏览器检查、交接节奏时更新。 |
| `doc/plan.cds-web-migration.md` | 总计划。记录 Week 2-5 迁移路线、已完成项、Week 4.5 功能差距清单、Week 5 删除 legacy 的前置条件和进度日志。 | 每完成一个迁移能力、调整剩余路线、决定保留/放弃某个 legacy 能力时更新。 |

阅读顺序：

1. 先读本文件，了解当前 PR 交付范围和不要踩的边界。
2. 再读 `doc/guide.cds-web-migration-runbook.md`，确认本地命令、验收方式和“继续工作不遗忘”的记录方式。
3. 最后读 `doc/plan.cds-web-migration.md`，决定下一步是否继续 Week 4.5 收口，或等待用户确认进入 Week 5 删除 legacy。

硬规则：

- 聊天里的“下一步”和“必跑命令”不能只留在对话里，必须写回 runbook 或 plan。
- 如果新增、删除或推迟任何迁移任务，必须更新 `doc/plan.cds-web-migration.md` 的 Week 4.5 清单或进度日志。
- 如果改变测试命令、浏览器验收方式、沙箱限制处理方式，必须更新 `doc/guide.cds-web-migration-runbook.md`。

## 已迁移页面

| 路由 | 状态 | 说明 |
|------|------|------|
| `/project-list` | 已迁移 | 项目控制台、Git URL 创建、GitHub 仓库选择、clone 进度、Agent pending import、全局/项目 Agent Key、技能包入口 |
| `/settings/:projectId` | 已迁移基础功能 | 基础信息、GitHub 绑定、事件策略、评论模板、项目环境变量、缓存诊断、统计、活动、危险区 |
| `/cds-settings` | 已迁移 | 认证、GitHub App、存储、集群、全局变量、维护、自更新、强制同步 |
| `/branches/:projectId` | 已迁移 | 一键预览、远程分支、已跟踪分支、部署/预览/详情、更多操作、批量、容量、执行器、活动流 |
| `/branch-panel/:branchId` | 已迁移 | 分支详情、失败诊断、服务状态、部署日志、容器日志、profile override、Bridge、提交、HTTP 转发日志 |
| `/branch-topology?project=<id>` | 已迁移 | 简化拓扑、节点详情、日志/提交入口、粘贴分支后跳回分支控制台复用一键预览 |

## 关键架构

React 工程在 `cds/web/`，legacy 在 `cds/web-legacy/`。服务器通过 `MIGRATED_REACT_ROUTES` 显式枚举已迁移路由：

```txt
/hello
/cds-settings
/project-list
/branches
/branch-list
/branch-panel
/branch-topology
/settings
```

优先级仍是：

1. `/api/**`：Express 后端。
2. React 已迁移路由和 `/assets/**`：`cds/web/dist/`。
3. legacy fallback：`cds/web-legacy/`。

不要直接让 React 接管全部 `/`，直到 Week 5 确认删除 legacy。

## 本轮重点变更

### 初始化和存储

- `./exec_cds.sh init` 不再询问是否启用 MongoDB。
- 新初始化默认启动 `cds-state-mongo` 并写入 `CDS_STORAGE_MODE=mongo-split`。
- 真实运行时没有 `CDS_MONGO_URI` 时会要求先 init；只有测试或显式 `CDS_STORAGE_MODE=json/auto` 保留 JSON 兼容。
- `.gitignore` 增加 `cds/.cds-repos/`，避免本地 clone fixture 被误提交。

### default 项目

- fresh install 空状态为 0 项目，不再生成空 `default`。
- 旧数据里有 pre-project branches/profiles 时才迁移 legacy default。
- 测试中需要 legacy default 的地方必须显式 seed，不能依赖 `StateService` 自动制造。

### 分支主链路

- `/branches/:projectId` 默认只暴露主动作：预览、详情、部署。
- 筛选、排序、批量、容量、主机、执行器、活动流默认折叠到二级入口。
- 部署动作卡展示阶段、耗时、最近步骤、失败建议和复制排错摘要。
- `/branch-topology` 的“粘贴分支并预览”不会复制部署状态机，而是跳转到 `/branches/:projectId?preview=<branch>`。

### 视觉与组件

- 移除大面积全屏网格背景。
- 页面收敛为居中工作区和统一深色表面。
- 新增共享 `DisclosurePanel`，分支详情、拓扑节点、维护页、项目页都复用。
- 复用 `MetricTile` 作为小型统计块，避免继续造局部组件。

## 已验证

最后一次验证命令：

```bash
pnpm --prefix cds/web typecheck
pnpm --prefix cds/web build
pnpm --prefix cds build
pnpm --prefix cds exec vitest run tests/routes/server-integration.test.ts tests/routes/branches.test.ts tests/integration/view-parity.smoke.test.ts
pnpm --prefix cds exec vitest run tests/routes/projects.test.ts tests/routes/legacy-cleanup.test.ts tests/routes/pending-import.test.ts
```

结果：

- 前端 typecheck 通过。
- 前端 build 通过。
- 后端 `tsc` 通过。
- 重点路由测试 65 passed。
- 项目 / legacy cleanup / pending import 测试 68 passed。
- 浏览器检查 `/project-list`、`/branches/c3d98fe1d949`、`/branch-topology?project=c3d98fe1d949`、`/cds-settings#maintenance`：DOM 关键内容存在，控制台无错误。

注意：本地全量 `pnpm --prefix cds test` 在沙箱内会因为 `listen EPERM 127.0.0.1` 失败。需要在允许监听 localhost 的环境跑，或只跑目标测试。

## 下一个 agent 从这里继续

优先顺序：

1. 等用户验收 React 版能力和视觉层级。
2. 若用户认为拓扑还需要更强画布体验，再考虑 React Flow；未确认前保持当前低复杂度拓扑。
3. 若用户确认 React 版能力足够，再进入 Week 5 删除 legacy：
   - 删除或归档 `cds/web-legacy/`。
   - 去掉 legacy 静态 mount 和 fallback。
   - 根路径 `/` 由 React 接管。
   - 删除过期 UI 规则。
4. 如果用户继续要求打磨，先看 `doc/plan.cds-web-migration.md` 的 Week 4.5 差距清单，不要凭感觉扩功能。

## 不要做

- 不要删除 `cds/web-legacy/`，除非用户明确确认。
- 不要重新引入 `/v2` 前缀。
- 不要把 default 项目恢复成 fresh install 自动创建。
- 不要把拓扑页做成第二套部署入口。
- 不要提交 `cds/.cds-repos/`、`cds/.cds.env`、`cds/.cds/` 等本地运行数据。

## 主要文件

| 文件 | 用途 |
|------|------|
| `cds/web/src/pages/ProjectListPage.tsx` | 项目控制台 |
| `cds/web/src/pages/BranchListPage.tsx` | 分支控制台和一键预览主链路 |
| `cds/web/src/pages/BranchDetailPage.tsx` | 分支详情和诊断 |
| `cds/web/src/pages/BranchTopologyPage.tsx` | 简化拓扑 |
| `cds/web/src/pages/CdsSettingsPage.tsx` | CDS 系统设置 |
| `cds/web/src/pages/ProjectSettingsPage.tsx` | 项目设置 |
| `cds/web/src/components/ui/disclosure-panel.tsx` | 共享折叠面板 |
| `doc/plan.cds-web-migration.md` | 总计划和差距清单 |
| `doc/guide.cds-web-migration-runbook.md` | 当前命令、验收和防遗忘机制 |
| `changelogs/2026-04-28_branch-list-react.md` | 分支/拓扑迁移记录 |
