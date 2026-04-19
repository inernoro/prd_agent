# AI 模型可见性原则 · 规则

中大型专门使用大模型的功能，**必须**在 UI 最顶部展示当前正在调用的模型名称，让用户一眼看到"AI 在用什么模型为我服务"。

## 规则

1. **模型名必须可见**：任何面向用户的 AI 功能区块，顶部必须展示 `{模型名} · {平台}` 或类似的标识
2. **数据来源**：必须由后端提供（从 `GatewayStreamChunk.Start.Resolution` 或存档的 `AlignmentReport.Model` 字段），禁止前端硬编码"默认模型名"
3. **实时性**：流式调用时，`Start` 事件带回的模型名必须立即渲染出来，不要等流结束
4. **可溯源**：点击模型名可跳转到该次调用的日志详情（可选，作为 V2 增强）

## 为什么

- **避免隐瞒调度**：LLM Gateway 会根据模型池、健康状态、降权规则把一个逻辑 AppCallerCode 映射到多个实际模型。用户无法知道"我点的这个 AI 功能背后跑的是 Claude Sonnet 4.6 还是 DeepSeek V3.1"，这会让**调试、成本归因、模型回滚**都变成盲盒
- **信任建立**：告诉用户"你正在使用 anthropic/claude-sonnet-4-6"本身就是一种价值——让用户知道你没有偷偷用便宜模型糊弄
- **Debug 能力**：用户报 bug 时可以截图告诉你"我看到的是 X 模型"，省去对照日志的工作

## 适用范围

| 必须遵守 | 可以豁免 |
|---|---|
| 独立 AI 面板（如 PR 摘要 / 对齐检查 / 方案评审 / 缺陷打分） | 意图识别等"辅助"调用（用户看不见结果的）|
| 长对话窗口（PRD Agent / Visual Agent Drawing Board） | 模型池健康探针 |
| 生图生视频主流程 | 内部 orchestration 路由 |
| 周报生成 / 缺陷自动修复等需要审查质量的动作 | 一次性枚举翻译 |

判断标准：**用户会因为"换了个模型"而感知到结果差异** → 必须显示模型名。

## 实现参考

### 后端（LlmGateway 已原生支持）

`GatewayStreamChunk.Start` 类型的 chunk 包含 `Resolution: GatewayModelResolution`，其中有：
- `ActualModel`（实际模型 ID）
- `ActualPlatformName`（平台显示名）
- `ModelGroupName`（若走模型池）

Service 层应把这些字段从 stream 中捕获并**通过 SSE 的 `phase` 或 `model-info` 事件**回传给前端：

```csharp
await foreach (var chunk in _gateway.StreamAsync(req, CancellationToken.None))
{
    if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
    {
        // 立即推送模型信息给前端
        yield return new { type = "model", model = chunk.Resolution.ActualModel, platform = chunk.Resolution.ActualPlatformName };
        continue;
    }
    // ...
}
```

Service 层若不走 SSE（`SendAsync` 同步调用），应在返回值里带 `Resolution` 字段。

### 前端（展示样式参考）

```tsx
<div className="flex items-center gap-1.5 text-[11px] text-white/40">
  <CircleDot size={10} className="text-violet-400" />
  <span className="font-mono">{model}</span>
  {platform && <span>· {platform}</span>}
</div>
```

最小要求：**顶部区域一行、字号小、颜色弱**，不喧宾夺主，但用户扫一眼能看到。

### 存库字段

已有 AI 报告类型（`SummaryReport`/`AlignmentReport`/类似）必须有 `Model` 字段并**实际填充**。目前 V1 多处留空为 TODO，后续迭代必须修掉。

## 反例

| 错误 | 问题 |
|---|---|
| 前端硬编码 `"claude-sonnet-4-6"` 字符串 | Gateway 调度到别的模型时用户被误导 |
| 只在 debug 面板展示，正常用户看不到 | 生产环境用户看不到 = 没展示 |
| 存库用显示名而不是模型 ID | 换显示名时历史记录全废 |
| SSE 结束后才推送模型信息 | 用户已经看到结果才知道是什么模型 → 晚了 |

## 关联

- LLM Gateway 接口：`prd-api/src/PrdAgent.Infrastructure/LlmGateway/ILlmGateway.cs`
- 模型调度日志：`doc/design.llm-gateway.md`
- 原则补充：与 `rule.llm-visibility.md`（流式可见性）+ `rule.llm-gateway.md`（调用统一）互补，三位一体保证"用户永远知道 AI 在干什么 / 用什么干"
