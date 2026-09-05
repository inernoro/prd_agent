# CDS Agent 工作台 · 债务台账

> **版本**：v0.2 | **日期**：2026-09-05 | **状态**：持续偿还

**一句话**：工作台长期卡在默认运行配置这道门禁，本文记债务清单与用户「看不懂、玩不明白」的根因。
**谁该读**：接手工作台的人；排查它为什么不好用的人。
**读完能做什么**：定位卡点在哪一环，并挑出优先偿还项。

---

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 3 |
| in-progress | 0 |
| paid | 3 |

模块范围：`/cds-agent` 工作台、`InfraAgentSessionService`、`GatewayReviewRuntimeAdapter`、`CdsAgentAdapter`，以及 `doc/` 下 `*.cds-agent*` 文档群。

## 背景

2026-05-30 用户反馈 CDS Agent「看不懂、玩不明白、接不进工作流」。根因之一是整套能力长期卡在门禁 R1（默认 runtime profile 非 Claude/Anthropic 兼容），运行链直接抛错中断，用户拿不到任何结果。本轮已落地优雅降级（Lite 只读审查，走现有 LLM Gateway），让用户先能用。以下记录尚未偿还的边界与债务。

## 债务清单

### D1 · R1 商业级 provider 闭环（open）

- **现状**：Lite 模式只读审查可用（非商业级）。官方 `claude-agent-sdk` provider 闭环（S1/S2/S3）仍需有效 Anthropic/Claude-compatible key 才能跑通。
- **影响**：商业级审查（带工具、审批、Stop interrupt）暂不可用；用户看到的是 Lite 预览级结论。
- **偿还条件**：配置有效 `sk-ant-...` 或 Claude-compatible provider profile → R1 自动闭合，默认路径回到官方 SDK，Lite 退为显式降级项。
- **不靠重新部署解决**：见 [guide.cds.agent.workbench.md](./guide.cds.agent.workbench.md)「不要反复部署」。

### D2 · Lite 模式能力边界（open，按设计）

- **只读**：读取工作区有界文件（白名单扩展名 + 单文件 24KB + 总量 180KB + 最多 40 文件），不修改文件、不执行命令。
- **无危险工具 / 无审批分支**：审批（S2）、写入、Stop interrupt（S3）仍属官方 SDK 路径，Lite 不实现。
- **跨作用域硬 Stop**：`GatewayReviewRuntimeAdapter` 注册为 Scoped（避免捕获 Scoped 的 `ILlmGateway`），跨请求作用域的硬 Stop 不在本轮；运行内取消由 linked CTS 处理。Lite 任务为单次短调用，可接受。
- **偿还条件**：如需 Lite 支持工具/审批/可中断，需要把运行句柄提升到可共享的运行注册表（非本轮范围）。

### D3 · CDS Agent 文档群熵减（paid，2026-07-17）

- **原问题**：同一主题同时存在超长工作台计划、SDK 迁移计划和多份阶段验收报告，当前状态被历史进度淹没。
- **偿还**：删除重复的历史工作台计划，把未完成 N1-N6 归口到 [plan.cds.agent.official-sdk-migration.md](./plan.cds.agent.official-sdk-migration.md)；阶段报告只保留仍被脚本或事实源引用的例外，其余回收；索引同步到 canonical 文档。

### D4 · 无 runtime profile 时的 Lite 直跑（paid，2026-07-09）

- **原现状**：`CdsAgentAdapter`（工作流节点）在完全没有系统级 runtime profile 时硬报「没有系统级模型配置」，全新环境工作流 CdsAgentRun 节点无法发起。
- **偿还**：`CdsAgentAdapter` 无 profile 时不再报错——输出提示「尝试以 CDS Lite 模式直跑」并合成占位 `RuntimeProfileChoice(null, "claude-sdk", ...)` 放行；下游 `EnsureRuntimeProfileCompatibleOrLiteFallback` / `DecideRuntimeSelection` 本就兼容 null profile，Lite 不可用时 session 层仍显式失败（行为不劣于原硬报错）。

### D5 · 会话级容器与资源策略强制（paid，2026-09-05）

- **原问题**：CDS 只记录 CPU、内存、超时、网络和清理策略，可执行链仍复用共享容器，不能按多租户标准启用外部 Provider。
- **偿还**：OpenDesign 已改为每个会话独立容器、内部网络和命名卷，强制只读根文件系统、CPU、内存、进程数、限域模型出口、超时与失败清理；能力探针不能证明这些事实时 Provider 仍不可选择。
- **验收边界**：代码合同和隔离参数已通过自动化验证；共享 CDS 宿主的最终真容器复验仍受 D6 的发布路径约束，不把该运维阻塞倒退解释为共享容器降级。

### D6 · Agent Workspace 独立控制面灰度（open）

- **现状**：共享 CDS 承载真实 Docker，但控制面更新属于高影响操作；`cds-self` 只用于 UI/API 预览，按设计不挂 Docker socket 并禁止宿主命令。当前没有一套可由 cdscli 创建、同时具备真实 Docker 且与共享控制面隔离的 Agent Workspace canary。
- **影响**：运行时改动可在分支预览完成编译和合同测试，却不能在不更新共享控制面的情况下取得宿主级 `docker create` 诊断或完成真容器回归，延长了问题收敛周期。
- **当前缓解**：容器创建失败会记录严格限长、统一脱敏的阶段、退出码和 stdout/stderr 摘要；错误事件不保存请求体、模型密钥、传输票据或完整命令。
- **偿还条件**：准备第二套 standalone CDS 或受控 Remote Agent 节点，挂独立 Docker socket、使用独立状态与凭据，并为 MAP 增加按运行显式固定连接的能力；cdscli 提供创建、部署、健康、回滚和清理的完整入口。

## 相关文件

- `prd-api/src/PrdAgent.Infrastructure/Services/AgentRuntime/GatewayReviewRuntimeAdapter.cs`
- `prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs`
- `prd-api/src/PrdAgent.Api/Services/CdsAgentRuntimeEventRenderer.cs`
- `prd-admin/src/pages/cds-agent/CdsAgentPage.tsx`
- [doc/guide.cds.agent.workbench.md](./guide.cds.agent.workbench.md)、[doc/design.cds.agent.official-sdk-adapter.md](./design.cds.agent.official-sdk-adapter.md)
