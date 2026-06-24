# MAP MCP 连接器接入 · 指南

> **版本**：v1.0 | **日期**：2026-06-16 | **状态**：已落地

## 这是什么

MAP 现在是一个 **MCP（Model Context Protocol）连接器**——和 GitHub、Slack 在 Claude / Codex 里一样，填一个网址 + 一把密钥，Claude / Codex 就能直接调用 MAP 的开放能力（搜索海鲜市场技能、读知识库等）。

底层不是新业务，是给已有开放接口加了一层 MCP 协议适配：远程 `/api/mcp` 端点把 MAP 的开放接口「翻译」成 MCP 工具，`tools/call` 回环转发到真实接口。鉴权、权限全部复用 `sk-ak` AgentApiKey + scope。

| 维度 | 值 |
|------|-----|
| 端点 | `https://<你的域名>/api/mcp` |
| 传输 | Streamable HTTP（JSON-RPC 2.0） |
| 鉴权 | `Authorization: Bearer sk-ak-...` |
| 设计 / 债务 | `doc/design.map-mcp-connector.md` / `doc/debt.map-mcp-connector.md` |

## 三步接入

### 第 1 步：生成 sk-ak 密钥

登录 MAP → 海鲜市场右上角「接入 AI」→ 生成一把 `sk-ak-*` 密钥，按需勾选 scope：
- `marketplace.skills:read` —— 用海鲜市场工具
- `document-store:read` —— 用知识库工具

明文密钥只显示一次，复制好。

### 第 2 步：在 Claude / Codex 里加连接器

- **Claude（自定义连接器 / Desktop 新版）**：添加远程 MCP server → URL 填 `https://<域名>/api/mcp` → 认证方式选 Bearer / 自定义 Header，值填 `Bearer sk-ak-...`
- **Codex（`config.toml`）**：配 HTTP transport 的 MCP server，headers 带 `Authorization = "Bearer sk-ak-..."`

### 第 3 步：用

对 Claude 说「搜一下海鲜市场关于 X 的技能」或「列一下我的知识库 / 读某篇文档」，它会自动调对应工具。

## 内置工具（5 个）

| 工具 | 作用 | 所需 scope |
|------|------|-----------|
| `marketplace_search_skills` | 搜海鲜市场技能（关键词 / 标签 / 热度 / 最新） | marketplace.skills:read |
| `marketplace_get_skill` | 按 id 取技能详情 | marketplace.skills:read |
| `knowledge_base_list_stores` | 列我自己 + 团队共享的知识库 | document-store:read |
| `knowledge_base_list_entries` | 列某知识库下的文档条目（扁平含嵌套） | document-store:read |
| `knowledge_base_read_entry` | 读某文档条目正文 | document-store:read |

> `document-store:write` 隐含 read；持写 scope 的密钥也能用知识库读工具。

## 快速验证（curl）

```bash
KEY="sk-ak-你的密钥"
URL="https://<域名>/api/mcp"

# 列工具（应返回 5 个）
curl -s "$URL" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -m json.tool

# 调海鲜市场搜索
curl -s "$URL" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"marketplace_search_skills","arguments":{"sort":"hot","limit":3}}}' | python3 -m json.tool

# 列我的知识库
curl -s "$URL" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"knowledge_base_list_stores","arguments":{}}}' | python3 -m json.tool
```

## 共享其他 Agent / appName 的功能（动态工具）

任何 Agent 的开放接口都能挂上 MCP，**零代码**——平台管理员登记一条 `AgentOpenEndpoint`：

```
POST /api/admin/agent-open-endpoints
{ "agentKey":"report-agent", "path":"/api/report/weekly/generate",
  "httpMethod":"POST", "requiredScopes":["agent.report-agent:call"],
  "requestExampleJson":"{...}" }
```

登记后 `tools/list` 自动多一个工具 `report-agent__call__<id>`；用户的 sk-ak 带上 `agent.report-agent:call` scope，该工具就出现在他的 Claude / Codex 里，`tools/call` 回环到真实接口。

> **关键约束**：被登记的目标接口必须对 sk-ak 友好——`[Authorize(AuthenticationSchemes="ApiKey")] + [RequireScope("agent.{key}:{action}")] + 读 boundUserId`。
> 不要登记走 `GetRequiredUserId()`（只读 sub）且在 `PublicRoutes` 豁免的接口（如 document-store 的 stores/entries 业务路由），那样 sk-ak 回环会 401（参见知识库为何另建 `/api/open/document-store`）。

## AI / 自动化无人值守签发（规划中）

理想情况下，带 `AiAccessKey` 全局超级密钥的自动化应能代用户签发 scoped sk-ak、端到端验证开放接口，无需人工进 UI。

> **当前状态**：曾试过在 `AgentApiKeysController` 同时挂 `Bearer,AiAccessKey` 双方案，但「同请求同时带 JWT + 全局 key」时 `FindFirst(sub)` 会选错用户（Bugbot Medium）。已撤回。
> **正确做法**（见 `debt.platform.map-mcp-connector.md`）：单独建一个**只接受 `AiAccessKey` 方案**的专用签发端点（单身份、无歧义），而不是给用户自助管理端点叠加全局密钥。`AiAccessKey` 鉴权器本身（`X-AI-Access-Key` + `X-AI-Impersonate`）是既有设计，不动。

## 排障

| 现象 | 原因 / 处理 |
|------|-----------|
| `POST /api/mcp` 返回 200 html | 端点必须在 `/api/` 前缀下（反代只把 `/api/*` 转后端）；确认是 `/api/mcp` 不是 `/mcp` |
| 401 UNAUTHORIZED | 密钥无效 / 过期 / 被撤销，或没带 `Authorization: Bearer` |
| `tools/list` 返回空 | 密钥 scope 不覆盖任何工具；补 `marketplace.skills:read` / `document-store:read` |
| 某工具 `isError:true` 401 | 目标开放接口对 sk-ak 不友好（见上「关键约束」） |
| 下载链接是 localhost | 回环未转发 host 头（已修：转发 `X-Forwarded-Host/Proto`） |

## 相关

- `doc/design.map-mcp-connector.md` —— 设计与实施
- `doc/design.skill-marketplace-open-api.md` —— AgentApiKey + AgentOpenEndpoint 上游设计
- `.claude/rules/no-rootless-tree.md` —— 借用法则（连接器借现成桩，不重建）
