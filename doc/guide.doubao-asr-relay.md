# 豆包 ASR 模型中继接入 · 指南

> **文档类型**: guide | **适用对象**: 后端开发 / 系统集成 | **最后更新**: 2026-03-29

---

## 管理摘要

本系统通过 **模型中继 (Exchange)** 机制将豆包语音识别 API 标准化为平台内部可调用的模型，使转录工作台无需关心底层 ASR 服务的协议差异。目前支持三种豆包 ASR 接入方式：

| 模式 | 协议 | 适用场景 | 延迟 |
|------|------|----------|------|
| HTTP 异步 (submit+query) | HTTPS | 离线转录、长音频 | 秒级（轮询） |
| WebSocket 流式 (sauc) | WSS | 实时转录、边录边转 | 毫秒级（推送） |

## 1. 架构总览

### 1.1 WebSocket 与 SSE 的关系（无冲突）

```
用户浏览器                  我们的后端                     豆包 ASR
┌─────────┐    SSE 推送    ┌──────────┐    WebSocket     ┌──────────┐
│ 前端     │◄──────────────│ .NET API │────────────────►│ 豆包 ASR  │
│ (React)  │   text/event  │ (C# 12)  │   wss:// 二进制  │ BigModel │
│          │   -stream     │          │   自定义帧协议    │          │
└─────────┘               └──────────┘                  └──────────┘
     ▲                         │
     │                         │ HTTP submit+query
     │    SSE 推送              │ (另一种模式)
     └─────────────────────────┘
```

**结论：完全不冲突。** 两种协议在不同链路上工作：

- **SSE（前端 ↔ 后端）**: 后端向前端推送转录进度和结果，遵循 `Run/Worker + afterSeq` 模式
- **WebSocket（后端 → 豆包）**: 后端作为客户端连接豆包 ASR 服务，发送音频分片、接收识别结果
- 后端是 **协议桥接层**：从豆包 WebSocket 收到结果后，转换为 SSE 事件推送给前端

这与视觉创作 Agent 调用 fal.ai 的架构完全一致——fal.ai 用 REST，豆包用 WebSocket，但对前端来说都是统一的 SSE 进度推送。

### 1.2 三层架构

```
┌─ Exchange 配置层 ─────────────────────────────────┐
│  MongoDB: model_exchanges                          │
│  存储: URL、API Key（加密）、转换器类型、认证方案    │
└───────────────────────────────────────────────────┘
           │
┌─ 转换器层 ────────────────────────────────────────┐
│  doubao-asr:        HTTP 请求/响应格式转换          │
│  doubao-asr-stream: WebSocket 标记（实际由专用服务） │
│  passthrough:       透传                           │
│  fal-image:         fal.ai 图片格式转换             │
└───────────────────────────────────────────────────┘
           │
┌─ 执行层 ──────────────────────────────────────────┐
│  LlmGateway:            HTTP 同步/异步调用          │
│  DoubaoStreamAsrService: WebSocket 二进制协议客户端  │
│  TranscriptRunWorker:    后台任务调度               │
└───────────────────────────────────────────────────┘
```

## 2. 快速接入（一键导入）

### 2.1 通过管理后台导入

1. 打开 **模型中继管理页**（侧边栏 → 模型服务 → 模型中继）
2. 点击 **「从模板导入」**
3. 选择模板，填入 API Key，点击「导入」

### 2.2 当前可用模板

| 模板名 | 模板 ID | 认证格式 | 协议 |
|--------|---------|----------|------|
| 豆包大模型语音识别 | `doubao-asr-xapikey` | `x-api-key` (UUID) | HTTP submit+query |
| 豆包流式语音识别 | `doubao-asr-stream` | `x-api-key` (UUID) 或 `AppID\|AccessToken` | WebSocket |
| fal.ai 图片生成 | `fal-image-gen` | Key | HTTP |

### 2.3 通过 API 导入

```bash
# 导入豆包 ASR（HTTP 异步模式）
curl -X POST /api/mds/exchanges/import-from-template \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "doubao-asr-xapikey",
    "apiKey": "你的-api-key-uuid"
  }'

# 导入豆包 ASR（WebSocket 流式模式）
curl -X POST /api/mds/exchanges/import-from-template \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "doubao-asr-stream",
    "apiKey": "你的-api-key-uuid"
  }'
```

## 3. 豆包 ASR 协议详解

### 3.1 HTTP 异步模式 (submit + query)

```
客户端                       豆包 API
  │                            │
  │  POST /submit              │
  │  {audio: {url: "..."}}     │
  │──────────────────────────►│
  │  X-Api-Status-Code:        │
  │  20000000 (已接收)          │
  │◄──────────────────────────│
  │                            │
  │  POST /query               │  ← 轮询（1s 间隔）
  │  {} + X-Api-Request-Id     │
  │──────────────────────────►│
  │  20000001 (处理中)          │
  │◄──────────────────────────│
  │                            │
  │  POST /query               │
  │──────────────────────────►│
  │  20000000 + {result: ...}  │  ← 完成
  │◄──────────────────────────│
```

**关键参数**:
- 认证: `x-api-key: {uuid}` 或 `X-Api-App-Key` + `X-Api-Access-Key`
- Resource ID: `volc.bigasr.auc`（BigModel）或 `volc.seedasr.auc`（Seed）
- 状态码通过 **响应 Header** `X-Api-Status-Code` 返回，不在 body 中
- 轮询需携带 submit 时的 `X-Api-Request-Id` 和响应中的 `X-Tt-Logid`

**响应状态码**:

| 状态码 | 含义 |
|--------|------|
| `20000000` | 完成 |
| `20000001` | 处理中（继续轮询） |
| `20000002` | 处理中（继续轮询） |
| 其他 | 失败 |

**我们的实现**: `IAsyncExchangeTransformer` + `LlmGateway.SendRawAsync` 自动轮询

### 3.2 WebSocket 流式模式 (sauc)

```
客户端                          豆包 WSS
  │                               │
  │  WebSocket 连接                │
  │  wss://.../sauc/bigmodel      │
  │  Headers: x-api-key, etc.     │
  │──────────────────────────────►│
  │                               │
  │  FullClientRequest (二进制帧)   │  ← JSON 配置（音频格式、模型参数）
  │──────────────────────────────►│
  │  ServerResponse (确认)         │
  │◄──────────────────────────────│
  │                               │
  │  AudioOnlyRequest × N         │  ← PCM 音频分片（200ms 间隔）
  │──────────────────────────────►│
  │  ServerResponse (部分结果)     │  ← 实时返回识别文本
  │◄──────────────────────────────│
  │                               │
  │  AudioOnlyRequest (最后一片)   │  ← NEG_WITH_SEQUENCE 标记
  │──────────────────────────────►│
  │  ServerResponse (is_last)     │  ← 最终结果
  │◄──────────────────────────────│
```

**二进制帧格式 (4 字节头)**:

```
Byte 0: [Version:4bit | HeaderSize:4bit]  → 0x11 (v1, 1 word)
Byte 1: [MsgType:4bit | Flags:4bit]
Byte 2: [Serialization:4bit | Compression:4bit]
Byte 3: [Reserved]
之后:   [Sequence:4byte BE] [PayloadSize:4byte BE] [Payload (gzip)]
```

**MsgType 值**:

| 值 | 名称 | 方向 |
|----|------|------|
| `0x1` | ClientFullRequest | 客户端→服务端 |
| `0x2` | ClientAudioOnlyRequest | 客户端→服务端 |
| `0x9` | ServerFullResponse | 服务端→客户端 |
| `0xF` | ServerErrorResponse | 服务端→客户端 |

**Flags 值**:

| 值 | 含义 |
|----|------|
| `0x1` | POS_SEQUENCE（正序号） |
| `0x2` | NEG_SEQUENCE |
| `0x3` | NEG_WITH_SEQUENCE（最后一片） |

**WebSocket URL 变体**:

| URL | 模式 | 说明 |
|-----|------|------|
| `.../sauc/bigmodel` | 流式 | 边发边返，实时结果 |
| `.../sauc/bigmodel_async` | 异步流式 | 发完再返 |
| `.../sauc/bigmodel_nostream` | 非流式 | 发完统一返回（推荐用于离线转录） |

**我们的实现**: `DoubaoStreamAsrService`，完整的 C# WebSocket 客户端

## 4. 认证方式

### 4.1 单 Key 认证（推荐，更简单）

```
Header: x-api-key: {uuid}
适用: HTTP submit/query、WebSocket sauc
Key 来源: 火山引擎控制台
```

### 4.2 双 Key 认证

```
Header: X-Api-App-Key: {appId}
Header: X-Api-Access-Key: {accessToken}
适用: HTTP submit/query、WebSocket sauc
Key 来源: 火山引擎控制台的 App ID + Access Token
```

**导入模板时**: 单 Key 直接填 UUID，双 Key 用 `AppID|AccessToken` 格式（竖线分隔）。

## 5. 其他 Agent 如何接入 ASR

如果你正在开发一个新 Agent，需要调用 ASR 模型进行语音转文字，按以下三步操作。

### 5.1 注册 AppCallerCode

在 `prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs` 中，按现有 Agent 的层级结构添加你的 AppCallerCode：

```csharp
// 在 AppCallerRegistry 类中添加
public static class YourAgent
{
    public static class SomeFeature
    {
        [AppCallerMetadata(
            displayName: "你的Agent-语音转写",
            description: "描述这个调用点的用途",
            ModelTypes = new[] { ModelTypes.Asr },
            Category = "YourAgent")]
        public const string Transcribe = "your-agent.some-feature.transcribe::asr";
    }
}
```

**命名规范**: `{app-key}.{feature}.{action}::{model-type}`

**已有的 ASR AppCallerCode 参考**:

| AppCallerCode | 用途 |
|---------------|------|
| `transcript-agent.transcribe::asr` | 转录工作台 |
| `video-agent.v2d.transcribe::asr` | 视频转文档 |

### 5.2 绑定模型池

有两种方式让你的 AppCallerCode 找到 ASR 模型：

**方式 A: 使用默认模型池（推荐）**

如果 ASR 模型池已设置 `isDefaultForType = true`，你的 Agent 无需额外配置。Gateway 调度三级优先级：

1. 专属模型池（AppCallerCode 绑定的 `ModelGroupIds`）
2. 默认模型池（`ModelType = "asr"` 且 `IsDefaultForType = true`）
3. 传统配置（`IsMain` 标记，不推荐）

**方式 B: 绑定专属模型池**

如果需要独立的模型池（如不同 Agent 使用不同 ASR 服务），在管理后台：
1. 模型池管理页 → 创建新模型池（类型选 `asr`）
2. 模型中继页 → 对应 Exchange 卡片点击「一键添加到模型池」
3. LLM 应用调用方页 → 找到你的 AppCallerCode → 绑定模型池

### 5.3 调用 Gateway

在你的 Service/Worker 中通过 `ILlmGateway` 发起 ASR 调用：

```csharp
// 注入 ILlmGateway
private readonly ILlmGateway _gateway;

// HTTP 异步模式（doubao-asr 转换器）
var response = await _gateway.SendRawAsync(new GatewayRequest
{
    AppCallerCode = AppCallerRegistry.YourAgent.SomeFeature.Transcribe,
    ModelType = ModelTypes.Asr,
    RawBody = JsonSerializer.Serialize(new
    {
        audio = new { url = audioFileUrl }
    }),
    // 异步模式 Gateway 自动轮询
}, CancellationToken.None);

// response.RawBody 包含转录结果 JSON
```

**WebSocket 流式模式**需直接注入 `DoubaoStreamAsrService`：

```csharp
// 注入 DoubaoStreamAsrService
private readonly DoubaoStreamAsrService _streamAsr;

// 需要自行从 Exchange 配置获取 wsUrl 和 apiKey
var result = await _streamAsr.TranscribeAsync(
    wsUrl, appKey, accessKey, audioData, config,
    CancellationToken.None);

// result.FullText 包含完整转录文本
// result.Segments 包含分段时间戳
```

> **注意**: WebSocket 流式模式目前不经过 Gateway 调度，直接调用 `DoubaoStreamAsrService`。如需 Gateway 统一调度 WebSocket，需扩展 Gateway 的 Exchange 调度路径（见第 10 节讨论）。

## 6. 代码对照

### 5.1 核心文件清单

| 文件 | 用途 |
|------|------|
| `IExchangeTransformer.cs` | Exchange 转换器接口（含 `IAsyncExchangeTransformer`） |
| `DoubaoAsrTransformer.cs` | HTTP 异步模式：请求/响应格式转换 + 轮询状态判断 |
| `DoubaoStreamAsrTransformer.cs` | WebSocket 流式模式：标记转换器 |
| `DoubaoStreamAsrService.cs` | WebSocket 二进制协议客户端完整实现 |
| `ExchangeTransformerRegistry.cs` | 转换器注册表 |
| `LlmGateway.cs` | HTTP Exchange 调用 + 异步轮询逻辑 |
| `ExchangeController.cs` | 中继管理 API + 导入模板 + 测试端点 |
| `TranscriptRunWorker.cs` | 转录后台 Worker（调用 Gateway/StreamAsr） |

### 6.2 新增接入点步骤

如果要接入其他 ASR 服务（如阿里云、讯飞）：

1. **创建转换器** `XxxAsrTransformer : IExchangeTransformer`（或 `IAsyncExchangeTransformer`）
2. **注册** 到 `ExchangeTransformerRegistry` 构造函数
3. **添加模板** 到 `ExchangeTemplates.All`
4. 如果是 WebSocket 协议，创建专用 Service 类
5. 认证方案如有新类型，在 `LlmGateway.SetAuthHeader` 增加 case

## 7. 测试验证

### 6.1 HTTP 异步模式验证（已通过）

```bash
# submit
curl -X POST 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: {你的key}' \
  -H 'X-Api-Resource-Id: volc.bigasr.auc' \
  -H 'X-Api-Request-Id: {uuid}' \
  -H 'X-Api-Sequence: -1' \
  -d '{"user":{"uid":"test"},"audio":{"url":"https://i.miduo.org/temp/output.wav"},"request":{"model_name":"bigmodel","enable_itn":true,"enable_punc":true}}'

# 检查 header: X-Api-Status-Code: 20000000 → 提交成功

# query（携带 submit 的 X-Api-Request-Id 和 X-Tt-Logid）
curl -X POST 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: {你的key}' \
  -H 'X-Api-Resource-Id: volc.bigasr.auc' \
  -H 'X-Api-Request-Id: {submit时的uuid}' \
  -H 'X-Tt-Logid: {submit响应的logid}' \
  -d '{}'
```

**实测结果** (2026-03-29):
- 音频: `output.wav` (5.6 秒)
- 转录: 「你先简单介绍介绍你自己，你是个什么样的人？」
- 含 19 个词级时间戳

### 6.2 管理后台测试

1. 模型中继页面 → 点击中继卡片「测试」按钮
2. ASR 类型自动切换到「音频」模式
3. 上传音频文件或输入 URL → 点击「发送测试」
4. 三列面板展示：转换后请求 | 原始响应 | 标准化响应

## 8. 注意事项

1. **音频格式**: WebSocket 流式模式**严格要求 16kHz 单声道 16bit PCM**，`DoubaoStreamAsrService` 会自动重采样（纯 C# 线性插值，无需 ffmpeg）。HTTP 异步模式接受多种格式
2. **任意格式上传**: 用户可能上传 MP3/M4A/OGG/FLAC/MP4 等任意格式，建议在 `TranscriptRunWorker` 中用 ffmpeg 转为 WAV 后再传入 Service
3. **文件大小**: HTTP 模式支持 URL 传入，无大小限制；WebSocket 模式需分片传输（每片 200ms PCM）
4. **超时**: HTTP 异步模式轮询最多 10 分钟；WebSocket 接收超时 120 秒
5. **Resource ID**: 不同产品线使用不同 ID：
   - `volc.bigasr.auc` — BigModel ASR (HTTP 异步)
   - `volc.bigasr.sauc.duration` — 流式 ASR (WebSocket)
6. **Key 安全**: API Key 在数据库中 AES 加密存储，API 返回时脱敏显示

## 9. 实测结果 (2026-03-29)

### HTTP 异步模式

```
音频: output.wav (48kHz/2ch, 5.6 秒)
认证: x-api-key (单Key)
结果: 「你先简单介绍介绍你自己，你是个什么样的人？」
耗时: submit 5s + query 2s
含 19 个词级时间戳 (word-level timestamps)
```

### WebSocket 流式模式

```
音频: output.wav (48kHz/2ch → 自动重采样 16kHz/1ch)
认证: x-api-key (单Key)
结果: 「你先简单介绍介绍你自己，你是个什么样的人？」
帧数: 28 帧 (每 200ms 一帧)
耗时: 6.5 秒
```

两种模式转录结果完全一致。

## 10. 已知限制与后续优化

| 项目 | 现状 | 优化方向 |
|------|------|----------|
| 音频格式 | 仅支持 WAV/raw PCM 输入 | TranscriptRunWorker 中加 ffmpeg 预处理，支持 MP3/M4A/OGG 等 |
| 重采样质量 | 线性插值（简单但有轻微失真） | 可改用 sinc 插值或 ffmpeg |
| 断线重连 | 无 | 生产环境长音频需增加重连机制 |
| 实时流式 | 使用 bigmodel_nostream（发完再返） | 如需实时字幕可改用 bigmodel 端点 |

## 11. Gateway 统一调度讨论

### 现状

| 模式 | 调度路径 | 是否经过 Gateway |
|------|----------|-----------------|
| HTTP 异步 (doubao-asr) | `ILlmGateway.SendRawAsync` → Exchange 管线 | ✅ 是 |
| WebSocket 流式 (doubao-asr-stream) | 直接调 `DoubaoStreamAsrService` | ❌ 否 |

### 不统一的影响

- WebSocket 模式不走 Gateway 意味着：不经过模型池策略引擎、不记录 `llmrequestlogs`、不支持健康检查降权
- 对于单 Exchange 单模型的场景（当前状态），影响不大
- 如果未来有多个 ASR 服务需要负载均衡，需要统一

### 如果要统一

Gateway 需要新增 WebSocket Exchange 调度路径，大致方案：

1. `GatewayRequest` 新增 `TransportType = "websocket"` 标记
2. `ModelResolver` 照常选择 Exchange + 模型
3. Gateway 根据 `TransportType` 走不同执行路径：HTTP → `HttpClient`，WebSocket → 注入对应 Service
4. 转换器标记类（如 `DoubaoStreamAsrTransformer`）提供 Service 类型信息

**建议**: 当前保持直连模式，等出现第二个 WebSocket ASR 服务时再统一。

---

> 关联文档: `doc/design.transcript-agent.md` | 关联代码: `prd-api/src/PrdAgent.Api/Services/DoubaoStreamAsrService.cs`
