# LLM 网关与模型池统一 · 设计

> **版本**：v1.0 | **日期**：2026-06-24 | **状态**：草案
> **关联实现**：`prd-api/.../LlmGateway/LlmGateway.cs`、`ModelResolver.cs`、`LlmGateway/Adapters/*`、`LlmGateway/Transformers/*`、`Infrastructure/LLM/OpenAIImageClient.cs`、`Infrastructure/ModelPool/*`、`Core/Models/AppCallerRegistry.cs`
> **关联取证**：`scripts/llm-gateway-phase0-forensics.mongo.js`
> **关联债务**：`debt.llm-gateway.md`
> **一句话**：把"接口模式挂在平台上、图片自成一套、池子背着 6 个没人用的策略引擎"的混乱调度，收敛为"协议挂在模型上、文本与图片共用一个网关、池退化成短兜底链、OpenRouter 做默认协议"的轻量体系——稳定优先、灵活兼容、易统计。

---

## 1. 管理摘要

模型池这套机器是为"AI 服务不稳定、各家请求格式各异、整体很乱"的早期阶段设计的。打磨到现在，体验已稳，OpenRouter 又证明了"一个接口能喂几百个模型"。于是当年为对抗混乱长出来的补丁——多套 adapter、Exchange 中转层、图片 5 套请求协议、156 个 appCallerCode、6 个调度策略引擎——大部分已是过度设计。

经过对代码的实测取证，三件事可以确定：

1. **病根只有一个**：接口模式（用哪种 HTTP 格式发请求）绑在**平台**上，而不是绑在**模型**上。这是你点名的"重大问题"，也是其余 5 个问题的源头。
2. **你已经造好了正确的抽象**：`IExchangeTransformer` 就是"每个模型自带协议"的机制——只是今天它只能通过"Exchange 虚拟平台"才够得着，没有直接挂到普通模型上。修复 = 把它从"Exchange 专用"提升为"全局协议层"，不是另起炉灶。
3. **6 个策略引擎是死代码**：实测整个 `Infrastructure/ModelPool/` 策略子系统**不在真实服务链路里**，网关只做"挑最健康的第一个"。唯一调用方是管理后台的一个预览接口。可以删。

本设计的总纲一句话：

> **把重心从「平台」搬到「模型」**——让模型自带协议/端点/key；把现有 Transformer 机制提升为统一协议层；文本与图片共用一个网关；池退化成 1-2 条的兜底链；OpenRouter 做默认协议，覆盖绝大多数文本和图片。

落地分 6 个相位，每相位向后兼容、可独立上线、可随时停。第一步只取证不动代码，用你库里的真实数据确认"哪些是死代码"再删，最稳。

---

## 2. 现状与问题（代码实测）

### 2.1 三套并行的"适配器"系统，做同一件事

| 系统 | 位置 | 选择依据 | 覆盖 |
|---|---|---|---|
| Gateway Adapters | `LlmGateway/Adapters/`（openai、claude 两个） | `resolution.PlatformType`（来自平台实体） | 文本 |
| Image Adapters | `Infrastructure/LLM/Adapters/`（OpenAI/Volces/Google） | `apiUrl` 猜 + `ImageGenPlatformAdapterFactory` | 图片 |
| Exchange Transformers | `LlmGateway/Transformers/`（passthrough/fal-image/gemini-native/doubao-asr×2） | 模型指向的 `ModelExchange.TransformerType` | 文本+图片+语音 |

三套都在解决同一个问题——"这个模型该用什么格式发请求"——却用三种不同机制、三个不同的绑定层。

### 2.2 接口模式绑在平台（病根）

文本链路：`GetAdapter(resolution.PlatformType)`。`PlatformType` 是平台实体的不可变属性。后果：同一个平台下的所有模型被迫用同一种格式；想给某个模型换格式，只能新建一个平台，或绕道建一个 Exchange。

图片链路更碎：`OpenAIImageClient.GenerateAsync` 里 5 个 `if` 分支（Exchange 统一协议 / Google 原生 / OpenRouter modalities / OpenAI images-generations / OpenAI images-edits multipart），adapter 靠 `apiUrl` 字符串猜，与文本网关完全独立。

### 2.3 Exchange 已经在偷偷做"协议挂模型"

`IExchangeTransformer` 接口做的正是请求/响应格式转换 + 目标 URL 解析 + 附加 header + 异步轮询。它按 `TransformerType` 字符串注册到 `ExchangeTransformerRegistry`，每个模型通过它指向的 Exchange 拿到自己的 transformer。**这就是"每模型协议"该有的样子**，唯一缺陷是入口被锁在"Exchange 虚拟平台"这层壳里。

### 2.4 死代码与冗余

- **6 个策略引擎**（FailFast/Race/Sequential/RoundRobin/WeightedRandom/LeastLatency）+ `ModelPoolDispatcher`：实测**不被真实网关链路引用**。`ModelResolver` 走的是简单的"健康优先取第一个"。`ModelPoolFactory` 唯一调用点是 `ModelGroupsController` 的管理预览接口。
- **第 3 层 legacy 解析**（`IsMain/IsIntent/IsVision/IsImageGen` 标记）：与"默认池"功能重叠，是历史兜底。
- **156 个 appCallerCode**：sync 服务只增不删（`AppCallerRegistrySyncService` 无删除分支）；绝大多数 code 并不需要专属池绑定，只是想要"一个 chat 模型"。

---

## 3. 目标

1. **稳定优先**：每一步向后兼容，老数据零行为变化；OpenRouter 做主但保留直连兜底，不把全系统压在单一供应商上。
2. **接口模式绑模型**：协议是模型的属性，平台只做默认兜底。
3. **文本与图片一个网关**：图片走与文本相同的 resolve + 协议层，不再自成帝国。
4. **轻量**：删死代码（策略引擎、legacy 层），三套 adapter 合一，池子缩成兜底链。
5. **易统计**：appCallerCode 降为"标签"，成为天然的分析维度；可视化面板吃现有日志真流量。

---

## 4. 核心决策

### 决策一：协议（Protocol）下沉到模型，三套 adapter 合一

给模型加一个 `Protocol` 字段（`LLMModel` 与 `ModelGroupItem` 各一份，后者可覆盖前者）。解析时：

```
protocol = item.Protocol ?? model.Protocol ?? platform.PlatformType
adapter  = protocolRegistry.Get(protocol)        // 统一注册表
endpoint = adapter.BuildEndpoint(model.ApiUrl ?? platform.ApiUrl, modelType)
key      = model.ApiKey ?? platform.ApiKey
```

把现有 `IExchangeTransformer` 提升为这个**统一协议层**：openai/claude 两个 Gateway Adapter、三个 Image Adapter、五个 Transformer 全部归一为"协议处理器"，按 protocol 字符串索引。Exchange 不再是"特殊平台"，只是"一个带自己 url/key + 非 passthrough 协议的模型"。

协议清单收敛到一个**小而封闭**的集合（不再"来个供应商写个 adapter"）：

| protocol | 覆盖 | 文本 | 图片 |
|---|---|---|---|
| `openai`（含 OpenRouter） | OpenRouter + 所有 OpenAI 兼容 | chat/completions | modalities / images-generations |
| `claude` | 直连 Anthropic | v1/messages | — |
| `google` | 直连 Gemini | generateContent | inline_data |
| `fal-image` 等少数 | 必须直连的图片商 | — | 各自格式 |

### 决策二：内部统一图片契约（你要的"内部图片交互方式"）

定义一个内部 image 契约，所有调用方只说这个，不感知线上格式：

```
ImageRequest  { prompt, n, size, images[], mask? }
ImageResponse { images[](URL), usage }
```

`OpenAIImageClient` 的 5 个分支退化为协议处理器的内部翻译。图片从此与文本共用同一个 resolver 和协议层，遵循已有的 `compute-then-send` 规则（算阶段定协议，发阶段只翻译，不二次猜）。

### 决策三：池退化成兜底链，删策略引擎

池的职责砍到只剩 `{modelType, 有序模型列表, 健康降级}`。删掉 6 个策略引擎（先用取证确认库里无人配，见 §8）。健康降级保留——它是稳定性的真价值。常态下 OpenRouter 做主 + 一条直连兜底 = 池子就 1-2 个条目。

### 决策四：调度 3 层 → 2 层

删掉 legacy 标记层。把 `IsMain/IsIntent/IsVision/IsImageGen` 迁进对应"默认池"后整层删除，`expectedModel` 的三级 fallback 复杂度随之消失。

```
专属池（app 显式绑定，少数）  →  该 ModelType 的默认池（绝大多数）
```

### 决策五：appCallerCode 从"绑定键"降级为"标签"

- 默认情况下 code 不需要任何池绑定，只解析到"自己 ModelType 的默认池"。它是**计费/统计/归因标签**，不是配置项。绑定只在例外时存在。
- 新增功能不再产生"又一条要管理的绑定"。156 个 code 变成廉价标签 + 天然分析维度。
- sync 改成**对账式**：registry 里没有的 code 标 `DeletedAt` 软删，面板一键清。

### 决策六："池子拆出来" = 先合并再收口

图片并网关、删死策略、删 legacy 层之后，剩下的东西小到可成为一个**单一内聚模块**（`Infrastructure/LlmGateway` 一个口子 = resolver + 协议注册表 + 短池 + 图片）。**不建议**现在拆成独立服务（过早优化，引入跨服务不稳定，与稳定优先冲突）。先做成干净内聚模块，真有规模再谈物理拆分。

---

## 5. 目标架构（协议为中心）

```
调用方（带 AppCallerCode + ModelType + 可选 expectedModel）
        │
        ▼
  ILlmGateway（文本 StreamAsync / 图片 GenerateAsync 同一入口族）
        │
        ▼
  ModelResolver（2 层：专属池 → 默认池）
        │   产出 Resolution { model, protocol, endpoint, key, 健康/兜底信息 }
        ▼
  ProtocolRegistry.Get(protocol)   ← 统一协议层（合并 adapter + transformer）
        │   BuildEndpoint / TransformRequest / 发送 / TransformResponse
        ▼
  上游（OpenRouter 默认 / Anthropic / Gemini / 直连图片商）
        │
        ▼
  LlmRequestLog（现有 165 字段，新增 protocol + resolutionReason）
```

可视化面板（§决策五 + 问题5）= 路由图（AppCaller/ModelType → 池 → 模型+协议）+ 模型为中心的健康/流量表，数据吃现有 `llmrequestlogs`，真实流量不是 demo 动画。

---

## 6. 数据设计（字段变更，全部向后兼容）

| 集合 | 变更 | 兼容策略 |
|---|---|---|
| `llmmodels` | 新增 `Protocol`（可空） | 空 → 走平台 `PlatformType`，行为不变 |
| `model_groups`（item） | 新增 `Protocol`（可空，覆盖模型级） | 空 → 走模型级 |
| `llm_app_callers` | 新增 `DeletedAt`（软删） | 空 → 视为有效 |
| `llmrequestlogs` | 新增 `Protocol`、`ResolutionReason` | 仅追加，老查询不受影响 |
| `model_exchanges` | 不删表，路由归一进协议层后逐步退役 | 现有 Exchange 继续工作 |

不动现有日志 schema 的语义，保证分析连续性。

---

## 7. 逐条对应你的 6 个问题

| 问题 | 解法 | 对应决策 |
|---|---|---|
| 1 池管理 | 池砍成有序兜底链，删 6 策略引擎，常态 1-2 条目 | 决策三 |
| 2 池调度 | 3 层 → 2 层，删 legacy 层 + expectedModel 三级 fallback | 决策四 |
| 3 code 过多/清理 | code 降为标签（默认零绑定）+ sync 对账软删 + 面板一键清 | 决策五 |
| 4 接口绑模型（重大） | Protocol 下沉到模型；提升 Transformer 为统一协议层；三套 adapter 合一 | 决策一 |
| 5 可视化面板 | 4 tab 合 1，路由图 + 模型中心表，吃现有日志真流量 | 决策五/六 |
| 6 池拆出来 | 先合并（图片并网关、删死码）成单一内聚模块，不急拆服务 | 决策六 |

---

## 8. 迁移路径（稳定优先，分相位）

| 相位 | 内容 | 风险 |
|---|---|---|
| **P0 取证** | 跑 `scripts/llm-gateway-phase0-forensics.mongo.js`：策略类型分布、有专属绑定的 code 数、图片各协议占比、orphan code 数。用数据确认死代码再删 | 只读，零 |
| **P1 协议下沉** | 加 `Protocol` 字段 + `protocol = model ?? platform` 解析；老数据空 → 平台兜底，路由结果不变 | 极低（纯地基） |
| **P2 图片并网关** | 内部 image 契约 + 5 分支收成协议处理器，走统一 resolver | 中（需双主题/真机验收图片） |
| **P3 删死重** | 迁 legacy flags 进默认池后删第 3 层；确认无人用策略引擎后删；Exchange 路由改走协议层 | 中（删除前必须 P0 数据背书） |
| **P4 code 降级** | code 默认零绑定 + 对账软删 + 面板一键清 | 低 |
| **P5 新面板** | 路由图 + 模型中心表 | 低（只读层） |

每相位满足 CDS 验证 + 集成测试，向后兼容，可停。

---

## 9. Phase 0 取证结果（截至 2026-06-24）

### 9.1 代码层已确认（静态分析）

| 事实 | 证据 |
|---|---|
| appCallerCode 共 **156** 条 | `AppCallerRegistry.cs` 含 156 个 `[AppCallerMetadata]` |
| 6 策略引擎 + Dispatcher **不在服务链路** | `Infrastructure/LlmGateway/*` 零引用 `ModelPoolDispatcher/IModelPool/ModelPoolFactory`；唯一调用点 `ModelGroupsController.cs:684`（管理预览） |
| Transformer 机制**存活且承重** | 77 处引用，5 个真实 transformer 注册进 `ExchangeTransformerRegistry`，被 `LlmGateway`（8 处）+ `ModelResolver` 引用 |
| 接口模式绑平台 | `LlmGateway` `GetAdapter(resolution.PlatformType)`；图片 `ImageGenPlatformAdapterFactory.GetAdapter(apiUrl)` |
| legacy 标记仍被消费 | `IsMain/IsIntent/IsVision/IsImageGen` 散落 ~15 文件（含 `ModelResolver` 第 3 层、多个 Controller、`ModelDomainService`） |
| sync 只增不删 | `AppCallerRegistrySyncService` 无删除/软删分支 |

### 9.2 需运行期数据确认（见取证脚本）

删除任何东西前，必须用真实库数据回答：

- `model_groups.StrategyType` 的分布——若全是 0（FailFast），删策略引擎零影响。
- 有多少 `llm_app_callers` 真的配了非空 `ModelGroupIds`（决定 code 降级的影响面）。
- 多少 `llm_app_callers` 已不在 registry（orphan，决定软删清理量）。
- 图片各协议（Exchange/Google/OpenRouter/OpenAI）的真实请求占比（决定收敛优先级）。
- 有多少模型实际依赖 Exchange（决定退役节奏）。

脚本输出即本节后续版本的填充依据。

---

## 10. 风险与已知边界

- **OpenRouter 单点**：默认走 OR 享受统一，但必须保留一条直连兜底，避免 OR 故障全系统瘫。池子的兜底价值因此不为零（这也是池不能删干净、只能缩短的原因）。
- **密钥下沉到模型**：Protocol 下沉意味着更多 `ApiKeyEncrypted` 字段。受 `cross-project-isolation.md` 规则 #2 约束——密钥轮换需先解密重加密。这是已知存量债务，迁移时不放大。
- **策略引擎删除依赖运行期数据**：静态已确认不在链路，但仍需 P0 脚本确认库里无人配 race/round-robin，再物理删，避免删掉某处隐式依赖。
- **图片验收必须闭环**：P2 需双主题 + 真机出图截图（`closed-loop-acceptance.md`），不得用"触发了"充当"出图了"。

---

## 11. 关联文档

- `design.llm-gateway.md`——Gateway 总体设计（现状基线，本设计在其上做减法）
- `design.llm-gateway-refactor.md`——图片 compute-then-send 重构（PR #490，本设计复用其算/发分离）
- `design.model-pool.md`——大模型池三级调度现状（本设计将其收敛为 2 级 + 兜底链）
- `debt.llm-gateway.md`——本次迁移的已知边界台账
- `.claude/rules/compute-then-send.md`——算/发两阶段（图片统一契约的依据）
- `.claude/rules/llm-gateway.md`——所有 LLM 调用必经 Gateway + LlmRequestContext
- `.claude/rules/cross-project-isolation.md`——密钥下沉的轮换约束
- `scripts/llm-gateway-phase0-forensics.mongo.js`——P0 运行期取证脚本
