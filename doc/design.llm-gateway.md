# LLM Gateway 统一调用 · 设计

> **状态**：已实现

## 一、管理摘要

- **解决什么问题**：系统有 6 个 Agent + 工作流引擎，每个都要调用大模型，但模型来自不同平台（OpenAI、Claude、火山引擎等），直接对接导致调用代码散乱、模型切换困难、无法统一监控和故障转移
- **方案概述**：所有 LLM 调用必须通过统一的 Gateway 守门员，Gateway 自动完成模型调度（三级链路）、平台适配、健康管理、日志记录，业务方只需声明"我是谁"和"我要什么类型的模型"
- **业务价值**：业务方零感知地享受模型故障自动切换、负载均衡、成本优化；运维方统一监控所有 LLM 调用的成本和质量
- **影响范围**：所有 Agent、工作流引擎、开放平台——系统中每一次 LLM 调用都经过 Gateway

## 二、产品定位

**一句话**：所有大模型调用的唯一入口——屏蔽平台差异，统一调度、监控、容灾。

**服务对象**：

| 角色 | 与 Gateway 的关系 |
|------|------------------|
| Agent 开发者 | 调用 `ILlmGateway.SendAsync/StreamAsync`，声明 AppCallerCode + ModelType，不关心模型选择细节 |
| 模型运维 | 在管理后台配置模型组、调度策略、健康阈值，Gateway 自动执行 |
| 产品负责人 | 查看 LLM 请求日志，了解各 Agent 的模型使用量和成本 |
| 系统架构师 | 通过三级调度实现模型隔离、灰度、故障转移 |

## 三、用户场景

### 场景 1：业务方调用（开发者视角）

> Visual Agent 需要调用图片生成模型。

1. 开发者构造请求：AppCallerCode = `visual-agent.image.vision::generation`, ModelType = `generation`
2. 调用 `gateway.SendAsync(request)` — 一行代码
3. Gateway 自动完成：查找模型组 → 选择健康模型 → 适配平台协议 → 发起请求 → 记录日志
4. 开发者拿到统一格式的响应，不需要知道底层用的是哪个模型

**核心价值**：开发者不需要关心模型选择、平台差异、故障处理——Gateway 全包了。

### 场景 2：模型故障自动切换（运维视角）

> 某个 OpenAI 模型突然 503 错误。

1. Gateway 检测到连续失败 → 标记该模型为不健康
2. 后续请求自动路由到备选模型（顺序策略）或健康模型（轮询策略）
3. 后台自动探活：每 120 秒发一个轻量请求（MaxTokens=1）检测模型是否恢复
4. 模型恢复 → 自动标记为健康 → 恢复接收流量

**核心价值**：模型故障对业务方完全透明，用户无感知。

### 场景 3：模型成本优化（管理者视角）

> CTO 想了解各 Agent 每月的模型调用成本。

1. Gateway 每次调用自动记录到 `llmrequestlogs`：哪个 Agent、哪个模型、Token 用量、耗时
2. 管理后台 LLM 日志页面 → 按 Agent/模型/日期聚合 → 成本报表
3. 发现某个 Agent 成本过高 → 调整其模型组配置（换用更便宜的模型）

### 场景 4：新模型灰度上线

> 要上线一个新的 Claude 模型，希望先让 10% 流量试用。

1. 运维创建新模型组，配置加权随机策略（新模型权重 10%，老模型 90%）
2. 将模型组绑定到特定 AppCallerCode
3. 观察 LLM 日志中新模型的响应质量和延迟
4. 质量达标 → 逐步调高权重直到 100%

## 四、核心能力矩阵

| 能力 | 说明 |
|------|------|
| **统一入口** | 所有 LLM 调用通过 `ILlmGateway` 单一接口 |
| **三级调度** | 专属模型池 → 默认模型池 → 传统配置（Legacy）逐级回退 |
| **平台适配** | OpenAI / Claude / 火山引擎等平台透明适配 |
| **6 种池策略** | FailFast、Race、Sequential、RoundRobin、WeightedRandom、（自定义扩展） |
| **健康管理** | 模型失败自动标记不健康 + 定时探活恢复 |
| **日志记录** | 每次调用自动记录 RequestPurpose、实际模型、Token、耗时 |
| **流式支持** | `StreamAsync` 返回 `IAsyncEnumerable` 流式响应 |
| **AppCaller 隔离** | 按 `AppCallerCode` 维度隔离模型配置，Agent 间互不影响 |
| **模型组管理** | 管理后台配置模型组、成员、策略、默认池 |
| **模型测试** | Model Lab 支持模型对比测试、批量评估 |

## 五、整体架构

```
┌─────────────────────────────────────────────────────────┐
│           业务调用方（6 个 Agent + 工作流 + 开放平台）      │
│  AppCallerCode = "{app}.{feature}::{modelType}"         │
└─────────────────────────┬───────────────────────────────┘
                          │ ILlmGateway.SendAsync / StreamAsync
┌─────────────────────────▼───────────────────────────────┐
│                     LLM Gateway                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  ModelResolver — 三级调度                        │    │
│  │  1. 查 AppCallerCode 绑定的专属模型组            │    │
│  │  2. 查 ModelType 对应的默认模型组                │    │
│  │  3. 回退到传统 IsMain/IsVision 配置              │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │                                │
│  ┌──────────────────────▼──────────────────────────┐    │
│  │  Pool Strategy Engine — 6 种策略                 │    │
│  │  FailFast │ Race │ Sequential │ RoundRobin │ ... │    │
│  └──────────────────────┬──────────────────────────┘    │
│                         │                                │
│  ┌──────────────────────▼──────────────────────────┐    │
│  │  Health Manager — 健康管理                       │    │
│  │  成功/失败反馈 → 健康状态标记 → 定时探活恢复      │    │
│  └──────────────────────┬──────────────────────────┘    │
└─────────────────────────┼───────────────────────────────┘
                          │
          ┌───────────────┼────────────────┐
          │               │                │
   ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼───────┐
   │ OpenAI      │ │ Claude     │ │ 火山引擎      │
   │ Adapter     │ │ Adapter    │ │ Adapter       │
   └─────────────┘ └────────────┘ └──────────────┘
```

### 三级调度链路

| 优先级 | 调度层 | 说明 |
|--------|--------|------|
| 1 | 专属模型池 | AppCallerCode 绑定的 ModelGroupIds → 按池策略选择模型 |
| 2 | 默认模型池 | ModelType 对应的 IsDefaultForType 池 → 按池策略选择 |
| 3 | 传统配置 | IsMain / IsIntent / IsVision / IsImageGen 标记 → 直接匹配 |

## 六、数据设计

| 集合 | 用途 | 关键字段 |
|------|------|----------|
| `llmconfigs` | LLM 配置（API Key 等） | Provider, ApiKey, BaseUrl |
| `llmplatforms` | 平台定义 | Name, AdapterType |
| `llmmodels` | 模型定义 | PlatformId, ModelId, ModelType, IsMain |
| `llmrequestlogs` | 请求日志 | AppCallerCode, Model, TokenUsage, Duration |
| `model_groups` | 模型组 | Name, StrategyType, Members, IsDefaultForType |
| `model_scheduler_config` | 调度配置 | 全局调度参数 |
| `model_test_stubs` | 测试桩 | 模型测试的 mock 响应 |
| `llm_app_callers` | AppCaller 注册 | AppCallerCode, ModelGroupIds |
| `model_exchanges` | 模型交换记录 | 模型间切换日志 |

## 七、接口设计

### 模型管理（ModelsController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/models` | 模型列表 |
| POST | `/api/models` | 创建模型 |
| PUT | `/api/models/{id}` | 更新模型 |
| DELETE | `/api/models/{id}` | 删除模型 |

### 平台管理（PlatformsController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/platforms` | 平台列表 |
| POST | `/api/platforms` | 创建平台 |
| PUT | `/api/platforms/{id}` | 更新平台 |
| DELETE | `/api/platforms/{id}` | 删除平台 |

### 模型组（ModelGroupsController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/model-groups` | 模型组列表 |
| POST | `/api/model-groups` | 创建模型组（含策略配置） |
| PUT | `/api/model-groups/{id}` | 更新模型组 |
| DELETE | `/api/model-groups/{id}` | 删除模型组 |

### LLM 日志（LlmLogsController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/llm-logs` | 请求日志列表（支持按 Agent/模型/日期筛选） |
| GET | `/api/llm-logs/{id}` | 日志详情 |
| GET | `/api/llm-logs/meta` | 日志元数据（可用筛选维度） |

### LLM 配置（LLMConfigController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/llm-configs` | 配置列表 |
| POST | `/api/llm-configs` | 创建配置 |
| PUT | `/api/llm-configs/{id}` | 更新配置 |

## 八、关联设计文档

| 文档 | 关系 |
|------|------|
| `design.model-pool.md` | 三级调度的详细设计（模型组、策略引擎、AppCaller 注册） |
| `design.model-pool-failover.md` | 故障转移与自动探活的详细设计 |
| `design.system-emergence.md` | Gateway 作为基础层支撑所有 Agent 的涌现能力 |
| `.claude/rules/llm-gateway.md` | Gateway 使用规则（AppCallerCode 命名规范、调度优先级） |
| `design.llm-gateway-refactor.md` | Compute-then-Send 重构详细设计 |

## 九、Compute-then-Send 原则（外部调用两阶段）

> 详见 `.claude/rules/compute-then-send.md` 和 `doc/design.llm-gateway-refactor.md`

外部调用（LLM / 图片生成 / 视频生成）必须把**计算阶段**和**发送阶段**严格拆分：

| 阶段 | 职责 | 关键方法 |
|------|------|---------|
| 计算（Compute） | 调用 `IModelResolver.ResolveAsync` 决定模型、平台、API URL | `ResolveModelAsync` |
| 发送（Send） | 接收已解析结果，发 HTTP，解析响应 | `SendRawWithResolutionAsync` |

**核心规则**：发送阶段不得在内部再调用 `ResolveAsync`——发送函数只接收参数，不做选择。

### 标准调用模式

```csharp
// ✅ 正确：先算后发
var resolution = await _gateway.ResolveModelAsync(appCallerCode, ModelType, expectedModel, ct);
if (!resolution.Success) { /* 返回错误 */ }

var response = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
{
    AppCallerCode = appCallerCode,
    ModelType     = ModelType,
    EndpointPath  = "/chat/completions",
    RequestBody   = body,
    HttpMethod    = "POST",
}, resolution, ct);
```

### 已落地的实现（2026-04-23）

- `LlmGateway.SendRawWithResolutionAsync` — 新标准发送方法，接收 `GatewayModelResolution`
- `OpenAIImageClient.GenerateAsync` — 已迁移，单次 Resolve
- `OpenRouterVideoClient` — `GetStatusAsync` 复用 `SubmitAsync` 阶段缓存，不重复 Resolve
- `ExpectedModelRespectingResolver.cs` — 已删除（旧补丁）

## 十、影响范围与风险

### 影响范围

| 影响模块 | 说明 |
|----------|------|
| 所有 Agent | 每一次 LLM 调用都经过 Gateway |
| 工作流引擎 | LLM 分析舱、报告生成舱等通过 Gateway 调用模型 |
| 开放平台 | 外部 API 请求通过 Gateway 路由到模型 |
| 管理后台 | 模型/平台/模型组/日志的管理界面 |

### 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Gateway 单点故障 | 低 | 极高 | 无状态设计 + 多实例部署 |
| 模型池配置错误导致所有请求失败 | 低 | 高 | 传统配置作为最终兜底（三级调度第 3 级） |
| API Key 泄露 | 低 | 高 | Key 加密存储，日志脱敏 |
| 模型切换导致输出质量下降 | 中 | 中 | Model Lab 提前评估 + 灰度上线 |
| LLM 日志量大影响数据库性能 | 中 | 中 | TTL 自动过期 + 异步写入 |
