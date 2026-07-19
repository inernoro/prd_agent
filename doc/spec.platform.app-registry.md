# 应用注册中心协议 · 规格

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 目标

应用注册中心让外部 HTTP 应用和测试桩以统一请求、响应和路由规则接入 MAP。它承担注册、启停、健康、路由解析和测试调用，不替代 LLM AppCaller、AgentOpenEndpoint 或海鲜市场开放接口。

## 角色

| 对象 | 职责 |
| --- | --- |
| RegisteredApp | 应用身份、端点、能力、认证、健康和统计 |
| AppRoutingRule | 按关键词、来源、用户或组合条件选择目标 appId |
| UnifiedAppRequest | 通道网关发送给应用的标准请求 |
| UnifiedAppResponse | 应用返回的标准结果、回复和错误 |
| StubAppConfig | 在不依赖外部服务时模拟固定、延迟或失败响应 |

## 注册契约

RegisteredApp 的关键字段：

| 字段 | 约束 |
| --- | --- |
| `appId` | 稳定唯一，路由和调用均使用，不把数据库 Id 暴露为业务身份 |
| `appName`、`description` | 用户可读；icon 使用 URL 或项目图标系统，不使用 emoji |
| `version` | 应用方版本，用于诊断，不参与路由排序 |
| `endpoint` | HTTPS 或受控内部路由；禁止任意内网 SSRF |
| `capabilities` | 输入、输出、附件、上下文、长度和预计耗时声明 |
| `inputSchema`、`outputSchema` | 字段要求与自定义字段定义 |
| `authType` | None、ApiKey、Bearer、Basic 或 Custom；secret 不返回前端 |
| `supportsStreaming` | 只有实现了对应流式契约才可开启 |
| `isActive`、`healthStatus` | 启停与健康分离，disabled 不等同于 unhealthy |

注册、更新、删除和启停属于管理员写权限；读取需要设置读取权限。外部应用不能通过 heartbeat 修改自身 scope、endpoint 或认证。

## UnifiedAppRequest

| 区域 | 必填 | 说明 |
| --- | --- | --- |
| `requestId`、`timestamp` | 是 | 追踪与幂等关联 |
| `source.channel`、`senderIdentifier` | 是 | email、sms、siri、webhook 或 api 等来源 |
| `content.body` | 是 | 正文；subject、contentType、attachments 和 parameters 可选 |
| `context` | 否 | userId、sessionId、groupId、customPrompt 和 metadata |
| `routing` | 否 | 命中的 ruleId、matchType 和命中依据，由平台填充 |

应用不得信任 source 或 context 中自报的权限；需要用户授权的业务由平台在调用前校验。

## UnifiedAppResponse

| 字段 | 说明 |
| --- | --- |
| `requestId` | 必须与请求一致 |
| `status` | Success、Failed、Pending、Processing、Timeout 或 Rejected |
| `result` | 处理内容、可选实体 ID/类型和结构化 data |
| `reply` | 是否回复来源通道、回复内容和附件 |
| `error` | code、message、retryable；成功时为空 |
| `durationMs` | 应用处理耗时；平台仍以自身观测为准 |

外部应用返回未知字段时平台可以保留在 data，但不能覆盖 requestId、status 或平台审计字段。

## 路由规则

- 规则只引用存在的 appId；目标应用删除后规则必须失效或删除。
- 多规则命中按显式优先级和稳定次序选择，不依赖 Mongo 返回顺序。
- disabled app 和 unhealthy app 的处理策略明确区分；是否允许降级由服务端配置决定。
- `/resolve` 只返回解析结果，不调用目标应用；`/invoke/{appId}` 用于受控测试调用。
- 路由条件和输入长度必须有上限，避免正则灾难和超大 payload。

## 桩应用

Stub 仅用于开发和测试，可以配置固定响应、延迟、随机失败、失败概率、回显和响应模板。生产路由默认不得把 stub 当作真实应用；启用随机失败时必须清楚标识。

## API

| 能力 | 端点 |
| --- | --- |
| 应用读取与注册 | `GET/POST /api/app-registry/apps` |
| 应用详情、更新和删除 | `GET/PUT/DELETE /api/app-registry/apps/{appId}` |
| 启停与心跳 | `POST /apps/{appId}/toggle`、`POST /apps/{appId}/heartbeat` |
| Stub | `POST /stubs`、`PUT /stubs/{appId}/config` |
| 路由规则 | `GET/POST /rules`、`GET/PUT/DELETE /rules/{id}`、toggle |
| 测试与协议 | `POST /invoke/{appId}`、`POST /resolve`、`GET /protocol` |

具体 DTO 和响应包装以 `AppRegistryController` 和 `AppRegistry.cs` 为代码事实源。

## 安全与可靠性

1. 注册 endpoint 必须通过 URL、协议、DNS 与内网地址校验，防止 SSRF。
2. API key、Bearer 和 Basic 凭据加密保存且不通过读取 API 返回。
3. 调用设置连接、首包和总超时；只有 retryable 错误按幂等策略重试。
4. requestId 贯穿日志和响应，日志不记录认证头或敏感正文。
5. 心跳只更新健康时间；长期无心跳可标记 offline，但不能自动删除应用。
6. 统计写入失败不影响业务响应，调用失败必须计入 failureCount。

## 验收标准

- 注册、更新、启停、删除、心跳和重复 appId 分支有测试。
- 路由优先级、无命中、目标禁用和目标删除行为稳定。
- Stub 可覆盖成功、延迟、失败和回显，不访问外部网络。
- 外部调用的超时、非 2xx、错误响应和无效 JSON 转成统一错误。
- 管理权限、SSRF 和 secret 脱敏通过安全测试。

## 实现来源

- `prd-api/src/PrdAgent.Core/Models/AppRegistry.cs`
- `prd-api/src/PrdAgent.Api/Controllers/AppRegistryController.cs`
- `prd-api/src/PrdAgent.Infrastructure/Services/AppRegistryService.cs`
