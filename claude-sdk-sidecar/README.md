# claude-sdk-sidecar

Python 进程，把 Anthropic 官方 SDK 的 Agent Loop（多轮 tool_use）包装成一个统一的
HTTP + SSE 协议，供 prd-api 的 `claude-sdk` 执行器消费。

## 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/agent/run` | SSE 流式，body 见 `app/schemas.py::SidecarRunRequest` |
| POST | `/v1/agent/cancel/{runId}` | 取消运行 |
| GET  | `/healthz` | 存活探针 |
| GET  | `/readyz` | 就绪探针（探测 ANTHROPIC_API_KEY） |

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
