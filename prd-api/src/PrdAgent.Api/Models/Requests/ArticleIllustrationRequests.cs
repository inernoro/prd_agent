namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 生成文章配图标记请求
/// </summary>
public record GenerateArticleMarkersRequest(
    string ArticleContent,
    string? UserInstruction,
    string? IdempotencyKey,
    /// <summary>
    /// 插入模式："legacy" = LLM 返回完整文章（默认，向后兼容），"anchor" = LLM 只返回锚点插入指令
    /// </summary>
    string? InsertionMode
);

/// <summary>
/// 提取文章配图标记请求
/// </summary>
public record ExtractArticleMarkersRequest(
    string ArticleContentWithMarkers
);

/// <summary>
/// 导出文章请求
/// </summary>
public record ExportArticleRequest(
    bool UseCdn,
    string? ExportFormat
);

/// <summary>
/// 更新单条 Marker 状态请求
/// </summary>
public class UpdateMarkerRequest
{
    public string? DraftText { get; set; }
    public string? Status { get; set; }
    public string? RunId { get; set; }
    public string? ErrorMessage { get; set; }
    public string? Url { get; set; }  // 图片 URL（用于刷新后恢复显示）
    public UpdateMarkerPlanItem? PlanItem { get; set; }  // 意图解析结果
}

/// <summary>
/// 意图解析结果（用于 UpdateMarkerRequest）
/// </summary>
public class UpdateMarkerPlanItem
{
    public string Prompt { get; set; } = string.Empty;
    public int Count { get; set; } = 1;
    public string? Size { get; set; }
}
