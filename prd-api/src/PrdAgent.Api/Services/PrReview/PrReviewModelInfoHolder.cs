namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// 服务层 → Controller 的模型信息传递载体。
///
/// 为什么用 holder 而不是返回值/out 参数：
/// 服务层的核心方法是 IAsyncEnumerable&lt;LlmStreamDelta&gt;（yield return），
/// 不支持 out 参数，也不能返回元组。用共享 holder 让 Controller 在
/// 每次 yield 之后都能读到最新的 modelInfo.Captured，及时推 SSE model 事件。
///
/// Controller 持有 holder 引用 → Service 捕获到 Start chunk 后写入 →
/// Controller 在下一次 yield 时检查 Captured 标志 → 推 SSE model 事件 →
/// 重置 Captured（或不重置都行，因为 Start chunk 只来一次）。
/// </summary>
public sealed class PrReviewModelInfoHolder
{
    /// <summary>Gateway 调度到的实际模型 ID（如 anthropic/claude-sonnet-4-6）</summary>
    public string? Model { get; set; }

    /// <summary>平台显示名（如 OpenRouter / 硅基流动）</summary>
    public string? Platform { get; set; }

    /// <summary>模型池名称（若走模型池路由）</summary>
    public string? ModelGroupName { get; set; }

    /// <summary>
    /// 是否已捕获到模型信息。Controller 在 yield 间检查此标志决定是否推送 SSE model 事件；
    /// 推送后建议置回 false 避免重复推送。
    /// </summary>
    public bool Captured { get; set; }
}

/// <summary>
/// 服务层 yield 出来的流式增量：可能是正文文本，也可能是推理模型的思考过程。
///
/// 为什么要区分：
/// qwen-thinking / deepseek-r1 等推理模型会先输出 reasoning_content（思考），
/// 再输出正式的 answer。如果只接收 Text chunk，会把几十秒的思考当成"空白等待"——
/// 真正的 bug 根源就是这个遗漏。区分后：
/// - Thinking：Controller 推 SSE thinking 事件，前端展示在折叠面板里
/// - Text：Controller 推 SSE typing 事件，累积进 fullMd 作为最终正文
///
/// IsThinking = true 时，Content 是思考碎片（不计入 fullMd）。
/// IsThinking = false 时，Content 是正式输出（计入 fullMd）。
/// </summary>
public readonly record struct LlmStreamDelta(bool IsThinking, string Content);

