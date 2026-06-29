# CDS Agent API · 设计

> **版本**：v1.0 | **日期**：2026-05-14 | **状态**：开发中

## 目标

本文定义 MAP 与 CDS Agent 工作台之间的 API 契约。API 目标是支持长期系统授权、任意模型运行配置、远程会话生命周期、流式事件、工具审批、Hook、日志与工作流调用。

## 认证模型

MAP 前端使用 MAP 登录态访问 `prd-api`。`prd-api` 使用已保存的 CDS long token 调用 CDS。

CDS long token 是长期系统授权，直到撤销或删除。`expiresAt` 为空或远未来值表示长期有效。配对 code 可以短期有效，但不能影响 long token 生命周期。

## MAP API

### Runtime Profile

`GET /api/infra-agent-runtime-profiles`

返回当前系统可用的模型运行配置。API key 不回显明文。

`POST /api/infra-agent-runtime-profiles`

请求：

```json
{
  "name": "公司 Claude 网关",
  "runtime": "claude-sdk",
  "baseUrl": "https://llm.example.com/v1",
  "model": "claude-sonnet-4-5",
  "apiKey": "sk-...",
  "isDefault": true
}
```

### Agent Sessions

`POST /api/infra-agent-sessions`

请求：

```json
{
  "connectionId": "infra-connection-id",
  "runtimeProfileId": "profile-id",
  "runtime": "claude-sdk",
  "model": "claude-sonnet-4-5",
  "title": "远程代码巡检",
  "toolPolicy": "confirm-dangerous",
  "hookProfileId": "hook-profile-id"
}
```

`POST /api/infra-agent-sessions/{id}/start`

启动或恢复远程 runtime。后端会把 profile 中的 `baseUrl`、`model`、API key 和 runtime 传给 CDS。

`POST /api/infra-agent-sessions/{id}/messages`

保存 user message 并转发给 CDS。返回会话视图；具体增量输出通过 events 或 stream 获取。

`GET /api/infra-agent-sessions/{id}/events?afterSeq=0`

按序返回事件，支持刷新恢复。

`GET /api/infra-agent-sessions/{id}/stream`

SSE 流式返回事件。事件必须带 `seq`，客户端用 `afterSeq` 续读。

`POST /api/infra-agent-sessions/{id}/tool-approvals/{approvalId}`

请求：

```json
{
  "decision": "allow"
}
```

`GET /api/infra-agent-sessions/{id}/logs`

返回 runtime 日志。长日志前端折叠展示。

`POST /api/infra-agent-sessions/{id}/stop`

停止并释放远程 runtime。停止失败必须返回错误事件和日志摘要。

## CDS API

`POST /api/projects/{projectId}/agent-sessions`

创建远程会话。请求包含 runtime、model、modelBaseUrl、modelApiKey、runtimeProfileId、toolPolicy、hookProfile。

`POST /api/projects/{projectId}/agent-sessions/{id}/messages`

向 runtime 发送消息。真实 runtime 应返回 text_delta、tool_call、tool_result、log、done 或 error。

`GET /api/projects/{projectId}/agent-sessions/{id}/stream`

CDS 事件流。MAP 可直接代理或转存后再推送。

`POST /api/projects/{projectId}/agent-sessions/{id}/stop`

停止容器或 worker。

`GET /api/projects/{projectId}/agent-sessions/{id}/logs`

返回 runtime 侧日志。

## 事件 schema

| type | payload 关键字段 |
|------|------------------|
| `status` | `status`、`runtime`、`model`、`baseUrl`、`workerId`、`containerName` |
| `text_delta` | `messageId`、`text` |
| `tool_call` | `approvalId`、`toolName`、`argsSummary`、`risk`、`status` |
| `tool_result` | `approvalId`、`decision`、`resultSummary` |
| `log` | `level`、`message`、`source` |
| `hook` | `stage`、`status`、`command`、`output` |
| `error` | `code`、`message`、`retryable` |
| `done` | `messageId`、`finalText`、`usage` |

## 错误码

| code | 含义 |
|------|------|
| `connection_id_required` | 缺少 CDS 连接 |
| `connection_not_found` | CDS 连接不存在 |
| `connection_not_active` | CDS 连接已撤销或不可用 |
| `token_unavailable` | long token 不存在 |
| `cds_request_failed` | CDS 调用失败 |
| `message_content_required` | 消息为空 |
| `hook_failed` | Hook 执行失败 |

## 工作流调用

工作流使用 `cds-agent` 舱类型。舱类型负责选择 CDS 连接和 runtime profile，创建会话、启动 runtime、发送提示词、收集事件和日志，并把结果作为工作流产物输出。

默认输出：

- `cds-agent-out`：远程 Agent 文本输出。
- `cds-agent-events`：事件 JSON。
- `cds-agent-log`：runtime 日志。
