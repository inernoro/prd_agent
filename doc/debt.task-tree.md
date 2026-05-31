# debt.task-tree

| 字段 | 内容 |
|---|---|
| 模块 | 个人任务树 Agent（`prd-api` TaskTreeController + `prd-admin` pages/task-tree） |
| 状态 | open（v1 已落地，2026-05-30；以下为已知边界，未排期） |
| 关联 | `prd-api/.../Controllers/Api/TaskTreeController.cs`、`prd-admin/src/pages/task-tree/`、`changelogs/2026-05-30_task-tree-agent.md` |
| 提出 | 用户需求：方便地（含对话）摘出个人任务与卡点，按树枝方式呈现进度，给自己/上级看 |

---

## 进度

- v1（2026-05-30）：全栈落地（树/节点 CRUD、对话摘取、卡点墙本人聚合）。
- v2（2026-05-31）：编辑增强 + 全员卡点墙。**已偿还** 原边界 1（部分）/2/4，详见下。

## 已偿还（v2）

- **依赖关系前端可编辑**（原边界 2）：侧栏「加依赖」下拉选择 + chip × 移除，候选已排除自身与子孙（防直接成环）。
- **新建任务树入口**（原边界 4）：顶部「新建树」按钮，任意时刻可建。
- **节点手动 CRUD**：加子任务、重命名、删除（含子树）全部落地，不再只能靠对话摘取。
- **全员卡点墙**（原边界 1 部分）：`GET /api/task-tree/blockers?scope=all` 聚合所有人卡点，门控权限 `task-tree.view-all`（仅 admin/operator），返回 ownerName；前端「我的/全员」切换。

## 仍存边界（下一轮）

1. **"全员"≠ 真团队**。当前 `scope=all` 是"有权限者看所有人"，不是按汇报关系/团队成员的精确聚合。真正的"我下属的卡点"仍需 team / report-line 模型。
2. **依赖仅防直接成环**。加依赖时排除自身与子孙，但未做跨枝多跳的完整 DAG 环检测；对话摘取也未做重复判重。
3. **节点坐标未持久化拖拽**。tidy/radial 自动布局，`PositionX/Y` 后端已存但前端未用于手动拖拽保存。
4. **删除节点依赖清理为全量扫描** + **无 MongoDB 索引**（按 `no-auto-index`，数据量上来需 DBA 建 `task_nodes` 的 treeId/ownerId/(ownerId,status) 索引）。

## 后续波次建议

- W1：团队/汇报关系模型 → 按下属精确聚合卡点（仍存边界 1）
- W2：完整 DAG 环检测 + 摘取判重（仍存边界 2）
- W3：节点拖拽布局持久化（仍存边界 3）
