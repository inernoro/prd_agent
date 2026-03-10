namespace PrdAgent.Core.Interfaces;

/// <summary>
/// URL 解析服务 — 解析短视频/文章/图片链接，提取标题、封面、作者等元数据
/// </summary>
public interface IUrlParserService
{
    /// <summary>
    /// 解析 URL，提取元数据
    /// </summary>
    Task<UrlParseResult> ParseAsync(string url, CancellationToken ct = default);

    /// <summary>
    /// 判断是否为已知平台的 URL
    /// </summary>
    bool IsKnownPlatform(string url);
}

/// <summary>
/// URL 解析结果
/// </summary>
public class UrlParseResult
{
    /// <summary>是否解析成功</summary>
    public bool Success { get; set; }

    /// <summary>原始 URL</summary>
    public string SourceUrl { get; set; } = string.Empty;

    /// <summary>解析后真实 URL（短链跳转后的目标）</summary>
    public string? ResolvedUrl { get; set; }

    /// <summary>内容类型：video / article / image / link</summary>
    public string ContentType { get; set; } = "link";

    /// <summary>来源平台：douyin / kuaishou / bilibili / xiaohongshu / wechat / other</summary>
    public string Platform { get; set; } = "other";

    /// <summary>标题</summary>
    public string? Title { get; set; }

    /// <summary>描述/摘要</summary>
    public string? Description { get; set; }

    /// <summary>封面图 URL</summary>
    public string? CoverUrl { get; set; }

    /// <summary>视频直链（如果能获取）</summary>
    public string? VideoUrl { get; set; }

    /// <summary>作者</summary>
    public string? Author { get; set; }

    /// <summary>额外元数据</summary>
    public Dictionary<string, string> Metadata { get; set; } = new();

    /// <summary>错误信息（解析失败时）</summary>
    public string? Error { get; set; }

    public static UrlParseResult Fail(string sourceUrl, string error) => new()
    {
        Success = false,
        SourceUrl = sourceUrl,
        Error = error
    };
}
