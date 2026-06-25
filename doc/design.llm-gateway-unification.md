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

> **范围扩展（2026-06-25）**：本设计在内部模型池简化之外，纳入"对外平台化"目标——把这台引擎暴露成 OpenRouter 式平台供别人调用。实测发现外部入口（`OpenApiController` + AgentApiKey）**已存在且已共用同一引擎**，故二者不是两个项目而是同一架构的两面。详见 §12。决策：内部其他团队为主、按可扩展设计；先清引擎（P1-P3）再装对外入口。

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

### 决策七：管理 UI = OpenRouter 心智（用户 2026-06-25 拍板）

本次重构的三个特征——**剥离 + 化繁为简 + 系统性结构**——同样作用于管理 UI，不只引擎。管理 UI 三原则：

1. **配置才出现，不预铺空类目（render-on-configure）**：modelType 类目/分组/入口只渲染"真实有配置(count>0)"的，新增配置才出现该类目；不再把 14 个 modelType 全展开成空 chip。这是 OpenRouter 心智 + 奥卡姆。首个落地：`ModelTypeFilterBar` 加 `availableTypes`，只渲染有池的类型（已实现 2026-06-25）。同principle推及四个 tab 自身、空 auto-池（§9.4 H5）等一切"预铺脚手架"。
2. **默认简单列表 + 日志，请求正文走 opt-in 监听**：管理页常态 = 简单的池/模型列表 + 元数据日志（模型/协议/延迟/状态/fallback，吃现有 165 字段 `llmrequestlogs`，永远在）。要看**请求/响应正文**才"开启监听"（按模型或全局 opt-in 捕获 body，默认关——隐私 + 存储友好），与 OpenRouter "enable logging" 一致。不建常驻重型 inspector。
3. **结构镜像运行时（systematic structure）**：管理 UI 的信息结构 = 运行时解析结构的镜像——`Caller → ModelType(默认/专属) → 池(短兜底链) → 模型+协议 → 平台`，一张连贯的路由图 + 模型为中心的健康/流量表，而不是 4 个互不相干的 CRUD tab。§9.4 H1/H2 的"死池 Unavailable + 静默 fallback 率"做成红色一级告警（正是这次取证挖出来的静默降级，UI 该一眼暴露）。

**剥离/化繁为简在 UI 的落点**：① `模型中继(Exchange)` 整 tab 退役（折叠进协议层，§决策一）；② `平台 + 模型池` 向"模型为中心"收敛（一个模型 = id+协议+url+key+所属平台，池退化成短兜底链）；③ `应用模型池管理(Caller)` 降级为以只读标签为主（§决策五），绑定只在例外出现；④ 4 tab 因此收敛到更少的、镜像运行时的视图。这套面板建在清理后的引擎上（P5，排在 P3 之后），但"配置才出现"这类纯前端化简可先行。

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
| **P1 协议下沉** | 加 `Protocol` 字段 + `protocol = model ?? platform` 解析；老数据空 → 平台兜底，路由结果不变 | 极低（纯地基） **【已完成 2026-06-25，commit b0172ce6】CDS 构建+部署绿、live 已证 protocol 字段 populating（146 条 protocol-from-platform-type，向后兼容已 live）、3 路对抗验证全 PASS、注册表黄金快照(153)+解析黄金集成测试双护栏落地** |
| **P2 图片并网关** | 内部 image 契约 + 5 分支收成协议处理器，走统一 resolver | 中（需双主题/真机验收图片） |
| **P3 删死重** | 迁 legacy flags 进默认池后删第 3 层；确认无人用策略引擎后删；Exchange 路由改走协议层 | 中（删除前必须 P0 数据背书）**【止血后实测仅 38 个 code 走 Legacy / 3 个 modelType，见 §9.5】** |
| **P4 code 降级** | code 默认零绑定 + 对账软删 + 面板一键清 | 低 |
| **P5 新面板** | 路由图 + 模型中心表，按 §决策七 三原则（配置才出现 / 列表+opt-in监听 / 结构镜像运行时） | 低（只读层；"配置才出现"纯前端部分可先行） |

每相位满足 CDS 验证 + 集成测试，向后兼容，可停。

### 8.1 P3 准确落地清单（止血后刷新，2026-06-25）

§9.4 H1/H2 的死池被止血修复后，legacy 承载量从 §9.3 的 91 个骤降到 **38 个 / 3 个 modelType**。P3 删 legacy 的准确前置：

| modelType | 仍走 Legacy 的 code 数 | 当前 legacy 目标 | P3 行为保持动作 |
|---|---|---|---|
| vision | 14 | qwen/qwen3.6-plus | 建 vision 默认池→qwen，golden 确认 14 个改走 DefaultPool 同模型 |
| intent | 8 | deepseek/deepseek-v4-flash | 建 intent 默认池→deepseek-v4-flash，同上 |
| generation | 16 | stub-image | **分叉点**：已存在 generation 默认池→gemini-3.1-flash-image-preview，但 legacy(IsImageGen) 优先级覆盖它路由到 stub。行为保持=建 generation 默认池→stub-image（或调整优先级让 generation 维持 stub）；改成 gemini=行为变更+烧钱，属用户显式决策，不在 P3 默认范围 |

chat 的 53 个已因止血脱离 Legacy（回到 deepseek-v4-flash 默认池）。7 个 NotFound（embedding/rerank/tts/code）需建真实池或显式标"不支持"（no-rootless-tree），独立于删 legacy。

P3 执行顺序：建上述 3 个默认池(生产共享 Mongo 写) → CDS 部署 → 刷新 golden 确认 38 个改走 DefaultPool 且 actualModel 不变 → 才删 legacy 解析层代码 + 策略引擎 → 再 CDS + golden 复confirm。任一步 golden diff 非空即停。

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

### 9.2 运行期取证结果（main 实测 2026-06-25）

通过 `AI_ACCESS_KEY` 直查 live `main` 的 API（预览分支共享真实 Mongo），结果：

| 取证项 | 实测 | 结论 |
|---|---|---|
| `model_groups.StrategyType` 分布 | 17 个池，**100% = 0(FailFast)** | 策略引擎确认死代码，P3 可删，零影响 |
| legacy 标记启用数 | IsMain/IsIntent/IsVision/IsImageGen **各 1 个，共 4 个模型** | 迁进默认池成本几乎为零 |
| Exchange 配置数 | **0 个**；池内 `__exchange__` 引用 **0 处** | Exchange 退役近乎零风险（其他分支可能不同，迁移时仍需双格式兼容兜底） |
| 有专属绑定的 caller | 50 个 caller 中 **26 个有绑定，全是 chat**；24 个已纯默认 | code 降级只动 26 个同构 chat 绑定 |
| 平台集中度 | 池内 19 item，platform1(openrouter) 占 10；模型 8/12 在 openrouter | 系统已 OpenRouter 为主，"OR 做默认"顺水推舟 |

**保留点**：`/api/open-platform/app-callers` 返回 50 条，而注册表有 156 条——该端点可能是过滤子集，或 main 落后于若干特性分支。caller 的 26/50 比例方向可信但绝对数待 P1 注册表黄金快照（反射枚举全部 156 条）对齐。池/模型/策略数据高置信无歧义。

### 9.3 全量解析底片（153 code × live main，2026-06-25）

进一步枚举注册表全部 153 个去重 code，逐个打 live `main` 的 `resolve-model` 端点，拍成全量底片（`prd-api/tests/PrdAgent.Tests/fixtures/llm-resolution-golden.main.json`）。这张底片立刻回答了"156 vs 50"并改写了迁移风险：

| 发现 | 数据 | 对方案的影响 |
|---|---|---|
| **"156 vs 50"真相** | 153 个 code **全部注册、全部可解析（0 失败）** | 50 只是"有显式 DB 绑定文档"的子集；其余 ~100 个 code 靠默认/legacy 解析，**不是数据缺口** |
| **legacy 层是承重墙，不是遗迹** | **91/153 (60%) 走 Legacy 层**：chat 53→deepseek-v4-pro、generation 16→stub-image、vision 14→qwen、intent 8→deepseek-v4-flash | 修正 §9.2 的乐观判断：只有 4 个模型带标记没错，但 **91 个 code 经 legacy 层路由到这 4 个模型**。**迁移顺序变成硬约束**：必须先为 chat/intent/vision/generation 建默认池、用黄金快照确认 91 个 code 全部改走 DefaultPool，**才能**删 legacy 层。直接删 = 砸 60% 调用方 |
| **7 个 code 解析到空（NotFound）** | `open-platform-agent.proxy::embedding/rerank`、`video-agent.audio::tts`、`video-agent.scene.codegen::code`、`visual-agent.scene.codegen::code`、`workflow-agent.cli-agent::code`、`workflow-agent.webpage-generator::code` | 存量隐患：这些 code 真被调用就会失败（无池无默认无 legacy 标记的冷门 modelType）。统一设计应显式暴露缺口（no-rootless-tree） |
| **图片默认走 stub** | 16 个 generation code 经 legacy 全落 `stub-image`(Stub 平台) | 真实生图靠 expectedModel 显式传入；P2 图片并网关时要确认真实路径，别被 stub 误导 |
| **DedicatedPool/DefaultPool** | DedicatedPool 52、DefaultPool 3、isFallback=true 69 | fallback 占比高印证"默认/legacy 兜底是常态" |

**这正是黄金快照的价值**：它在写第一行生产代码之前，就拦下了"删 legacy 层会砸 60% 调用方"这个会让你重新调一遍的坑。

### 9.4 举一反三：同类隐患实测（live main，2026-06-25）

用同一套取证手法横扫"配置与实际不符 / 静默降级 / 孤儿配置 / 运行时报错"，挖出一批**当前就在发生**的问题（不是假设）：

| # | 隐患 | 实测 | 性质 |
|---|---|---|---|
| H1 | **3 个池此刻 Unavailable，被 legacy 静默兜住** | `deepseek-v4-flash`(intent,连failed 5)、`whisper-large-v3`(asr,5)、`openai/gpt-5.4-image-2`(generation,7) 全挂；fallbackReason 实锤"池内所有模型不可用，回退直连" | **迁移阻断 + 现网降级**：legacy 层正在给这 3 个死池当安全网。先修/补默认池，否则删 legacy = 直接 outage |
| H2 | **45% 的 code 在跑 fallback** | 69/153 isFallback=true，53 个 chat 全因 deepseek-v4-flash 池死了回退到 deepseek-v4-pro | 用户拿到的不是"配置该用的模型"，且**无任何告警**——静默降级 |
| H3 | **图片默认走 stub，真在报错** | 16 个 generation code 解析到 `stub-image`；近 7 天 `visual-agent.image.text2img::generation` failed 10 次、模型=stub-image | 真实生图全靠 expectedModel 兜，忘传就拿 stub/报错（zero-friction 反面） |
| H4 | **池孤儿 + 悬空引用** | 5 个孤儿模型(stub-chat/intent/vision + 2 个没进池的 gemini 图模)；多个池 item 指向 llmmodels 里不存在的 modelId（如 qwen 池里混入 `anthropic/claude-3.7-sonnet`） | 配置腐烂；部分是"池直连模型"by-design，但 claude 混进 qwen 池是可疑脏数据 |
| H5 | **auto-* 自动建池泛滥（池版的 code 泛滥）** | `auto-prd-agent-desktop.chat...`、`auto-ccas-agent.equipment...`、`auto-marking-line-agent.diagram...`（后者**0 个模型，空池**） | 每 code 自动建池是 §决策五要治的另一面；空池 + 日期戳旧模型名 = 待清 |
| H6 | **近 7 天 failed 24 笔**（stub-image 10 / deepseek 系 10 / report TIMEOUT 3） | 失败量低 = legacy 在兜底，不是真健康 | 印证"低失败率"是假象，根因（死池）没人管 |

**对方案的影响（硬约束新增）**：

1. **legacy 删除前必加一步「死池治理」**：H1+H2 说明 legacy 层当前在掩盖 3 个死池。迁移顺序升级为：建默认池 → **修复/确认这 3 个死池的替代** → 黄金快照确认全部 code 改走健康 DefaultPool → 才删 legacy。
2. **新面板必须有「池健康 + fallback 率」告警**（问题5 升级）：45% 静默 fallback 无人知，正是"可视化面板"该一眼暴露的——把 Unavailable 池和 fallback 热度做成红色一级信息。
3. **清理项明确**：5 孤儿模型 + 空 auto-池 + 悬空引用进 P4 清理清单。

这些隐患**强化**了重构的必要性（乱是真的、且在烧），同时给了 P3/P4 具体的清理与修复标的。

> 取证手段：`scripts/llm-gateway-phase0-forensics.mongo.js` 是 DBA 直连 Mongo 版；本次走 API 等价路径（`GET /api/mds/model-groups|models|main-model|...`、`/api/open-platform/app-callers`、`/api/mds/exchanges`），二者结论应一致。

---

## 10. 风险与已知边界

- **OpenRouter 单点**：默认走 OR 享受统一，但必须保留一条直连兜底，避免 OR 故障全系统瘫。池子的兜底价值因此不为零（这也是池不能删干净、只能缩短的原因）。
- **密钥下沉到模型**：Protocol 下沉意味着更多 `ApiKeyEncrypted` 字段。受 `cross-project-isolation.md` 规则 #2 约束——密钥轮换需先解密重加密。这是已知存量债务，迁移时不放大。
- **策略引擎删除依赖运行期数据**：静态已确认不在链路，但仍需 P0 脚本确认库里无人配 race/round-robin，再物理删，避免删掉某处隐式依赖。
- **图片验收必须闭环**：P2 需双主题 + 真机出图截图（`closed-loop-acceptance.md`），不得用"触发了"充当"出图了"。

---

## 11. 测试策略（MECE 全交叉 + 100% 核心覆盖）

> 目标：把"模型池解析 + 协议选择"这层**决策逻辑**做到 100% 行+分支覆盖 + 高变异分数；新增 code/协议**结构上无法漏测**；每个意外情况有命名回归守护。一次测全，不再手工回调。
> 背景：上一代模型池靠人肉反复调，代价巨大。本次重构的硬约束是——**安全网先于动刀**：解析快照不变 + 取证零使用，才允许删任何东西。

### 11.1 覆盖金字塔（每层一道 CI 闸）

| 层 | 机制 | 覆盖什么 | 闸门 |
|---|---|---|---|
| L1 解析矩阵 | xUnit `[Theory]`+`[MemberData]` | 输入维度全交叉（见 11.2） | 矩阵行全绿 |
| L2 注册表黄金快照 | 反射 `AppCallerRegistry` | 全部 156 code × ModelType 的解析结果快照 | 快照零 diff |
| L3 协议一致性契约 | 共享契约 × 每个协议 | 每协议 endpoint/headers/body/parse | 每协议过同一契约 |
| L4 覆盖率门禁 | coverlet | 核心模块行+分支 | 核心 100%（胶水层除外，见 11.4） |
| L5 变异测试 | Stryker.NET | 断言强度（防覆盖率虚高） | mutation score ≥ 阈值 |
| L6 真实产出（gated） | 现有 Integration 模式 + 真 key | 每协议 × 模态真实出图/出字 | nightly，闭环截图取证 |
| L7 影子双跑（prod） | 只读 mismatch 计数 | 上游真实怪癖 | mismatch=0 连续 N 天才翻开关 |

### 11.2 MECE 维度与交叉

解析行为是下列**正交维度**的函数；测试 = 对有意义的交叉逐格断言：

| 维度 | 取值（穷举） |
|---|---|
| D1 解析层 | Dedicated / Default / Legacy / NotFound |
| D2 ModelType | chat / intent / vision / generation / code / longContext / embedding / rerank / asr / tts / videoGen / audioGen / moderation |
| D3 协议 | openai / claude / google / fal-image / passthrough / doubao-asr / ... |
| D4 绑定来源 | 有专属绑定 / 无绑定 / orphan / 未注册 |
| D5 expectedModel | 无 / 命中候选池 / 命中全池 / 命中 legacy 直查 / 未命中 |
| D6 健康 | 全健康 / 部分降级 / 全不可用 / 混合 |
| D7 路由 | 直连平台 / exchange(`__exchange__`) / exchange(真 id) |
| D8 模态 | text 非流 / text 流 / 图 text2img / 图 img2img / 图多图 / asr / tts |
| D9 意外 | 启动 bootstrap(IsMain) / anthropic 禁 /images / 尺寸 cap 400 重学 / OR 429 / 密钥解密失败 / 二次 resolve / 影子 mismatch |

每格断言输出不变量：**O1** `(model, protocol, endpoint, key, headers, body.model)` 正确；**O2** resolutionType 正确；**O3** 日志字段正确；**O4** resolve 只发生一次（compute-then-send 守卫）；**O5** 健康状态转移正确；**O6** failover 选对下一个。

矩阵用 `[MemberData]` 数据驱动——**矩阵即 SSOT**，加一格加一行，不写新方法。独立维度做全交叉；有依赖的维度（某协议不支持某模态）用约束剪枝并**显式记录"为何不测此格"**——这是 MECE 的两半：互不重叠（ME）+ 剪枝有据的完全穷举（CE）。

### 11.3 让覆盖"自我维持"（治本：新增不漏测）

- **注册表驱动**：L2 从 `AppCallerRegistry` 反射枚举所有 code——**新加一个 code 自动进黄金快照**，忘了配池立刻红。
- **协议契约参数化**：L3 对协议注册表里**每一个** protocol 跑同一份契约——**新加一个协议必须过契约才能注册**，否则红。
- 这两条把"覆盖全"从"靠人记得补测"变成"结构上漏不掉"。这是"不想再手工调一次"的**根本答案**：覆盖随源码自动生长。

### 11.4 为什么是"这个 100%"而不是"那个 100%"

- **核心决策模块**（resolver + 协议选择 + body 构建）**目标 100% 行+分支**——之前受的苦都在这层，纯逻辑，mock 掉 Mongo/HTTP 后可达。
- **HTTP/SSE/DI 胶水层不强求 100%**——低价值高成本，用 `[ExcludeFromCodeCoverage]` 显式标注且**逐条评审**，真实产出由 L6 兜。
- **覆盖率数字 ≠ 安全**——所以加 L5 变异测试，它翻转运算符/条件看测试抓不抓得到。**高变异分数才是"不用再手工 debug"的真凭证**；只看 100% 行覆盖会骗自己（弱断言也能刷满行覆盖）。

### 11.5 意外情况登记 = 命名回归守护

§10 与 `debt.llm-gateway.md` 挖出的每个意外，落一条**命名回归测试**（不只债务条），撞过的坑永不复发：

| 测试名 | 守护的意外 |
|---|---|
| `Startup_WithoutLegacyFlags_ClaudeBootstrapStillResolves` | 删 legacy 标记后启动期 `Program.cs`/InfraAgent 仍能建 claude 客户端 |
| `ProtocolBinding_ModelLab_Arena_ImageClient_AllRouteThroughRegistry` | 协议绑定散在 3 处的漂移 |
| `Stats_AfterCodeDowngrade_SegmentationUnchanged` | code 降级后统计分段（`chat.*` 前缀）不变 |
| `ImageSizeCap_OnUpstream400_RelearnsWithoutUserError` | 尺寸缓存孤儿导致首发 400 |
| `Exchange_BothSentinelAndRealId_Resolve` | `__exchange__` 旧 sentinel 与真 id 双格式 |

### 11.6 执行顺序（护栏先于动刀）

```
L2 黄金快照建立（P1 前必须先有）
   → L1 矩阵 + L3 协议契约全绿
   → L4 覆盖率达标 + L5 变异分数达标
   → L7 影子双跑实测等价（mismatch=0）
   → CDS 部署冒烟
   → 才允许删任何东西（且 P0 取证确认线上零使用）
```

任何删除都排在"快照不变 + 取证零使用"两道闸之后，绝不先删再看。

---

## 12. 对外平台化（OpenRouter 式）——与本重构混合

> 用户 2026-06-25 追加目标：拆掉原来的 apigateway，把这台引擎统一成"类似 OpenRouter 的平台"供别人调用，并问"本次重构能否混合使用"。实测结论：**能，且二者已经是同一架构的两面**。

### 12.1 关键发现：平台已 ~60% 在跑，且已共用同一引擎

| 已就绪（实测） | 文件 |
|---|---|
| OpenAI 兼容入口：`POST /api/v1/chat/completions`、`/v1/images/generations`、`GET /v1/models`、`/v1/key` | `OpenApiController.cs` |
| 鉴权 `sk-ak-*` AgentApiKey + scope `open-api:call` | `Authentication/ApiKeyAuthenticationHandler.cs`、`Models/AgentApiKey.cs` |
| per-key 模型白名单（`OpenApiChatModels`/`OpenApiImageModels`） | `AgentApiKey.cs` |
| scope 框架（`{resource}:{action}` + 动态 agent scope） | `Helpers/AgentScopeFormat.cs`、`Models/AgentOpenEndpoint.cs` |
| 用量日志 + Admin 控制台 | `AdminOpenApiController.cs`、`OpenApiUsageService.cs` |

**决定性事实**：`open-api.proxy::chat` / `::generation` 是注册 code——**外部调用早已走同一个 `ModelResolver` + 引擎**。所以"混合"不是选择题，今天就是混的；本次重构清的是这台共用引擎，**外部平台自动受益，零额外打通成本**。

### 12.2 "拆掉原来的 apigateway"拆的是哪个

| 组件 | 身份 | 处置 |
|---|---|---|
| **OpenPlatformApp**（`sk-*`，绑死 PRD-chat、无 scope、`openplatformrequestlogs`） | 原 apigateway | **退役** |
| `OpenApiController` + AgentApiKey（`sk-ak-*`） | 现代地基，已 OpenAI 兼容 | **接管，扩成统一平台** |
| `open-platform-agent.proxy::embedding/rerank`（§9.4 的 NotFound） | 老 proxy 悬挂残骸 | 随老平台清掉 |

§9.3 那两个 NotFound 之谜解开：是**老平台残留**，新路径 `open-api.proxy::*` 是好的。

### 12.3 收敛：Caller 合一

内部 `appCallerCode` + 外部 `AgentApiKey` = 同一个"Caller"（谁调 / 能调什么 / 算谁账）。两者已都解析进引擎，统一成一个 Caller 抽象，scope + 计费在关口分流。这就是"混合使用"的落地形态：**内部功能 = 平台的第一个客户，吃自己狗粮。**

### 12.4 待建（基于实测，非从零）

- per-key 配额硬执行（`PassUsageGateAsync` 仍是 stub，`OpenApiDailyTokenQuota` 等字段已声明未执行）
- scope → 模型门（现仅 per-key 白名单，无 scope 级模型路由）
- 动态模型列表（现为静态白名单）
- 用量聚合面板（日志有，缺跨 key 聚合）
- Unavailable 降级（`IsFallback` 已有，缺策略）

### 12.5 范围与节奏（用户拍板 2026-06-25）

- **范围**：内部其他团队/系统为主，**按可扩展设计**——scope/配额留好 seams，但现在不建公网付费墙、不做抗滥用。
- **节奏**：**先清引擎（P1-P3）再装对外入口**。外部已共用引擎 → 清引擎=同时打平台地基。
- **新硬约束**：模型名/池 code 一旦对外即成**公开 API 契约**——`auto-*` 脏池、空池、`stub-image` 默认（H3/H5）的清理从卫生升级为对外稳定性，必须在开放入口前清完。

### 12.6 对相位的影响

P4 清理范围扩大（含退役 OpenPlatformApp）；新增 **P6 平台收口**：Caller 合一 + 补 Phase2 配额/scope 门/模型列表 + 把模型名固化为公开契约。引擎相位（P1-P3）不变。

---

## 13. 关联文档

- `design.llm-gateway.md`——Gateway 总体设计（现状基线，本设计在其上做减法）
- `design.llm-gateway-refactor.md`——图片 compute-then-send 重构（PR #490，本设计复用其算/发分离）
- `design.model-pool.md`——大模型池三级调度现状（本设计将其收敛为 2 级 + 兜底链）
- `debt.llm-gateway.md`——本次迁移的已知边界台账
- `.claude/rules/compute-then-send.md`——算/发两阶段（图片统一契约的依据）
- `.claude/rules/llm-gateway.md`——所有 LLM 调用必经 Gateway + LlmRequestContext
- `.claude/rules/cross-project-isolation.md`——密钥下沉的轮换约束
- `scripts/llm-gateway-phase0-forensics.mongo.js`——P0 运行期取证脚本
