# guide.claude-sdk-cds-map-mvp

> 启动项：CDS 调度外部 Anthropic Agent SDK sidecar，MAP 通过 CDS-MAP 配对发现并路由到该 sidecar。

## 当前结论

截至 2026-05-13，MVP 链路已打通：

1. CDS 注册 remote host 与 shared-service project。
2. CDS scheduler 通过 `/api/executors/dispatch/:branch` 选择承载外部 Agent SDK 的 executor。
3. CDS 通过 `/api/projects/:id/instances` 暴露 MAP 配对后的 project 级实例发现。
4. MAP 的 `DynamicSidecarRegistry` 会读取 `infra_connections` 中 active CDS 配对记录，使用 longToken 拉实例发现，再把实例合并进 `ClaudeSidecarRouter` 路由池。
5. 即使 MAP 本地 `ClaudeSdkExecutor.Enabled=false`，只要存在 `Source="cds-pairing"` 的实例，`claude-sdk` 执行器也可调度到外部 sidecar。

本机没有 `ANTHROPIC_API_KEY`，所以真实 Anthropic 调用未跑；sidecar 结构性 smoke 已验证 `/healthz`、`/readyz`、鉴权失败路径，CDS MVP 用 fake sidecar 验证 SSE 协议闭环。

## 一键 MVP 冒烟

在仓库根目录运行：

```bash
MVP_FAKE_SIDECAR=1 cds/node_modules/.bin/tsx cds/scripts/mvp-demo.ts
```

成功时关键输出：

```text
dispatch.selected.id: map-agent-sdk-executor
project instances count: 1
sidecar /healthz status: 200
sidecar /v1/agent/run status: 200
text_delta event count: 1
final_text: 春风入窗，花影新。
=== Demo OK ===
```

这个冒烟不写正式 state，不触碰线上 CDS。脚本会创建临时 state、临时 mini CDS、临时 fake sidecar，结束后清理。

## 真实 sidecar 结构性 smoke

```bash
bash claude-sdk-sidecar/smoke.sh
```

无 `ANTHROPIC_API_KEY` 时，预期结果是：

- `/healthz` 返回 200。
- `/readyz` 返回 200，`agentAdapter=claude-agent-sdk`，`loopOwner=claude-agent-sdk`。
- 无 token 调 `/v1/agent/run` 返回 401。
- T4 返回 `provider_key_missing` 结构化 SSE error，证明 provider key 缺失在 official adapter 边界被识别，而不是伪装成 SDK 运行失败。

要做真实 Anthropic 端到端，把 key 放入环境变量后重跑：

```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
bash claude-sdk-sidecar/smoke.sh
```

## MAP 路由规则

`prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/DynamicSidecarRegistry.cs` 现在有两条发现路径：

| 来源 | 触发条件 | 发现 API | Sidecar token |
|---|---|---|---|
| `cds-pairing` | `infra_connections` 中 active CDS 连接 | `{PartnerBaseUrl}{InstanceDiscoveryUrl}` | `ClaudeSdkExecutor:CdsDiscovery:SharedSidecarToken`，缺省用 `DefaultSidecarToken` |
| `cds` | appsettings 显式启用 `CdsDiscovery` | `/api/cds-system/remote-hosts` + `/instance` | 同上 |

`cds-pairing` 是主路径。它使用配对 longToken 访问 CDS 实例发现 API，避免 MAP 端再手工配置 CDS base URL。

## 后续真实验收清单

1. 在 CDS UI 生成连接密钥，在 MAP `/infra-services` 粘贴配对。
2. 在 CDS shared-service project 部署真实 `claude-sdk-sidecar`，确保 `SIDECAR_TOKEN` 与 MAP `SharedSidecarToken` 一致。
3. MAP 等待一次 `CdsSidecarSyncService` 刷新，或重启 MAP。
4. 创建工作流节点：

```json
{
  "executorType": "claude-sdk",
  "model": "claude-haiku-4-5-20251001",
  "prompt": "用一句话写春天",
  "maxTurns": 1
}
```

5. 验证工作流输出、`llmrequestlogs` token 记录、sidecar 日志三处一致。

## 已验证命令

```bash
npm --prefix cds test -- tests/scheduler/dispatcher.test.ts tests/routes/remote-hosts-helpers.test.ts tests/services/proxy.test.ts
dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --filter DynamicSidecarRegistryTests
MVP_FAKE_SIDECAR=1 cds/node_modules/.bin/tsx cds/scripts/mvp-demo.ts
bash claude-sdk-sidecar/smoke.sh
npm --prefix cds run build
dotnet build prd-api/PrdAgent.sln --no-restore
```
