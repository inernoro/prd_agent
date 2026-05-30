# debt.task-tree

| 字段 | 内容 |
|---|---|
| 模块 | 个人任务树 Agent（`prd-api` TaskTreeController + `prd-admin` pages/task-tree） |
| 状态 | open（v1 已落地，2026-05-30；以下为已知边界，未排期） |
| 关联 | `prd-api/.../Controllers/Api/TaskTreeController.cs`、`prd-admin/src/pages/task-tree/`、`changelogs/2026-05-30_task-tree-agent.md` |
| 提出 | 用户需求：方便地（含对话）摘出个人任务与卡点，按树枝方式呈现进度，给自己/上级看 |

---

## 已知边界（v1 主动声明，下一轮可补）

1. **卡点墙仅聚合本人**。`GET /api/task-tree/blockers` 只返回当前用户自己的 blocked 节点。"给老板看的全员卡点墙"需要团队/汇报关系模型（谁管谁），属于借用法则范畴的缺失能力——当前不假装具备，UI 已注明"当前聚合本人卡点"。下一步：引入 team / report-line 模型后开放跨人聚合。

2. **依赖关系（DAG）前端只读**。后端已提供 `POST/DELETE nodes/{id}/dependencies` 增删依赖端点，但前端 v1 只渲染依赖虚线、未提供"添加依赖"的交互入口（拖连线/选择器）。

3. **节点坐标未持久化拖拽**。前端用 tidy/radial 自动布局，`PositionX/Y` 字段后端已存但未被前端用于"手动拖动节点并保存位置"。

4. **新建第二棵树入口缺失**。多树切换已支持（顶部下拉），但"再建一棵树"的入口目前只在空状态出现；已有树时新建入口待补。

5. **对话摘取无循环依赖/重复检测**。LLM 摘取只生成单节点挂到指定父节点，未做 DAG 环检测、未做"是否与已有任务重复"的判重。

6. **删除节点的依赖清理为全量扫描**。`DeleteNode` 用内存遍历收集子孙 + PullAll 清依赖引用，节点量极大时需改批量/索引优化（当前个人规模无压力）。

7. **无 MongoDB 索引**。按 `no-auto-index` 规则未自动建索引；`task_nodes` 的 `treeId` / `ownerId` / `(ownerId,status)` 查询若数据量上来需 DBA 手动建索引，登记到 `doc/guide.mongodb-indexes.md`。

## 后续波次建议

- W1：团队/汇报关系模型 → 真正的跨人卡点墙（边界 1）
- W2：前端依赖编辑（拖连线加依赖）+ 环检测（边界 2、5）
- W3：节点拖拽布局持久化 + 多树管理面板（边界 3、4）
