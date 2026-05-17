# claude-sdk-sidecar

Python 进程，把 Agent runtime 包装成统一的 HTTP + SSE 协议，供 prd-api 的
`claude-sdk` 历史执行器消费。

当前有两条 runtime 路径：

- `legacy-sidecar`：兼容路径，使用官方 `anthropic` Python SDK + 本仓库自研
  `agent_loop.py`。
- `claude-agent-sdk`：官方 Claude Agent SDK adapter spike，使用
  `claude-agent-sdk` 的 Claude Code tools / agent loop / context management。该路径可通过
  请求字段 `runtimeAdapter=claude-agent-sdk` 或环境变量
  `SIDECAR_AGENT_ADAPTER=claude-agent-sdk` 启用。
  当前 adapter 使用 `ClaudeSDKClient`，sidecar `/v1/agent/cancel/{runId}` 会触发
  `client.interrupt()`。
  默认只开放 `Read,Grep,Glob` 只读内置工具，避免 Claude Code 内置
  `Bash/Edit/Write` 绕过 MAP 审批。确需写文件或执行命令时，显式设置
  `CLAUDE_AGENT_SDK_ALLOWED_TOOLS=Read,Grep,Glob,Bash,Edit,Write`，并在上线前接入
  SDK permission callback / MAP approval bridge。当前已接入 `can_use_tool` 骨架：
  对 `Bash/Edit/Write` 会先向 MAP 创建 approval request，再等待 MAP approval。

MAP/prd-api 侧也可以设置 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=claude-agent-sdk`，
由 `ClaudeSidecarRouter` 把选择项透传给 sidecar。MAP 未设置时默认请求
`claude-agent-sdk`；如果需要回退自研 loop，可显式设置
`INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar`。sidecar 独立运行且请求未传
`runtimeAdapter` 时，仍由 `SIDECAR_AGENT_ADAPTER` 决定，未设置则保留 legacy fallback。

## 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/agent/run` | SSE 流式，body 见 `app/schemas.py::SidecarRunRequest` |
| POST | `/v1/agent/cancel/{runId}` | 取消运行 |
| GET  | `/healthz` | 存活探针 |
| GET  | `/readyz` | 就绪探针（探测 ANTHROPIC_API_KEY、当前 adapter、官方 SDK 包、外部 CLI 路径观测和 workspace 诊断） |

所有 `/v1/*` 请求需 `Authorization: Bearer ${SIDECAR_TOKEN}`。开发期可设
`SIDECAR_TOKEN=dev-skip` 跳过校验。

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
Header: X-Agent-Api-Key: {agentApiKey}
Body:   { toolName, input, runId, appCallerCode }
Resp:   { success, content } 或 { success: false, errorCode, message }
```

主服务侧通过 `sk-ak-*` 临时签发的 AgentApiKey 鉴权，scope 限定为本次 run 允许的
工具集合，TTL 默认 15 分钟。

未配置 `callbackBaseUrl + agentApiKey` 时（本地 smoke 测试），sidecar 会返回
固定 stub 字符串，方便端到端打通调用链。

## 本地启动

```bash
cd claude-sdk-sidecar
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-xxx
export SIDECAR_TOKEN=dev-skip
uvicorn app.main:app --host 0.0.0.0 --port 7400 --reload
```

冒烟：

```bash
curl -N -X POST http://127.0.0.1:7400/v1/agent/run \
  -H 'Authorization: Bearer dev-skip' \
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
  -H 'Authorization: Bearer dev-skip' \
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
CLAUDE_AGENT_SDK_PERMISSION_MODE=acceptEdits
```

官方 adapter 工作区准备：

- 请求带 `workspaceRoot` 时，sidecar 直接把它作为 `ClaudeAgentOptions.cwd`，并要求该目录存在。
- 请求未带 `workspaceRoot` 但带 `gitRepository` 时，sidecar 会在
  `SIDECAR_WORKSPACES_ROOT`（默认 `/tmp/cds-agent-workspaces`）下准备 GitHub 工作区，
  支持 `owner/repo` 或 `https://github.com/owner/repo`，再把准备好的目录作为 SDK cwd。
- `gitRef` 会作为 shallow clone/fetch 的 ref；当前只支持安全字符集，不支持任意 shell 片段。
- 同一 repo/ref 的准备过程有 sidecar 进程内异步锁，避免并发 clone/fetch 互相覆盖。
- `readyz.adapterDiagnostics.workspacePreparation` 会暴露 workspace root、git 是否可用、支持的仓库格式和锁策略。
- 这一步只负责 workspace/control-plane 准备，不接管 Claude Agent SDK 的 agent loop。

官方 adapter 就绪诊断：

```bash
curl http://127.0.0.1:7400/readyz
```

`readyz.adapterDiagnostics` 会返回 `sdkInstalled`、`sdkVersion`、`claudeCliPath`、
`claudeCliBundled`、`workspaceRootExists`、`allowedTools`、`permissionMode`、
`builtinWriteToolsEnabled` 和 `approvalBridge`，并用 `loopOwner` / `sdkLoopEnabled` 明确当前 turn loop
归属：`claude-agent-sdk` 表示官方 SDK loop，`sidecar-legacy-loop` 表示仍在 legacy fallback。
`readyz.blockers` / `readyz.nextActions` 会直接给出缺失项和修复动作；
默认 `SIDECAR_PROVIDER_KEY_MODE=runtime-profile-or-env` 时，不会因为 sidecar env 缺少
`ANTHROPIC_API_KEY` 判定不可用，provider key 可由 MAP runtime profile 或请求覆盖下发。
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

依赖说明：官方 `claude-agent-sdk` 当前依赖链要求较新的 `pydantic`，并会通过
`mcp` 间接引入 SSE 相关包。`requirements.txt` 已固定 `pydantic`、`starlette`
和 `sse-starlette`，避免和 `fastapi==0.115.0` 解出不兼容组合。

## Docker

```bash
docker build -t prd-agent/claude-sidecar:latest .
docker run --rm -p 7400:7400 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e SIDECAR_TOKEN=dev-skip \
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
