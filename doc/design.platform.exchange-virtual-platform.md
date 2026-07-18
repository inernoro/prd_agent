# 模型中继虚拟平台设计 · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 一、管理摘要

- **解决什么问题**：非标准模型服务、ASR、图片和视频 API 需要接入统一模型池，但各自的 URL、认证和协议不同。
- **当前方案**：每条 Exchange 作为可命名的虚拟平台，挂载多个模型，由 transformer 将平台标准请求转换为目标协议。
- **池化方式**：新模型池使用真实 Exchange ID 作为 PlatformId；`__exchange__` 只保留旧数据兼容。
- **边界**：Exchange 是协议适配和路由能力，不是绕过模型池、权限、日志和密钥治理的任意 HTTP 代理。

## 1. 核心对象

| 对象 | 责任 |
|------|------|
| ModelExchange | 名称、目标 URL、认证方案、转换器、配置和模型列表 |
| ExchangeModel | 模型 ID、显示名、模型类型和启用状态 |
| ExchangeTransformer | URL 解析、请求转换、响应转换和额外 Header |
| Async Exchange Transformer | submit、query 等异步目标协议的轮询适配 |
| ExchangeTransformerRegistry | 登记并按 transformer type 查找适配器 |

一条 Exchange 可以挂载多个同类模型。目标 URL 可以包含受控 `{model}` 占位符，实际值只能来自该 Exchange 的有效模型列表。

## 2. 虚拟平台语义

平台列表把真实模型平台和 Exchange 统一展示，但保留 `kind` 或等价类型用于管理差异。对模型池而言，Exchange ID 是稳定平台标识，模型 ID 标识其子模型。

旧模型池可能使用 `PlatformId=__exchange__` 并仅保存模型别名。Resolver 在兼容期可以按模型反查 Exchange，但新写入不得继续制造该魔法标识。

当多个旧 Exchange 包含相同别名时，兼容解析存在歧义，应要求迁移到真实 Exchange ID，而不是任意选择第一条。

## 3. 转换器契约

| 能力 | 约束 |
|------|------|
| ResolveTargetUrl | 基于受控模板和标准请求确定目标，不接受任意客户端 URL |
| TransformRequest | 从平台标准结构生成目标协议请求 |
| TransformResponse | 把目标响应转换回平台标准结果 |
| GetExtraHeaders | 只生成该协议允许的附加 Header |
| Async polling | 有上限、超时、取消和阶段日志 |

当前 registry 包含 passthrough、Gemini Native、Fal 图片、豆包 ASR、豆包流式 ASR 和火山视频等适配器。具体列表以 `ExchangeTransformerRegistry` 为准。

转换器只处理协议差异，不读取业务数据库、不决定用户权限，也不自行解析第二次模型。

## 4. 认证与密钥

Exchange 保存认证方案和加密凭据，支持 Bearer、API key Header 等明确模式。服务端根据受支持方案设置 Header，客户端不能提交任意 Header 名和值并要求透传。

- API 返回不包含明文密钥。
- 测试和正式调用使用同一认证构造规则。
- 日志记录认证方案，不记录凭据。
- transformer config 中的敏感字段按密钥规则处理。
- 未知认证方案和转换器类型在保存或执行前拒绝。

## 5. 模型池与解析

1. 模型池成员保存 Exchange ID 和 ExchangeModel.ModelId。
2. Resolver 校验 Exchange 已启用且模型存在、启用、类型匹配。
3. 解析结果携带目标 URL、认证方案、转换器类型和脱敏配置。
4. Gateway 在发送阶段使用该解析结果，不重新选择 Exchange。
5. 调用成功或失败回写对应池成员健康状态和日志。

Exchange 模型与真实平台模型遵循同一 appCallerCode、模型类型、能力和健康治理。

## 6. 管理与测试

管理页支持创建、编辑、启停、模型列表、模板和单模型试调用。试调用必须显示解析后的目标、转换器、HTTP 状态、阶段和脱敏响应摘要。

模板只是配置起点。用户保存前仍需确认目标 URL、模型、认证和 transformer config，模板更新不能静默覆盖已有 Exchange。

流式 ASR、异步 ASR、图片和视频协议应使用各自专用测试路径，不能用普通 chat 成功作为全部能力可用的证据。

## 7. 安全边界

- TargetUrl 只允许受支持协议和经过校验的目标，阻止本机与内网 SSRF。
- `{model}` 之外的模板变量必须登记并校验。
- 响应和日志设置大小上限，避免目标返回大体积数据拖垮网关。
- 异步轮询有最大次数和总时长，客户端取消向下传播。
- transformer 异常返回结构化错误，不把原始敏感响应直接暴露给用户。
- 删除 Exchange 前检查模型池引用，不能制造悬挂成员。

## 8. 当前事实入口

| 能力 | 事实入口 |
|------|----------|
| Exchange 模型 | `prd-api/src/PrdAgent.Core/Models/ModelExchange.cs` |
| 管理和测试 API | `prd-api/src/PrdAgent.Api/Controllers/Api/ExchangeController.cs` |
| 平台聚合 | `prd-api/src/PrdAgent.Api/Controllers/Api/PlatformsController.cs` |
| 转换器接口 | `prd-api/src/PrdAgent.Core/Interfaces/IExchangeTransformer.cs` |
| 转换器 registry | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/Transformers/ExchangeTransformerRegistry.cs` |
| 模型解析 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs` |
| 网关发送 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs` |
| 管理页面 | `prd-admin/src/pages/ExchangeManagePage.tsx` |

## 9. 验收标准

- 新模型池成员保存真实 Exchange ID，不再生成 `__exchange__`。
- 多模型 Exchange 能按模型 ID 解析不同目标 URL。
- 未知转换器、认证方案和模型在发送前被拒绝。
- 试调用与正式调用使用相同转换和认证规则。
- 异步与流式协议有持续进度、取消和超时。
- 日志可追踪 Exchange 和 transformer，但不泄露密钥。

## 关联文档

- `doc/design.platform.model-pool.md`
- `doc/design.platform.llm-gateway.md`
- `doc/rule.platform.llm-gateway.md`
