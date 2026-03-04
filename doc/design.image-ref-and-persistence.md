# 图片引用日志 & 消息服务器权威持久化 — 架构设计

> **版本**：v1.0 | **日期**：2026-02-08
> **关联分支**：`claude/fix-image-url-redraw-KK7Oe`
> **解决问题**：
> 1. LLM 请求日志中参考图显示 base64 而非 COS URL
> 2. 重绘消息刷新后丢失 & 编辑窗不显示参考图

---

## 一、问题根因

### 问题 1：参考图显示 base64

```
  ┌──────────────────────────────────────────────────────────────┐
  │  旧流程：base64 被截断导致图片无法显示                          │
  └──────────────────────────────────────────────────────────────┘

  OpenAIImageClient                 LlmGateway                LlmRequestLogWriter
  ┌──────────────┐             ┌──────────────────┐        ┌───────────────────┐
  │ 构建请求 JSON  │────────────▶│ 转发 + 记日志     │───────▶│  StartAsync()     │
  │ body 含 base64│             │                  │        │                   │
  │ data:image/.. │             │ RequestBody 原文  │        │ TruncateJson      │
  │ (200KB+)      │             │ 传给日志系统       │        │ Values(100 chars) │
  └──────────────┘             └──────────────────┘        │        ↓          │
                                                           │ "data:image/pn..." │
                                                           │   ← 被截断！       │
                                                           │   图片不可用 ✗     │
                                                           └───────────────────┘

  前端 LlmLogsPage:
    extractInlineImagesFromBody(requestBodyRedacted)
    → 解析出 "data:image/pn...[TRUNCATED]"
    → <img src="data:image/pn..."> ← 无法渲染 ✗
```

**根因**：`LlmRequestLogWriter.TruncateJsonStringValues()` 将所有 JSON 字符串值截断到 100 字符，
base64 图片数据 (通常 200KB+) 被截断后无法作为 `<img>` 的 src 使用。

### 问题 2：消息刷新后丢失

```
  ┌──────────────────────────────────────────────────────────────┐
  │  旧流程：前端 fire-and-forget 导致消息丢失                      │
  └──────────────────────────────────────────────────────────────┘

  前端 AdvancedVisualAgentTab                          后端
  ┌──────────────────────────┐                   ┌──────────────┐
  │ 1. pushMsg(userMsg)      │                   │              │
  │    ├─ UI: 显示消息 ✓     │                   │              │
  │    └─ API: addMessage()  │──── async ────────▶│ 保存到 DB    │
  │         .catch(warn) ←───── 可能静默失败 ✗    │              │
  │                          │                   │              │
  │ 2. SSE: imageDone        │◀──────────────────│ Worker 完成   │
  │    ├─ UI: 显示结果 ✓     │                   │              │
  │    └─ API: addMessage()  │──── async ────────▶│ 保存到 DB    │
  │         .catch(warn) ←───── 可能静默失败 ✗    │              │
  │                          │                   │              │
  │ 3. 用户刷新页面          │                   │              │
  │    loadMessages() → 空！  │◀──────────────────│ DB 无记录 ✗  │
  └──────────────────────────┘                   └──────────────┘

  问题：消息持久化依赖前端异步调用，网络抖动/页面快速切换均可导致丢失
```

---

## 二、解决方案架构

### 方案 1：ImageReferences 独立字段

```
  ┌──────────────────────────────────────────────────────────────────┐
  │  新流程：COS URL 通过 ImageReferences 独立存储                     │
  └──────────────────────────────────────────────────────────────────┘

  OpenAIImageClient              GatewayRequest              LlmRequestLogWriter
  ┌──────────────┐          ┌──────────────────┐         ┌────────────────────┐
  │ 加载参考图     │          │                  │         │                    │
  │ imageRefs:    │          │ Context:         │         │ StartAsync():      │
  │  ├ Sha256     │──build──▶│  ImageReferences │──pass──▶│   log.ImageRefs =  │
  │  ├ CosUrl  ✓  │          │   ├ Sha256       │         │     start.ImageRefs│
  │  ├ Label      │          │   ├ CosUrl    ✓  │         │                    │
  │  └ MimeType   │          │   ├ Label        │         │  RequestBody 仍然   │
  └──────────────┘          │   └ MimeType     │         │  截断（无影响）      │
                            └──────────────────┘         └─────────┬──────────┘
                                                                   │
                                                                   ▼
                                                          ┌────────────────┐
                                                          │  MongoDB       │
                                                          │  llm_request   │
                                                          │  _logs         │
                                                          │                │
                                                          │ imageReferences│
                                                          │  ├ sha256      │
                                                          │  ├ cosUrl   ✓  │
                                                          │  ├ label       │
                                                          │  ├ mimeType    │
                                                          │  └ sizeBytes   │
                                                          └───────┬────────┘
                                                                  │
                                                                  ▼
                                                          ┌────────────────┐
                                                          │  前端          │
                                                          │  LlmLogsPage  │
                                                          │                │
                                                          │  优先使用       │
                                                          │  imageReferences│
                                                          │  的 cosUrl     │
                                                          │  显示图片 ✓    │
                                                          │                │
                                                          │  旧日志降级：   │
                                                          │  extractInline │
                                                          │  ImagesFromBody│
                                                          └────────────────┘
```

**数据模型**：

```
  LlmImageReference
  ┌───────────────────┐
  │ sha256:  string?  │  ← 图片内容 SHA256（用于去重/校验）
  │ cosUrl:  string?  │  ← COS 公开访问 URL（直接用于 <img>）
  │ label:   string?  │  ← 图片用途标签（"参考图"/"蒙版"）
  │ mimeType:string?  │  ← MIME 类型（image/png, image/jpeg）
  │ sizeBytes:long?   │  ← 原始文件大小
  └───────────────────┘
```

**传递路径**：

```
  ImageRefData (已有模型)
       │
       │ .Select(r => new LlmImageReference { ... })
       ▼
  GatewayRequest.Context.ImageReferences
       │
       │ 透传
       ▼
  LlmLogStart.ImageReferences
       │
       │ 直接赋值
       ▼
  LlmRequestLog.ImageReferences  →  MongoDB  →  前端展示
```

### 方案 2：服务器权威消息持久化

```
  ┌──────────────────────────────────────────────────────────────────┐
  │  新流程：后端自动保存消息，前端仅更新 UI                            │
  └──────────────────────────────────────────────────────────────────┘

  前端                              后端 Controller              后端 Worker
  ┌─────────────┐              ┌──────────────────┐         ┌────────────────┐
  │             │              │                  │         │                │
  │ 1.创建 Run  │── POST ─────▶│ CreateRun()      │         │                │
  │   传入      │              │  ├ 创建 Run      │         │                │
  │   userMsg   │              │  ├ 保存 UserMsg  │────┐    │                │
  │   Content   │              │  │  到 DB ✓      │    │    │                │
  │             │              │  └ 返回 RunId    │    │    │                │
  │             │◀── 200 ──────│                  │    │    │                │
  │             │              └──────────────────┘    │    │                │
  │ 2.pushMsg   │                                      │    │                │
  │   仅更新 UI │                                      │    │                │
  │   不调 API  │                                      ▼    │                │
  │             │                               ┌──────────┐│                │
  │             │                               │ MongoDB  ││ 3.Worker 处理  │
  │             │                               │ image_   ││   LLM 调用     │
  │             │                               │ master_  ││   生成图片     │
  │             │                               │ messages ││                │
  │             │                               │          ││ 4.imageDone:   │
  │             │              ┌─── SSE ────────│ ←────────││  保存 AsstMsg  │
  │             │◀─────────────│ savedMessageId │          ││  到 DB ✓       │
  │ 5.收到 SSE  │              └────────────────│          ││                │
  │   显示结果  │                               │          ││ 5.imageError:  │
  │   + 参考图  │                               │ ←────────││  保存 ErrMsg   │
  │             │                               │          ││  到 DB ✓       │
  └─────────────┘                               └──────────┘└────────────────┘

  刷新页面后：
  ┌─────────────┐              ┌──────────────────┐
  │ loadMessages│── GET ──────▶│ 从 DB 加载       │
  │             │              │ 所有消息 ✓       │
  │ 显示完整    │◀── 200 ──────│ User + Assistant  │
  │ 历史记录 ✓  │              │ 都在 ✓           │
  └─────────────┘              └──────────────────┘
```

**消息保存时机**：

```
  ┌──────────────────────────────────────────────┐
  │              消息生命周期                      │
  ├──────────────┬───────────────────────────────┤
  │   时机        │  保存方                        │
  ├──────────────┼───────────────────────────────┤
  │ CreateRun    │  Controller 保存 User 消息     │
  │              │  内容 = userMessageContent     │
  │              │  或 fallback 到 prompt         │
  ├──────────────┼───────────────────────────────┤
  │ imageDone    │  Worker 保存 Assistant 消息    │
  │   (SSE)      │  内容 = [GEN_DONE]{json}      │
  │              │  json 含 src, refSrc, prompt,  │
  │              │  runId, modelPool, genType,    │
  │              │  imageRefShas                  │
  ├──────────────┼───────────────────────────────┤
  │ imageError   │  Worker 保存 Assistant 消息    │
  │   (SSE)      │  内容 = [GEN_ERROR]{json}     │
  │              │  json 含 error, refSrc, runId, │
  │              │  genType                       │
  └──────────────┴───────────────────────────────┘
```

### genDone 渲染：参考图 + 生成图并排

```
  ┌──────────────────────────────────────────────────┐
  │  编辑窗消息渲染 (genDone)                          │
  ├──────────────────────────────────────────────────┤
  │                                                  │
  │  ┌──────────┐  ┌──────────────────────────────┐  │
  │  │ 参考图    │  │                              │  │
  │  │ (64×64)  │  │       生成结果图              │  │
  │  │ refSrc   │  │       (最大宽度)              │  │
  │  │          │  │       src                    │  │
  │  └──────────┘  │                              │  │
  │   ↑ 新增显示   │                              │  │
  │                │                              │  │
  │                └──────────────────────────────┘  │
  │                                                  │
  │  提示词: "xxx"          模型池: yyy               │
  │  运行ID: zzz                                     │
  └──────────────────────────────────────────────────┘

  旧行为：只显示生成结果图，不显示参考图
  新行为：左侧 64px 参考图缩略图 + 右侧生成结果图
```

---

## 三、数据流全景图

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                    Visual Agent 图片生成全流程                            │
  └─────────────────────────────────────────────────────────────────────────┘

  ①                    ②                    ③                    ④
  用户操作              Controller           Worker               前端渲染
  ─────────            ──────────           ──────               ────────

  [发送重绘]     ───▶  CreateRun()
                       │
                       ├─ 创建 Run 记录
                       ├─ 保存 User 消息
                       │   到 DB ✓
                       └─ 返回 RunId

  [等待 SSE]                                Worker 启动
                                            │
                                            ├─ 加载 ImageRefs
                                            │   (从 COS 获取)
                                            │
                                            ├─ 构建 LLM 请求
                                            │   ├─ base64 in body
                                            │   └─ COS URLs in
                                            │      ImageReferences ←── 新增
                                            │
                                            ├─ Gateway.SendAsync()
                                            │   ├─ LlmRequestLog
                                            │   │   .ImageReferences ←── 新增
                                            │   └─ 调用 Provider
                                            │
                                            ├─ 上传结果到 COS
                                            │
                                            ├─ 保存 Assistant 消息
                                            │   到 DB ✓ ←──────────── 新增
                                            │
                                            └─ SSE: imageDone
                                                 + savedMessageId ←── 新增

  [收到 SSE]                                                     渲染 genDone:
                                                                  ├─ 参考图 64px ←── 新增
                                                                  └─ 生成图 full

  [刷新页面]    ───▶  loadMessages()
                       └─ 从 DB 加载                              渲染历史消息
                          全部消息 ✓                               完整显示 ✓
```

---

## 四、涉及文件清单

### 后端 (C#)

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `Core/Models/LlmRequestLog.cs` | 新增字段 | `ImageReferences` + `LlmImageReference` 类 |
| `Core/Interfaces/ILlmRequestLogWriter.cs` | 新增参数 | `LlmLogStart.ImageReferences` |
| `Infrastructure/LLM/LlmRequestLogWriter.cs` | 赋值 | 保存 ImageReferences 到日志 |
| `Infrastructure/LlmGateway/GatewayRequest.cs` | 新增字段 | `GatewayRequestContext.ImageReferences` |
| `Infrastructure/LlmGateway/LlmGateway.cs` | 透传 | WriteStartLogAsync 传递 ImageReferences |
| `Infrastructure/LLM/OpenAIImageClient.cs` | 构建 | 3 处构建 ImageReferences (Exchange/Vision/Multi) |
| `Api/Controllers/Api/ImageMasterController.cs` | 重构 | CreateRun 自动保存 User 消息 |
| `Api/Services/ImageGenRunWorker.cs` | 重构 | imageDone/imageError 自动保存 Assistant 消息 |

### 前端 (TypeScript)

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `types/admin.ts` | 新增类型 | `LlmImageReference` 接口 |
| `pages/LlmLogsPage.tsx` | 渲染逻辑 | 优先 imageReferences COS URL，降级 extractInline |
| `pages/ai-chat/AdvancedVisualAgentTab.tsx` | 渲染 + 持久化 | genDone 显示 refSrc；pushMsg 改为纯 UI |
| `services/contracts/visualAgent.ts` | 新增字段 | `userMessageContent` |

---

## 五、向后兼容

| 场景 | 处理方式 |
|------|----------|
| 旧 LLM 日志无 `imageReferences` | 前端降级到 `extractInlineImagesFromBody()` |
| 旧消息无 `refSrc` 字段 | genDone 渲染时 `refSrc` 为空则不显示参考图 |
| 前端旧版本不传 `userMessageContent` | Controller fallback 到 `prompt` 字段 |

---

## 六、设计原则遵循

- **服务器权威性** (CLAUDE.md)：消息由后端在处理流程中保存，不依赖前端异步调用
- **日志自包含** (CLAUDE.md)：ImageReferences 与日志一起存储，查询时无需二次解析
- **LLM Gateway 统一调用** (CLAUDE.md)：ImageReferences 通过 Gateway 标准流程传递
- **前端仅作观察者** (CLAUDE.md)：pushMsg 改为纯 UI 更新，不再负责消息持久化
