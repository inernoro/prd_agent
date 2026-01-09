namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 生成文章配图标记请求
/// </summary>
public record GenerateArticleMarkersRequest(
    string ArticleContent,
    string? UserInstruction,
    string? IdempotencyKey
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
}
