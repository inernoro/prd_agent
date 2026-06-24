# design.cds.agent.sdk-executor

| 字段 | 内容 |
|---|---|
| 版本 | 0.3.0 |
| 状态 | active（v0.2 能跑通，但命名和官方 SDK 边界已在 v0.3 校准） |
| 责任人 | Claude Code |
| 关联 | `.claude/rules/llm-gateway.md`、`.claude/rules/cds-first-verification.md`、`doc/design.ai-toolbox.md` |

---

## 0. 三步无脑配置（开发期）

```bash
# 1. 把 Anthropic API key 写入项目根 .env
echo "ANTHROPIC_API_KEY=sk-ant-xxx" >> .env

# 2. 启动 docker compose（claude-sidecar 默认包含，零额外参数）
docker compose -f docker-compose.dev.yml up -d --build

# 3. 完事 —— 历史名为 claude-sdk 的 sidecar runtime 自动可用
#   工作流节点配 executorType="claude-sdk" 即可调用
```

发生了什么：

- `prd-api` 启动时检测到 `ANTHROPIC_API_KEY` 非空 → `PostConfigure<ClaudeSidecarOptions>` 自动注入 `default` sidecar 实例并把 `Enabled=true`
- `claude-sidecar` 容器随 compose 启动，跟 `api` 在同一内网，BaseUrl 默认 `http://claude-sidecar:7400`
- 双向鉴权对称用同一个 token（默认 `dev-skip`），开发期不用配；生产把 `CLAUDE_SIDECAR_TOKEN` 设成强随机即可
- 节点不写 `tools` 字段 = 纯 chat 模式；写了（如 `tools: "echo,current_time"`）= 启用工具调用，sidecar 收到 `tool_use` 后反向调 `/api/agent-tools/invoke`

**生产覆盖（远程 sandbox）**：把 `appsettings.json` 的 `Sidecars[]` 列表填上远程 URL 即可，零代码改动。详见 §7。

---

## 1. 管理摘要

`claude-sdk` 是历史执行器名，不等于“完整接入官方 Claude Code SDK / Claude Agent SDK”。当前实现更准确的描述是：

- sidecar 使用官方 Anthropic Python SDK 包 `anthropic==0.39.0`，通过 `AsyncAnthropic.messages.stream` 调 Claude Messages API。
- 多轮 `tool_use` 循环、HTTP + SSE sidecar 协议、工具审批等待、工具桥、MAP/CDS 事件转译，都是本仓库自研封装。
- `prd-api` 不直接 import Python SDK，而是通过 HTTP + SSE 调 `claude-sdk-sidecar/`，由 sidecar 持有上游模型凭据。
- 后续若迁移到官方 Claude Code SDK / Claude Agent SDK，应把自研 loop 收缩为 adapter，而不是继续扩大自研协议面。

效果：
- 业务层零迁移：现有 `WorkflowNode` 配置 `executorType: "claude-sdk"` 即可使用。
- 部署灵活：sidecar 可以与 `prd-api` 同 compose、跑在远程 sandbox 服务器、k8s pod 多副本，**业务代码完全无感知**，差异只在 `appsettings.json` 的 `ClaudeSdkExecutor:Sidecars` 列表。
- 不破坏 LlmGateway：常规 LLM 调用仍走 `ILlmGateway` 三级模型池。`claude-sdk` 是"自治 agent"路径，与之并行存在。

命名约束：

- 对外产品文案尽量叫 `CDS Agent runtime` 或 `Claude sidecar runtime`。
- 只有引用旧配置、旧字段、旧事件时才写 `claude-sdk`。
- 不得把当前实现表述为“官方 Claude Code SDK 完整接入”。

## 1.1 官方 / 自研边界

| 层 | 当前来源 | 能省掉吗 | 说明 |
|---|---|---|---|
| Claude Messages API client | 官方 `anthropic` Python SDK | 不建议自研 | 负责鉴权、HTTP、stream event 基础封装 |
| Agent 多轮 loop | 本仓库自研 | 可被官方 Agent SDK 替换 | 当前处理 tool_use、history 拼接、usage 汇总 |
| Sidecar HTTP/SSE 协议 | 本仓库自研 | 需保留或适配 | MAP/CDS 需要跨进程、跨主机调度 |
| 工具审批与审计 | 本仓库自研 | 必须保留 | 这是 MAP 权限和审计能力，不是 SDK 职责 |
| repo / PR / browser 工具 | 本仓库自研 | 必须保留 | 与 CDS workspace、GitHub 凭据、Bridge 绑定 |
| runtime pool / CDS 授权 | 本仓库自研 | 必须保留 | 属于基础设施控制面 |

减少自研的现实收益：若迁移官方 Claude Code SDK / Claude Agent SDK，预计可以减少 30%-50% agent-loop 和上游适配维护量，主要集中在多轮工具调用、stream event、上下文续传、MCP/工具协议兼容和取消语义。但 MAP/CDS 的权限、审批、产物、日志、workspace、PR、运行时池仍需要本仓库维护。

---

## 2. 产品定位

| 何时选 | 何时不选 |
|---|---|
| 需要多轮 `tool_use` 循环 + Claude Messages 流式 | 单轮 chat completion |
| 需要让 Claude 自主决定调用哪个工具 | 业务代码自己编排工具顺序 |
| 需要远程 sandbox 里的自治 Agent 行为 | 团队希望集中在 LlmGateway 三级池 |
| 跑跨服务器 sandbox 隔离（凭据隔离 / 网络隔离） | 主服务进程内调即可 |

`claude-sdk` 不是 LlmGateway 的替代品，是它**之外**的一类专用执行器。

---

## 3. 用户场景

1. **PR 审查 Agent**：节点配置 `executorType="claude-sdk"`，prompt = "审查 PR diff，必要时用 search_code 查看周边实现"。Claude 自主决定查不查、查几次、最后输出审查报告。
2. **缺陷修复 Agent**：sidecar 接收缺陷 ID，循环：拉取详情 → 定位代码 → 写补丁 → 验证。
3. **文档生成 Agent**：从 OpenAPI spec 出发，让 Claude 调 `read_endpoint` / `read_model` 工具拼出完整 API 文档。

---

## 4. 核心架构

```
+-------------------------------+
| Workflow / 业务 Controller     |
|   ↓ 创建 Run                  |
| WorkflowRunWorker              |
|   ↓                            |
| CapsuleExecutor                |
|   .ExecuteCliAgentAsync()      |
|   switch executorType:         |
|     claude-sdk → ClaudeSdk     |     prd-api 进程
+--------------|----------------+
               ↓ IClaudeSidecarRouter
               ↓
+-------------------------------+
| ClaudeSidecarRouter            |
|   - 健康路由 / 标签匹配         |
|   - HTTP + SSE 调 sidecar      |
|   - 事件转译                    |
+-------------------------------+
               ↓ HTTP + Bearer ${SIDECAR_TOKEN}
               ↓
+----------------------------------------------+
| Python sidecar (独立进程 / 独立容器 / 远程主机) |
|   POST /v1/agent/run                          |
|   - anthropic.AsyncAnthropic.messages.stream  |
|   - 多轮 tool_use 循环                         |
|   - tool_use 时反向调主服务 /api/agent-tools  |
+----------------------------------------------+
               ↑ X-Sidecar-Token
               ↑ v0.2 已实现工具 callback + 审批等待
```

部署形态由配置决定：

```jsonc
// 1) 本地开发：sidecar 跑在同机
"Sidecars": [{ "Name": "local", "BaseUrl": "http://127.0.0.1:7400", ... }]

// 2) docker-compose：同一 compose 网络
"Sidecars": [{ "Name": "compose", "BaseUrl": "http://claude-sidecar:7400", ... }]

// 3) 跨服务器 sandbox：远程主机 + TLS
"Sidecars": [
  { "Name": "sandbox-a", "BaseUrl": "https://sdk-a.miduo.org", "Tags": ["prod"], ... },
  { "Name": "sandbox-b", "BaseUrl": "https://sdk-b.miduo.org", "Tags": ["prod"], ... }
]
```

`RoutingStrategy` 支持 `tag-weighted`（默认）、`round-robin`、`sticky-by-runId`。

---

## 5. 数据设计

执行器本身无新建 MongoDB 集合。Token 用量记录复用 `llmrequestlogs`，`ExecuteCliAgent_ClaudeSdkAsync` 会在启动、首字节、完成、失败路径写入日志。

健康状态由 `InstanceStateRegistry`（单例内存）维护，不入库；HostedService 周期写入。

---

## 6. 接口设计

### 6.1 sidecar 对外（被 prd-api 调）

```
POST /v1/agent/run
  Header: Authorization: Bearer ${SIDECAR_TOKEN}
  Body:   SidecarRunRequest
  Resp:   text/event-stream

POST /v1/agent/cancel/{runId}
GET  /healthz
GET  /readyz
```

`SidecarRunRequest` 与 `SidecarEvent` 字段定义：
- Python：`claude-sdk-sidecar/app/schemas.py`
- C#：`prd-api/src/PrdAgent.Core/Interfaces/IClaudeSidecarRouter.cs`

字段调整必须两边同步。

### 6.2 sidecar 反向调主服务（v0.2 已实现）

```
POST /api/agent-tools/invoke
  Header:
    X-Sidecar-Token: {同 SIDECAR_TOKEN，对称鉴权}
    X-Sidecar-Name:  {sidecar 实例名，可选}
  Body:   { toolName, input, runId, appCallerCode }
  Resp:   { success, content, errorCode?, message? }

GET /api/agent-tools/list   返回所有已注册工具的 descriptor 列表
```

实现：
- Controller：`prd-api/src/PrdAgent.Api/Controllers/Api/AgentToolsController.cs`
- Registry：`PrdAgent.Infrastructure.Services.AgentTools.AgentToolRegistry`，构造时登记内置工具
- 内置工具（v0.2）：`echo`（调试用）、`current_time`（返回 UTC）；新工具一个 PR 一个文件落到 `Tools/*.cs`

工作流节点 `tools` 字段填逗号分隔的工具名（如 `"echo,current_time"`）即可启用工具调用。
sidecar 在未配置 `callbackBaseUrl + token` 时返回 stub 文本，方便本地 smoke 测试。

---

## 7. 配置

`appsettings.json` 默认：

```jsonc
"ClaudeSdkExecutor": {
  "Enabled": false,
  "Sidecars": [],
  "RoutingStrategy": "tag-weighted",
  "HealthCheck": { "Path": "/readyz", "IntervalSeconds": 10, ... },
  "Timeouts": { "ConnectMs": 3000, "RequestSeconds": 600, "IdleStreamSeconds": 60 },
  "CallbackBaseUrl": "http://api:8080",
  "DefaultModel": "claude-opus-4-5",
  "EphemeralKeyTtlMinutes": 15
}
```

CDS / docker-compose 通过环境变量覆盖：

```
ClaudeSdkExecutor__Enabled=true
ClaudeSdkExecutor__Sidecars__0__Name=local
ClaudeSdkExecutor__Sidecars__0__BaseUrl=http://claude-sidecar:7400
ClaudeSdkExecutor__Sidecars__0__Token=$CLAUDE_SIDECAR_TOKEN
ClaudeSdkExecutor__Sidecars__0__Tags__0=local
```

`docker-compose.dev.yml` 提供 `claude-sidecar` service（profile 名 `claude-sdk`）：

```bash
ANTHROPIC_API_KEY=sk-ant-xxx CLAUDE_SDK_ENABLED=true \
  docker compose -f docker-compose.dev.yml --profile claude-sdk up -d
```

---

## 8. 关联设计文档

- `.claude/rules/llm-gateway.md` — 常规 LLM 调用统一原则（claude-sdk 是例外，由本文记录原因）
- `.claude/rules/cds-first-verification.md` — 部署验证流程
- `doc/design.ai-toolbox.md` — Toolbox Run/Worker 上层调度
- `doc/spec.marketplace.md` — AgentApiKey scope 规约

---

## 9. 风险与已知边界

| 风险 | 缓解 |
|---|---|
| 凭据泄露：sidecar 持有 Anthropic key | 独立容器 + token 走 env / Secret Manager；不写入镜像 |
| 跨服务器网络不通 | HostedService 周期健康检查，路由器自动跳过不健康实例 |
| Run 中 sidecar 崩溃 | SSE 断流 → executor 抛 InvalidOperationException → Run 标记失败 |
| 不走 LlmGateway 导致计费/审计分裂 | executor 写 `llmrequestlogs`，但长期应统一到模型用量面板 |
| Tool 桥接权限过粗 | 已有 `/api/agent-tools/invoke`，但仍用对称 `X-Sidecar-Token`，高安全场景需补 scope |
| 多个 sidecar 实例间 run 不共享状态 | `stickyKey` 强制同 run 落同实例（默认 stickyKey=runId） |
| 历史命名误导 | 文档和 UI 必须注明当前是官方 `anthropic` SDK + 自研 sidecar loop |

---

## 10. 已知边界（debt）

- 没有为新 executorType 在 admin UI 加可视化 schema（前端 `WorkflowNodeEditor` 不知道 `claudeSdk.*` 字段），需通过 JSON 手动配置。
- 没有 retry/熔断器（Polly）保护对 sidecar 的调用，依赖 IHttpClientFactory 默认行为；高频失败时会抖动。
- `CDS Agent` 页面当前发送消息仍是同步等待后端处理，前端靠 3 秒轮询补体验，不是真正的后台 run + SSE。
- `Stop` 当前停止 CDS session，不保证取消已经派发到 sidecar 的模型 run；需要持久化 runId 并接 `/v1/agent/cancel/{runId}`。
- 事件列表默认最多 500 条，长审查会话需要按 `afterSeq` 分页或增量订阅。
- `repo_run_command` 单次命令上限 180 秒，不适合大型测试套件或长构建。
- 默认 `repo_create_pull_request` 会建 draft PR，后续应改成策略化配置。

以上条目同步登记到 `doc/debt.claude-sdk-executor.md`。

---

## 11. 验收路径

1. **本地冒烟**：`cd claude-sdk-sidecar && pip install -r requirements.txt && uvicorn app.main:app --port 7400`，curl `/v1/agent/run` 拿到 SSE 流。
2. **compose 联调**：`docker compose -f docker-compose.dev.yml --profile claude-sdk up`，启用 `ClaudeSdkExecutor__Enabled=true`，建一个 `executorType="claude-sdk"` 的 WorkflowNode 跑通。
3. **CDS 灰度**：`/cds-deploy` 推到 sandbox，CDS 自动起 sidecar profile（需调整 CDS 模板支持 profile），真人通过预览域名验收。
