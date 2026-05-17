# CDS Agent Runtime Pool 恢复与官方 SDK Smoke · 指南

> **版本**：v1.0 | **日期**：2026-05-17 | **状态**：active recovery runbook

## 目标

这份 runbook 只处理一个阻塞：MAP 已具备官方 SDK adapter seam，但远程 CDS Agent 仍不能跑真实 official SDK run，因为 MAP 发现不到 CDS sidecar runtime 实例。

不要把“页面能打开”“preview 已部署”或“fake/legacy sidecar 可输出”当成完成。完成标准是：远程 MAP 能发现至少一个 healthy sidecar instance，并通过 `claude-agent-sdk` adapter 跑通只读、审批、取消三条 smoke。

## 当前证据

截至 2026-05-17，远程 preview `prd-agent-codex-cds-agent-workbench-ui` 的 MAP runtime-status 已证明：

```json
{
  "discoveryRefreshed": true,
  "diagnostics": {
    "isConfigured": false,
    "instanceCount": 0,
    "healthyCount": 0
  }
}
```

详细 blocker 指向有效 CDS connection 的 `/api/projects/shared-sidecar-pool-mp4anabh/instances` 返回空实例。MAP 侧已能把 `invalid_long_token` 历史连接收敛为 revoked，当前剩余问题不是重新授权，而是共享 CDS 控制面的实例发现还没有暴露 running branch service。

## 发布前检查

在考虑更新共享 CDS 控制面前，先在当前分支确认这些本地检查已经通过：

```bash
npm --prefix cds test -- remote-hosts-helpers remote-hosts-instances
npm --prefix cds run build
dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter FullyQualifiedName~DynamicSidecarRegistryTests
dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter FullyQualifiedName~InfraAgentSessionsControllerTests
npm --prefix prd-admin run tsc
git diff --check
```

`remote-hosts-instances` 是关键测试：它用真实 `CdsPairingService` 签发 long token，再经 HTTP 请求 `/api/projects/:id/instances` 证明 shared-service project 的 running branch service 会返回可被 MAP 发现的实例。

## 共享 CDS 控制面更新

共享 `https://cds.miduo.org` 是生产控制面，不允许普通 preview 部署自动覆盖。只有用户明确批准后，才能执行共享 CDS 本体更新。

发布前必须确认：

- 更新范围只包含 CDS `/api/projects/:id/instances` 实例发现和 `discovery` 摘要，不混入无关 UI 或 schema 迁移。
- 目标服务是共享 CDS 控制面，不是本分支 preview。
- 已记录当前 shared sidecar pool project id、active connection id、当前 commitSha。
- 可回滚到上一版 CDS 控制面。

发布后立刻验证：

```bash
CDS_HOST=https://cds.miduo.org python3 .claude/skills/cds/cli/cdscli.py branch status prd-agent-codex-cds-agent-workbench-ui
```

然后在 MAP preview 登录态下调用：

```text
GET /api/infra-agent-sessions/runtime-status?refreshDiscovery=true
```

预期结果：

- `discoveryRefreshed=true`
- `diagnostics.instanceCount > 0`
- `diagnostics.healthyCount > 0`
- `blockers` 为空，或不再出现 `empty_instances`

如果仍然是 `empty_instances`，检查返回体是否已经包含 `discovery(...)` 摘要：

| 摘要字段 | 判断 |
| --- | --- |
| `runningBranchServiceCount=0` | branch service 没有 running，先修 sidecar pool 部署 |
| `previewRootConfigured=false` | CDS preview root 或 branch service URL 推导缺失 |
| `branchCount=0` | shared sidecar pool project 没有可发现分支 |
| 没有 `discovery(...)` | 共享 CDS 控制面仍是旧版本，发布未生效 |

## 官方 SDK Smoke

只有 runtime pool healthy 后，才开始官方 SDK smoke。每一步都要保存 sessionId、traceId、runtimeAdapter、CurrentRuntimeRunId 和截图。

### S1 只读仓库检查

Prompt：

```text
请只读检查当前仓库结构，只输出 5 个最关键目录和当前分支。不要修改文件，不要运行危险命令。
```

通过标准：

- runtime init 显示 `runtimeAdapter=claude-agent-sdk`
- 事件流出现 `runtime_init`、`text_delta`、`done`
- 无文件变更
- `/cds-agent` Runtime 调试面板显示 instance、run id、adapter、discovery refresh 时间

### S2 工具审批

Prompt：

```text
请尝试运行 git status --short。这个命令必须等待 MAP 页面审批，通过后再输出结果。
```

通过标准：

- 页面出现 approval requested
- 刷新页面后审批卡仍在
- 点击允许后出现 tool result
- 点击拒绝时官方 SDK 收到 deny，不继续执行该工具

### S3 取消

Prompt：

```text
请循环输出状态 2 分钟，每 5 秒输出一次当前时间。
```

通过标准：

- 点击 Stop 后 MAP session 停止
- sidecar cancel 调到 official `ClaudeSDKClient.interrupt()`
- 后续无持续 token 消耗或新增 runtime 输出
- 事件里能看到 cancelled/error outcome，不能只改数据库状态

### S4 Toolbox 委托

从 AI 百宝箱选择 `cds-agent`，发送只读检查任务。

通过标准：

- Toolbox step 立即返回 `kind=cds-agent-run-handle`
- 卡片可打开 `/cds-agent?sessionId=...`
- 卡片停止按钮能停止远程 session
- Toolbox 不同步等待完整远程 run 结束

## 失败分支

| 失败 | 说明 | 下一步 |
| --- | --- | --- |
| `instanceCount=0` 且无 `discovery(...)` | 共享 CDS 控制面仍未更新 | 回到共享 CDS 发布 |
| `instanceCount=0` 但有 `runningBranchServiceCount=0` | CDS 可观测已更新，但 sidecar pool 没有 running 服务 | 修 sidecar pool 部署 |
| `healthyCount=0` | MAP 发现实例但 `/readyz` 不健康 | 查 `claude-agent-sdk`、Claude CLI、provider key、workspaceRoot |
| `runtimeAdapter=legacy-sidecar` | 运行时 profile 或 env 未切到官方 adapter | 检查 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER` / request payload |
| approval 不出现 | official `can_use_tool` 没接到 MAP bridge | 查 `/api/agent-tools/approvals/.../request` 和 sidecar logs |
| Stop 后仍输出 | cancel 没传到底层 SDK client | 查 `CurrentRuntimeRunId` 和 sidecar cancel event |

## 回滚

如果共享 CDS 控制面更新后影响普通 branch preview 或授权：

1. 回滚 CDS 控制面到上一版。
2. 保留 MAP preview 当前分支，不回滚 adapter 诊断代码。
3. 导出失败时的 `/api/projects/:id/instances` body 和 MAP runtime-status bundle。
4. 禁止把 connection 全部删除重配来掩盖路由回归；先保留证据。

## 最终交付证据

完成本 runbook 后，验收报告必须包含：

- MAP preview URL 和 commitSha。
- CDS 控制面 commitSha。
- runtime-status JSON 摘要。
- S1/S2/S3/S4 的 sessionId、traceId、runId。
- `/cds-agent` 截图，必须显示真实运行态字段。
- 如果某项失败，给出对应失败分支和下一步，不写“基本可用”。
