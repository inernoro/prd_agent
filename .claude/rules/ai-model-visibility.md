# AI 模型可见性原则

中大型专门使用大模型的功能，**必须**在 UI 最顶部展示当前正在调用的模型名称。

## 强制规则

1. **必须可见**：独立 AI 面板 / 长对话窗口 / 生图生视频主流程 / AI 评审打分 → 顶部显示 `{模型名} · {平台}`
2. **数据后端来源**：从 `GatewayStreamChunk.Start.Resolution` 捕获，**禁止前端硬编码**
3. **流式实时**：`Start` chunk 带的模型信息必须立即推给前端，不要等流结束
4. **存库字段**：AI 报告实体（如 `AlignmentReport`/`SummaryReport`）的 `Model` 字段必须填充
5. **豁免清单**：意图识别、模型池健康探针、内部 orchestration、一次性枚举翻译

## 判断标准

**用户会因"换了个模型"感知到结果差异 → 必须显示模型名**

## 实现要点

Service 层捕获 `Start` chunk 的 `Resolution`：

```csharp
if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
{
    // 通过 SSE model 事件推送，或存入服务层变量后最终落 Report.Model
}
```

Controller SSE 协议新增 `model` 事件：
```
event: model
data: { "model": "anthropic/claude-sonnet-4-6", "platform": "OpenRouter" }
```

前端在面板顶部以低饱和度字体展示：
```tsx
<div className="text-[11px] text-white/40 font-mono">
  ● {model} · {platform}
</div>
```

> 详细：`doc/rule.ai-model-visibility.md`
