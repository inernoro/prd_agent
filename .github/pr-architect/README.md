# DDD Anchor PR 协作流程

## 1. 目标

本目录用于支持“顶层设计者裁决”场景：

- 开发者按垂直切片提交 PR
- Agent 先进行预审并产出决策卡
- 顶层设计者仅基于关键证据做合并决策

目标是减少逐行审查成本，同时降低架构偏离与漏检风险。

## 2. 角色分工

- 顶层设计者（Architect）
  - 维护顶层设计约束（DDD、锚定项、上下文边界）
  - 对 PR 做最终裁决：`Approve` / `Request Changes` / `Block`
- 开发者（Slice Owner）
  - 只在分配的垂直切片内开发
  - 按 PR 模板完整提交元数据与测试证据
- PR Agent（DDD-Anchor 裁决官）
  - 执行硬规则门禁
  - 进行风险评分
  - 输出决策卡与退回建议

## 3. 流程状态机

`task-assigned -> dev-selfcheck -> pr-open -> agent-precheck -> architect-decision -> merge/rework`

### 3.1 task-assigned

任务分配时必须绑定以下信息：

- `slice_id`
- `bounded_context`
- `anchor_refs`
- `acceptance_criteria`

### 3.2 pr-open

开发者创建 PR 并填写模板必填字段，缺失字段视为不合格提交。

### 3.3 agent-precheck

Agent 按 `review-rules.yml` 执行：

1. 硬规则（命中即阻断）
2. 软评分（生成风险级别与建议）
3. 输出决策卡（`decision-card-template.md`）

### 3.4 architect-decision

顶层设计者根据决策卡做最终判断，不再以逐行代码浏览为主。

## 4. 裁决逻辑（Architect）

1. 若存在任意阻断项，直接 `Block`
2. 否则根据风险分执行：
   - `0-20`: `Approve`
   - `21-49`: `Request Changes`
   - `>=50`: `Block`
3. 对于连续两轮修订仍不达标的 PR，升级为 `Type C`（设计回炉）

## 5. 退回机制（PR 不符合预期）

所有退回必须使用统一结构，禁止模糊反馈。

### 5.1 退回单结构

1. 结论（`Request Changes` 或 `Block`）
2. 证据（文件/模块/行为）
3. 违背点（对应 anchor 或 DDD 约束）
4. 期望改法（可执行）
5. 重审条件（可验证）

### 5.2 退回类型

- Type A：同 PR 修复（局部问题）
- Type B：拆分 PR（范围失控，需拆切片）
- Type C：设计回炉（与顶设冲突，需先补 ADR）

## 6. 文件说明

- `../PULL_REQUEST_TEMPLATE.md`：开发者提交模板
- `review-rules.yml`：门禁规则、风险评分与退回策略
- `decision-card-template.md`：Agent 输出卡模板
- `label-taxonomy.md`：标签规范与自动化策略
