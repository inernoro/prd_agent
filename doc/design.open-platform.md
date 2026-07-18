# 开放平台功能概要 · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 管理摘要

- **解决的问题**：外部系统需要以稳定协议调用 PRD 问答、通用聊天和图片生成能力，同时受到身份、模型、配额与审计约束。
- **核心方案**：开放平台分为“应用型 PRD 对话代理”和“通用 Agent OpenAPI”两条兼容 OpenAI 的接入面，共用 API Key 鉴权和 LLM Gateway。
- **当前状态**：应用管理、PRD 对话、通用 Chat Completion、生图、模型列表、密钥自省、配额、限流和调用日志均已落地。
- **关键边界**：两类密钥的用途和数据模型不同，不能把应用配置与通用 M2M Scope 混用。

## 问题背景

早期开放平台只提供绑定用户和群组的 PRD 问答应用。后来外部 Agent 还需要通用聊天、生图、海鲜市场和其他按 Scope 开放的能力，因此增加了 `AgentApiKey` 与标准 `/api/v1` 网关。

如果把两套能力合并成一个万能 Key，会让 PRD 专属配置、Webhook、模型白名单和资源 Scope 相互污染。当前设计保留两个清晰接入面，并在认证层按密钥前缀和存储类型分流。

## 设计目标

1. 外部调用方可使用 OpenAI 兼容客户端接入。
2. PRD 问答能绑定用户、群组、系统提示和通知策略。
3. 通用网关以最小 Scope、模型白名单、限流和每日配额控制风险。
4. 所有模型请求经 LLM Gateway 调度并记录实际模型。
5. API Key 只存哈希，明文只在创建时返回。
6. 流式与非流式响应保持可诊断的错误和用量语义。

## 两类接入面

| 能力 | 应用型开放平台 | Agent OpenAPI |
|------|----------------|---------------|
| 凭据 | `OpenPlatformApp` 的历史 `sk-` Key | `AgentApiKey` 的 `sk-ak-` Key |
| 主要用途 | 绑定 PRD 和群组的对话代理 | 通用 M2M Chat、生图和按 Scope 开放接口 |
| 路由前缀 | `/api/v1/open-platform` | `/api/v1` |
| 权限 | 应用启用状态、绑定用户与群组 | Scope、有效期、撤销状态与资源权限 |
| 模型 | `prdagent` 模式或应用代理策略 | 每个 Key 的聊天与生图模型白名单 |
| 专属配置 | 系统提示、群上下文、Webhook、累计 Token 配额 | 每日配额、速率限制、模型清单与密钥自省 |

## 应用型 PRD 对话

`OpenPlatformApp` 是有业务配置的对话代理，不只是鉴权载体。

| 配置 | 用途 |
|------|------|
| `BoundUserId` | 以哪个用户身份访问文档与会话 |
| `BoundGroupId` | PRD 问答使用的群组上下文 |
| `IgnoreUserSystemPrompt` | 是否拒绝外部覆盖系统提示 |
| `DisableGroupContext` | 是否排除群历史但保留 PRD |
| `ConversationSystemPrompt` | 应用专属对话约束 |
| Webhook 配置 | 完成、错误和额度事件通知 |
| Token 配额 | 应用累计用量上限和预警 |

调用 `model=prdagent` 时进入 PRD 问答路径；其他模型行为受应用代理模式和服务端配置约束。外部请求不能绕过绑定用户的文档权限。

## Agent OpenAPI

通用网关使用 `open-api:call` Scope，提供：

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/v1/chat/completions` | 流式或非流式聊天 |
| `POST` | `/api/v1/images/generations` | 图片生成 |
| `GET` | `/api/v1/models` | 当前 Key 可用模型列表 |
| `GET` | `/api/v1/key` | 密钥有效期、白名单、配额与当日用量自省 |

模型选择遵循白名单：Key 已绑定模型时，调用方只能在清单内选择；未填写模型时使用清单首项。白名单为空则回退到平台默认能力池，外部传入的任意模型名不能突破服务端策略。

## 鉴权与授权

1. 认证中间件读取 API Key，并按前缀查找 `AgentApiKey` 或 `OpenPlatformApp`。
2. 校验哈希、启用状态、撤销、过期和宽限期。
3. `AgentApiKey` 生成 Owner 身份和 Scope Claims，但不伪造普通 JWT 的 `sub`。
4. Controller 或权限中间件校验具体 Scope。
5. 资源层继续校验 Owner、应用绑定和业务权限。

Scope 只代表调用某类接口的资格，不自动授予任意数据访问权。

## 配额、限流与输入保护

- 通用网关按 Key 执行请求速率和每日 Token 配额预占。
- 模型调用失败时按规则退还尚未消耗的请求配额。
- 输入字符数和原始请求体均有上限，坏请求在占额前拒绝。
- 响应提供标准状态码、错误码、重试提示和限流头。
- 宽限期内的 Key 可继续调用，但响应头明确提示续期。
- 服务器已接收的模型调用不因客户端断开而取消，遵循服务器权威性设计。

## 审计与可观测性

每次调用记录 Key、请求 ID、能力类型、请求模型、实际模型、成功状态、状态码、错误码、Token、耗时和回退信息。日志不得保存 API Key 明文或完整敏感提示内容。

管理后台提供应用、密钥、日志、授权和 OpenAPI 配置视图。通用 Key 可由用户创建、续期、撤销和删除，管理员可管理模型绑定与用量策略。

## 事实来源

| 文件 | 职责 |
|------|------|
| `prd-api/src/PrdAgent.Api/Controllers/OpenPlatform/OpenPlatformChatController.cs` | 应用型 PRD 对话兼容接口 |
| `prd-api/src/PrdAgent.Api/Controllers/OpenApiController.cs` | 通用 Chat、生图、模型与密钥自省 |
| `prd-api/src/PrdAgent.Api/Authentication/ApiKeyAuthenticationHandler.cs` | 两类 Key 认证分流 |
| `prd-api/src/PrdAgent.Api/Authorization/RequireScopeAttribute.cs` | Scope 声明 |
| `prd-api/src/PrdAgent.Core/Models/OpenPlatformApp.cs` | 应用型代理配置 |
| `prd-api/src/PrdAgent.Core/Models/AgentApiKey.cs` | 通用 M2M 密钥、白名单与配额 |
| `prd-api/src/PrdAgent.Core/Interfaces/IOpenApiUsageService.cs` | 用量、限流与回退通知 |
| `prd-admin/src/pages/OpenPlatformTabsPage.tsx` | 管理后台开放平台入口 |
| `prd-admin/src/pages/open-platform/OpenApiPanel.tsx` | 通用 OpenAPI 管理界面 |

## 验证重点

1. 两类 Key 只能进入各自允许的接口和数据范围。
2. 撤销、过期、宽限期和 Scope 不足返回稳定错误。
3. 模型白名单外请求被拒绝，未绑定白名单时只走默认池。
4. 限流与配额在流式、非流式和失败路径上保持一致。
5. 客户端断开后，上游调用和用量记录仍能正确收口。
6. 日志可定位实际模型和回退原因，但不泄漏密钥。

## 关联文档

- `design.open-platform.open-api.md`：通用 OpenAI 兼容网关详细设计。
- `guide.open-platform.open-api.md`：外部调用指南。
- `design.platform.external-authorization.md`：外部身份与资源授权。
- `design.skill.marketplace-open-api.md`：海鲜市场开放接口。
