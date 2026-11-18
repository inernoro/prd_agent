# claude-sdk-sidecar

Python 进程，把 Agent runtime 包装成统一的 HTTP + SSE 协议，供 prd-api 的
`claude-sdk` 历史执行器消费。

当前有两条 runtime 路径：

- `legacy-sidecar`：兼容路径，使用官方 `anthropic` Python SDK + 本仓库自研
  `agent_loop.py`；只能通过显式配置作为 fallback 使用。默认官方路径不会在 sidecar
  启动时加载该 legacy loop，只有显式选择 `legacy-sidecar` 时才懒加载。
- `claude-agent-sdk`：官方 Claude Agent SDK adapter spike，使用
  `claude-agent-sdk` 的 Claude Code tools / agent loop / context management。该路径是
  sidecar、MAP 和 CDS Agent 代码审查的默认路径；请求字段
  `runtimeAdapter=claude-agent-sdk` 或环境变量 `SIDECAR_AGENT_ADAPTER=claude-agent-sdk`
  只用于显式声明和诊断。
  当前 adapter 使用 `ClaudeSDKClient`，sidecar `/v1/agent/cancel/{runId}` 会触发
  `client.interrupt()`。
  部署上限默认只开放 `Read,Grep,Glob`。Edit/Write 需部署配置及任务授权同时许可，
  并经过固定 MAP 审批桥。Bash 在当前实现中拒绝，不能靠环境变量或请求字段开启。

MAP/prd-api 侧也可以设置 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=claude-agent-sdk`，
由 `ClaudeSidecarRouter` 把选择项透传给 sidecar。MAP 未设置时默认请求
`claude-agent-sdk`；如果需要回退自研 loop，可显式设置
`INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar`。sidecar 独立运行且请求未传
`runtimeAdapter` 时，仍由 `SIDECAR_AGENT_ADAPTER` 决定；未设置则默认
`claude-agent-sdk`。只有显式设置 `SIDECAR_AGENT_ADAPTER=legacy-sidecar` 才会走自研
loop fallback。

## 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/agent/run` | SSE 流式，body 见 `app/schemas.py::SidecarRunRequest` |
| POST | `/v1/agent/cancel/{runId}` | 取消运行 |
| GET  | `/healthz` | 存活探针 |
| GET  | `/readyz` | 就绪探针（探测 ANTHROPIC_API_KEY、当前 adapter、官方 SDK 包、外部 CLI 路径观测和 workspace 诊断） |

所有 `/v1/*` 请求需平台签发的 `map-task-v2.*` 短期任务凭据。共享
`SIDECAR_TOKEN`（包括 `dev-skip`）不再授权运行、取消或回调。部署必须设置
`SIDECAR_AUTHORITY_URL` 为可信 MAP 控制面地址；请求不能替换该地址。
Sidecar 向该固定地址核验主体、run、用途、工具、工作区、profile 和期限，
并与部署工具上限取交集。未分配工作区或仓库时禁用内置文件工具，不授权进程默认目录。callbackBaseUrl 若提供必须等于该固定地址。

这是需要 MAP 与 Sidecar 同步升级的协议变更。控制面不可达、凭据过期、旧凭据
缺少 runtime scope 时均拒绝执行。运行凭据由任务准入流程签发，不能用 curl
自行构造；下面的调用示例须使用已有的授权运行请求与短期凭据。

## 事件类型（SSE）

```
event: text_delta    -> 流式文本增量 { text }
event: tool_use      -> Claude 决定调工具 { tool_name, tool_input, tool_use_id }
event: tool_result   -> 工具执行返回 { tool_name, tool_use_id, content }
event: usage         -> 本轮 token 用量 { input_tokens, output_tokens }
event: done          -> 终态 { final_text, input_tokens, output_tokens }
event: error         -> 异常终态 { error_code, message }
```

## 工具桥接

sidecar 收到 `tool_use` 后会反向调主服务：

```
POST {callbackBaseUrl}/api/agent-tools/invoke
Header: X-Sidecar-Token: {agentApiKey}
Body:   { toolName, input, runId, appCallerCode }
Resp:   { success, content } 或 { success: false, errorCode, message }
```

主服务的任务续接凭据冻结本次 run 的主体、工具和运行时配置，并在每次回调重新检查
任务租约。审批绑定 run、凭据、工具和原始参数；等待和调用均只可消费一次。
缺少审批桥不会返回成功 stub。审批拒绝、超时、取消及过期均关闭执行路径。

SDK 固定使用 default permission mode、bare 模式和严格 MCP 配置。PreToolUse
拦截所有工具（包括 SDK 自动批准的读取），其失败策略为 block。Read/Grep/Glob
检查工作区边界和符号链接；Edit/Write 还必须通过审批。Bash 和未知内置工具拒绝
执行，恢复 shell 能力前须接入独立 OS 沙箱。当前并非 OS 级多租户隔离：不能把
有不可信本地写入者的共享目录当作安全沙箱，检查与 SDK 文件访问之间的竞争仍需
隔离运行环境消除。Git 工作区按主体和 run 分开。

运行占位在返回 SSE 前完成。MAP 使用现有 Mongo 数据域持久登记 run 和审批，
通过唯一键与原子状态转换防重放，写入须获得 majority/journal 确认；存储故障拒绝执行。
审批绑定主体、凭据、工具、原始参数及期限，按数据库时间校验有效期。记录不自动删除，
不得清除或回滚防重放集合后重用旧凭据。崩溃或响应丢失可能消耗批准，需创建新批准，
不自动重试已消费操作。该保证是至多一次分派，不是副作用恰好一次。
取消意图与终态也存储在同一 Mongo 中，不广播凭据。任意 Sidecar 副本可受理绑定
凭据的取消；执行副本每 0.5 秒轮询固定控制面，控制面故障时停止继续执行。
取消受理为 HTTP 202/cancel_requested，停止确认后为 cancelled；已完成任务保持原终态。
路由结果 Cancelled 只有确认停止才为 true；待确认时为 false，Reason=cancel_requested。
调用方须按 pending 状态处理，不能沿用“HTTP 成功等于已经停止”的判断。
成功 SSE 终态须先确认持久状态。失联或无法确认清理时报告 run_state_unconfirmed，
不能冒充 cancelled/completed；过期状态在后续查询时收敛为 expired。
MAP 任意副本可凭可信认证用户主体取消其运行；后台调用需原任务租约上下文与本地
运行凭据，控制面在本地复核授权后写入共享状态。可信服务也可传递已验证的主体。会话停止服务验证持久会话归属与停止租约后
可跨副本取消；其他缺少主体或任务权威的后台调度须显式接入授权上下文。
MAP/Sidecar 必须同步升级以支持 status/complete/fail 控制操作，旧运行墓碑不能作为
可运行记录恢复；不需要新增基础设施。每轮查询 HTTP 超时 10 秒，故障停止并非即时。
取消不撤销已经开始的工具副作用，SDK/OS 层的强制终止保证仍须单独验收。
多副本须共享同一可信 Mongo 数据库和既有 Data Protection 密钥环；本地测试不证明
真实生产副本故障转移、备份恢复或密钥分发已正确配置。

## 本地启动

```bash
cd claude-sdk-sidecar
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-xxx
export SIDECAR_AUTHORITY_URL=https://trusted-map.example
uvicorn app.main:app --host 0.0.0.0 --port 7400 --reload
```

冒烟：

```bash
curl -N -X POST http://127.0.0.1:7400/v1/agent/run \
  -H "Authorization: Bearer ${RUNTIME_CREDENTIAL}" \
  -H 'Content-Type: application/json' \
  -d '{
    "runId":"smoke-1",
    "model":"claude-opus-4-5",
    "systemPrompt":"You are a Chinese poet.",
    "messages":[{"role":"user","content":"用一句话写春天"}],
    "maxTurns":1
  }'
```

官方 Claude Agent SDK adapter 冒烟：

```bash
curl -N -X POST http://127.0.0.1:7400/v1/agent/run \
  -H "Authorization: Bearer ${RUNTIME_CREDENTIAL}" \
  -H 'Content-Type: application/json' \
  -d '{
    "runId":"official-smoke-1",
    "runtimeAdapter":"claude-agent-sdk",
    "model":"claude-opus-4-5",
    "systemPrompt":"只做只读检查。",
    "messages":[{"role":"user","content":"列出当前目录下最关键的 5 个文件，不修改。"}],
    "maxTurns":3
  }'
```

官方 adapter 权限环境变量：

```bash
# 默认：只读
CLAUDE_AGENT_SDK_ALLOWED_TOOLS=Read,Grep,Glob
CLAUDE_AGENT_SDK_PERMISSION_MODE=default

# 写入/命令 opt-in；必须配合 MAP 审批桥验证后再上生产
CLAUDE_AGENT_SDK_ALLOWED_TOOLS=Read,Grep,Glob,Bash,Edit,Write
CLAUDE_AGENT_SDK_PERMISSION_MODE=default
```

官方 adapter 工作区准备：

- 请求带 `workspaceRoot` 时，必须精确匹配任务授权且位于部署的 `AGENT_WORKSPACE_ROOT`（或 `SIDECAR_WORKSPACES_ROOT`）内；目录必须存在且没有符号链接祖先。
- 请求未带 `workspaceRoot` 但带 `gitRepository` 时，sidecar 会在
  `SIDECAR_WORKSPACES_ROOT`（默认 `/tmp/cds-agent-workspaces`）下准备 GitHub 工作区，
  支持 `owner/repo` 或 `https://github.com/owner/repo`，再把准备好的目录作为 SDK cwd。
- 私有 GitHub 仓库可设置 `SIDECAR_GITHUB_TOKEN`，未设置时回退读取 `GITHUB_TOKEN`。
  token 只通过 Git 临时 config env 作为 HTTP authorization header 传给 `clone/fetch`，
  不写入 clone URL、remote config 或 `runtime_init` 事件。
- `gitRef` 会作为 shallow clone/fetch 的 ref；当前只支持安全字符集，不支持任意 shell 片段。
- 同一 repo/ref 的准备过程有 sidecar 进程内异步锁，避免并发 clone/fetch 互相覆盖。
- `readyz.adapterDiagnostics.workspacePreparation` 会暴露 workspace root、git 是否可用、支持的仓库格式、私有仓库授权是否已配置和锁策略；不会返回 token 值。
- workspace 准备失败时，adapter 会返回 `workspace_prepare_failed`，并在事件
  `content.workspaceErrorCode/nextActions/privateRepositoryAuthConfigured` 中区分
  `unsupported_git_repository`、`unsupported_git_ref`、
  `github_repository_auth_or_not_found` 等原因，便于 MAP 诊断包直接指向修复动作。
- 这一步只负责 workspace/control-plane 准备，不接管 Claude Agent SDK 的 agent loop。

官方 adapter 就绪诊断：

```bash
curl http://127.0.0.1:7400/readyz
```

`readyz.adapterDiagnostics` 会返回 `sdkInstalled`、`sdkVersion`、`claudeCliPath`、
`claudeCliBundled`、`workspaceRootExists`、`allowedTools`、`permissionMode`、
`builtinWriteToolsEnabled` 和 `approvalBridge`，并用 `loopOwner` / `sdkLoopEnabled` 明确当前 turn loop
归属：`claude-agent-sdk` 表示官方 SDK loop，`sidecar-legacy-loop` 表示仍在 legacy fallback。
如果显式回退 `legacy-sidecar`，SSE 第一条事件也会是 `runtime_init`，其中
`content.loopOwner=sidecar-legacy-loop`、`content.sdkLoopEnabled=false`、
`content.fallback=explicit`，确保 MAP 事件流、诊断包和 UI 都能审计这次运行没有走官方 SDK。
默认 `claude-agent-sdk` 路径的诊断字段 `legacyLoopImport=lazy-explicit-fallback`
表示自研 loop 没有进入默认运行路径，只作为显式 fallback 保留。
`readyz.blockers` / `readyz.nextActions` 会直接给出缺失项和修复动作；
默认 `SIDECAR_PROVIDER_KEY_MODE=runtime-profile-or-env` 时，不会因为 sidecar env 缺少
`ANTHROPIC_API_KEY` 判定不可用，provider key 可由 MAP runtime profile 或请求覆盖下发。
真正执行 run 时，官方 adapter 会在进入 Claude Agent SDK 前检查有效 provider key；
如果 env、runtime profile、request override 都没有 key，会返回结构化
`provider_key_missing`，并在 `content.nextActions` 中提示设置 sidecar env 或选择 MAP
runtime profile。这个错误发生在 SDK client 创建之前，不会伪装成 SDK 执行失败。
MAP 页面通过
`GET /api/infra-agent-sessions/runtime-status` 读取 sidecar pool 诊断；如果
`SIDECAR_AGENT_ADAPTER=claude-agent-sdk` 但缺 `claude_agent_sdk` 或 workspace root 不存在，
readyz 会返回 503，避免用户启动任务后才发现运行时不可用。
`claudeCliPath` 只观测外部 PATH 命令；官方 Python SDK 包会携带 CLI 能力，所以 MAP 不把
外部 `claude` 命令作为默认就绪门禁。

无真实 SDK/key 的结构性测试：

```bash
python3 -m unittest discover -s claude-sdk-sidecar/tests
```

这个测试使用 fake `claude_agent_sdk`，只验证 adapter 事件映射和取消路径。

官方 SDK adapter 本地 smoke：

```bash
bash claude-sdk-sidecar/smoke.sh
```

历史 `smoke.sh` 仍使用旧共享凭据，不能作为新授权合同验收路径；迁移前会被拒绝。

`smoke.sh` 默认以 `SIDECAR_AGENT_ADAPTER=claude-agent-sdk` 启动 sidecar。缺少
`uvicorn` 或 `claude_agent_sdk` 时会按 `requirements.txt` 安装依赖；无
`ANTHROPIC_API_KEY` 时不会直接跳过，而是发起一次 official adapter run 并期望看到
`provider_key_missing` 结构化错误，证明错误发生在 SDK client 创建前且能被 MAP/UI
稳定消费。有 `ANTHROPIC_API_KEY` 时，会继续跑真实 Anthropic 流式调用。

依赖说明：官方 `claude-agent-sdk` 当前依赖链要求较新的 `pydantic`，并会通过
`mcp` 间接引入 SSE 相关包。`requirements.txt` 已固定 `pydantic`、`starlette`
和 `sse-starlette`，避免和 `fastapi==0.115.0` 解出不兼容组合。

## Docker

```bash
docker build -t prd-agent/claude-sidecar:latest .
docker run --rm -p 7400:7400 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e SIDECAR_AUTHORITY_URL=https://trusted-map.example \
  prd-agent/claude-sidecar:latest
```

CDS / docker-compose 编排见仓库根 `docker-compose.dev.yml` 的 `claude-sidecar`
服务定义。

## 与 prd-api 的协议对齐

任何字段调整必须同步：

- `app/schemas.py::SidecarRunRequest / SidecarEvent`
- `prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/SidecarTypes.cs`

事件类型映射到 prd-api 的 `ToolboxRunEventType` 在 `ClaudeSidecarRouter.cs`
完成转译，新增事件需两处同时改。
