# 大模型池设计（三级调度/三级链路） · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 一、管理摘要

- **解决什么问题**：模型调用需要按业务用途绑定模型、在端点故障时降级，并能解释最终选中了哪个平台、模型和池。
- **当前方案**：appCallerCode 声明模型类型与专属池，Resolver 按专属池、默认池、兼容配置依次解析，再按健康和能力选择池内成员。
- **健康闭环**：业务调用记录成功和失败，后台探活使已隔离端点有机会恢复，池耗尽与恢复形成通知和日志。
- **事实源演进**：网关控制面逐步拥有模型池权威；MAP 侧集合仍承担兼容读取，不能形成无规则双写。

## 1. 核心对象

| 对象 | 责任 |
|------|------|
| LLMAppCaller | 用稳定 appCallerCode 表达业务调用用途和模型要求 |
| ModelRequirement | 指定模型类型、候选池和能力约束 |
| ModelGroup | 表达同类模型的池、优先级、默认属性和策略 |
| ModelGroupItem | 绑定平台与模型，并保存健康、失败计数和能力快照 |
| ModelResolver | 解析调用方、池、成员、平台配置和最终发送参数 |
| LlmRequestContext | 保存用户、调用方、运行和审计上下文 |

appCallerCode 是业务用途，不等于模型名。一个调用点不得通过临时字符串绕开注册表，也不能把前端选择直接当成最终解析结果。

## 2. 三级解析

解析顺序固定为：

1. 当前 appCaller 对应模型类型的专属模型池。
2. 同模型类型的默认模型池。
3. 尚未迁移部署的 legacy 模型标记兼容路径。

每一级只选择已启用、类型匹配且未被判定为不可用的候选。解析失败必须返回已检查的层级和原因，不能静默选用不同模型类型。

legacy 是迁移兜底，不是长期并行调度系统。新调用和新配置必须进入模型池与调用方注册体系。

## 3. 池内选择

| 条件 | 处理 |
|------|------|
| 指定期望模型且可用 | 在候选池中优先选择匹配项 |
| Healthy 成员存在 | 按池策略和优先级选择 |
| 仅 Degraded 成员存在 | 允许降级使用并记录健康状态 |
| 成员 Unavailable | 普通业务流量跳过，等待探活恢复 |
| 能力不满足 | 跳过并记录 capability mismatch |
| 全池耗尽 | 尝试下一候选池，最终返回结构化不可用错误 |

模型能力至少包括视觉、函数调用、图片生成、thinking 和结构化输出等。池成员的能力快照优先；旧数据缺失时可以从平台模型配置补足，但要记录来源。

## 4. 健康状态与故障转移

池成员状态为 Healthy、Degraded 和 Unavailable。当前失败阈值由 Resolver 实现维护：连续失败达到降级阈值后降低优先级，达到隔离阈值后停止承接普通流量；任意受认可的成功可恢复健康并清零连续失败。

业务成功和失败只更新实际使用的池与成员。超时、上游 5xx、协议错误和明确限流可以计入健康；用户输入错误、内容策略拒绝和主动取消不应错误惩罚模型。

### 自动探活

Unavailable 成员没有正常业务流量，必须由 `ModelPoolHealthProbeService` 在冷却后发起低成本探活。探活遵循：

- 限制并发和频率，避免放大上游故障或额度消耗。
- 使用最小请求并标记 `IsHealthProbe`，与用户调用日志区分。
- 成功后恢复成员，失败后更新最近探活信息并等待下一窗口。
- 探活写入与业务健康写入必须指向同一权威池集合。
- 全池不可用与恢复可以通知管理员，但要做去重和冷却。

## 5. compute-then-send

模型解析与发送分为两个阶段。发送阶段接收已经解析的结果，不再重新解析模型；否则可能出现配额、日志或界面显示选中 A，真正请求却发送到 B。

跨进程网关模式下，明文密钥不随解析 DTO 穿越 HTTP 边界。网关侧拥有解析和发送时，MAP 只能取得脱敏的选择摘要用于展示与前置判断。

## 6. 策略与优先级

池策略可以表达顺序、权重、成本或能力偏好，但所有策略都必须满足：

- 不选择禁用或 Unavailable 成员。
- 不跨越模型类型与调用方授权范围。
- 选择结果可解释并写入日志。
- 同一请求重试有上限，避免在多个坏端点间无限循环。
- 期望模型只是偏好，是否允许降级由调用契约决定。

策略实现和前端编辑器不得各自维护一套枚举映射；服务端策略类型是权威。

## 7. 日志与可观测性

每次调用至少记录：appCallerCode、modelType、解析层级、池 ID 与名称、平台、期望模型、实际模型、候选摘要、健康状态、耗时、首字节、错误分类和是否探活。

日志不能包含明文平台密钥。流式请求的开始、首字节和终态必须属于同一次调用记录，Watchdog 不能把仍在运行的长推理误判为孤儿。

## 8. 权威与兼容

网关独立化后，`llmgw_model_pools` 和网关调用方注册逐步成为权威。MAP 的 `model_groups` 与 `llm_app_callers` 在迁移期可以兼容读取，但必须明确 lookup status 和来源。

以下行为禁止：

- 无来源地在 MAP 与 GW 两个集合同时写健康状态。
- 删除或失效池后仍保留悬挂调用方绑定。
- 用平台默认模型绕过模型池失败。
- 在前端硬编码模型类型、策略和健康状态的业务含义。

## 9. 当前事实入口

| 能力 | 事实入口 |
|------|----------|
| 解析与健康写入 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs` |
| 解析契约 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/IModelResolver.cs` |
| 网关调用 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs` |
| 自动探活 | `prd-api/src/PrdAgent.Infrastructure/ModelPool/ModelPoolHealthProbeService.cs` |
| 模型池模型 | `prd-api/src/PrdAgent.Core/Models/ModelGroup.cs` |
| 调用方模型 | `prd-api/src/PrdAgent.Core/Models/LLMAppCaller.cs` |
| 注册同步 | `prd-api/src/PrdAgent.Api/Services/AppCallerRegistrySyncService.cs` |

## 10. 验收标准

- 专属池、默认池和 legacy 解析顺序可通过日志证明。
- Healthy、Degraded、Unavailable 成员的选择行为符合约束。
- 全池不可用后，探活可以恢复端点且不依赖普通业务流量。
- 模型能力不满足时不会发送请求后才发现错误。
- 期望模型、实际模型、池和平台在日志与用户界面一致。
- MAP 与 GW 并存期能解释每次读取和健康写入的权威来源。

## 关联文档

- `doc/design.platform.llm-gateway.md`
- `doc/design.llm-gateway-physical-isolation.md`
- `doc/rule.platform.llm-gateway.md`
- `doc/rule.platform.ai-model-visibility.md`
