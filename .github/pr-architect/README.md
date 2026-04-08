# DDD Anchor PR 协作流程

## 1. 目标

本目录用于支持“顶层设计者裁决”场景，并且默认采用“顶层设计外部上传”模式：

- 顶层设计文档不内置到 Agent 逻辑中
- 通过设计包（bundle）实现跨项目复用
- 开发者按垂直切片提交 PR
- Agent 先进行预审并产出决策卡
- 顶层设计者仅基于关键证据做合并决策

目标是减少逐行审查成本，同时降低架构偏离与漏检风险。

### 1.1 设计前提（固定不变）

本方案严格基于以下固定前提，不随项目阶段改变：

- 顶层设计基线：锚定项 + DDD
- 执行组织方式：分配垂直切片任务
- 开发方式：开发者使用项目内 skills 体系完成切片实现
- 审批职责：最终合并审批责任由 Architect 承担

若以上任一前提缺失，Agent 仅能输出建议，不应作为合并门禁。

## 2. 外部顶层设计上传机制

### 2.1 设计包（Design Bundle）最小结构

顶层设计者需要维护一个可版本化的设计包，建议包含：

- `bundle_id`：设计包唯一标识
- `bundle_version`：版本号（建议语义化）
- `anchors_manifest`：锚定项清单（ID、约束、适用边界）
- `slices_manifest`：垂直切片清单（slice 与 owner 映射）
- `bounded_context_manifest`：上下文边界定义
- `checksum`：设计包完整性校验值（如 sha256）

### 2.2 激活方式

仓库内仅存放“设计源注册信息”，不强制存放设计正文：

- `design-sources.yml`：当前激活设计包引用
- 设计正文可放在对象存储、知识库或独立仓库

Agent 预审时从 `design-sources.yml` 获取当前生效版本，校验 PR 声明是否匹配。

## 3. 角色分工

- 顶层设计者（Architect）
  - 维护顶层设计约束（DDD、锚定项、上下文边界）
  - 维护 `design-sources.yml` 的激活版本
  - 对 PR 做最终裁决：`Approve` / `Approve with Guardrails` / `Request Changes` / `Block`
- 开发者（Slice Owner）
  - 只在分配的垂直切片内开发
  - 按 PR 模板完整提交元数据与测试证据
  - 明确声明本 PR 绑定的 `design_source_id` 与 `design_source_version`
  - 当 `contract_change_declared=true` 时，必须设置 `compatibility_plan_attached=true` 并附引用
- PR Agent（DDD-Anchor 裁决官）
  - 先校验设计源是否可用、版本是否匹配
  - 执行硬规则门禁
  - 进行风险评分
  - 输出决策卡与退回建议

## 4. 流程状态机

`task-assigned -> design-source-bound -> dev-selfcheck -> pr-open -> design-sync-gate -> agent-precheck -> architect-decision -> merge/rework`

### 4.1 task-assigned

任务分配时必须绑定以下信息：

- `slice_id`
- `bounded_context`
- `anchor_refs`
- `acceptance_criteria`

### 4.2 design-source-bound

顶层设计者确认并激活本轮使用的设计包（`design-sources.yml`）。

### 4.3 pr-open

开发者创建 PR 并填写模板必填字段，缺失字段视为不合格提交。

### 4.4 design-sync-gate

Agent 先校验以下条件：

1. `design-sources.yml` 存在且字段完整
2. PR 声明的 `design_source_id`、`design_source_version` 与激活版本一致
3. `anchor_refs` 能在当前 anchor 清单中找到

任一失败直接阻断，不进入下一阶段。

### 4.5 agent-precheck

Agent 按 `review-rules.yml` 执行：

1. 硬规则（命中即阻断）
2. 软规则（仅提示，不自动阻断）
3. 软评分（仅用于排序与关注，不直接阻断）
4. 输出决策卡（`decision-card-template.md`）

### 4.6 architect-decision

顶层设计者根据决策卡做最终判断，不再以逐行代码浏览为主。

## 5. 裁决逻辑（Architect）

1. 若存在任意阻断项，直接 `Block`
2. 否则根据风险分执行：
   - `0-20`: `Approve`
   - `21-39`: `Approve with Guardrails`
   - `>=40`: `Request Changes`
3. V1 阶段不允许仅凭风险分直接 `Block`
4. 对于连续两轮修订仍不达标的 PR，升级为 `Type C`（设计回炉）
5. 若设计包版本不一致或锚定项无法解析，优先按 `Type C` 处理

### 5.1 护栏通过（Approve with Guardrails）

当结论为 `Approve with Guardrails` 时，必须补充以下内容：

- `guardrail_plan`：灰度范围、监控指标、回滚阈值
- `rollback_trigger`：触发回滚的明确条件
- `owner_on_call`：风险接管责任人

缺失任一项，则降级为 `Request Changes`

## 6. 退回机制（PR 不符合预期）

所有退回必须使用统一结构，禁止模糊反馈。

### 6.1 退回单结构

1. 结论（`Request Changes` 或 `Block`）
2. 证据（文件/模块/行为）
3. 违背点（对应 anchor 或 DDD 约束）
4. 期望改法（可执行）
5. 重审条件（可验证）

### 6.2 退回类型

- Type A：同 PR 修复（局部问题）
- Type B：拆分 PR（范围失控，需拆切片）
- Type C：设计回炉（与顶设冲突，需先补 ADR 或修正设计包绑定）

## 7. 文件说明

- `../PULL_REQUEST_TEMPLATE.md`：开发者提交模板（包含设计包绑定字段）
- `review-rules.yml`：门禁规则、风险评分与退回策略
- `decision-card-template.md`：Agent 输出卡模板
- `label-taxonomy.md`：标签规范与自动化策略
- `design-sources.yml`：当前生效的顶层设计包引用
- `design-sources.example.yml`：设计源注册示例
- `repo-bindings.yml`：仓库到设计源/审批策略的绑定表（T1）
- `../scripts/pr_architect_check.py`：PR 门禁脚本（V1 仅执行 L1 硬阻断）
- `../scripts/pr_architect_prefill.py`：PR 模板字段自动回填脚本（T2）
- `../workflows/pr-architect-check.yml`：PR 自动校验工作流
- `../workflows/pr-architect-prefill.yml`：PR 自动回填工作流（T2）

## 8. P0 自动化能力（T1-T3）

### 8.1 T1 — 仓库绑定中心

通过 `repo-bindings.yml` 声明每个仓库的：

- `design_source_id` / `design_source_version`
- `required_checks`
- `architects`

门禁脚本会优先读取仓库绑定，不允许未绑定仓库直接进入规则判断。

### 8.2 T2 — 模板自动回填

`pr-architect-prefill` 工作流会在 PR 打开/编辑时自动补齐 section-1 的缺省字段：

- `design_source_id` / `design_source_version`
- `owner` / `bounded_context`
- 布尔字段默认值（如 `out_of_slice_changes=false`）

原则：仅填空，不覆盖开发者已填写值。

### 8.3 T3 — 统一检查与结果产物

`pr-architect-check` 在单次执行中完成：

1. L1 硬门禁
2. Advisory 提示
3. 产出结构化结果 JSON：`artifacts/pr-architect/review_run.json`

该 JSON 可作为后续决策卡发布、指标统计和审计追踪的统一输入。
