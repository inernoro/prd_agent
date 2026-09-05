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

    /// <summary>当前发布尝试的 fencing token；仅 publishing 状态存在。</summary>
    public string? PublishAttemptId { get; set; }

    /// <summary>当前发布尝试开始时间。进程退出后，过期尝试可由后续请求安全接管。</summary>
    public DateTime? PublishAttemptStartedAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? PublishedAt { get; set; }
}

public static class HostedSiteRevisionStatuses
{
    public const string Draft = "draft";
    public const string Publishing = "publishing";
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
    public const string GeneratedArtifactCsp = "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'";
    private const string DocumentRootPattern = @"^\uFEFF?\s*(?:<!doctype\s+html\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*<html(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:""[^""<>]*""|'[^'<>]*'|[^\s""'`=<>]+))?)*\s*>";
    private const string DocumentHeadPattern = @"^\s*(?:<!--[\s\S]*?-->\s*)*<head(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:""[^""<>]*""|'[^'<>]*'|[^\s""'`=<>]+))?)*\s*>";
    private static readonly string TrustedSystemCspMeta =
        $"<meta http-equiv=\"Content-Security-Policy\" content=\"{GeneratedArtifactCsp}\">";
    private static readonly string TrustedSystemCspEnvelope =
        $"<head>{TrustedSystemCspMeta}</head>";

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
        if (!System.Text.RegularExpressions.Regex.IsMatch(html, DocumentRootPattern, RegexOptions))
            throw new InvalidOperationException("生成结果必须包含显式 html 根元素，以便注入安全策略");
    }

    public static string HardenGeneratedHtml(string raw)
    {
        var html = NormalizeGeneratedHtml(raw);
        ValidateHtml(html);
        EnsureNoUnresolvedTemplatePlaceholders(html);
        html = ConvertRelativeKnowledgeAnchors(html);

        if (System.Text.RegularExpressions.Regex.IsMatch(html, @"<script\b", RegexOptions))
            throw new InvalidOperationException("生成页面包含可执行脚本，当前安全模式只允许声明式 HTML 与 CSS");

        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                     html,
                     @"<([a-z][a-z0-9-]*)\b[^>]*\b(src|href)\s*=\s*([""'])(.*?)\3",
                     RegexOptions))
        {
            EnsureInlineReference(match.Groups[1].Value, match.Groups[4].Value);
        }
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                     html,
                     @"<([a-z][a-z0-9-]*)\b[^>]*\b(src|href)\s*=\s*([^\s""'`=<>]+)",
                     RegexOptions))
        {
            EnsureInlineReference(match.Groups[1].Value, match.Groups[3].Value);
        }

        if (System.Text.RegularExpressions.Regex.IsMatch(html, @"\bsrcset\s*=|\bsrcdoc\s*=|\s(?:background|poster|ping)\s*=|@import\s+(?:url\s*\()?", RegexOptions)
            || System.Text.RegularExpressions.Regex.IsMatch(html, @"\son[a-z0-9_-]+\s*=", RegexOptions)
            || System.Text.RegularExpressions.Regex.IsMatch(html, @"<\s*(?:applet|base|iframe|frame|object|embed|form)\b|\sformaction\s*=|<meta\b[^>]*\bhttp-equiv\s*=", RegexOptions))
            throw new InvalidOperationException("生成页面包含不能证明为离线安全的导航或嵌入能力");

        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                     html,
                     @"url\(\s*([""']?)(.*?)\1\s*\)",
                     RegexOptions))
        {
            var value = match.Groups[2].Value.Trim();
            if (value.Length > 0 && !value.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && !value.StartsWith('#'))
                throw new InvalidOperationException("生成页面的 CSS 引用了外部资源");
        }

        var root = System.Text.RegularExpressions.Regex.Match(
            html,
            DocumentRootPattern,
            RegexOptions,
            TimeSpan.FromSeconds(1));
        var afterRoot = root.Index + root.Length;
        var head = System.Text.RegularExpressions.Regex.Match(
            html[afterRoot..],
            DocumentHeadPattern,
            RegexOptions,
            TimeSpan.FromSeconds(1));
        if (head.Success)
        {
            var insertionIndex = afterRoot + head.Index + head.Length;
            return html.Insert(insertionIndex, TrustedSystemCspMeta);
        }
        return html.Insert(afterRoot, TrustedSystemCspEnvelope);
    }

    private static void EnsureNoUnresolvedTemplatePlaceholders(string html)
    {
        var visibleMarkup = System.Text.RegularExpressions.Regex.Replace(
            html,
            @"<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?</style\s*>",
            string.Empty,
            RegexOptions,
            TimeSpan.FromSeconds(1));
        var hasReplaceSentinel = System.Text.RegularExpressions.Regex.IsMatch(
            visibleMarkup,
            @"\[\s*replace\s*\]",
            RegexOptions,
            TimeSpan.FromSeconds(1));
        var hasProtectedEmailSentinel = System.Text.RegularExpressions.Regex.IsMatch(
            visibleMarkup,
            @"\[\s*email(?:\s|&(?:nbsp|#0*160|#x0*a0);)+protected\s*\]",
            RegexOptions,
            TimeSpan.FromSeconds(1));
        if (hasReplaceSentinel || hasProtectedEmailSentinel)
        {
            throw new InvalidOperationException(
                "生成的页面仍包含未替换的模板占位内容，已停止保存。请明确品牌与主操作文案后重新生成；若仍出现，请改用其他可用执行器。");
        }
    }

    /// <summary>
    /// 只供已通过 CDS 工作区 token、哈希与 manifest 校验的边界调用。
    /// 仅移除紧随安全 html 根、字节内容完全匹配 MAP 严格策略的单个系统包装；
    /// 其他位置、拼写、实体、自定义值或重复块都保留，随后由 HardenGeneratedHtml 拒绝。
    /// </summary>
    public static string StripSingleTrustedSystemCspEnvelope(string html)
    {
        if (string.IsNullOrEmpty(html)) return html;
        var root = System.Text.RegularExpressions.Regex.Match(
            html,
            DocumentRootPattern,
            RegexOptions,
            TimeSpan.FromSeconds(1));
        if (!root.Success) return html;
        var envelopeStart = root.Index + root.Length;
        if (!html.AsSpan(envelopeStart).StartsWith(TrustedSystemCspEnvelope, StringComparison.Ordinal))
        {
            var head = System.Text.RegularExpressions.Regex.Match(
                html[envelopeStart..],
                DocumentHeadPattern,
                RegexOptions,
                TimeSpan.FromSeconds(1));
            if (!head.Success) return html;
            var metaStart = envelopeStart + head.Index + head.Length;
            if (!html.AsSpan(metaStart).StartsWith(TrustedSystemCspMeta, StringComparison.Ordinal))
                return html;
            return html.Remove(metaStart, TrustedSystemCspMeta.Length);
        }
        return html.Remove(envelopeStart, TrustedSystemCspEnvelope.Length);
    }

    private static readonly System.Text.RegularExpressions.RegexOptions RegexOptions =
        System.Text.RegularExpressions.RegexOptions.IgnoreCase
        | System.Text.RegularExpressions.RegexOptions.CultureInvariant
        | System.Text.RegularExpressions.RegexOptions.Singleline;

    private static void EnsureInlineReference(string tag, string rawValue)
    {
        var value = rawValue.Trim();
        if (value.Length == 0 || value.StartsWith('#')) return;
        if (value.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
            && !tag.Equals("a", StringComparison.OrdinalIgnoreCase)
            && !tag.Equals("area", StringComparison.OrdinalIgnoreCase)) return;
        throw new InvalidOperationException($"生成页面的 <{tag.ToLowerInvariant()}> 引用了外部资源");
    }

    private static string ConvertRelativeKnowledgeAnchors(string html)
    {
        const string quoted = @"<a\b[^>]*\bhref\s*=\s*([""'])(\./[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_.:-]+)?)\1[^>]*>(.*?)</a\s*>";
        const string unquoted = @"<a\b[^>]*\bhref\s*=\s*(\./[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_.:-]+)?)[^\s""'`=<>]*[^>]*>(.*?)</a\s*>";
        string Replace(System.Text.RegularExpressions.Match match, int valueGroup, int bodyGroup)
        {
            var value = match.Groups[valueGroup].Value;
            if (System.Text.RegularExpressions.Regex.IsMatch(value, @"(?:^|/)\.\.(?:/|$)", RegexOptions)) return match.Value;
            return $"<span data-cds-source-reference=\"{value}\">{match.Groups[bodyGroup].Value}</span>";
        }
        html = System.Text.RegularExpressions.Regex.Replace(html, quoted, match => Replace(match, 2, 3), RegexOptions);
        return System.Text.RegularExpressions.Regex.Replace(html, unquoted, match => Replace(match, 1, 2), RegexOptions);
    }
}
