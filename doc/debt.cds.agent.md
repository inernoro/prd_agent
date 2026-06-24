# CDS Agent 工作台 · 债务台账

> **版本**：v0.1 | **日期**：2026-05-30 | **状态**：open / 待规划

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 4 |
| in-progress | 0 |
| paid | 0 |

模块范围：`/cds-agent` 工作台、`InfraAgentSessionService`、`GatewayReviewRuntimeAdapter`、`CdsAgentAdapter`，以及 `doc/` 下 `*.cds-agent*` 文档群。

## 背景

2026-05-30 用户反馈 CDS Agent「看不懂、玩不明白、接不进工作流」。根因之一是整套能力长期卡在门禁 R1（默认 runtime profile 非 Claude/Anthropic 兼容），运行链直接抛错中断，用户拿不到任何结果。本轮已落地优雅降级（Lite 只读审查，走现有 LLM Gateway），让用户先能用。以下记录尚未偿还的边界与债务。

## 债务清单

### D1 · R1 商业级 provider 闭环（open）

- **现状**：Lite 模式只读审查可用（非商业级）。官方 `claude-agent-sdk` provider 闭环（S1/S2/S3）仍需有效 Anthropic/Claude-compatible key 才能跑通。
- **影响**：商业级审查（带工具、审批、Stop interrupt）暂不可用；用户看到的是 Lite 预览级结论。
- **偿还条件**：配置有效 `sk-ant-...` 或 Claude-compatible provider profile → R1 自动闭合，默认路径回到官方 SDK，Lite 退为显式降级项。
- **不靠重新部署解决**：见 `guide.cds.agent.workbench.md`「不要反复部署」。

### D2 · Lite 模式能力边界（open，按设计）

- **只读**：读取工作区有界文件（白名单扩展名 + 单文件 24KB + 总量 180KB + 最多 40 文件），不修改文件、不执行命令。
- **无危险工具 / 无审批分支**：审批（S2）、写入、Stop interrupt（S3）仍属官方 SDK 路径，Lite 不实现。
- **跨作用域硬 Stop**：`GatewayReviewRuntimeAdapter` 注册为 Scoped（避免捕获 Scoped 的 `ILlmGateway`），跨请求作用域的硬 Stop 不在本轮；运行内取消由 linked CTS 处理。Lite 任务为单次短调用，可接受。
- **偿还条件**：如需 Lite 支持工具/审批/可中断，需要把运行句柄提升到可共享的运行注册表（非本轮范围）。

### D3 · CDS Agent 文档群熵减（open）

- **现状**：`doc/` 下 `*.cds-agent*` 文档约 20+ 篇（含同一周 2026-05-19 的 ~10 篇 `report.cds-agent-*` 验收报告 + `plan.cds.agent.workbench.md` 113KB + `plan.cds.agent.official-sdk-migration.md` 62KB + `design.cds.agent.commercial-architecture-and-roadmap.md` 100KB）。这是 `blocked-state-circuit-breaker.md` 所述「进度剧场」的产物，导致「找不到真相」。
- **偿还计划**：收敛为 4 篇 canonical —— `spec.cds-agent`（这是什么/能做什么）、`design.cds-agent`（架构 + 官方/自研边界）、`guide.cds.agent.workbench`（用户/排障 runbook，已存在）、`debt.cds.agent`（本文件）。同一周的 `report.cds-agent-*-2026-05-19.*` 与重复 plan 归档或删除，同步 `index.yml` 与 `guide.list.directory.md`。
- **未在本轮执行删除**：保留历史，避免一次性大规模删除丢信息；本台账先登记，后续走 `/entropy` / `/doc-sync` 分批偿还。

### D4 · 无 runtime profile 时的 Lite 直跑（open）

- **现状**：`CdsAgentAdapter`（工作流节点）在完全没有系统级 runtime profile 时仍硬报「没有系统级模型配置」。Lite 实际只依赖 Gateway 默认 chat 池，理论上可在无 profile 时直跑。
- **影响**：全新环境未配任何 profile 时，工作流 CdsAgentRun 节点无法发起。
- **偿还条件**：为 Lite 提供合成默认（runtime/model 占位）让 `CreateAsync` 在 lite 可用时放行。

## 相关文件

- `prd-api/src/PrdAgent.Infrastructure/Services/AgentRuntime/GatewayReviewRuntimeAdapter.cs`
- `prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs`
- `prd-api/src/PrdAgent.Api/Services/CdsAgentRuntimeEventRenderer.cs`
- `prd-admin/src/pages/cds-agent/CdsAgentPage.tsx`
- `doc/guide.cds-agent-workbench.md`、`doc/design.cds-agent-official-sdk-adapter.md`
