# 图片引用日志与消息持久化 · 设计

> **版本**：v1.1 | **日期**：2026-07-17 | **状态**：已落地

## 管理摘要

- **问题**：图片请求体中的 base64 会在日志脱敏或截断后失效；由前端异步保存的视觉创作消息会因网络抖动或页面切换丢失。
- **决策**：图片引用以独立元数据随 LLM 日志保存；消息由创建 Run 的 Controller 与执行 Worker 在服务端持久化。
- **结果**：日志可展示可访问的参考图，刷新后可恢复完整消息历史；前端只负责显示和订阅 SSE。
- **范围**：LLM Gateway、视觉创作 Run、LLM 日志页和视觉创作聊天面板。

## 问题边界

请求体中的 base64 是传输细节，不是适合日志展示的长期数据。日志系统对大字段截断后，前端即使识别出 data URL 也无法渲染完整图片。

同样，消息持久化属于业务事实，不能依赖浏览器的 fire-and-forget 请求。浏览器只能乐观显示；服务端必须在接受任务和产出结果的两个权威时点写库。

## 核心决策

### 图片引用独立保存

每条 LLM 请求日志可带 `imageReferences`，不从截断后的 `requestBody` 反推图片。每个引用只保存展示与追溯所需的信息：

| 字段 | 用途 |
|---|---|
| `sha256` | 内容校验、去重和关联 |
| `cosUrl` | 前端安全展示的图片地址 |
| `label` | 说明图片在请求中的用途，例如参考图或蒙版 |
| `mimeType` | 展示和下载的媒体类型 |
| `sizeBytes` | 审计与容量判断 |

引用沿着“图片客户端 → Gateway 请求上下文 → 日志开始事件 → 请求日志”单向透传。日志页优先使用 `imageReferences`；历史日志没有该字段时，才降级解析旧请求体中的内联图片。

### 服务端权威消息持久化

| 时点 | 权威写入方 | 保存内容 |
|---|---|---|
| 创建 Run | `ImageMasterController` | 用户输入消息；旧客户端未提供正文时兼容回退到提示词 |
| 图片生成完成 | `ImageGenRunWorker` | 生成结果、参考图、提示词、Run 标识、模型池和生成类型 |
| 图片生成失败 | `ImageGenRunWorker` | 错误信息、Run 标识和生成上下文 |

SSE 事件只通知客户端刷新显示，不能作为持久化的唯一来源。页面刷新时由消息读取接口从数据库恢复用户和助手消息。

## 交互与数据流

1. 用户发起生成或重绘，Controller 创建 Run 并保存用户消息。
2. Worker 加载参考图，调用 LLM Gateway 时同时提供请求体和图片引用元数据。
3. Gateway 写入请求日志，日志保留可展示的图片引用而非完整 base64。
4. Worker 将生成图上传到对象存储，保存助手消息后发出完成或失败 SSE。
5. 前端收到事件后更新界面；历史会话统一通过消息读取接口恢复。

视觉创作消息中的完成态可同时显示生成图和参考图缩略图；缺少 `refSrc` 的旧消息只显示生成图。

## 兼容与安全

| 场景 | 行为 |
|---|---|
| 历史日志没有 `imageReferences` | 降级解析旧请求体中的内联图片 |
| 历史消息没有参考图字段 | 不显示参考图，不影响生成图和正文 |
| 旧客户端未传用户正文 | 服务端从提示词回退构造用户消息 |
| 对象地址不可用 | 日志仍保留引用元数据；界面按普通加载失败处理 |

请求体仍可按日志规则截断或脱敏；图片展示依赖独立引用，不放宽日志隐私边界。

## 实现边界与来源

| 层级 | 权威实现 |
|---|---|
| 请求日志模型与写入 | `prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs`、`PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs` |
| Gateway 上下文与图片请求 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/`、`PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs` |
| Run 与消息持久化 | `prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs`、`PrdAgent.Api/Services/ImageGenRunWorker.cs` |
| 日志和视觉创作界面 | `prd-admin/src/pages/LlmLogsPage.tsx`、`prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx` |

## 关联文档

- `design.visual-agent.md`：视觉创作能力与消息展示上下文。
- `design.platform.llm-gateway.md`：统一 Gateway 调用与日志边界。
- `rule.platform.server-authority.md`：服务端保存业务事实的约束。
