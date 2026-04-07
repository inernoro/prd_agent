# PR 提交模板（锚定项 + DDD + 垂直切片 + skills + 外置设计源）

> 说明：本模板用于“顶层设计裁决”流程。未完整填写必填项的 PR 将被自动判定为不合格提交。

## 1) 基础元数据（必填）

```yaml
slice_id:
bounded_context:
anchor_refs: []          # 例如: [ANCHOR-101, ANCHOR-203]
task_link:
owner:
skills_used: []          # 例如: [skill-a@1.0.0, skill-b@2.1.3]
skills_traceability_attached: false  # 是否附上 skills 执行追溯证据
design_source_id:        # 设计源标识，例如: system-main
design_source_version:   # 设计版本，例如: 2026.04.1
out_of_slice_changes: false
contract_change_declared: false
critical_path_changed: false
```

## 2) 需求与设计映射（必填）

- 本 PR 解决的问题：
- 与顶层设计的映射关系（必须对应 anchor_refs）：
- 顶层设计包位置（URL/文件路径）：
- 设计源校验方式（tag/commit-hash/checksum 任选其一）：
- 本 PR 是否改变既有 DDD 边界：
  - [ ] 否
  - [ ] 是（若选“是”，必须在下方提供 ADR 链接）
- ADR 链接（如无则填 N/A）：

## 3) 改动范围说明（必填）

- 主要改动模块：
- 非目标改动（如重构/顺手修复）：
- `out_of_slice_changes`（需与基础元数据一致）：
  - [ ] false（无越界）
  - [ ] true（有越界，必须说明原因、影响、回滚方式）
- 越界改动说明（若无填 N/A）：
- 垂直切片领取记录（任务单或看板链接）：

## 4) 测试证据（必填）

```yaml
tests_evidence:
  unit:
  integration:
  e2e:
  manual:
```

```yaml
skills_traceability:
  - skill: ""
    version: ""
    run_ref: ""       # 执行记录链接/日志ID/产物路径
    override_reason: ""  # 如有人工改写，需填写原因
```

- 涉及契约变更时是否补充兼容/迁移说明：
  - [ ] 是
  - [ ] 否（说明原因）

## 5) 自检清单（提交前必须全选）

- [ ] 仅覆盖本次 `slice_id` 的主目标
- [ ] `bounded_context` 未发生未声明的跨域调用
- [ ] `anchor_refs` 与实现一一对应
- [ ] 本 PR 由分配的切片 owner 完成（或已明确协作关系）
- [ ] `skills_used` 已标明名称与版本，且可追溯执行记录
- [ ] `skills_traceability_attached` 与实际证据一致
- [ ] 未引入新的权限绕过路径
- [ ] 关键接口响应结构符合项目统一契约
- [ ] 若有数据结构变更，已给出迁移/回滚方案
- [ ] 已提供最小可复现测试证据

## 6) 风险声明（必填）

```yaml
risk_level: low|medium|high
risk_notes:
rollback_plan:
```

## 7) Agent 预审结果（由自动化/提交者补充）

- 建议裁决：`Approve` / `Approve with Guardrails` / `Request Changes` / `Block`
- 阻断项：
- 风险项：
- 护栏要求（如适用）：
- 架构师关注问题（最多 3 项）：

## 8) 架构师裁决区（由 Architect 填写）

- 最终裁决：`Approve` / `Approve with Guardrails` / `Request Changes` / `Block`
- 退回类型（如适用）：`Type A` / `Type B` / `Type C`
- 必改项（必须可执行）：
- 护栏条件（开关/灰度/监控/回滚触发）：
- 重审条件（必须可验证）：
