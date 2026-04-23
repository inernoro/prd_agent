---
name: llm-call-trace
description: 排查大模型调用链路问题的方法论。当出现"前端选 A 后端跑 B"、"LLM 日志 model 字段不对"、"自定义模型调度被忽略"类 bug 时触发。强制走"捕获前端真实请求 → DB 真实状态 → 每层 resolve 调用审计 → 对比 LLM 日志实际 body.model"的顺序，禁止靠 DI 装饰器/AsyncLocal 打补丁。触发词："/llm-trace", "模型调用不对", "LLM 日志不符", "选 A 给 B", "trace model".
---

# LLM Call Trace — 大模型调用链路排查

当用户报告"模型被换了"、"前端选 X 但日志显示 Y"、"自定义模型调度不生效"类 bug，**必须**按本 skill 顺序执行，禁止凭直觉加补丁。

---

## 核心原则（这次血泪来的）

1. **不看装饰器，看 LLM 日志的 `Model` 字段** —— 这是真实上游 body.model，是验证的终极 ground truth。
2. **前端请求 body 从 `apirequestlogs` 集合读**，不要猜。
3. **"多次 resolve 互相覆盖"才是真正问题**，不是哪一次 resolve 写错了。
4. **禁止用 DI 装饰器 / AsyncLocal / 实例字段 跨兄弟调用传递 state**。这是补丁，不是修复（见 `.claude/rules/compute-then-send.md`）。

---

## 触发条件

- 用户说 "/llm-trace"、"模型调用不对"、"LLM 日志不符"、"选 A 给 B"
- 业务截图/日志显示"用户期望模型"和"LLM 日志 Model 字段"不一致
- 涉及 `IModelResolver` / `ILlmGateway.SendRawAsync` / `ILlmGateway.SendStreamAsync` / `OpenAIImageClient` 等路径

---

## 强制执行顺序（缺一步都会走弯路）

### Step 1. 冻结现场：记下"前端声称选了什么、LLM 日志记了什么"

从截图/日志抓：
- 前端 UI 显示的"用户期望"（通常是 picker 选的 model 名）
- LLM 调用日志页面的 `Model` 列 + `专属模型池` 列
- `requestId` 前 8 位

**不要急着修代码**。写在笔记里：`期望=X, 实际=Y, requestId=xxx`。

### Step 2. 读前端发送的**真实请求 body**（不是猜的）

用 MongoDB / CDS 查 `apirequestlogs` 集合：

```javascript
db.apirequestlogs.find({
  Path: /image-gen.runs$/
}).sort({StartedAt: -1}).limit(5)
```

重点看 body JSON 里的字段：
- `modelId` / `configModelId` / `platformId` ← 前端实际发了什么？
- `userMessageContent` 里的 `(@model:xxx)` token ← 仅展示用，不影响后端

**判断**：如果前端发的 `modelId` 就是错的，那是前端 bug；如果前端发对了，问题在后端。

### Step 3. 读 `image_gen_runs` / 等价 run 记录在 DB 里的真实状态

```javascript
db.image_gen_runs.find({WorkspaceId: "xxx"})
  .sort({CreatedAt: -1}).limit(3)
```

关注 `ModelId`、`PlatformId`、`ModelResolutionType`、`ModelGroupName`。

判断：
- `run.ModelId == 前端发送的 modelId` → Controller 层无覆盖
- `run.ModelId != 前端发送的 modelId` → Controller 或 Worker 某处覆盖了，找修改点
- `ModelResolutionType=2 (DedicatedPool)` 且 `ModelId` 被改 → Worker `ResolveModelGroupAsync` 覆盖
- `ModelResolutionType=0 (DirectModel)` 但 LLM 日志里 Model 被改 → **问题在下游 SendRawAsync / SendStreamAsync 的二次 resolve**（这次血泪的根因）

### Step 4. 审计 resolve 调用次数

全文 grep：
```bash
grep -rn "_modelResolver.ResolveAsync\|_gateway.ResolveModelAsync\|IModelResolver.*ResolveAsync" prd-api/src/
```

对每条调用链（Controller → Worker → Client → Gateway → upstream HTTP），数一下"同一逻辑请求中 resolve 被调几次"：
- **== 1 次**：✓ 符合 `compute-then-send.md` 规则
- **>= 2 次**：✗ **根因在这里**。不要去给第二次、第三次打补丁，而是合并成一次

### Step 5. 在独立端点里验证匹配算法本身对不对（离线、可重复）

本仓库已有的调试端点（位于 `prd-api/src/PrdAgent.Api/Controllers/Api/ResolverDebugController.cs`）：

```bash
# 查 AppCaller 绑定池
curl -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "$BASE/api/debug/resolver/inspect?appCallerCode=visual-agent.image.text2img::generation"

# 单次 Tier 匹配测试
curl -H "X-AI-Access-Key: $AI_ACCESS_KEY" -H "Content-Type: application/json" \
  -X POST "$BASE/api/debug/resolver/test" \
  -d '{"appCallerCode":"...","expectedModel":"stub-image"}'
```

**如果 `/test` 返回的 `actualModel` 是对的，但真实请求的 LLM 日志 `Model` 还是错的 → 100% 是下游二次 resolve 覆盖了**。

### Step 6. 判定根因类型（对号入座）

| 症状 | 根因 | 不要做 | 要做 |
|------|------|------|------|
| run.ModelId 就错了 | Controller/Worker 覆盖 | 不要在 OpenAIImageClient 层拦截 | 修 Controller/Worker 的覆盖点 |
| run.ModelId 对但 LLM 日志错 | 下游 SendRawAsync 二次 resolve | 不要加 DI 装饰器、AsyncLocal 等补丁 | 把 send 函数改为接收已 resolve 结果 |
| Tier 匹配本身错 | `FindPreferredModel` 逻辑或数据问题 | 不要加归一化匹配兜底 | 修 `FindPreferredModel` / 修 DB 里 pool.Code |
| Unavailable 池被跳过换了另一个 | scheduler 的健康降级 | 不要偷偷换 | 返回失败让前端询问用户（参考 smart fallback 开关）|

### Step 7. 单元测试前置（修完以后）

```csharp
// 验证 resolve 计算层
[Fact]
public async Task ResolveAsync_ExpectedModel_Hits_Tier3_When_Pool_Code_Matches()
{
    var resolver = new ModelResolver(mockDb, mockConfig, mockLogger);
    var result = await resolver.ResolveAsync("visual-agent.image.text2img::generation", "generation", "gpt-image-1-5");
    Assert.Equal("gpt-image-1.5", result.ActualModel);
}

// 验证 send 层不会再次 resolve
[Fact]
public async Task SendAsync_DoesNotCallResolver()
{
    var mockResolver = new Mock<IModelResolver>();
    var sender = new ImageGenSender(mockHttp, ...);
    await sender.SendAsync(preResolved, body, CancellationToken.None);
    mockResolver.Verify(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()),
        Times.Never);  // ← 发送函数不能内部 resolve
}
```

**上线前必须有这两类单测**。没有就说明你还是走在"打补丁"的老路上。

---

## 反面案例（本 skill 的来源）

2026-04-23 "选 stub-image 给 gpt-image-2-all" bug，花一整天、8 轮修复，**其中 5 轮 (Round 1-5) 完全无效**（CDS 部署层缓存 + 改错层），剩余 3 轮（Round 6-8）都是"给内部二次 resolve 打补丁"的 DI 装饰器方案。

全部走错的真正原因：**没有先按本 skill 的 Step 1-4 顺序追根因，而是凭直觉在猜**。一旦按 Step 4 审计到"SendRawAsync 内部 Line 561 的硬编码 null 二次 resolve"，修复方向就清楚了——不是加补丁，是消除第二次 resolve。

---

## 一句话总结

> **别靠补丁在 state 传递上较劲。分两阶段写代码（算一次 + 发一次），从源头避免"互相覆盖"。**

详细规则 → `.claude/rules/compute-then-send.md`

---

## 相关

- `.claude/rules/compute-then-send.md` — 强制规则
- `prd-api/src/PrdAgent.Api/Controllers/Api/ResolverDebugController.cs` — inspect / test 两个调试端点（test-chain / simulate-worker / trigger-real-gen 是反模式时代的产物，等重构完成后删除）
- `.claude/skills/deep-trace` — 跨层数据流追踪，本 skill 专注 LLM 调用链的子集
