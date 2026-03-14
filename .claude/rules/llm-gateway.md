---
globs: ["prd-api/src/**/*.cs"]
---

# LLM Gateway 统一调用规则

所有大模型调用必须通过 `ILlmGateway`，禁止直接调用底层 LLM 客户端。

## 使用方式

通过 `GatewayRequest` 调用，必填字段：`AppCallerCode`、`ModelType`。

## AppCallerCode 命名规范

格式：`{app-key}.{feature}::{model-type}`

示例：`visual-agent.image.vision::generation`、`prd-agent.chat::chat`

## 模型调度优先级

1. 专属模型池（AppCallerCode 绑定的 ModelGroupIds）
2. 默认模型池（ModelType 对应的 IsDefaultForType 池）
3. 传统配置（IsMain / IsIntent / IsVision / IsImageGen 标记）

## Gateway 核心文件

`ILlmGateway.cs`、`LlmGateway.cs`、`GatewayRequest.cs`、`GatewayResponse.cs`、`Adapters/*.cs`

## 日志字段

Gateway 自动记录到 `llmrequestlogs`：`RequestPurpose`、`ModelResolutionType`、`ModelGroupId`、`Model`
