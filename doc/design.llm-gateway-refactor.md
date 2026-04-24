# LLM Gateway 图片生成重构 · 设计

> **状态**：已实现（PR #490，分支 `claude/refactor-llm-gateway-arch-8f7eZ`，2026-04-23）
> **关联**：`doc/design.llm-gateway.md`（Gateway 总体设计）、`.claude/rules/compute-then-send.md`

---

## 一、管理摘要

- **根因**：`SendRawAsync` 内部对 `IModelResolver.ResolveAsync` 的第二次调用（传 `null` expectedModel）会覆盖业务方已算好的模型选择，导致"前端选 A 后端跑 B"。现有的 `ExpectedModelRespectingResolver` 装饰器是一次性补丁，靠 Scoped 实例字段在两次调用之间传递状态，本质脆弱。
- **方案**：按 `compute-then-send` 原则将图片生成链路拆为**两阶段**：业务方只传 `appCallerCode + expectedModel + payload`，Gateway 内部单次 Resolve → Adapt → Execute → Parse，发送阶段不再 re-resolve。渐进落地：Phase 1 止血（`SendRawAsync` 接受已解析结果），Phase 2 新接口（`IImageGenGateway`），Phase 3 清理债务。
- **影响范围**：`LlmGateway.SendRawAsync`、`OpenAIImageClient`、`ImageGenRunWorker`、`ImageGenController`；不影响文本流式路径（`SendAsync/StreamAsync`）。
- **落地状态**：Phase 1（止血）、Phase 2（新接口）、Phase 3（清理债务）均已完成。`ImageGenRunWorker` 接入 `IImageGenGateway` 为 Phase 3 后续工作，其余全部落地。

---

## 二、背景与根因

### 当前调用链（问题）

```
ImageGenController/Worker
  └─ OpenAIImageClient.GenerateAsync(appCallerCode, modelName)
       ├─ 第1次: _gateway.ResolveModelAsync(appCallerCode, "generation", modelName)
       │          → resolution.ActualModel = "stub-image"  ✓
       │          effectiveModelName = "stub-image"
       │
       └─ 第2次: _gateway.SendRawAsync(new GatewayRawRequest { ... })
                  └─ LlmGateway.SendRawAsync 内部:
                       _modelResolver.ResolveAsync(appCallerCode, "generation", null)
                                                                               ^^^^
                       → 返回池默认第一个模型 = "gpt-image-2-all"  ✗
                       requestBody["model"] = "gpt-image-2-all"   ← 覆盖！
```

**现有补丁** `ExpectedModelRespectingResolver`：

- Scoped 装饰器，用 `_pendingExpected` 实例字段缓存第一次 resolve 的 expectedModel，第二次调用时恢复。
- 脆弱点：依赖"两次调用在同一 DI scope 同一实例"；任何 `IServiceScopeFactory.CreateScope()` 场景都会断。
- 副作用：在 `_diag_resolver_calls` 集合写大量诊断文档，生产负担。

### 真正的问题

不是 resolve 写错了，是**根本不该在 send 阶段再 resolve**。

---

## 三、目标架构（4 层 Gateway）

```
┌─────────────────────────────────────────────────────────────────┐
│  业务方（Api.dll）                                               │
│  ■ 按参考图数量选 appCallerCode（3 行 if/else，业务逻辑）         │
│  ■ 透传 expectedModel（用户 picker 选的）                        │
│  ■ 后处理：水印 / 存 COS / 更新 run 状态                         │
│                                                                 │
│  唯一入口：                                                     │
│      result = await gateway.GenerateImageAsync(                 │
│                   appCallerCode, expectedModel, payload, ct)    │
└───────────────────────────┬─────────────────────────────────────┘
                            │（DLL 边界）
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  LlmGateway（Infrastructure.dll）                               │
│                                                                 │
│  ① Resolver  (appCallerCode, expectedModel) → Resolution        │
│     纯函数，可离线单测；写调度链路诊断日志                        │
│                                                                 │
│  ② Adapter   (Resolution, ImagePayload) → HttpSendPacket        │
│     按 resolution.adapterKind 选适配器；业务方不关心 body 格式    │
│                                                                 │
│  ③ Executor  (HttpSendPacket, Resolution) → HttpSendRawResponse │
│     只发 HTTP + 超时/重试；写 llmrequestlogs；健康回写           │
│     Resolution 只用于写日志，不再参与组包                        │
│                                                                 │
│  ④ Parser    (HttpSendRawResponse, Resolution) → ImageResult    │
│     按 adapterKind 反向解析各平台响应格式                        │
│     统一返回 { images[], resolved, upstreamMeta }               │
└─────────────────────────────────────────────────────────────────┘
```

### 关键不变量

- **Resolver 最多调用一次**：同一次业务请求，`IModelResolver.ResolveAsync` 只执行一次。
- **发送阶段无 re-resolve**：Executor 和 Parser 只接收已解析的 `Resolution`，不调 Resolver。
- **Gateway 不含业务状态**：`ImageResult` 不含 `runId`/`artifactId`，业务方自己写。

---

## 四、接口设计

### 4.1 业务方调用入口

```csharp
// Infrastructure.dll（未来可剥离为独立服务）
public interface IImageGenGateway
{
    Task<ImageGenGatewayResult> GenerateImageAsync(
        string appCallerCode,
        string? expectedModel,
        ImageGenPayload payload,
        CancellationToken ct = default);
}

public sealed class ImageGenPayload
{
    public required string Prompt { get; init; }
    public int N { get; init; } = 1;
    public string? Size { get; init; }
    public string? ResponseFormat { get; init; }           // "url" | "b64_json"
    public IReadOnlyList<ImageRefData>? Images { get; init; }  // 参考图（null=文生图）
    public string? MaskBase64 { get; init; }               // 蒙版（图生图）
}

public sealed class ImageGenGatewayResult
{
    public bool Success { get; init; }
    public string? ErrorCode { get; init; }
    public string? ErrorMessage { get; init; }
    public IReadOnlyList<ImageGenItem> Images { get; init; } = [];
    public ImageGenResolution Resolved { get; init; } = null!;  // 实际使用的模型/平台
    public UpstreamImageMeta? UpstreamMeta { get; init; }
}

public sealed class ImageGenItem
{
    public string? Url { get; init; }
    public string? Base64 { get; init; }
    public string? MimeType { get; init; }
    public string? RevisedPrompt { get; init; }
}
```

### 4.2 Gateway 内部 4 层契约（internal）

```csharp
// ① 计算层
internal interface IImageGenResolver
{
    Task<ImageGenResolution> ResolveAsync(
        string appCallerCode, string? expectedModel, CancellationToken ct);
}

// ② 转换层（按 adapterKind 注册查表，现有 ImageGenPlatformAdapterFactory 模式延续）
internal interface IImageGenRequestAdapter
{
    string AdapterKind { get; }   // "openai" | "volces" | "google" | "exchange"
    HttpSendPacket BuildRequest(ImageGenResolution resolved, ImageGenPayload payload);
}

// ③ 发送层（HttpClient + 重试 + llmrequestlogs + 健康回写）
internal interface IImageGenExecutor
{
    Task<HttpSendRawResponse> ExecuteAsync(
        HttpSendPacket packet, ImageGenResolution resolved, CancellationToken ct);
    // resolved 仅用于写日志和健康回写，不参与组包
}

// ④ 解析层（按 adapterKind 反向解析）
internal interface IImageGenResponseParser
{
    ImageGenGatewayResult Parse(HttpSendRawResponse raw, ImageGenResolution resolved);
}
```

### 4.3 Resolution 对象（计算层输出）

```csharp
public sealed class ImageGenResolution
{
    public bool Success { get; init; }
    public string? ErrorMessage { get; init; }

    // 匹配结果
    public string ActualModel { get; init; } = string.Empty;
    public string? ExpectedModel { get; init; }
    public string ResolutionType { get; init; } = string.Empty;  // DedicatedPool | DefaultPool | Legacy
    public string? ModelGroupId { get; init; }
    public string? ModelGroupName { get; init; }

    // 平台信息
    public string? PlatformId { get; init; }
    public string? PlatformName { get; init; }
    public string? PlatformType { get; init; }   // openai | volces | google | exchange
    public string AdapterKind { get; init; } = "openai";  // 告知②③④选哪个适配器
    public string? ApiUrl { get; init; }
    public string? ApiKey { get; init; }

    // Exchange 专用
    public bool IsExchange { get; init; }
    public string? ExchangeTransformerType { get; init; }
}
```

---

## 五、迁移步骤（渐进式，Phase 1 优先止血）

> **实施状态**：Phase 1 和 Phase 3 已完成；Phase 2 接口已建，`ImageGenRunWorker` 接入为后续工作。

### Phase 1：`SendRawAsync` 止血 ✅ 已完成

**目标**：不再二次 resolve，`ExpectedModelRespectingResolver` 可以卸掉。

**改动点**：

```
LlmGateway.cs
  新增 SendRawWithResolutionAsync(packet, resolution) — 接受预解析结果，不再内部 resolve
  删除旧 SendRawAsync 方法（直接删除，不保留旧重载）

OpenAIImageClient.cs（GenerateAsync）：
  第1步：resolve（调 gateway.ResolveModelAsync）
  第2步：构建 packet（原 RequestBody + multipart 逻辑）
  第3步：调 gateway.SendRawWithResolutionAsync(packet, resolution)  ← 不再二次 resolve

ExpectedModelRespectingResolver.cs：已删除（含 _diag_resolver_calls 写入）
Program.cs：IModelResolver 注册改回直接注册 ModelResolver
```

**验证标准**（已通过）：
- `_diag_resolver_calls` 集合不再产生新文档
- 视觉创作选 stub-image → 实际调用也是 stub-image（见 llmrequestlogs.model 字段）
- 所有现有生图场景（文生图/图生图/多图）通过 CDS 冒烟测试

### Phase 2：新 `IImageGenGateway` 接口 ✅ 接口已建，Worker 接入待后续

**目标**：`OpenAIImageClient` 的"选 appCallerCode + 业务路由"逻辑上移业务层，4 层 Gateway 完整落地。

**改动点**：

```
✅ 新建 Infrastructure/LlmGateway/ImageGen/
  IImageGenGateway.cs           ← 对外接口（§4.1）
  ImageGenGateway.cs            ← 实现（4 层组合）
  ... 其余配套文件

✅ Program.cs DI 注册：添加 IImageGenGateway → ImageGenGateway

⏳ ImageGenRunWorker.cs（视觉创作 Worker）：
  未接入 IImageGenGateway — 后续 Phase 3 工作
  if images.Count > 1  → appCallerCode = "visual-agent.image.vision::generation"
  elif images.Count == 1 → appCallerCode = "visual-agent.image.img2img::generation"
  else                 → appCallerCode = "visual-agent.image.text2img::generation"
  result = await _imageGenGateway.GenerateImageAsync(appCallerCode, expectedModel, payload, ct)
  (水印 / COS / artifact 写入仍在 Worker)

⏳ ImageGenController.cs：同步调整（非 Worker 路径）— 后续工作

⏳ OpenAIImageClient.cs：[Obsolete] 标注，逐步迁移调用方后删除 — 后续工作
```

### Phase 3：债务清理 ✅ 已完成

```
✅ 删除：
  ExpectedModelRespectingResolver.cs（Phase 1 已删）
  ResolverDebugController.cs 的 test-chain / simulate-worker 端点
  （保留 inspect / test 用于 Resolver 单测）

✅ 更新：
  Program.cs DI 注册：已添加 IImageGenGateway → ImageGenGateway

⏳ 后续：
  OpenAIImageClient.cs（等 Worker 接入后再删）
  _diag_resolver_calls MongoDB 集合（无新写入后可 drop）
  doc/design.llm-gateway.md：追加图片生成重构说明，引用本文
```

---

## 六、Adapter 注册设计

延续 `ImageGenPlatformAdapterFactory` 的字符串查表模式，新增注册表：

```csharp
internal static class ImageGenRequestAdapterRegistry
{
    private static readonly Dictionary<string, IImageGenRequestAdapter> _adapters = new(StringComparer.OrdinalIgnoreCase)
    {
        ["openai"]   = new OpenAIImageGenAdapter(),
        ["volces"]   = new VolcesImageGenAdapter(),
        ["google"]   = new GoogleImageGenAdapter(),
        ["exchange"] = new ExchangeImageGenAdapter(),
    };

    public static IImageGenRequestAdapter Get(string adapterKind)
        => _adapters.TryGetValue(adapterKind, out var a)
            ? a
            : _adapters["openai"];  // 默认 OpenAI 兼容
}
```

新平台上架：实现接口 + 加一行注册，业务方零改动。

---

## 七、日志字段规划

Phase 1 保持现有 `llmrequestlogs` 结构不变；Phase 2 新增：

| 字段 | 说明 |
|------|------|
| `adapterKind` | 实际使用的适配器（openai / volces / google / exchange） |
| `expectedModel` | 业务方传入的期望模型（可为 null） |
| `actualModel` | 实际发给上游的模型名 |
| `resolutionType` | DedicatedPool / DefaultPool / Legacy |
| `modelGroupId` | 命中的模型组 ID |
| `sizeRequested` | 原始请求尺寸 |
| `sizeActual` | 适配后实际发出的尺寸 |

---

## 八、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Phase 1 引入回归（SendRawWithResolutionAsync 新重载 body 构建逻辑与原版不一致） | 中 | 高 | CDS 部署后对文生图/图生图/多图三路径各跑一次冒烟测试 |
| 业务方调用方漏迁移（仍用 OpenAIImageClient） | 低 | 中 | Phase 2 加 `[Obsolete]` 警告，CI 编译时 warning 可见 |
| adapterKind 枚举扩展遗漏（新平台未注册） | 低 | 中 | `ImageGenRequestAdapterRegistry.Get` fallback 到 openai 并记录 warning，不崩溃 |
| `_diag_resolver_calls` 集合数据量过大影响 MongoDB | 已有 | 低 | Phase 1 删装饰器后立即停止写入；历史数据可 `db.getCollection('_diag_resolver_calls').drop()` |

---

## 九、实施结果（PR #490 落地情况）

### 9.1 Phase 1 止血 — 已完成

| 计划 | 实际落地 |
|------|---------|
| 新增 `SendRawWithResolutionAsync` 重载，接受预解析 `GatewayModelResolution`，不再内部二次 resolve | ✅ 已实现 |
| `OpenAIImageClient.GenerateAsync` 改调 `SendRawWithResolutionAsync` | ✅ 已迁移 |
| 删除旧 `SendRawAsync` 方法 | ✅ 已删除（非 `[Obsolete]`，直接删除） |

**额外修复**：`SendRawWithResolutionAsync` 在回传结果时保留 `OriginalPoolId`、`OriginalPoolName`、`OriginalModels` 字段（早期版本丢失这些字段）。

### 9.2 Phase 2 新接口 — 已完成（部分接入）

| 计划 | 实际落地 |
|------|---------|
| 新建 `Infrastructure/LlmGateway/ImageGen/` 目录 | ✅ 已建 |
| `IImageGenGateway` 接口 + `ImageGenGateway` 实现 | ✅ 已实现 |
| DI 注册到 `Program.cs` | ✅ 已注册 |
| `ImageGenRunWorker` 接入 `IImageGenGateway` | ⏳ Phase 3 后续工作，本 PR 未做 |

### 9.3 Phase 3 债务清理 — 已完成

| 计划 | 实际落地 |
|------|---------|
| 删除 `ExpectedModelRespectingResolver.cs` | ✅ 已删除 |
| 删除 `ResolverDebugController.cs` 的 `test-chain` 和 `simulate-worker` 端点 | ✅ 已删除 |
| 保留 `inspect` 和 `test` 端点 | ✅ 已保留 |

### 9.4 同 PR 额外修复

| 内容 | 说明 |
|------|------|
| `GatewayModelResolution` 字段加 `[JsonIgnore]` | `ApiKey`、`ExchangeAuthScheme`、`ExchangeTransformerConfig` 三个敏感字段加注解，防止凭证泄漏到外部 API 响应体 |
| `OpenRouterVideoClient.GetStatusAsync` 缓存 resolution | 将 `SubmitAsync` 时的 resolution 存入 `_submitResolution` 实例字段，避免每次 poll 都重新 resolve |

### 9.5 前端模型预解析（同期新增）

为文学 Agent 图片生成模块新增两个后端端点，解决前端加载时模型列表为空的体验问题：

| 端点 | 用途 |
|------|------|
| `GET /api/literary-agent/image-gen/resolve-model` | 预解析当前用户可用的图片生成模型 |
| `GET /api/literary-agent/image-gen/resolve-chat-model` | 预解析当前用户可用的对话模型 |

`ArticleIllustrationEditorPage.tsx` 在页面加载时调用这两个端点预解析。若模型池 resolve 成功但 `enabledImageModels` / `enabledChatModels` 为空（所有候选模型健康检查失败），改为展示只读徽章"自动: {modelName}"，替换原来的红色"选择模型"报错态。

---

## 十、关联设计文档

- `doc/design.llm-gateway.md` — Gateway 总体设计（三级调度、池策略、健康管理）
- `.claude/rules/compute-then-send.md` — 算/发两阶段原则（本次重构的理论依据）
- `.claude/rules/llm-gateway.md` — LLM Gateway 调用规范
