# LLM Gateway 图片生成重构 · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 管理摘要

- **解决的问题**：图片生成链路曾在发送前再次解析模型，覆盖用户已经选择的模型，出现“选择 A、实际调用 B”。
- **核心方案**：按 Compute-then-Send 原则把模型选择与网络发送分开；一次请求最多解析一次，发送阶段只消费已确定的结果。
- **当前状态**：统一入口 `IImageGenGateway`、单次解析路径、模型适配器与回归守卫均已落地。
- **适用范围**：图片生成 Controller、后台 Worker、视觉创作及其他调用生图能力的 Agent。

## 问题背景

旧链路由业务层先解析用户指定模型，再由底层发送方法以空的期望模型重新解析。第二次结果可能回退到模型池默认项，从而覆盖第一次决策。为补救该问题曾使用带实例状态的 Resolver 装饰器在两次调用之间传值，但它依赖相同 DI Scope，无法形成可靠架构约束。

根因不是某个 Resolver 算错，而是发送阶段拥有了不该拥有的重新决策权。

## 设计目标

1. 用户或业务方已经确定的模型不得被下游静默改写。
2. 模型调度、请求适配、HTTP 发送和响应解析各自单一职责。
3. 业务层只处理业务状态，不感知上游平台报文差异。
4. 新增同协议模型优先通过配置完成，只有协议形态全新时才增加适配器。
5. 保留调度结果、实际模型和上游状态的可观测性。

## 核心决策

| 决策 | 约束 |
|------|------|
| 单次 Resolve | 同一业务请求最多调用一次模型解析 |
| 发送无决策 | Send 阶段不得再次调用 Resolver |
| 统一生图入口 | API 与 Worker 依赖 `IImageGenGateway` 或 `IImageGenerationClient`，不直接依赖具体客户端 |
| 配置驱动适配 | 尺寸、参数名、响应格式和平台类型由模型配置与适配器注册表处理 |
| 业务状态外置 | run、artifact、水印和持久化由调用方负责，不进入 Gateway 结果模型 |

## 整体方案

图片请求按以下顺序处理：

1. 业务方提供 `appCallerCode`、期望模型和标准化图片生成载荷。
2. Gateway 解析模型组、平台、实际模型与凭据。
3. Request Builder 根据模型配置和平台适配器构建上游请求。
4. 发送器只执行 HTTP、超时、重试、日志与健康回写。
5. 解析器把不同平台响应转换为统一图片结果。
6. 业务方保存图片、更新 Run 状态并执行水印等后处理。

这条链路的事实入口是 `IImageGenGateway.GenerateImageAsync`。当前实现由 `ImageGenGateway` 委托 `IImageGenerationClient.GenerateUnifiedAsync` 完成解析、构建、发送和解析，但对调用方保持统一契约。

## 接口边界

| 层级 | 输入 | 输出 | 不负责 |
|------|------|------|--------|
| 业务调用层 | 调用方标识、期望模型、标准载荷 | 业务处理结果 | 平台报文拼装 |
| 调度层 | 调用方标识、能力类型、期望模型 | 已解析模型与平台 | HTTP 发送 |
| 适配层 | 已解析结果、标准载荷 | 上游请求 | 修改模型选择 |
| 发送层 | 已构建请求、已解析结果 | 原始响应 | 再次调度 |
| 解析层 | 原始响应、适配器类型 | 统一图片结果 | run 与资产持久化 |

## 迁移结果

| 项目 | 结果 |
|------|------|
| 二次解析止血 | `SendRawWithResolutionAsync` 接收已解析结果，发送阶段不再重新解析 |
| 临时装饰器 | `ExpectedModelRespectingResolver` 与诊断集合已删除 |
| 统一接口 | `IImageGenGateway` 与标准输入、输出模型已建立 |
| 调用方收口 | API 和 Worker 通过 Gateway 接口调用，不直接 new 具体客户端 |
| 适配器收口 | 模型参数构建集中到 Request Builder 和 Adapter Registry |
| 自动守卫 | 测试禁止 API 层重新依赖具体生图客户端，并验证模型选择不被覆盖 |

## 可观测性与验证

每次请求至少应能追踪调用方标识、期望模型、实际模型、解析类型、平台、适配器、耗时与错误码。验收重点不是“请求成功”这一点，而是实际模型必须等于调度结果，且一次请求没有第二次 Resolve。

关键回归测试位于：

- `prd-api/tests/PrdAgent.Tests/GatewayDirectClientRatchetTests.cs`
- `prd-api/tests/PrdAgent.Api.Tests/Gateway/GatewayServingEndpointContractTests.cs`
- `prd-api/tests/PrdAgent.Tests/GatewayDataDomainGuardTests.cs`

## 事实来源

| 文件 | 职责 |
|------|------|
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/ImageGen/IImageGenGateway.cs` | 对外统一生图入口 |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/ImageGen/ImageGenGateway.cs` | Gateway 实现 |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs` | 通用发送与已解析结果路径 |
| `prd-api/src/PrdAgent.Infrastructure/LlmGateway/ILlmGateway.cs` | 通用 Gateway 契约 |
| `prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs` | 后台业务编排与结果持久化 |
| `.claude/rules/compute-then-send.md` | 强制不变量与审计清单 |

## 关联文档

- `design.platform.llm-gateway.md`：Gateway 总体架构。
- `plan.llm-gateway.full-cutover.md`：Gateway 旧路径清理与生产门禁。
- `.claude/rules/compute-then-send.md`：所有外部模型调用共用的计算与发送边界。
