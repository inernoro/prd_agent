# CDS Agent 官方 SDK 商业闭环 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 目标

保留 MAP/CDS 的登录、工作区、运行配置、审批、事件、日志和产物控制面，把代码 Agent 的 turn loop、工具调用、流式输出和中断交给官方 Claude Agent SDK，并完成真实 provider 下的商业级闭环。

历史工作台建设、页面功能和已完成阶段不再放在计划中。当前架构以 `design.cds.agent.official-sdk-adapter.md` 为准，用户操作以 `guide.cds.agent.workbench.md` 为准，已知边界以 `debt.cds.agent.md` 为准。

## 当前事实

- `/cds-agent` 页面、会话、SSE 事件游标、诊断面板、审批、停止、产物和百宝箱入口已经落地。
- 默认代码审查路径支持 `claude-agent-sdk`；`legacy-sidecar` 只能显式选择，未知 adapter 不得静默回退。
- 当官方 SDK runtime 或兼容 profile 不可用时，系统可以走 LLM Gateway 的 Lite 只读审查；Lite 不写文件、不执行命令，也不冒充商业级 SDK 闭环。
- 当前剩余主矛盾是有效 Claude/Anthropic-compatible runtime profile 与真实 provider 证据，不是继续增加工作台页面或重复部署。

## 未完成闭环

| 顺序 | 工作 | 完成证据 |
| --- | --- | --- |
| N1 | 配置可用的 Claude/Anthropic-compatible 默认 runtime profile | `runtime-status.defaultRuntimeProfile.compatibleWithDesiredRuntimeAdapter=true`，密钥可解密且探测成功 |
| N2 | 在 CDS preview 执行只读仓库审查 | 真实 `runtime_init` 显示 `loopOwner=claude-agent-sdk`，返回仓库结论且无文件改动 |
| N3 | 验证危险工具审批 | MAP 收到 approval，拒绝或允许结果回写 SDK tool result，审计链可关联 |
| N4 | 验证 Stop | 长任务停止后底层 SDK run 被 interrupt/cancel，页面和事件终态一致 |
| N5 | 固化真实视觉证据 | 页面展示 session、trace、adapter、workspace、事件和错误；空态或 mock 不算 |
| N6 | 跑非代码 Agent 兼容回归 | PRD、缺陷、文学、视觉和工作流不被 SDK profile 或 sidecar pool 误阻断 |

N1 未完成时，N2-N4 只能记作 readiness 或 preflight 证据，不能标记为真实 SDK 验收通过。

## 运行时边界

| 能力 | 官方 SDK | MAP/CDS |
| --- | --- | --- |
| turn loop、上下文、流式 token | 权威 | 只映射事件，不复制实现 |
| Claude Code 工具协议 | 权威 | 提供 workspace 和工具边界 |
| 权限与人工确认 | 发起 callback | 保存审批、展示并回传结果 |
| interrupt/cancel | 执行底层中断 | 保存 run handle 并触发停止 |
| 事件、审计和产物 | 提供原始事件 | 统一 envelope、游标、持久化与 UI |
| 多租户、连接和运行配置 | 不负责 | 权威 |

OpenAI Agents SDK、Google ADK 和 Codex-like adapter 在完成各自契约与兼容验证前保持 `planned-not-routable`，不得因配置可以保存就进入默认代码审查路径。

## 调试顺序

1. 运行 runtime doctor，确认 runtime pool、adapter、profile、workspace 和 blocker。
2. 先执行只读最小 run，再开放安全工具。
3. 单独验证审批和停止，不把页面按钮变化当作底层中断证据。
4. 制造超过单页上限的事件，验证 `afterSeq` 游标、SSE 重连和去重。
5. 从百宝箱和工作流各执行一次，验证远程句柄、事件回放和非代码兼容。
6. 在 preview 走真实入口截图，并导出机器可读证据包。

## 验收命令入口

- `scripts/doctor-cds-agent-runtime.sh`：分层诊断 runtime、profile、实例和下一动作。
- `scripts/smoke-cds-agent-runtime-status.sh`：要求存在健康实例，且官方实例声明 `loopOwner=claude-agent-sdk`。
- `scripts/smoke-cds-agent-profile-preflight.sh`：验证不兼容 profile 在写消息和入队前被拦截。
- `scripts/smoke-cds-agent-official-sdk-run.sh`：N2 真实只读 run；provider 调用必须显式允许。
- `scripts/smoke-cds-agent-official-sdk-controls.sh`：N3/N4 审批与停止。
- `scripts/smoke-cds-agent-workbench-visual.sh`：认证后的工作台视觉证据。

## 商业级完成标准

- 用户只需选择仓库、分支、任务和有效 profile，即可启动真实 SDK 运行。
- 失败能够明确归因到 provider、SDK、工具、权限、仓库、测试或发布，不以泛化“运行失败”收口。
- Stop 真正中断底层 run；审批有 request、decision 和 tool result 的完整审计链。
- 事件超过 500 条不丢失，刷新和重连后按序恢复。
- Lite 降级始终明确标识为只读预览，不承诺写入、命令、审批或 SDK interrupt。
- 非代码 Agent 不依赖 CDS sidecar pool，SDK 迁移不能改变其 artifact schema 或用户可见输出。

## 关联文档

- `doc/design.cds.agent.official-sdk-adapter.md`
- `doc/design.cds.agent.runtime-architecture.md`
- `doc/guide.cds.agent.workbench.md`
- `doc/guide.cds.agent.runtime-pool-recovery.md`
- `doc/guide.cds.agent.code-review-quickstart.md`
- `doc/debt.cds.agent.md`
