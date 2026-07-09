# LLM Gateway 目标架构图绘制说明书

> 用途：给设计师、前端、架构评审人员重新绘制一张专业的 LLM Gateway 目标架构说明图。
> 目标：让不熟悉代码的人也能看懂“MAP 保留什么、GW 接管什么、模型池归谁、多协议入口怎么统一、旧代码还剩哪些”。
> 推荐输出：一张 1440px 宽的长图，或一份 6-8 页 Keynote/Figma 分页。

## 1. 一句话主旨

目标态不是“MAP 里多了一个网关客户端”，而是：

```text
MAP 和外部系统只提交 AI 能力请求；
LLM Gateway 统一接收多协议入口，转换为 GW Request IR；
appCaller 注册、模型池、路由策略、平台密钥、请求日志和审计都归 GW 管理；
MAP 只保留业务协议、run、会话、画布、素材和业务生命周期。
```

架构图必须避免把“模型池”画在 MAP 旁边作为独立调度层。模型池最终归属是 GW。

## 2. 受众与阅读目标

### 2.1 给业务方看

- 视觉创作、聊天、ASR、视频等业务生命周期仍在 MAP。
- 用户侧接口和业务状态不会因为 GW 目标架构而丢失。
- AI 请求的模型选择、密钥、fallback、日志和审计会统一进入 GW。
- 其他系统未来不需要请求 MAP 才能用 AI 能力，而是直接接 GW 的标准协议入口。

### 2.2 给工程方看

- MAP 的职责是把业务上下文整理成 GW Native 请求，或在兼容场景中转发 OpenAI/Claude/Gemini 请求。
- GW ingress adapter 是协议边界：GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 都要先转为同一个 IR。
- `appCallerCode` 是 GW 注册表、模型池绑定、预算、限流和日志归因主键。
- `auto`、`pool`、`pinned` 都在 GW router 内完成，不允许绕过 GW 直连上游。
- `llm_gateway` 是 GW 的数据所有权边界；MAP 业务库只保存业务 run 和素材状态。
- inproc/legacy 代码只作为稳定期回滚兜底，不是目标主路径。

### 2.3 给设计师看

- 风格是企业级系统架构蓝图，不是营销 landing page。
- 画面重点是分层、归属、流向、证据，不需要装饰性插图。
- 使用清晰泳道：调用方、MAP 业务层、GW 协议与路由层、GW 数据层、上游供应商。
- 用实线表达目标主路径，用虚线表达暂存回滚路径和迁移债务。

## 3. 目标主图

主图建议画成从左到右的五段：

```text
MAP / 外部系统
  -> GW ingress adapter
  -> GW Request IR
  -> appCaller registry
  -> GW router
  -> GW model pools
  -> provider adapter
  -> upstream provider
```

### 3.1 第一段：调用方

节点：

| 节点 | 说明 |
|---|---|
| MAP Web / Desktop | 业务页面、会话、视觉创作、开放接口后台 |
| MAP API / Worker | 创建 run、保存业务状态、推送 SSE、管理素材生命周期 |
| External Systems | 第三方或其他内部系统，未来不需要绕 MAP 使用 AI |

关键标注：

```text
MAP keeps business protocol and lifecycle.
MAP does not own model routing in target state.
```

### 3.2 第二段：GW ingress adapter

四个入口必须并排画出：

| 入口 | 示例 | 说明 |
|---|---|---|
| GW Native | `/gw/v1/invoke`、`/gw/v1/stream`、`/gw/v1/raw` | MAP 和内部系统首选入口，表达最完整 |
| OpenAI-compatible | `/v1/chat/completions`、`/v1/responses`、`/v1/images/*` | 兼容业界默认调用心智 |
| Claude-compatible | `/v1/messages` | 接收 Anthropic Messages 风格 |
| Gemini-compatible | `/v1beta/models/{model}:generateContent` | 接收 Gemini generateContent 风格 |

关键标注：

```text
Adapters normalize protocol shape.
Adapters do not decide provider or key.
```

### 3.3 第三段：GW Request IR

IR 节点要展示核心字段：

| 字段 | 含义 |
|---|---|
| `requestId` | 端到端追踪 |
| `sourceSystem` | map、external、workflow 等 |
| `appCallerCode` | 治理、模型池、预算、日志归因主键 |
| `requestType` | chat、vision、generation、video-gen、asr 等 |
| `modelPolicy` | auto、pool、pinned |
| `parameterPolicy` | default-drop、strict-require |
| `trace` | sessionId、runId、workspaceId、业务 metadata |

关键标注：

```text
Router only understands IR.
Protocol-specific details live in extensions.
```

### 3.4 第四段：GW 治理与路由

画成三个上下排列的治理节点：

| 节点 | 说明 |
|---|---|
| appCaller registry | discovered/configured/active/disabled/archived，owner、预算、限流、策略 |
| GW router | auto、pool、pinned、fallback、provider preference、能力过滤 |
| GW model pools | 默认池、专属池、成员优先级、健康、成本、参数能力 |

关键标注：

```text
auto: appCaller default pool.
pool: selected GW pool.
pinned: exact platform/model, still through GW.
```

### 3.5 第五段：Provider adapter 与上游

画出：

| 节点 | 说明 |
|---|---|
| provider adapter | OpenAI、Claude、Gemini、OpenRouter-compatible、Exchange/raw |
| key vault | GW-owned API key，解密健康检查，操作审计 |
| upstream provider | SiliconFlow、APIyi、Google、Volcengine Ark、OpenRouter 等 |

关键标注：

```text
Unsupported parameters are dropped and recorded, or rejected in strict mode.
```

## 4. 数据所有权图

建议单独画一块左右对照：

| MAP owns | GW owns |
|---|---|
| 用户、项目、会话、run、画布、素材 | appCaller registry |
| 业务状态机和业务日志 | model pools |
| 前端到 MAP 的业务协议 | platforms、models、exchanges |
| `requestId/sessionId/runId` 关联字段 | provider keys |
| 业务错误与重试状态 | request logs、shadow comparisons、operation audits |

底部写关联键：

```text
requestId / sessionId / appCallerCode / runId
```

## 5. 视觉创作生命周期

视觉创作不要画成“页面直接请求 GW”。目标路径是：

```text
Visual UI
  -> MAP API creates image/video run
  -> MAP Worker manages lifecycle and assets
  -> GW Native request with appCallerCode and requestType
  -> GW router selects pool/model/provider
  -> provider adapter sends upstream
  -> MAP stores resulting asset and pushes SSE
```

说明：

- 尺寸、画布、素材引用、run 状态仍属于 MAP 生命周期。
- 模型选择和上游调用归 GW。
- 图生图、多图、vision、ASR、视频 raw 请求必须通过 GW raw/multipart 或对象存储引用协议跨进程。

## 6. OpenRouter 对标但不复制

图中可以放一个小角标：

| OpenRouter 心智 | 本系统目标 |
|---|---|
| Unified API | GW 四类入口统一转 IR |
| Model fallback | GW model pools 与 provider attempts |
| Provider routing | GW router、健康、成本、能力过滤 |
| Router metadata | routerTrace、actual model、provider attempts |
| Require parameters | strict-require 参数策略 |

不要写成“做一个 OpenRouter”。本系统目标是统一治理 MAP 和外部系统的 AI 请求。

## 7. 旧代码与迁移债务

用右下角虚线框表达：

| 项 | 状态 |
|---|---|
| inproc/legacy | 稳定期回滚兜底，目标态不作为主路径 |
| MAP config fallback | 待 config-authority 阶段和生产复核后关闭 |
| provider template coverage | 需按真实文档持续补齐 |
| raw retry | submit 阶段已覆盖，poll/download/WebSocket 仍是边界 |

风险提示必须写清：

```text
Do not claim final target state until config-authority executes, active appCallers bind GW pools, MAP fallback gate is enabled, and rollout evidence passes.
```

## 8. 推荐视觉规范

| 用途 | 颜色 |
|---|---|
| 背景 | `#F8FAFC` |
| MAP 业务 | `#2563EB` |
| GW 协议与路由 | `#059669` |
| GW 数据权威 | `#0F766E` |
| 上游供应商 | `#7C3AED` |
| 回滚/债务 | `#DC2626` |
| 连线 | `#94A3B8` |

排版要求：

- 一屏先看到主链路，不要从细节开始。
- 每个节点最多两行说明。
- 箭头方向统一从左到右。
- 虚线只用于回滚和债务。
- 不使用 emoji。
