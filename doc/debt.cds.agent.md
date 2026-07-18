# CDS Agent 工作台 · 债务台账

> **版本**：v0.1 | **日期**：2026-07-17 | **状态**：开发中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 2 |
| in-progress | 0 |
| paid | 2 |

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

### D3 · CDS Agent 文档群熵减（paid，2026-07-17）

- **原问题**：同一主题同时存在超长工作台计划、SDK 迁移计划和多份阶段验收报告，当前状态被历史进度淹没。
- **偿还**：删除重复的历史工作台计划，把未完成 N1-N6 归口到 `plan.cds.agent.official-sdk-migration.md`；阶段报告只保留仍被脚本或事实源引用的例外，其余回收；索引同步到 canonical 文档。

### D4 · 无 runtime profile 时的 Lite 直跑（paid，2026-07-09）

- **原现状**：`CdsAgentAdapter`（工作流节点）在完全没有系统级 runtime profile 时硬报「没有系统级模型配置」，全新环境工作流 CdsAgentRun 节点无法发起。
- **偿还**：`CdsAgentAdapter` 无 profile 时不再报错——输出提示「尝试以 CDS Lite 模式直跑」并合成占位 `RuntimeProfileChoice(null, "claude-sdk", ...)` 放行；下游 `EnsureRuntimeProfileCompatibleOrLiteFallback` / `DecideRuntimeSelection` 本就兼容 null profile，Lite 不可用时 session 层仍显式失败（行为不劣于原硬报错）。

## 相关文件

- `prd-api/src/PrdAgent.Infrastructure/Services/AgentRuntime/GatewayReviewRuntimeAdapter.cs`
- `prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs`
- `prd-api/src/PrdAgent.Api/Services/CdsAgentRuntimeEventRenderer.cs`
- `prd-admin/src/pages/cds-agent/CdsAgentPage.tsx`
- `doc/guide.cds.agent.workbench.md`、`doc/design.cds.agent.official-sdk-adapter.md`
