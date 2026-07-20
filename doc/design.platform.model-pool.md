# 逻辑模型、上游 Offering 与默认模型池设计

> **版本**：v3.0 | **日期**：2026-07-20 | **状态**：开发中

## 一、管理摘要

- **应用看什么**：应用只维护自己有权使用的逻辑模型列表，例如 `image2`、`nanobanana-2`。它不读取 Provider、Endpoint、密钥或上游真实模型名。
- **Gateway 管什么**：Gateway 为每个逻辑模型维护一个或多个 Offering。每个 Offering 指向平台模型或 Exchange，并独立声明协议、优先级、权重、并发、分钟速率和健康状态。
- **模型池做什么**：模型池不再承担应用的全部离散模型组合。只有请求未显式选择逻辑模型时，模型池才提供 appCaller 专属默认、模型类型默认与 legacy 兜底。
- **为什么这样拆**：同一逻辑模型可由多个不同协议、不同限额的上游供给；应用选择稳定能力，Gateway 负责路由和故障切换，双方可以独立演进。

## 1. 核心对象

| 对象 | 责任 |
|---|---|
| appCaller | 表达谁在什么业务场景调用，并承载权限、预算、速率与 PromptPolicy |
| GatewayLogicalModel | 面向应用的稳定公开模型标识、名称、类型、能力与 appCaller 可见范围 |
| GatewayModelOffering | 把一个逻辑模型连接到一个真实上游目标，并保存路由和治理参数 |
| Provider / Endpoint / Credential | 保存供应商、请求地址、协议和只写凭据；不暴露给应用 |
| LLMModel / ModelExchange | 表达可执行的普通模型或异构 Exchange 目标 |
| ModelGroup | 只在没有显式逻辑模型时提供默认与兼容兜底 |
| ModelResolver | 在一次计算阶段完成租户、权限、逻辑模型、Offering 和重试候选解析 |

appCallerCode 是业务用途，逻辑模型 PublicId 是应用选择，真实上游模型名是 Gateway 执行细节。三个标识不得互相代替。

## 2. 解析顺序

解析顺序固定为：

1. 请求显式给出模型时，先按当前租户、模型类型和 appCaller 可见范围解析逻辑模型。
2. 对该逻辑模型读取启用且未隔离的 Offering，按 `priority` 或 `weighted` 产生一次性主候选与有界重试候选。
3. 请求未显式给出模型时，才按 appCaller 专属模型池、模型类型默认池、legacy 兼容配置依次解析。
4. 显式模型不存在、跨租户或无权限时 fail-closed，不能静默退回默认池并伪装成用户所选模型。

解析阶段一次性确定候选，发送阶段不得再次调用 Resolver。这样可以保证界面选择、预算预占、日志与真实请求使用同一份决策。

## 3. 应用模型列表

视觉创作等应用从 Gateway 的租户模型目录读取列表。目录只返回：

- 逻辑模型 PublicId、显示名、模型类型和能力；
- 当前 appCaller 是否可见；
- 是否至少存在一个可用 Offering。

目录不得返回上游密钥、真实 Endpoint、Provider 内部配置或候选顺序。应用提交 PublicId，日志同时保存 PublicId、OfferingId、实际模型和 Provider，既保持应用稳定，又能完成运维追踪。

迁移期间，既有“可用模型池”接口可以返回逻辑模型的兼容投影，避免一次重写所有调用方。只要租户已经有逻辑模型，投影不得再把池成员或上游名称当成应用选项；没有逻辑模型数据时才回退旧池列表。

## 4. Offering 路由与异构协议

同一逻辑模型可以拥有多个 Offering，例如：

| 逻辑模型 | Offering | 协议 | 典型用途 |
|---|---|---|---|
| `image2` | OpenAI 直连 | OpenAI Images | 主上游 |
| `image2` | OpenRouter | OpenAI Chat 多模态 | 备用上游 |
| `nanobanana-2` | Google 直连 | Gemini `generateContent` | 主上游 |
| `nanobanana-2` | 兼容平台代理 | OpenAI Images 或 Exchange | 备用上游 |

不同 Offering 的请求形状完全不同时，Gateway 必须从协议无关的 canonical request 重新构建下一次请求。禁止把第一个上游的 JSON 或 multipart 原样发给第二个上游。图片请求至少保留 prompt、数量、尺寸、响应格式、参考图与 mask；每次尝试再生成对应的 endpoint、鉴权头和 body。

重试只处理受认可的上游故障，例如 429、超时与 5xx。用户输入错误、权限拒绝、内容策略拒绝和主动取消不得被误判为健康故障，也不得无限重试。

## 5. 策略、限流与健康

`priority` 先使用健康且优先级数值更小的 Offering；`weighted` 在健康候选中按权重选主候选，并保留其余候选作为有界故障切换顺序。所有策略必须满足：

- 禁用或 Unavailable 的 Offering 不承接普通流量；
- 不跨租户、不跨逻辑模型、不跨 appCaller 授权范围；
- Offering 的并发和每分钟速率在 Gateway 数据面执行，不交给应用自觉遵守；
- 多个 serving 实例共享 Mongo 原子速率窗口和并发租约；
- 一次失败只更新实际命中的 Offering；成功清理连续失败并恢复健康；
- 最终选择与每次尝试都写入同一请求日志。

平台和模型级并发仍可作为更粗粒度总闸。Offering 级限制表达某条具体供应线路的额度，任一层触顶时可以尝试同一逻辑模型的下一个 Offering；候选耗尽后返回结构化 429。

## 6. 模型池的保留边界

模型池仍有三个合法用途：

1. 调用方没有显式选择模型时的默认选择；
2. 特殊 appCaller 的专属默认与兼容策略；
3. 旧调用方和回滚版本的非破坏性兼容。

模型池不再负责把每个应用模型与每个上游做笛卡尔组合。新应用不得通过读取池成员来推断完整模型目录，也不得要求为每个 appCaller 复制一套相同池。

## 7. 权威、迁移与回滚

新权威集合为 `llmgw_logical_models` 与 `llmgw_model_offerings`。Offering 复用 Gateway 已拥有的 `llmgw_models`、`llmgw_platforms` 和 `llmgw_model_exchanges`，凭据继续只写和加密保存。

迁移采用兼容投影，不删除旧集合：

- 新版应用先读逻辑模型；旧版应用仍可读模型池投影；
- 逻辑模型命中时不写伪造的 ModelGroupId，日志使用 LogicalModelId 与 OfferingId；
- 没有逻辑模型数据时保留旧三级池解析；
- 回滚到旧版本不需要恢复被删除的数据，因为本变更不删除池、平台、模型或 Exchange。

禁止同时无来源地双写两套健康状态。逻辑模型路径写 Offering 健康；旧池路径写池成员健康。

## 8. 日志与可观测性

每次请求至少记录：TenantId、appCallerCode、逻辑模型 PublicId、OfferingId、实际 Provider、实际模型、协议、endpoint 摘要、每次上游尝试、耗时、错误分类、token、价格证据和是否回退。

用户日志列表以逻辑模型为主，实际上游作为次级信息；详情页同时展示两层，避免用户把正常故障切换误认为“模型偷偷变了”。任何日志和 API 都不得回显明文凭据。

## 9. 当前事实入口

| 能力 | 事实入口 |
|---|---|
| 逻辑模型与 Offering 模型 | `prd-api/src/PrdAgent.Core/Models/GatewayLogicalModel.cs` |
| 解析与健康写入 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs` |
| 解析契约 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/IModelResolver.cs` |
| 多协议发送与重试 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs` |
| Offering 限流与并发 | `prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayProviderConcurrencyCoordinator.cs` |
| 控制台管理 API | `llmgw/console-api/Program.cs` |
| 视觉创作模型目录 | `prd-admin/src/services/real/visualCreation.ts` |

## 10. 验收标准

- 视觉创作能显示多个租户授权逻辑模型，选择值是 PublicId，不泄漏上游。
- 同一逻辑模型至少可配置两个不同协议的 Offering；首个 429、超时或 5xx 后会按第二个协议重建请求。
- Offering 的并发、RPM、健康和启停在多 serving 实例下生效并彼此隔离。
- 显式未知模型和无权限模型 fail-closed；未显式选模型才使用默认池。
- 日志能同时回答“用户选了什么”和“Gateway 实际走了哪个上游”。
- 旧池数据保持可读，回滚不需要数据恢复或删除新集合。

## 关联文档

- `doc/design.platform.llm-gateway.md`
- `doc/design.llm-gateway-physical-isolation.md`
- `doc/plan.platform.llm-gateway-external-platform.md`
- `doc/rule.platform.llm-gateway.md`
