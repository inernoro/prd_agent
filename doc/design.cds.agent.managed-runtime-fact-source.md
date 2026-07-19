# CDS Agent 托管运行时事实源设计 · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 一、管理摘要

- **解决什么问题**：Agent 运行时曾依赖 SSH、远程主机和手工镜像配置，产品状态与运维恢复手段混在一起。
- **当前设计**：CDS 管理 official SDK runtime 的项目、profile、容器、探活和 session transport；MAP 只调用 CDS。
- **顶层事实**：是否可执行由 `CDS_MANAGED_RUNTIME_CAPACITY` 判定，不再由远程主机或环境变量推断。
- **当前进度**：容量 contract、reconciler 和本地 `liveApply` 路径已经接通；真实 shared-service runtime 的 running 证据仍需闭环。

## 1. 目标与边界

### 1.1 目标

- 让普通用户只面对 CDS 托管运行能力，不接触 SSH、镜像和主机密钥。
- 让 runtime 容量、session 执行归属和官方 SDK loop owner 可查询、可验证。
- runtime 缺失时由 CDS 返回明确错误，不回退成 MAP 内部的隐式 Agent loop。
- 运维恢复路径与产品主路径在状态、页面和诊断命令中严格分离。

### 1.2 非目标

- 不删除 RemoteHost 和 deploy-sidecar 等运维恢复能力。
- 不把本地 route test 等同于真实运行容量已经可用。
- 不允许普通 preview redeploy 伪装成 runtime capacity 修复。
- 不在本文定义 provider 任务、业务 Agent 能力或页面视觉细节。

## 2. 所有权边界

| 边界 | 所有者 | 责任 |
|------|--------|------|
| runtime 项目与 profile | CDS | 保存官方 SDK runtime 的部署定义 |
| 容器启动、停止和探活 | CDS | 形成可查询的容量事实 |
| workspace、网络与资源策略 | CDS runtime | 为 session 提供受控执行环境 |
| session、消息、取消和事件 | CDS | 执行并输出统一事件流 |
| official SDK agent loop | runtime adapter | 执行模型与工具循环 |
| 产品路由与展示 | MAP | 调用 CDS，映射状态、SSE 和取消 |
| RemoteHost 与手工部署 | operator fallback | 故障恢复和诊断，不是产品前置条件 |

MAP 不保存 direct runtime URL 作为普通用户路径，也不在 CDS 容量缺失时自行接管 loop。CDS 必须对执行成功或不可用负责。

## 3. 事实源层级

事实按以下优先级判断：

1. CDS 的项目级 runtime-capacity 结果。
2. CDS 管理的 runtime profile、branch service 与容器状态。
3. runtime readiness 和 adapter diagnostics。
4. session 事件流中的执行归属与终态。
5. RemoteHost、SSH 和镜像环境变量，仅作为 operator fallback 证据。

任何页面、审计脚本或进度板都不得用第五层替换前四层。配置存在只表示可能部署，不表示当前有可用容量。

## 4. 容量状态契约

容量结果至少要回答：目标项目是否为 shared-service、runtime profile 是否存在、服务记录是否存在、容器是否 running、readiness 是否通过以及 official SDK loop owner 是否正确。

`GET /api/projects/:id/runtime-capacity` 是只读事实入口。`POST /api/projects/:id/runtime-capacity/reconcile` 负责生成或应用 CDS 内部修复计划。

reconcile 的 dry-run 只返回差异；apply 可以创建或修正 profile 与 branch-service 记录；`liveApply=true` 才请求 CDS container service 启动实际容器。

应用项目不能承载托管 runtime 容量。reconciler 必须以 shared-service 或 system-runtime 项目为目标，避免 runtime 混入业务 appServices。

## 5. 产品主 Gate

顶层 requirement 固定为 `CDS_MANAGED_RUNTIME_CAPACITY`。

通过条件如下：

| Gate | 通过条件 |
|------|----------|
| 托管项目 | 独立 shared-service 或 system-runtime 项目承载 runtime |
| 托管 profile | CDS 保存 image、command、readiness 和资源约束 |
| 托管容器 | CDS container service 启动并管理 runtime |
| sandbox ready | workspace、网络、权限和资源策略可用 |
| session owned by CDS | 消息由 CDS runtime 执行或由 CDS 返回明确不可用错误 |
| official SDK loop | diagnostics 的 loop owner 指向官方 SDK adapter |
| MAP to CDS only | MAP 只调用 CDS session、discovery、cancel 和 log API |

只有上述产品事实成立，容量才可标记 available。仅有 profile、服务记录、分配端口或本地测试通过都不足以宣告成功。

## 6. 失败与降级条件

以下任一情况都保持 `CDS_MANAGED_RUNTIME_CAPACITY=missing`：

- shared-service runtime 的 running 数量为 0。
- 容器记录存在但 readiness 未通过。
- session 仍委托给 MAP sidecar bridge 或 direct runtime queue。
- loop owner 不是已登记的 official SDK adapter。
- 只有 RemoteHost、SSH、镜像变量或手工 sidecar 可用。
- live evidence 无法证明 session 产生 runtimeInit、text、tool、done 或 CDS-owned error。

runtime 缺失时，CDS session API 返回 `cds_managed_runtime_unavailable`。该错误是 CDS 拥有执行失败的证据，不应被替换为要求产品用户提供 SSH、env 或 image。

## 7. Product path 与 operator fallback

产品路径是：MAP 创建 CDS session，CDS 发现托管 runtime，CDS 投递消息，official SDK runtime 执行，CDS 返回事件流。

legacy fallback 包括 `CDS_REMOTE_HOST_*`、`CDS_AGENT_SIDECAR_IMAGE`、RemoteHost deploy-sidecar 和手工 SSH。它们可用于运维诊断，但不得出现在普通用户的主 CTA、顶层 blocker 或完成条件中。

如果产品容量缺失，下一步是运行 CDS 内部 reconciler 并取得 live evidence；不是要求用户补远程主机材料，也不是重复部署业务 preview。

## 8. Reconcile 与 Smoke

先运行 `bash scripts/smoke-cds-agent-managed-runtime-capacity.sh`，确认 runtime-status、progress board 和 audit 的顶层 requirement 一致。

只读检查使用 `GET /api/projects/:id/runtime-capacity`。修复计划使用 `POST /api/projects/:id/runtime-capacity/reconcile`，默认 dry-run；真实启动必须显式设置 `liveApply=true`。

容量 smoke 必须断言：`CDS_MANAGED_RUNTIME_CAPACITY` 是主 gate，remote host/env/image 只出现在 legacy fallback，应用项目不会被选作 runtime capacity 项目。

session smoke 必须断言：有容量时消息进入 CDS-managed official SDK runtime；无容量时返回 `cds_managed_runtime_unavailable`，不能出现 delegated-to-MAP 行为。

本地一致性检查使用 `scripts/check-cds-agent-progress-consistency.sh`。运行时状态检查使用 `scripts/smoke-cds-agent-runtime-status.sh`。现场证据收集使用 `scripts/collect-cds-agent-runtime-pool-evidence.sh`。

## 9. 当前 R0 进度

| 阶段 | 状态 | 当前事实 |
|------|------|----------|
| R0.2 session ownership | 已完成 | 非 fake 路径由 CDS 对执行或不可用负责 |
| R0.3 official SDK transport | 最小闭环 | CDS 能向托管 sidecar 协议投递并映射事件 |
| R0.4 MAP transport | 已完成 | 默认经 CDS session，direct runtime 仅显式 fallback |
| R0.5 capacity contract | 最小闭环 | CDS 暴露项目级 runtime-capacity |
| R0.6 reconciler | 最小闭环 | dry-run/apply 可维护 profile 与服务容量事实 |
| R0.7 live apply | 进行中 | 本地 container start 路径已接通，真实 running 证据待完成 |

最新进度以 `scripts/print-cds-agent-current-progress.sh` 和 `scripts/audit-cds-agent-goal.sh` 为准。文档不把某次 `/tmp` 证据目录或瞬时容器数量写成长期事实。

R0.7 完成必须取得真实 CDS shared-service runtime 的证据：running 数量大于 0、readiness 通过、loop owner 正确，并有一次 session 走完 CDS-owned 事件链。

在以上证据出现前，目标保持未完成。不得因为 route test、profile 创建或服务记录存在而提前更改结论。

## 10. 页面表达

运行时状态页第一屏展示当前阶段、已完成步骤、剩余步骤和可执行下一步。产品 gate 与 operator fallback 分区展示，fallback 默认降级或折叠。

当容量缺失时，主行动指向 CDS-managed runtime reconcile 和 live evidence。页面不得把“提供 SSH 私钥”或“设置 sidecar image”显示为普通用户任务。

## 11. 当前实现入口

| 能力 | 事实入口 |
|------|----------|
| capacity 与 reconciler | `cds/src/routes/remote-hosts.ts` |
| MAP runtime 状态 | `prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentSessionsController.cs` |
| capacity smoke | `scripts/smoke-cds-agent-managed-runtime-capacity.sh` |
| runtime status smoke | `scripts/smoke-cds-agent-runtime-status.sh` |
| live evidence | `scripts/collect-cds-agent-runtime-pool-evidence.sh` |
| 进度事实 | `scripts/print-cds-agent-current-progress.sh` |
| 目标审计 | `scripts/audit-cds-agent-goal.sh` |

## 12. 验收标准

- 所有状态源把 `CDS_MANAGED_RUNTIME_CAPACITY` 作为顶层 requirement。
- liveApply 由 CDS container service 执行，不依赖 MAP 直连 runtime。
- runtime 不进入业务应用项目的 appServices。
- 容量不可用时返回 CDS-owned 明确错误。
- RemoteHost、SSH、env 和 image 仅出现在 operator fallback。
- 真实 shared-service runtime 完成一次可追溯 session 后，R0.7 才能标记完成。

## 关联文档

- `doc/design.cds.agent-orchestration.md`
- `doc/design.cds.shared-sidecar-runtime.md`
- `doc/design.cds.md`
