# debt.pm-agent — 项目管理智能体工程债务台账

> 类型：debt（工程债务台账）｜状态：active｜最后更新：2026-05-29

记录项目管理智能体（pm-agent）已知边界、后续可补项与留尾。

## 已知边界（Phase 1 MVP 范围）

Phase 1 交付「执行层」：立项 + 任务 CRUD + 看板/列表/甘特图 + AI 需求拆解。
Phase 2 交付「评价层」：干系人(权力利益矩阵) + NPSS 结案评价。
以下「组织治理层」能力按方案分期，尚未实现：

| 能力 | 所属阶段 | 状态 | 说明 |
|------|----------|------|------|
| 干系人管理 + 权力利益矩阵 | Phase 2 | 已完成 | 四象限分类 + 管理策略；角色加权（受益方 2×） |
| NPSS 评价（单项目） | Phase 2 | 已完成 | 干系人 0-10 加权打分 → 满意度(0-100) → 等级（成功/平庸/失败） |
| 组织级 NPSS 仪表盘 + M.O.R.E 自评 | Phase 3 | 已完成 | NPSS = 成功占比 − 失败占比，对比全球基线 36；M.O.R.E 为自评展示 |
| 项目奖金计算 + 奖金配置 | Phase 3 | 已完成 | 基数 × 价值系数 × (满意度/100)，<60 归零；整改/督办无奖金；基数走配置 |
| 定期项目盘点 + 优秀项目评选 | Phase 4 | 已完成 | 财年/季度盘点（财年起始月可配）+ 优秀项目星标评选 + 优秀奖金叠加 |
| 预算绑定 + 进度留痕监控（成本侧） | Phase 4 | 已完成 | 项目详情可编辑预算/实际成本；看板按时交付率 + 预算控制率 + 预算/实际汇总 |

## Phase 3 留尾

1. **NPSS 仪表盘聚合全部已评价项目**，未按财年/季度筛选；且当前对所有 pm-agent.use 用户可见（未做 PMO-only RBAC）。Phase 4 补时间维度筛选 + 角色收敛。
2. **M.O.R.E 为组织自评**（0-100 滑杆，存 reward-config），不自动从项目数据推导，不参与 NPSS 计算 —— 避免无根之木式的伪计算。
3. **奖金基数默认值**（S 10万/I 5万/O 3万）为占位，正式数值由 PMO 细则在看板内配置。

## Phase 4 留尾

1. **财年归属按"评价时间(EvaluatedAt)"判定**；若 PMO 口径应按"结案时间"则需调整 `FiscalYearOf` 取 ClosedAt。
2. **按时交付率**用 `ClosedAt <= PlannedEndAt` 判定，依赖项目填了计划结束时间且已结案；缺数据的项目不计入分母（显示 —）。
3. **优秀项目评选**为手动星标（任何 pm-agent.use 可操作）；方法论的"下财年首季度第二个月评选"时间窗口约束未做强制，PMO 自行把控时机。
4. **NPSS 看板 RBAC**：仍对所有 pm-agent.use 用户可见全量；PMO-only 收敛留待后续。

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
