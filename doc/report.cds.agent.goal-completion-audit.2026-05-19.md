# CDS Agent 商业级可用闭环目标审计报告

日期：2026-05-19

## 结论

目标级审计通过。当前 CDS Agent 商业级可用闭环达到“远端只读试用 + 本地扩展能力已验收 + 发布/写入灰度路径清晰”的完成标准：

- MAP/CDS 控制面保持不变，MAP 不直连 agent host。
- CDS 负责 runtime/container/sandbox，Claude Agent SDK 作为 CDS-managed runtime。
- 自研 agent loop 已压缩到 official SDK adapter 和必要胶水层；legacy loop 只保留为显式 fallback。
- 远端 provider-backed 只读代码巡检闭环通过。
- 简洁面板、可观测性、stop/timeout、工作流调度、KB 只读工具、Phase 2 写入扩展能力均有 smoke/单测/视觉/报告证据。
- Phase 4 P4-1/P4-2/P4-3/P4-4/P4-5 已全部收口。

审计命令：

```bash
CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit-current.json \
CDS_AGENT_GOAL_CYCLE_SUMMARY=/tmp/cds-agent-p4-2-one-cycle-accepted/cycle-summary.json \
CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS=120 \
bash scripts/audit-cds-agent-goal.sh
```

## 审计结果

| 项 | 结果 |
| --- | --- |
| Goal status | `complete` |
| Commercial complete | `true` |
| Current blocking gate | `complete` |
| A0 official SDK adapter boundary | pass |
| D0 docs current-state calibration | pass |
| D1 progress surface consistency | pass |
| N6 non-code compatibility | pass |
| Evidence index quality | pass |
| Runtime pool recovery | pass |
| Branch isolation apply manifest | clean from runtime pool summary |
| Cycle status | `provider_smokes_passed` |
| Cycle freshness | fresh |
| Cycle git status | compatible non-runtime drift |
| Gates | R0/A0/R1/S1/S2/S3/V1/N6 pass |

## 关键证据

| 要求 | 证据 |
| --- | --- |
| MAP/CDS 控制面 | `scripts/audit-cds-agent-goal.sh` A0/D1 pass；`doc/design.cds.agent.commercial-architecture-and-roadmap.md` §1/§2 |
| 官方 SDK adapter 主路径 | A0 pass：official adapter 289/320，bridge support 509/650，总胶水 798/850，legacy loop 425 |
| 远端只读代码巡检 | `/tmp/cds-agent-p4-2-one-cycle-accepted/s1-report.json` pass |
| 危险工具阻断与 stop | `/tmp/cds-agent-p4-2-one-cycle-accepted/controls-report.json` pass |
| 远端视觉验收 | `/tmp/cds-agent-p4-2-one-cycle-accepted/workbench-visual.png`；coverage pass |
| 工作流调度 | `scripts/smoke-cds-agent-workflow-node.sh`；Phase 1 report |
| KB 只读工具 | `scripts/smoke-cds-agent-kb-readonly-tools.sh`；Phase 1 report |
| 写入扩展路径 | `doc/report.cds.agent.p4-5-writable-trial-plan.2026-05-19.md`；Phase 2 report |
| 进度唯一看板 | `doc/design.cds.agent.commercial-architecture-and-roadmap.md` |

## 当前发布状态

| 项 | 当前值 |
| --- | --- |
| branch | `codex/cds-agent-workbench-ui` |
| remote preview | `https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/cds-agent` |
| validated runtime commit | `6b2f1552e` |
| current branch head during audit | see `/tmp/cds-agent-goal-audit-current.json` after the latest audit run |
| runtime relation | `runtime_matches_head` for validated runtime; later drift is compatible non-runtime docs/scripts |
| deploy advice | no deploy needed unless code/profile changes or branch is promoted |

## 仍需用户选择的后续路径

这些不是当前只读商业级闭环的阻塞项，而是下一阶段选择：

1. 继续 preview 真实试用并收集问题。
2. 按 P4-4 路径，把 `origin/main` 合入当前分支，跑发布门禁和 preview 验收。
3. 按 P4-5 路径，进入 W1/W2 KB draft/apply 写入灰度，先指定试用知识库和 owner。

## 审计限制

本次审计没有执行新的远端部署，也没有重复 provider 调用。P4-2 one-cycle 是当前远端 runtime 行为的权威证据；P4-3/P4-4/P4-5 之后的变化为文档和脚本校准，审计判定为 compatible non-runtime drift。
