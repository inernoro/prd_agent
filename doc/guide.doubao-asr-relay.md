# 豆包 ASR 模型中继接入指南

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

## 5. 代码对照

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

### 5.2 新增接入点步骤

如果要接入其他 ASR 服务（如阿里云、讯飞）：

1. **创建转换器** `XxxAsrTransformer : IExchangeTransformer`（或 `IAsyncExchangeTransformer`）
2. **注册** 到 `ExchangeTransformerRegistry` 构造函数
3. **添加模板** 到 `ExchangeTemplates.All`
4. 如果是 WebSocket 协议，创建专用 Service 类
5. 认证方案如有新类型，在 `LlmGateway.SetAuthHeader` 增加 case

## 6. 测试验证

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

## 7. 注意事项

1. **音频格式**: 推荐 MP3 或 WAV (PCM 16bit 16kHz)，其他格式需先用 ffmpeg 转换
2. **文件大小**: HTTP 模式支持 URL 传入，无大小限制；WebSocket 模式需分片传输
3. **超时**: HTTP 异步模式轮询最多 10 分钟（600 次 × 1s）；WebSocket 无超时
4. **Resource ID**: 不同产品线使用不同 ID：
   - `volc.bigasr.auc` — BigModel ASR (HTTP)
   - `volc.seedasr.auc` — Seed ASR (HTTP)
   - `volc.bigasr.sauc.duration` — 流式 ASR (WebSocket)
5. **Key 安全**: API Key 在数据库中 AES 加密存储，API 返回时脱敏显示

---

> 关联文档: `doc/design.transcript-agent.md` | 关联代码: `prd-api/src/PrdAgent.Infrastructure/LlmGateway/Transformers/`
