# guide.claude-sdk-quickstart

> 三步把 Claude Agent SDK 接进本系统，零代码改动、零专业知识。

---

## 你需要准备的

- Anthropic API key（`sk-ant-xxx`）—— 从 https://console.anthropic.com/ 获取
- Docker（已安装）

就这两个。其他全自动。

---

## 三步启动

### 1. 把 API key 写进 .env

```bash
# 在项目根目录
echo "ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx" >> .env
```

### 2. 启动 docker compose

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

`claude-sidecar` 容器会随其他服务一起起来，`prd-api` 检测到 `ANTHROPIC_API_KEY` 后自动启用 `claude-sdk` 执行器。

### 3. 验证

```bash
# (a) sidecar 健康
docker exec prdagent-claude-sidecar curl -s http://localhost:7400/readyz | python3 -m json.tool
# 应返回 {"ready": true, "anthropicKey": true, "sidecarToken": true, ...}

# (b) prd-api 看到 sidecar
docker logs prdagent-api 2>&1 | grep -i claudesd | head -5
# 应有 "[ClaudeSdk] Sidecar 健康检查启动，实例数=1"

# (c) 创建一个工作流节点用 claude-sdk
# 在 admin UI 工作流编辑器，节点 raw JSON 配置：
{
  "executorType": "claude-sdk",
  "model": "claude-opus-4-5",
  "prompt": "用一句话写春天",
  "maxTurns": 1
}
```

---

## 怎么让 Claude 用工具

节点配置加一个 `tools` 字段（逗号分隔的工具名）：

```json
{
  "executorType": "claude-sdk",
  "prompt": "请查一下当前服务器时间然后告诉我",
  "tools": "current_time",
  "maxTurns": 3
}
```

可用工具列表（v0.2）：

| 工具名 | 用途 |
|---|---|
| `echo` | 调试，原样返回 message 字段 |
| `current_time` | 返回 UTC 当前时间 |

新工具的注册位置在 `prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/`。一个工具一个文件，按 `IAgentTool` 接口实现，构造函数里 `Register` 一下即可。详见 `doc/design.claude-sdk-executor.md` §6.2。

---

## 切换其他模型 / 上游（cc-switch / DeepSeek / Kimi / GLM / 自建网关）

底层是 Anthropic 官方 SDK，**任何 Anthropic-compatible 端点都能用**。三档配置：

### 档位 1：全局切上游（最无脑，30 秒）

只想让整个分支都走 DeepSeek？.env 加两行重启即可：

```bash
echo "ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic" >> .env
echo "ANTHROPIC_API_KEY=sk-deepseek-xxx" >> .env
docker compose -f docker-compose.dev.yml restart claude-sidecar
```

cc-switch 同理：

```bash
echo "ANTHROPIC_BASE_URL=http://host.docker.internal:8888" >> .env
echo "ANTHROPIC_API_KEY=any-dummy-cc-switch-accepts" >> .env
```

### 档位 2：节点级覆盖（同分支不同节点不同模型）

工作流节点 JSON 加 `baseUrl` + `apiKey` 字段：

```json
{
  "executorType": "claude-sdk",
  "model": "deepseek-chat",
  "prompt": "用一句话写春天",
  "baseUrl": "https://api.deepseek.com/anthropic",
  "apiKey": "${env:DEEPSEEK_API_KEY}"
}
```

注意：节点配置会被持久化到工作流文档，**生产环境不要把 apiKey 明文写在节点里**，用档位 3 的 profile 引用更安全。

### 档位 3：命名 profile（cc-switch 风格，频繁切换）

一次配置 N 处复用：

```bash
# 1. 复制示例
cp claude-sdk-sidecar/profiles.example.yaml claude-sdk-sidecar/profiles.yaml

# 2. 编辑 profiles.yaml（已 gitignore），填上你的多个上游
#   profile 的 ${VAR} 占位符会从 sidecar 进程 env 替换

# 3. 在 docker-compose.dev.yml 里把 claude-sidecar 的 volumes 注释打开：
#    volumes:
#      - ./claude-sdk-sidecar/profiles.yaml:/app/profiles.yaml:ro

# 4. 重启
docker compose -f docker-compose.dev.yml up -d --force-recreate claude-sidecar
```

然后节点只写 `profile` 名：

```json
{ "executorType": "claude-sdk", "model": "claude-haiku-4-5-20251001", "profile": "deepseek" }
{ "executorType": "claude-sdk", "model": "moonshot-v1-128k",          "profile": "kimi" }
{ "executorType": "claude-sdk", "model": "claude-haiku-4-5-20251001", "profile": "cc-switch" }
```

### 优先级（同时给多个时）

1. `profile`（最高）—— sidecar 查 profiles.yaml 解析 baseUrl + apiKey
2. `baseUrl` + `apiKey`（per-request 直接覆盖）
3. `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` env（默认）

### 已知兼容端点（截至 2026-04，请以官方为准）

| 端点 | base_url 示例 | 备注 |
|---|---|---|
| Anthropic 官方 | _不设 base_url 即可_ | 默认 |
| DeepSeek | `https://api.deepseek.com/anthropic` | 模型名 `deepseek-chat` 等 |
| Kimi | `https://api.moonshot.cn/anthropic` | 模型名 `moonshot-v1-*` |
| 智谱 GLM | `https://open.bigmodel.cn/api/anthropic` | 模型名 `glm-4-*` |
| cc-switch 本地代理 | `http://host.docker.internal:8888` | 注意是 host.docker.internal，不是 127.0.0.1 |
| 自建 OpenRouter / 网关 | `https://...` | 取决于网关是否做 anthropic 协议适配 |

### 实测证明

我们在沙箱里跑了 4 项测试（U1/U2/U3/U4），用 mock 上游验证：

- U1 默认 env 上游 -> 请求确实落到 `api.anthropic.com`（拿到真 request_id）
- U2 per-request `baseUrl` 覆盖 -> 请求落到 `127.0.0.1:8765` mock
- U3 `profile: mock` + yaml 里的 `${MOCK_KEY_VAR}` -> 占位符正确从 env 替换
- U4 不存在的 profile -> 立即报 `upstream_resolve_failed`，不发外网请求

切换上游 = 改一行配置，零代码改动。

---

## 跨服务器（远程 sandbox）部署

不改代码，改配置。在 `appsettings.Production.json`（或环境变量）：

```jsonc
"ClaudeSdkExecutor": {
  "Enabled": true,
  "Sidecars": [
    {
      "Name": "sandbox-a",
      "BaseUrl": "https://sdk-a.miduo.org",
      "Token": "<strong-random-token>",
      "Tags": ["prod"]
    },
    {
      "Name": "sandbox-b",
      "BaseUrl": "https://sdk-b.miduo.org",
      "Token": "<strong-random-token>",
      "Tags": ["prod"]
    }
  ],
  "CallbackBaseUrl": "https://api-internal.miduo.org",
  "RoutingStrategy": "tag-weighted"
}
```

要点：
- 多实例 = 自动负载均衡 + 健康检查 + 故障转移
- `CallbackBaseUrl` 必须是远程 sidecar 网络可达的内网域名（不能用 127.0.0.1）
- 同一 token 双向使用：sidecar 用它验证主服务调用，主服务也用它验证 sidecar 反向 callback

---

## 常见问题

**Q: 我没有 ANTHROPIC_API_KEY，会怎样？**
A: claude-sidecar 容器照常启动但 `/readyz` 返回 503，prd-api 健康检查会标记不健康，`claude-sdk` 执行器不会启用。其他执行器（builtin-llm / docker / api / script / lobster）一切照常。零影响。

**Q: 我已经有 LLM Gateway 三级模型池，为什么还要 Claude SDK？**
A: 不是替代，是并行。LLM Gateway 处理"业务代码自己编排"的场景；Claude SDK 处理"让 Claude 自主决定调用哪些工具、调几次"的场景（多轮 tool_use 循环）。详见 `doc/design.claude-sdk-executor.md` §2。

**Q: claude-sdk 调用会不会绕过我的账单？**
A: 不会。`ExecuteCliAgent_ClaudeSdkAsync` 启动 / 结束时主动写 `llmrequestlogs`（Provider="anthropic-sdk", Model=具体模型, Tokens=usage 字段），跟其他 LLM 调用一样能在 LLM 日志页看到。

**Q: token 默认 `dev-skip` 安全吗？**
A: 仅适用于本地开发。生产必须设 `CLAUDE_SIDECAR_TOKEN=<32+ 字符强随机>`，否则任何能访问内网的人都能反向调你的工具集。

---

## 出问题怎么排查

| 症状 | 排查路径 |
|---|---|
| 节点报 "claude-sdk 执行器未启用" | `docker logs prdagent-api \| grep ClaudeSdk` 看 PostConfigure 是否生效 |
| sidecar `/readyz` 返回 503 | 检查 ANTHROPIC_API_KEY 是否传到容器：`docker exec prdagent-claude-sidecar env \| grep -i ANTHROPIC` |
| 工具调用 401 | `X-Sidecar-Token` 不一致。检查 prd-api 和 sidecar 的 `CLAUDE_SIDECAR_TOKEN` 是否相同 |
| LLM 日志页看不到 claude-sdk | 检查节点配置 `executorType` 是否拼写正确；检查 `LlmRequestLogWriter` DI 是否成功注入 |

---

## 相关文档

- `doc/design.claude-sdk-executor.md` —— 完整架构设计
- `doc/debt.claude-sdk-executor.md` —— 已知边界 / 工程债务
- `claude-sdk-sidecar/README.md` —— sidecar 协议详情
- `.claude/rules/llm-gateway.md` —— 为何 claude-sdk 是 LlmGateway 的"并行路径"
