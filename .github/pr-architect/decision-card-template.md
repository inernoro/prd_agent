# PR审查棱镜 决策卡模板（Agent 输出）

> 用途：供 PR Agent 自动生成结构化审查结果，帮助顶层设计者快速裁决。

## A. 基础信息

- PR：`<PR_NUMBER_OR_URL>`
- 标题：`<PR_TITLE>`
- 提交者：`<AUTHOR>`
- `slice_id`：`<SLICE_ID>`
- `bounded_context`：`<BOUNDED_CONTEXT>`
- `anchor_refs`：`<ANCHOR_REFS>`
- `design_source_id`：`<DESIGN_SOURCE_ID>`
- `design_source_version`：`<DESIGN_SOURCE_VERSION>`

## B. 裁决建议

- 建议：`Approve` / `Approve with Guardrails` / `Request Changes` / `Block`
- 风险分：`<SCORE>/100`
- 置信度：`<CONFIDENCE>`
- 触发硬阻断：`Yes` / `No`
- 护栏（仅当建议为 `Approve with Guardrails` 时必填）：
  1. `<GUARDRAIL_1>`
  2. `<GUARDRAIL_2>`

## C. 阻断项（必须修复）

| ID | 证据 | 违背点 | 期望改法 |
|---|---|---|---|
| `<RULE_ID>` | `<FILE_OR_BEHAVIOR>` | `<ANCHOR_OR_DDD_RULE_OR_DESIGN_VERSION>` | `<ACTIONABLE_FIX>` |

> 无阻断项时填写：`None`

## D. 风险项（建议修复）

| 维度 | 风险描述 | 影响 | 建议 |
|---|---|---|---|
| `<DIMENSION>` | `<RISK_DESC>` | `<IMPACT>` | `<SUGGESTION>` |

> 无风险项时填写：`None`

## E. 架构师关注问题（最多 3 项）

1. `<QUESTION_1>`
2. `<QUESTION_2>`
3. `<QUESTION_3>`

## F. 退回单（当结论不是 Approve 时必填）

- 结论：`Request Changes` / `Block`
- 退回类型：`Type A` / `Type B` / `Type C`
- 重审条件：
  1. `<CHECKABLE_CONDITION_1>`
  2. `<CHECKABLE_CONDITION_2>`
- 备注：`<OPTIONAL_NOTE>`

## G. 架构师最终裁决（人工填写）

- 最终结论：`Approve` / `Approve with Guardrails` / `Request Changes` / `Block`
- 最终意见：`<FINAL_NOTE>`
