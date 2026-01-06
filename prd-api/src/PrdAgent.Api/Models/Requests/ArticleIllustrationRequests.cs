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

