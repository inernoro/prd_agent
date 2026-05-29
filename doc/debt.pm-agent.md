# debt.pm-agent — 项目管理智能体工程债务台账

> 类型：debt（工程债务台账）｜状态：active｜最后更新：2026-05-29

记录项目管理智能体（pm-agent）已知边界、后续可补项与留尾。

## 已知边界（Phase 1 MVP 范围）

Phase 1 仅交付「执行层」：立项注册 + 任务 CRUD + 看板/列表/甘特图三视图 + AI 需求拆解。
以下「治理层」能力按方案分期，尚未实现：

| 能力 | 所属阶段 | 状态 | 说明 |
|------|----------|------|------|
| 干系人管理 + 权力利益矩阵 | Phase 2 | 未实现 | 干系人四象限分类、加权打分权重（受益方 2×） |
| NPSS 评价 | Phase 2 | 未实现 | 干系人 0-10 加权打分 → 满意度 → 项目分级（成功/平庸/失败） |
| 组织级 NPSS 仪表盘 + M.O.R.E 诊断 | Phase 3 | 未实现 | NPSS = 成功占比 − 失败占比，对比全球基线 36 |
| 项目奖金计算 | Phase 3 | 未实现 | 基数 × 价值系数 × (满意度/100)，<60 归零；基数/系数走配置 |
| 定期项目盘点 + 优秀项目评选 | Phase 3 | 未实现 | 季度/财年盘点 |
| 预算绑定 + 进度留痕监控（成本侧） | Phase 2 | 部分 | 模型已留 Budget/ActualCost 字段，UI 仅展示预算输入 |

## 留尾项（Phase 1 内的简化）

1. **Leader 职级强校验未落地**：方法论要求「战略级 S≥L3 / 运营级 O≥L2 担任 Leader」。
   当前 `User` 模型无职级字段，Controller 暂不强制校验。补法：User 增加 JobLevel 字段后，在 `PmAgentController.CreateProject` 加校验。
2. **甘特图为只读时间线**：横向滚动展示，暂不支持拖拽改期 / 依赖连线绘制（仅 tooltip 标注依赖数）。
   故未涉及 `gesture-unification` 画布手势规则。后续若升级为可拖拽画布需对齐该规则。
3. **任务编辑入口有限**：看板/列表支持改状态、删除、快速新增；详细编辑（负责人/排期/依赖）暂走 API，UI 编辑面板待补。
4. **PMO 注册关联文档**：模型预留 ProposalRef/PlanRef/SummaryRef 字段，UI 关联立项方案/计划/总结文档待补。

## 数据模型预留（已写入模型，UI 未全用）

- `PmProject`：StrategyAlignment、Budget、ActualCost、ProposalRef、PlanRef、SummaryRef、MemberIds
- `PmTask`：ParentTaskId（子任务）、DependsOn（依赖）、SourceRef（AI 拆解可追溯锚点）
