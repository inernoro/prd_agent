---
globs: ["prd-api/src/**/*.cs"]
---

# 外部调用必须分"算/发"两阶段（Compute-then-Send）

外部调用（LLM / 图片生成 / 视频生成 / 第三方 API）必须把**计算阶段**（决定用哪个模型、哪个平台、哪条 URL）和**发送阶段**（真正发 HTTP 并处理响应）拆成两个独立步骤。**发送阶段不得在内部"再算一次"**。

---

## 为什么（整日排查的血泪）

2026-04-23 视觉创作"选 A 给 B"bug 排查一整天的根因：

```
调用链                              结果
┌─────────────────────────────────────────────────────────────────┐
│ Controller: run.ModelId = "stub-image" (用户选的)                │
│      ↓                                                           │
│ Worker → OpenAIImageClient.GenerateAsync                         │
│   第1次: gateway.ResolveModelAsync(..., modelName="stub-image")  │
│          → 返回 stub-image ✓                                     │
│          effectiveModelName = "stub-image"                       │
│          reqBody.model = "stub-image" ✓                          │
│      ↓                                                           │
│   调 gateway.SendRawAsync(req)                                   │
│      ↓                                                           │
│     【LlmGateway.SendRawAsync 内部第2次 Resolve】                 │
│   第2次: _modelResolver.ResolveAsync(..., null) ← 硬编码 null    │
│          → 返回第一个池的模型 = "gpt-image-2-all"                │
│      ↓                                                           │
│     requestBody["model"] = resolution.ActualModel  ← 覆盖！       │
│          实际上游 body.model = "gpt-image-2-all" ✗               │
└─────────────────────────────────────────────────────────────────┘
```

**同一个"选模型"的逻辑跑了两次，第二次把第一次的结果覆盖了**。为打这个补丁，花了一天试了 8 轮修复（Round 1-5 改 Infrastructure 不生效 → Round 6 Controller 预设 DirectModel → Round 7 DI 装饰器拦截第 1 次 → Round 8 AsyncLocal/实例字段尝试跨"兄弟 await"共享 expectedModel 给第 2 次），全都是在绕这个"内部二次 resolve"。

**真正的问题不是 resolve 写错了，是根本不该在 send 阶段再 resolve**。

---

## 强制规则

### 1. 发送阶段接收"已解析结果"，不得再调 resolver

**❌ 错误写法**（当前 `LlmGateway.SendRawAsync`）

```csharp
public async Task<GatewayRawResponse> SendRawAsync(GatewayRawRequest request, CancellationToken ct)
{
    // ⚠ 违反分层：在发送阶段又调了一次 resolve
    var resolution = await _modelResolver.ResolveAsync(
        request.AppCallerCode, request.ModelType, null, ct);

    requestBody["model"] = resolution.ActualModel;  // 覆盖调用方已算好的
    ...
}
```

**✅ 正确写法**

```csharp
// 计算阶段：独立，纯函数，可测
var resolved = await _modelResolver.ResolveAsync(
    appCallerCode, modelType, expectedModel: userPicked, ct);

// 发送阶段：只接收已解析结果，不再查任何东西
var response = await _gateway.SendWithResolvedAsync(new GatewayRawRequest
{
    Resolved = resolved,      // ← 已算好，直接用
    RequestBody = body,
    ...
}, ct);
```

### 2. 签名里带 "expectedModel" / "modelName" 的函数禁止再做模型选择

如果函数签名已经有 `modelName` 参数（= 调用方明确指定要用的模型），**不得**在内部调 `ResolveModelAsync`、`SelectBestModel`、"池默认选择"等逻辑。调用方传了就直接用，最多做"healthy 探活 + 查平台 API URL"。

**适用方法**：`OpenAIImageClient.GenerateAsync(..., modelName)` / `LlmGateway.SendStreamAsync` / 任何名字里出现 `modelName` / `model` / `modelId` 的下游发送函数。

### 3. 同一次 HTTP/业务请求，resolver 最多被调用一次

用 scope 级 DI 或 `LlmRequestContext` 里的字段记录"本次请求的解析结果"。之后所有读取都从这个已缓存的结果拿，不重复解析。

**判断准则**：如果某条调用链里 `IModelResolver.ResolveAsync` 会被调两次以上，立即重构 —— 要么合并，要么把第二次改成"读缓存"。

### 4. 禁止用 DI 装饰器 / AsyncLocal / 实例字段 "跨兄弟调用"传递状态

这些都是在"内部二次 resolve"这个反模式上打补丁，**越补越脆**：
- DI 装饰器：每次 DI 改动都可能绕过
- AsyncLocal：ExecutionContext 在 await 前 capture，被调用方写入不会回传给调用方的 continuation（兄弟调用场景直接失效）
- Scoped 实例字段：依赖 "两次调用在同一 scope 内命中同一实例"，遇到 `_scopeFactory.CreateScope()` 新建 scope / Transient 服务就断

**正确的做法不是"让兄弟调用看见彼此的 state"，而是"让发送阶段只接收参数，压根不需要 state"**。

### 5. 所有外部调用类必须暴露"纯计算"入口供单元测试

```csharp
public interface IImageGenResolver         // 纯计算，可在单测 mock DB
{
    Task<ImageGenResolution> ResolveAsync(ImageGenRequest req, CancellationToken ct);
}

public interface IImageGenSender            // 只发 HTTP，参数全从 Resolution 取
{
    Task<ImageGenResponse> SendAsync(ImageGenResolution resolved, ImageGenRequestBody body, CancellationToken ct);
}
```

上层业务：
```csharp
var resolved = await resolver.ResolveAsync(req, ct);
if (resolved.NeedsUserConfirmation) { /* 弹窗询问 */ return; }
var resp = await sender.SendAsync(resolved, body, ct);
```

测试：
- `ResolveAsync` 单测：mock `MongoDbContext`，断言 Tier1/2/3 匹配、Unavailable 降级等逻辑
- `SendAsync` 单测：mock `HttpClient`，断言 URL / headers / body.model 字段
- 彻底脱钩，不需要跑 Docker/CDS 就能验证整个调度

---

## 审计清单（改 `LlmGateway.SendRawAsync` / `OpenAIImageClient.GenerateAsync` / 新加 LLM 调用类时）

- [ ] 同一逻辑请求中，`IModelResolver.ResolveAsync` 只被调一次
- [ ] 如果函数签名有 `modelName` / `expectedModel`，函数内不得再 resolve
- [ ] 发送阶段拿到的 `model` / `platformId` / `apiUrl` 全部来自一个 `Resolution` 对象
- [ ] 有纯"计算"入口（不发 HTTP、不写 DB 业务状态）可供单测
- [ ] 没有用 DI 装饰器 / AsyncLocal / 实例字段 跨调用链传递 expectedModel

---

## 当前仓库的债务（✅ 全部偿还，2026-04-23）

| 文件 | 债务 | 状态 |
|------|------|------|
| `LlmGateway.cs` SendRawAsync | 内部二次 `ResolveAsync(..., null)` 覆盖 body.model | ✅ 已删除旧方法，新增 `SendRawWithResolutionAsync` |
| `OpenAIImageClient.cs` GenerateAsync | 先 resolve 再调 SendRawAsync 被二次 resolve | ✅ 改用 `SendRawWithResolutionAsync`，单次 resolve |
| `ExpectedModelRespectingResolver.cs` | 整个文件是二次 resolve 反模式的补丁 | ✅ 文件已删除 |
| `ResolverDebugController.cs` test-chain / simulate-worker | 这两个端点因反模式而存在 | ✅ 端点已删除，仅保留 inspect / test |

---

## 相关

- `.claude/skills/llm-call-trace/SKILL.md` — 大模型调用链路排查 skill（从这次的血泪经验总结）
- 对应详细设计：`doc/design.compute-then-send.md`（待补）
