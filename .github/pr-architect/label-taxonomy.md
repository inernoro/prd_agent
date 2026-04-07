# PR 标签规范（DDD Anchor 协作，V1 最小可复用）

## 1. 目标

通过统一标签体系实现：

- 快速识别 PR 所属切片与上下文
- 支持 Agent 自动标注风险与阻断
- 让 Architect 仅关注高优先级待裁决 PR

## 2. 标签分组

### 2.1 归属类（必备）

| 标签模式 | 示例 | 责任人 | 说明 |
|---|---|---|---|
| `slice:<id>` | `slice:payment-reconcile` | 提交者 | 标识垂直切片归属 |
| `context:<name>` | `context:billing` | 提交者 | 标识 bounded context |
| `owner:<user>` | `owner:alice` | 提交者 | 标识主责任人 |

### 2.2 设计与约束类（Agent 自动）

| 标签 | 设置方 | 含义 |
|---|---|---|
| `anchor:missing` | Agent | 缺失锚定项映射或映射不完整 |
| `design-pack:missing` | Agent | 未声明或无法解析顶层设计包来源 |
| `design-pack:version-mismatch` | Agent | PR 声明的设计包版本与当前生效版本不一致 |
| `scope:out-of-slice` | Agent | 检测到越界改动 |
| `ddd:boundary-risk` | Agent | 疑似破坏 DDD 边界 |
| `contract:changed` | Agent | API/事件契约发生变更 |
| `tests:insufficient` | Agent | 测试证据不足 |

### 2.3 风险等级类（Agent 自动）

| 标签 | 含义 |
|---|---|
| `risk:low` | 可直接进入人工快速复核 |
| `risk:medium` | 建议修复后再合并 |
| `risk:high` | 高风险，默认不合并 |

### 2.4 决策状态类（Architect）

| 标签 | 含义 |
|---|---|
| `decision:approve` | 可合并 |
| `decision:approve-with-guardrails` | 带护栏通过（需满足监控/开关/回滚条件） |
| `decision:request-changes` | 需要修订 |
| `decision:block` | 阻断合并 |
| `decision:type-a` | 同 PR 修复 |
| `decision:type-b` | 拆分 PR |
| `decision:type-c` | 设计回炉 |

### 2.5 流程类（自动化）

| 标签 | 触发条件 |
|---|---|
| `agent:precheck-passed` | Agent 完成预审且无阻断 |
| `agent:precheck-failed` | Agent 预审有阻断项 |
| `architect:review-required` | 风险中高或触发硬规则 |
| `ready-to-merge` | Architect 给出 `decision:approve` 且 CI 通过 |

## 3. 使用规范

1. 新建 PR 时必须带上归属类标签（`slice/context/owner`）。
2. Agent 标签由自动化维护，人工不应随意修改。
3. Architect 决策后必须更新决策状态类标签。
4. 当标签与 PR 内容冲突时，以 `review-rules.yml` 判定为准。

## 4. 最小自动化策略

1. PR 打开后：
   - 校验是否有 `slice:*` 与 `context:*`
   - 缺失则打 `anchor:missing` 并标记 `agent:precheck-failed`
2. 规则命中硬阻断：
   - 打 `risk:high` + `architect:review-required`
3. 无硬阻断且 advisory 风险可控：
   - 打 `agent:precheck-passed`
4. 架构师最终审批后：
   - 若结论为 `Approve with Guardrails`，必须加 `decision:approve-with-guardrails`
   - 若结论为 `Approve`，可加 `ready-to-merge`（仍需 CI 通过）
