namespace PrdAgent.Core.Models;

/// <summary>
/// 托管站点入口 HTML 的不可变版本。
///
/// 首期只版本化入口 HTML；ZIP 内的 CSS、图片等资源仍保留在原站点目录中。
/// 草稿发布与历史回退都会追加一条新记录，不覆盖历史记录。
/// </summary>
public class HostedSiteRevision
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SiteId { get; set; } = string.Empty;

    public string CreatedByUserId { get; set; } = string.Empty;

    /// <summary>draft | published</summary>
    public string Status { get; set; } = HostedSiteRevisionStatuses.Draft;

    /// <summary>baseline | ai-edit | rollback</summary>
    public string Source { get; set; } = HostedSiteRevisionSources.AiEdit;

    /// <summary>生成该版本所依据的上一版本；首个基线为空。</summary>
    public string? ParentRevisionId { get; set; }

    /// <summary>生成草稿的 Run，用于从版本追溯模型交互过程。</summary>
    public string? SourceRunId { get; set; }

    /// <summary>用户给出的修改要求；基线版本为空。</summary>
    public string? Instruction { get; set; }

    /// <summary>实际执行引擎，例如 map-gateway、codex。</summary>
    public string Runtime { get; set; } = HostedSiteEditRuntimes.MapGateway;

    /// <summary>生成该版本时引用的知识库条目，正文以任务创建时的快照参与生成。</summary>
    public List<string> KnowledgeEntryIds { get; set; } = new();

    /// <summary>完整入口 HTML。控制在 2MB 以内，不向版本列表接口返回。</summary>
    public string Html { get; set; } = string.Empty;

    /// <summary>该版本生成时所依据的线上 ContentVersion。</summary>
    public DateTime BasedOnContentVersion { get; set; }

    /// <summary>发布后对应的新线上 ContentVersion；草稿为空。</summary>
    public DateTime? PublishedContentVersion { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? PublishedAt { get; set; }
}

public static class HostedSiteRevisionStatuses
{
    public const string Draft = "draft";
    public const string Published = "published";
}

public static class HostedSiteRevisionSources
{
    public const string Baseline = "baseline";
    public const string AiEdit = "ai-edit";
    public const string Rollback = "rollback";
}

public static class HostedSiteEditRuntimes
{
    public const string MapGateway = "map-gateway";
    public const string Codex = "codex";
}

public static class HostedSiteRevisionRules
{
    public const int MaxHtmlBytes = 2 * 1024 * 1024;

    public static string NormalizeGeneratedHtml(string raw)
    {
        var value = (raw ?? string.Empty).Trim();
        if (!value.StartsWith("```", StringComparison.Ordinal)) return value;
        var firstLine = value.IndexOf('\n');
        if (firstLine >= 0) value = value[(firstLine + 1)..];
        var closing = value.LastIndexOf("```", StringComparison.Ordinal);
        if (closing >= 0) value = value[..closing];
        return value.Trim();
    }

    public static void ValidateHtml(string html)
    {
        if (string.IsNullOrWhiteSpace(html))
            throw new InvalidOperationException("生成的 HTML 为空");
        if (System.Text.Encoding.UTF8.GetByteCount(html) > MaxHtmlBytes)
            throw new InvalidOperationException("生成的 HTML 超过 2MB，无法保存为草稿");
        if (!html.Contains("<html", StringComparison.OrdinalIgnoreCase)
            && !html.Contains("<!doctype", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("生成结果不是完整 HTML 页面");
    }
}
