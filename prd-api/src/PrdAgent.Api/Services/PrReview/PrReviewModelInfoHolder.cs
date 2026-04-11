namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// 服务层 → Controller 的模型信息传递载体。
///
/// 为什么用 holder 而不是返回值/out 参数：
/// 服务层的核心方法是 IAsyncEnumerable&lt;string&gt;（yield return），
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
