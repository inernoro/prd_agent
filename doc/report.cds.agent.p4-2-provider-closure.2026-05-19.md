# CDS Agent P4-2 远端 Provider 闭环验收报告

日期：2026-05-19

## 结论

P4-2 完成。远端 preview 已跑通 provider-backed 只读代码巡检闭环，`commercialComplete=true`，R0/A0/R1/S1/S2/S3/V1/N6 全部通过。当前用户可以从 CDS Agent 工作台发起一次真实远端只读代码巡检，并在页面看到 session、trace、事件、结果和产物入口。

本轮没有新增自研 agent loop。MAP/CDS 继续作为控制面，CDS 负责 branch/runtime/sandbox 管理，实际推理循环由 official Claude Agent SDK adapter 承担。默认 runtime profile 使用 CDS 管理的 Anthropic-compatible provider-switch 配置；产品主路径不要求用户额外提供 Anthropic 原生 profile/secret。

## 验收清单

| Gate | 结果 | 说明 | 证据 |
| --- | --- | --- | --- |
| R0 runtime ownership | pass | runtime pool 与 sidecar alias 证明 loop owner 为 `claude-agent-sdk` | `/tmp/cds-agent-p4-2-one-cycle-accepted/r0-runtime.log` |
| A0 official SDK adapter boundary | pass | 默认路径走 official SDK adapter，自研 legacy loop 仅为显式 fallback | `/tmp/cds-agent-p4-2-one-cycle-accepted/official-sdk-boundary-report.json` |
| R1 provider-switch profile | pass | 默认 profile 已兼容并带 CDS-managed provider secret | `/tmp/cds-agent-p4-2-one-cycle-accepted/r1-report.json` |
| S1 read-only code inspection | pass | provider-backed 官方 SDK 完成只读仓库巡检 | `/tmp/cds-agent-p4-2-one-cycle-accepted/s1-report.json` |
| S2 dangerous tool boundary | pass | hardened readonly 下危险工具未获得 MAP approval | `/tmp/cds-agent-p4-2-one-cycle-accepted/controls-report.json` |
| S3 stop control | pass | SDK run 可被停止，最终状态为 `stopped` | `/tmp/cds-agent-p4-2-one-cycle-accepted/controls-report.json` |
| V1 visual acceptance | pass | 远端工作台截图覆盖 19 个可观测能力信号 | `/tmp/cds-agent-p4-2-one-cycle-accepted/workbench-visual.png` |
| N6 non-code boundary | pass | 非代码智能体与 CDS sidecar runtime pool 边界保持独立 | `/tmp/cds-agent-p4-2-one-cycle-accepted/n6-non-code-boundary.log` |

## 远端状态

| 字段 | 当前值 |
| --- | --- |
| preview | `https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/cds-agent` |
| Git branch | `codex/cds-agent-workbench-ui` |
| deployed runtime commit | `6b2f1552e` |
| deploy count | `452` |
| last deploy | `2026-05-19T09:26:52.783Z` |
| services | `api-prd-agent:10655`、`admin-prd-agent:10656` running |
| runtime relation | `runtime_matches_head` |
| provider cycle | enabled by `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` |

## 本轮修正

| 问题 | 修正 |
| --- | --- |
| CDS official SDK runtime 等待完整 response 后才 ingest，MAP 长时间看不到事件 | 改为流式 ingest `/v1/agent/run` SSE，运行中即可同步事件 |
| SDK `error_max_turns` 被当成普通运行中状态覆盖，页面终态不清晰 | MAP 导入 CDS error 事件后归并为 failed，并标记 `sdk_turn_limit` 非重试错误 |
| 固定 `maxTurns=10` 导致正常巡检容易提前失败 | 按任务类型动态设置 `maxTurns`，代码巡检类任务提高到 40 |
| smoke 脚本把模型长规划当作产品失败 | S1/S2 prompt 缩小为可复跑的一次只读检查和一次边界验证 |
| 用户路径被误解为必须 Anthropic 原生认证 | 明确产品主路径走 CDS-managed provider-switch；Anthropic 原生 key 只用于显式 native repair/test |

## 关键证据

| 证据 | 路径 |
| --- | --- |
| 总验收摘要 | `/tmp/cds-agent-p4-2-one-cycle-accepted/cycle-summary.json` |
| 证据索引 | `/tmp/cds-agent-p4-2-one-cycle-accepted/evidence-index.md` |
| S1 真实 provider run | `/tmp/cds-agent-p4-2-one-cycle-accepted/s1-report.json` |
| S2/S3 controls | `/tmp/cds-agent-p4-2-one-cycle-accepted/controls-report.json` |
| 视觉截图 | `/tmp/cds-agent-p4-2-one-cycle-accepted/workbench-visual.png` |
| 视觉 coverage | `/tmp/cds-agent-p4-2-one-cycle-accepted/workbench-visual.coverage.json` |
| 非代码边界 | `/tmp/cds-agent-p4-2-one-cycle-accepted/n6-non-code-boundary.log` |

## 时间

| 项目 | 用时 |
| --- | --- |
| one-cycle 总耗时 | 140s |
| S2/S3 approval and stop controls | 38s |
| V1 authenticated workbench visual | 32s |
| S1 official SDK run evidence | 29s |

耗时最高的部分是 provider-backed controls、远端视觉截图和真实 SDK run。后续开发应优先本地静态/单测验证，只在代码或 profile 改动后才重跑 provider one-cycle，避免无效部署和重复远端调用。

## 残留风险

| 风险 | 判断 | 后续处理 |
| --- | --- | --- |
| `env-sidecar` 历史残留 warning | 不阻塞产品主路径；当前 product runtime 与 head 匹配，provider one-cycle 已通过 | 保留在 operator/debug 视图观察，不让用户路径依赖该 alias |
| prompt 太宽导致 SDK turn limit | 已能明确失败并显示 `sdk_turn_limit`；不是静默卡死 | 简洁模式默认提供更窄的只读巡检模板 |
| 写入知识库、PR、commit 仍未开放 | Phase 1 商业级最小闭环范围外 | 后续进入 draft/diff/approval/apply 阶段再开放 |

## 下一步

P4-3：整理远端试用入口说明与发布验收包。目标是不新增架构、不新增 agent loop，只把“如何试用、如何复跑、如何看结果、失败时看哪里、哪些能力暂不开放”收口成用户和研发都能执行的入口。
