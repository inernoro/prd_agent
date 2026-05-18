# CDS Agent R0 · CDS-managed runtime fact source 设计

> 创建时间：2026-05-18 22:05 Asia/Shanghai
> 分支：`codex/cds-agent-workbench-ui`
> 上游边界：`doc/plan.cds-agent-runtime-correction-limited.md`

## 1. 本轮目标

把 R0 从旧的：

```text
MAP -> CDS -> remote host / sidecar image / SSH handoff
```

改成：

```text
MAP -> CDS -> CDS-managed runtime/container/sandbox -> official SDK adapter
```

本轮只定义 fact source 和最小开发计划，不做远程部署，不要求用户补 SSH、image 或 env。

## 2. 当前代码事实

| 层级 | 当前事实 | 可用性 | R0 结论 |
| --- | --- | --- | --- |
| CDS Project | `Project.kind` 已有 `shared-service` | 可复用 | 可表达 long-lived runtime pool，但不能再让用户手工绑 host 作为产品路径 |
| CDS BuildProfile | `BuildProfile` 已能表达 image、command、env、resource、readiness | 可复用 | 可以承载 `cds-managed-runtime` profile，但不能写回 `prd-agent` 业务项目 |
| CDS Branch service | `BranchEntry.services` 记录 containerName、hostPort、status | 可复用 | shared-service runtime 可以作为独立项目分支服务被发现 |
| Instance discovery | `/api/projects/:id/instances` 已支持 shared-service branch services | 可复用 | MAP 仍只连 CDS，通过 project-scoped discovery 找 runtime |
| Agent session API | `/api/projects/:id/agent-sessions` 已存在 | 部分可用 | 非 fake runtime 已能从 shared-service branch service 发现 CDS-managed `claude-agent-sdk` runtime 并投递 `/v1/agent/run`；runtime 缺失时由 CDS 返回 `cds_managed_runtime_unavailable` |
| MAP runtime adapter | `IInfraAgentRuntimeAdapter` 已是 thin adapter boundary | 可复用 | MAP 只做 routing/SSE/cancel 映射，不 owns agent loop |
| Sidecar official adapter | `claude-sdk-sidecar` 默认 `claude-agent-sdk`，legacy loop 显式 fallback | 可复用 | official SDK loop 已在 sidecar 内，不应再自造 loop |
| Remote host deployer | `RemoteHost` + `ServiceDeployment` + deploy-sidecar | fallback | 只能作为 operator/debug 恢复路径，不是用户主路径 |

## 3. R0 新事实源

R0 不再以 `REMOTE_HOST_AVAILABLE` 或 `CDS_AGENT_SIDECAR_IMAGE` 作为产品主 blocker。

新的 R0 fact source：

```text
CDS_MANAGED_RUNTIME_PROJECT
CDS_MANAGED_RUNTIME_PROFILE
CDS_MANAGED_RUNTIME_CONTAINER
CDS_MANAGED_RUNTIME_SANDBOX_READY
CDS_AGENT_SESSION_EXECUTION_OWNED_BY_CDS
OFFICIAL_SDK_LOOP_OWNER
MAP_TO_CDS_ONLY
```

### 3.1 通过条件

| Gate | 通过条件 | 证据 |
| --- | --- | --- |
| `CDS_MANAGED_RUNTIME_PROJECT` | 存在独立 `shared-service` 或 `system-runtime` 项目承载 Agent runtime | CDS project list，不属于 `prd-agent` 业务 appServices |
| `CDS_MANAGED_RUNTIME_PROFILE` | runtime profile 由 CDS 管理，配置 image/command/readiness/resource | CDS build profile 或后续 runtime profile endpoint |
| `CDS_MANAGED_RUNTIME_CONTAINER` | runtime container 由 CDS container service 启动、停止、探活 | branch service / deployment state |
| `CDS_MANAGED_RUNTIME_SANDBOX_READY` | workspace、network、resource、permission policy 由 CDS 生成 | runtime session view / readyz diagnostics |
| `CDS_AGENT_SESSION_EXECUTION_OWNED_BY_CDS` | `/agent-sessions/:id/messages` 在 CDS runtime 内执行、投递到 CDS-managed worker，或在 runtime 缺失时由 CDS 产生明确 `cds_managed_runtime_unavailable` 错误 | 事件流出现 `runtimeInit/text/tool/done/error` 或 CDS-owned unavailable/error，不能出现“delegated to MAP sidecar bridge” |
| `OFFICIAL_SDK_LOOP_OWNER` | `loopOwner=claude-agent-sdk` 或其他官方 SDK adapter | `/readyz.adapterDiagnostics.loopOwner` |
| `MAP_TO_CDS_ONLY` | MAP runtime adapter 只调用 CDS session/discovery/cancel/log API | MAP adapter diagnostics / no direct runtime URL in user path |

### 3.2 失败条件

以下只能作为 fallback diagnostics，不能作为 R0 产品主阻塞：

```text
CDS_REMOTE_HOST_*
CDS_AGENT_SIDECAR_IMAGE
CDS_AGENT_REMOTE_PULL_VERIFY
RemoteHost.deploy-sidecar
手工 SSH 登录主机
```

## 4. 最小开发计划

| # | 任务 | 预计 | 改动范围 | 成功标准 |
| --- | ---: | --- | --- | --- |
| R0.2.1 | 定义 CDS-managed runtime status DTO | 20-30 分钟 | CDS route / MAP diagnostics contract | runtime-status 能展示新 gate，不出现 env handoff |
| R0.2.2 | 改造 CDS `/agent-sessions` 非 fake 路径 | done | `cds/src/routes/remote-hosts.ts`、`cds/tests/routes/remote-hosts-instances.test.ts` | message 不再返回“delegated to MAP sidecar bridge”；runtime 缺失时返回 CDS-owned unavailable/error |
| R0.2.3 | 将 official SDK runtime 作为 CDS-managed profile/container/transport | done_minimal | `cds/src/routes/remote-hosts.ts`、`cds/tests/routes/remote-hosts-instances.test.ts` | runtime 不进入 `prd-agent` appServices；message 能投递到 CDS-managed official SDK runtime，并写回 `runtime_init/text_delta/done` |
| R0.2.4 | MAP adapter 改为 CDS session transport 并补 managed-runtime smoke | done | `CdsAgentAdapter` / `InfraAgentSessionService` / scripts / tests | MAP Toolbox adapter 不注入 direct runtime adapter；session message 先走 CDS；direct runtime queue 只在显式 fallback env 下启用 |
| R0V | managed-runtime post-check/live evidence | done_blocked | scripts / live evidence | 远程证据证明 branch isolation clean，但 CDS-managed runtime capacity 缺失；不要求 SSH/image/env 作为产品主路径 |
| R0.5 | CDS-managed runtime capacity 收口 | 30-60 分钟 | runtime-status / audit / scripts / CDS capacity contract | 顶层 blocker 表达为 `CDS_MANAGED_RUNTIME_CAPACITY`；remote host/env/image 只作为 operator fallback |
| R0.2.6 | 页面数据源和视觉测试 | 30-45 分钟 | runtime-status / `/cds-agent` | 页面展示 R0 facts、ETA、debug fallback，截图通过 |

第一开发周期已完成：

```text
R0.2.1 + runtime-status execution panel 修正 + R0.2.2 session ownership guard
证据：CDS route test 通过，非 fake runtime 不再委托 MAP sidecar bridge
```

第二开发周期已完成：

```text
R0.2.3 CDS-managed official SDK runtime transport
证据：CDS route test 通过，message 经 CDS-managed branch service transport 投递到 official SDK sidecar 协议
```

第三开发周期已完成：

```text
R0.2.4 MAP adapter session transport + managed-runtime smoke
证据：MAP Toolbox adapter 不再注入 IInfraAgentRuntimeAdapter；InfraAgentSessionService 默认经 CDS session message transport；direct runtime queue 只在 INFRA_AGENT_ENABLE_MAP_DIRECT_RUNTIME_FALLBACK 下启用
```

R0V live evidence 已完成：

```text
/tmp/cds-agent-runtime-pool-evidence-latest/summary.json
branch isolation = clean
shared-sidecar-pool-mp4anabh running = 0
enabled remote host = 0
结论：当前缺 CDS-managed runtime capacity；remote host/env/image 只能作为 operator fallback，不是普通用户下一步。
```

下一开发周期建议只做：

```text
R0.5 CDS-managed runtime capacity 收口
预计 30-60 分钟形成最小实现计划和 guard；R0V 远程只读证据已证明当前 capacity 缺失
```

## 5. Smoke 设计

### 5.1 本地只读 smoke

```bash
scripts/check-cds-agent-progress-consistency.sh
dotnet test prd-api/tests/PrdAgent.Api.Tests --filter InfraAgentSessionsControllerTests
```

### 5.2 R0 fact-source smoke

后续新增：

```bash
scripts/smoke-cds-agent-managed-runtime-fact-source.sh
```

成功标准：

```text
MAP_TO_CDS_ONLY=pass
CDS_MANAGED_RUNTIME_PROJECT=pass
CDS_MANAGED_RUNTIME_PROFILE=pass
CDS_AGENT_SESSION_EXECUTION_OWNED_BY_CDS=pass
OFFICIAL_SDK_LOOP_OWNER=pass
REMOTE_HOST_ENV_AS_PRODUCT_PATH=rejected
```

## 6. 视觉测试触发条件

只有以下条件满足后才跑视觉测试：

```text
runtime-status.executionPanel.taskBoard 已显示 R0.2/R0.3 新主线
页面不把 SSH/env/image 展示成“下一步”
页面能区分 product path 和 operator fallback
```

视觉验收点：

```text
1. 第一屏能看到当前阶段、完成/剩余步骤、ETA。
2. 当前下一步是 CDS-managed runtime fact-source / runtime profile / session execution。
3. Legacy fallback 单独折叠或降级展示，不能成为主 CTA。
4. 截图中不能出现“提供 SSH 私钥 / 设置 CDS_AGENT_SIDECAR_IMAGE”作为主任务。
```

## 7. 当前停止点

本轮完成后，允许停在：

```text
R0 设计文档已落地
runtime-status execution panel 已从 remote host/image 主路径改为 CDS-managed runtime 主路径
本地 controller tests / consistency 通过
真正 runtime 执行仍未实现，目标保持 not_complete
```
