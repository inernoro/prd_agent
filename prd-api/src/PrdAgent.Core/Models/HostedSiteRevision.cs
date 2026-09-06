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

    /// <summary>回退版本明确指向被选择的历史版本；与 ParentRevisionId 的回退前当前版本语义分离。</summary>
    public string? RollbackTargetRevisionId { get; set; }

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

    /// <summary>最近一次发布尝试的稳定失败码；不得保存原始异常或外部服务信息。</summary>
    public string? LastPublishFailureCode { get; set; }

    public DateTime? LastPublishFailedAt { get; set; }

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
    public const string OpenDesign = "open-design";
    public const string Codex = "codex";
    public const string Manual = "manual";
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

        foreach (var tag in ScanHtmlStartTags(html).Where(item => !item.IsClosing))
        {
            if (tag.Name.Equals("script", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("生成页面包含可执行脚本，当前安全模式只允许声明式 HTML 与 CSS");
            foreach (var attribute in new[] { "src", "href" })
            {
                var reference = ReadHtmlAttribute(tag.Attributes, attribute);
                if (reference != null) EnsureInlineReference(tag.Name, reference);
            }
            var attributes = ParseHtmlAttributes(tag.Attributes);
            if (attributes.Keys.Any(name =>
                    name.Equals("srcset", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("srcdoc", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("background", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("poster", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("ping", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("formaction", StringComparison.OrdinalIgnoreCase)
                    || name.StartsWith("on", StringComparison.OrdinalIgnoreCase))
                || System.Text.RegularExpressions.Regex.IsMatch(
                    tag.Name,
                    @"^(?:applet|base|iframe|frame|object|embed|form)$",
                    RegexOptions,
                    TimeSpan.FromSeconds(1))
                || (tag.Name.Equals("meta", StringComparison.OrdinalIgnoreCase)
                    && attributes.ContainsKey("http-equiv")))
                throw new InvalidOperationException("生成页面包含不能证明为离线安全的导航或嵌入能力");
        }

        if (System.Text.RegularExpressions.Regex.IsMatch(html, @"@import\s+(?:url\s*\()?", RegexOptions))
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

    /// <summary>
    /// 对已经通过离线安全校验的 AI 产物执行可发布质量闸门。
    /// evidenceText 必须由任务指令、知识快照和编辑前页面的可见正文组成，不能包含 CSS 或脚本。
    /// </summary>
    public static void ValidateGeneratedContentQuality(string html, string evidenceText)
    {
        ValidateHtml(html);
        var visibleText = ExtractVisibleText(html);
        EnsureNoVisibleDraftMarkers(html, visibleText);
        EnsureStaticControlsHaveBehavior(html);
        EnsureNumericClaimsAreSupported(visibleText, evidenceText ?? string.Empty);
        EnsureSensitiveFactsAreSupported(visibleText, evidenceText ?? string.Empty);
    }

    public static string ExtractVisibleText(string html)
    {
        var value = System.Text.RegularExpressions.Regex.Replace(
            html ?? string.Empty,
            @"<!--[\s\S]*?-->|<head\b[^>]*>[\s\S]*?</head\s*>|<style\b[^>]*>[\s\S]*?</style\s*>|<script\b[^>]*>[\s\S]*?</script\s*>|<template\b[^>]*>[\s\S]*?</template\s*>|<noscript\b[^>]*>[\s\S]*?</noscript\s*>",
            " ",
            RegexOptions,
            TimeSpan.FromSeconds(1));
        value = ExtractVisibleTextFromMarkup(value);
        value = System.Net.WebUtility.HtmlDecode(value);
        return System.Text.RegularExpressions.Regex.Replace(
            value,
            @"\s+",
            " ",
            RegexOptions,
            TimeSpan.FromSeconds(1)).Trim();
    }

    private static void EnsureNoVisibleDraftMarkers(string html, string visibleText)
    {
        var hasVisibleDraftMarker = System.Text.RegularExpressions.Regex.IsMatch(
            visibleText,
            @"(?:图|图片|图示|插图|截图|内容|文案|数据|此处|位置)\s*(?:仍|仅|为|是|[:：·—-])?\s*占位|占位\s*(?:图|图片|图示|插图|截图|内容|文案|数据|[:：·—-])|待\s*(?:补充|替换|填写|完善)|\blorem\s+ipsum\b|\b(?:todo|tbd)\b",
            RegexOptions,
            TimeSpan.FromSeconds(1));
        if (hasVisibleDraftMarker)
        {
            throw new InvalidOperationException(
                "生成页面仍包含占位或待补内容，已停止保存。请让执行器替换为真实内容，或删除无法完成的区块后重试。");
        }
    }

    private static void EnsureStaticControlsHaveBehavior(string html)
    {
        var targets = new HashSet<string>(StringComparer.Ordinal);
        var popoverTargets = new HashSet<string>(StringComparer.Ordinal);
        var tags = ScanHtmlStartTags(html).ToList();
        foreach (var tag in tags.Where(item => !item.IsClosing))
        {
            var attrs = tag.Attributes;
            var target = System.Net.WebUtility.HtmlDecode(
                (ReadHtmlAttribute(attrs, "id") ?? ReadHtmlAttribute(attrs, "name") ?? string.Empty).Trim());
            if (target.Length > 0)
            {
                targets.Add(target);
                if (HasHtmlAttribute(attrs, "popover")) popoverTargets.Add(target);
            }
        }

        foreach (var tag in tags.Where(item => !item.IsClosing && item.Name.Equals("a", StringComparison.OrdinalIgnoreCase)))
        {
            var attrs = tag.Attributes;
            var href = ReadHtmlAttribute(attrs, "href");
            if (href == null)
                throw new InvalidOperationException("生成页面包含没有目标的链接，已停止保存。请改为普通元素或提供真实页内目标。");

            var decoded = System.Net.WebUtility.HtmlDecode(href.Trim());
            if (decoded.Length == 0 || decoded == "#")
                throw new InvalidOperationException("生成页面包含空链接，已停止保存。请改为普通文本或提供真实页内目标。");
            if (!decoded.StartsWith('#')) continue;
            string fragment;
            try
            {
                fragment = Uri.UnescapeDataString(decoded[1..]);
            }
            catch (UriFormatException)
            {
                throw new InvalidOperationException("生成页面包含格式错误的页内链接，已停止保存。请改为普通文本或提供真实页内目标。");
            }
            if (fragment.Length == 0 || !targets.Contains(fragment))
                throw new InvalidOperationException($"生成页面的页内链接目标不存在：#{fragment}");
        }

        foreach (var tag in tags.Where(item => !item.IsClosing && item.Name.Equals("button", StringComparison.OrdinalIgnoreCase)))
        {
            var attrs = tag.Attributes;
            if (HasHtmlAttribute(attrs, "disabled")) continue;
            var popoverTarget = System.Net.WebUtility.HtmlDecode((ReadHtmlAttribute(attrs, "popovertarget") ?? string.Empty).Trim());
            if (popoverTarget.Length > 0 && popoverTargets.Contains(popoverTarget)) continue;
            throw new InvalidOperationException(
                "生成页面包含无法执行动作的按钮，已停止保存。声明式页面请使用指向真实区块的链接，或移除该按钮。");
        }
    }

    private static void EnsureNumericClaimsAreSupported(string visibleText, string evidenceText)
    {
        var supported = ExtractMeasuredClaimContexts(evidenceText);
        foreach (var claim in ExtractMeasuredClaimContexts(visibleText))
        {
            if (claim.IsStructural) continue;
            var candidates = supported
                .Where(item => item.Token.Equals(claim.Token, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (candidates.Count == 0
                || !candidates.Any(candidate => HasClaimContextOverlap(
                    candidate.Context,
                    claim.Context,
                    claim.RequiresContext,
                    candidate.EntityKeys,
                    claim.EntityKeys)))
            {
                var parts = claim.Token.Split('|', 2);
                throw new InvalidOperationException(
                    $"生成页面包含知识与指令未支持的数值陈述：{parts[0]}{parts[1]}。已停止保存，请删除或改回来源中的准确数值。");
            }
        }
    }

    private sealed record MeasuredClaimContext(
        string Token,
        string Context,
        bool RequiresContext,
        bool IsStructural,
        HashSet<string> EntityKeys);

    private static List<MeasuredClaimContext> ExtractMeasuredClaimContexts(string text)
    {
        var claims = new List<MeasuredClaimContext>();
        foreach (var segment in System.Text.RegularExpressions.Regex.Split(text ?? string.Empty, @"[\r\n。！？!?；;，,：:]+"))
        {
            var patterns = new[]
            {
                @"(?<![A-Za-z0-9_])(?<number>\d+(?:[.,]\d+)*)\s*(?<unit>%|％|分钟|小时|天|周|月|年|万字|元|美元|人民币|KB|MB|GB)(?![A-Za-z])",
                @"(?<unit>￥|¥|\$)\s*(?<number>\d+(?:[.,]\d+)*)",
                @"(?<![A-Za-z0-9_])(?<number>\d+(?:[.,]\d+)*)\s*(?<unit>个|条|次|篇|字|人|位|家|项|例|份|种|类|层|步|章|节|页)(?![A-Za-z])",
            };
            foreach (var pattern in patterns)
            {
                foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(segment, pattern, RegexOptions))
                {
                    var number = match.Groups["number"].Value.Replace(",", string.Empty, StringComparison.Ordinal);
                    if (decimal.TryParse(
                            number,
                            System.Globalization.NumberStyles.AllowDecimalPoint,
                            System.Globalization.CultureInfo.InvariantCulture,
                            out var parsed))
                        number = parsed.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    var rawUnit = match.Groups["unit"].Value;
                    var requiresContext = IsCountUnit(rawUnit);
                    var entityKeys = ExtractClaimEntityKeys(segment, rawUnit);
                    var unit = NormalizeClaimUnit(rawUnit, entityKeys);
                    claims.Add(new MeasuredClaimContext(
                        $"{number}|{unit}",
                        NormalizeClaimContext(segment),
                        requiresContext,
                        requiresContext && IsStructuralCount(segment),
                        entityKeys));
                }
            }
        }
        return claims;
    }

    private static string NormalizeClaimContext(string value) =>
        System.Text.RegularExpressions.Regex.Replace(
            value,
            @"\d+(?:[.,]\d+)*|%|％|￥|¥|\$|分钟|小时|天|周|月|年|万字|元|美元|人民币|KB|MB|GB|个|条|次|篇|字|人|家|项|大约|约|只需|总共|预计|可达|达到|需要|耗时|时长|total|approximately|about|around",
            string.Empty,
            RegexOptions,
            TimeSpan.FromSeconds(1));

    private static bool HasClaimContextOverlap(
        string left,
        string right,
        bool requiresContext,
        HashSet<string> leftEntities,
        HashSet<string> rightEntities)
    {
        if (!requiresContext) return true;
        var comparableLeftEntities = leftEntities.Where(key => key != "PERSON").ToHashSet(StringComparer.Ordinal);
        var comparableRightEntities = rightEntities.Where(key => key != "PERSON").ToHashSet(StringComparer.Ordinal);
        if (requiresContext && comparableLeftEntities.Count > 0 && comparableRightEntities.Count > 0)
            return comparableRightEntities.Any(comparableLeftEntities.Contains);
        var leftTokens = ClaimContextTokens(left);
        if (leftTokens.Count == 0) return !requiresContext;
        var rightTokens = ClaimContextTokens(right);
        if (rightTokens.Count == 0) return false;
        var overlap = rightTokens.Count(leftTokens.Contains);
        return Math.Min(leftTokens.Count, rightTokens.Count) <= 1 ? overlap == 1 : overlap >= 2;
    }

    private static string NormalizeClaimUnit(string value, HashSet<string> entityKeys)
    {
        if (value == "％") return "%";
        if (value is "￥" or "¥" or "元" or "人民币") return "CNY";
        if (value is "$" or "美元") return "USD";
        if (value is "人" or "位" || value == "个" && entityKeys.Overlaps(["CUSTOMER", "USER", "CONSUMER", "READER", "EMPLOYEE"])) return "PERSON";
        if (value == "篇" || value == "个" && entityKeys.Contains("ARTICLE")) return "ARTICLE";
        if (value == "家" || value == "个" && entityKeys.Contains("ORGANIZATION")) return "ORGANIZATION";
        if (value is "章" or "节" || value == "个" && entityKeys.Contains("SECTION")) return "SECTION";
        if (value == "页") return "PAGE";
        if (value == "个" && entityKeys.Count == 1) return entityKeys.Single();
        return value.ToUpperInvariant();
    }

    private static bool IsCountUnit(string unit) =>
        "个|条|次|篇|字|人|位|家|项|例|份|种|类|层|步|章|节|页"
            .Split('|')
            .Contains(unit, StringComparer.Ordinal);

    private static bool IsStructuralCount(string segment) =>
        System.Text.RegularExpressions.Regex.IsMatch(
            segment,
            @"(?:第\s*\d+\s*(?:步|章|节)(?:\b|。|，|,|：|:|$))|(?:(?:本文|本页|下文|以下|使用方式|操作流程|阅读路径|页面内容)[^\r\n。！？!?；;]{0,16}(?:分为|包括|包含|共有)\s*\d+(?:[.,]\d+)*\s*(?:个|条|项|种|类|层|步|章|节)?\s*(?:步骤|阶段|部分|章节|要点|原则|方式|层级|类别|模块|区块|栏目|操作)(?:\b|。|，|,|：|:|$))",
            RegexOptions,
            TimeSpan.FromSeconds(1));

    private static HashSet<string> ExtractClaimEntityKeys(string segment, string unit)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (key, pattern) in new[]
                 {
                     ("PROJECT", @"项目"),
                     ("CUSTOMER", @"客户"),
                     ("USER", @"用户"),
                     ("CONSUMER", @"消费者"),
                     ("READER", @"读者"),
                     ("EMPLOYEE", @"员工|成员"),
                     ("CASE", @"案例|样例"),
                     ("ARTICLE", @"文章|文档|知识|内容"),
                     ("MODULE", @"模块|功能"),
                     ("CATEGORY", @"类别|分类|种类"),
                     ("OPERATION", @"操作|流程|步骤"),
                     ("SECTION", @"章节|章|节"),
                     ("COLUMN", @"栏目|专栏"),
                     ("ORGANIZATION", @"企业|公司|机构|商家"),
                 })
        {
            if (System.Text.RegularExpressions.Regex.IsMatch(segment, pattern, RegexOptions, TimeSpan.FromSeconds(1)))
                keys.Add(key);
        }
        if (unit is "人" or "位") keys.Add("PERSON");
        if (unit == "篇") keys.Add("ARTICLE");
        if (unit is "章" or "节") keys.Add("SECTION");
        if (unit == "家") keys.Add("ORGANIZATION");
        if (unit == "页") keys.Add("PAGE");
        return keys;
    }

    private static HashSet<string> ClaimContextTokens(string value)
    {
        var tokens = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Text.RegularExpressions.Match word in System.Text.RegularExpressions.Regex.Matches(
                     value,
                     @"[A-Za-z][A-Za-z0-9_-]{2,}",
                     RegexOptions))
            tokens.Add(word.Value);
        var chinese = string.Concat(value.Where(character => character >= '\u4e00' && character <= '\u9fff'));
        for (var index = 0; index + 1 < chinese.Length; index++) tokens.Add(chinese.Substring(index, 2));
        return tokens;
    }

    private sealed record HtmlStartTag(string Name, string Attributes, int Start, int End, bool IsClosing, bool IsSelfClosing);

    private static List<HtmlStartTag> ScanHtmlStartTags(string html)
    {
        var tags = new List<HtmlStartTag>();
        for (var index = 0; index < html.Length; index++)
        {
            if (html[index] != '<' || index + 1 >= html.Length) continue;
            var cursor = index + 1;
            var isClosing = cursor < html.Length && html[cursor] == '/';
            if (isClosing) cursor++;
            if (cursor >= html.Length || !char.IsLetter(html[cursor])) continue;
            var nameStart = cursor;
            while (cursor < html.Length && (char.IsLetterOrDigit(html[cursor]) || html[cursor] is '-' or ':')) cursor++;
            var name = html[nameStart..cursor];
            var attributesStart = cursor;
            char? quote = null;
            while (cursor < html.Length)
            {
                var current = html[cursor];
                if (quote.HasValue)
                {
                    if (current == quote.Value) quote = null;
                }
                else if (current is '"' or '\'')
                {
                    quote = current;
                }
                else if (current == '>')
                {
                    var attributes = html[attributesStart..cursor];
                    tags.Add(new HtmlStartTag(name, attributes, index, cursor + 1, isClosing, attributes.TrimEnd().EndsWith('/')));
                    index = cursor;
                    break;
                }
                cursor++;
            }
        }
        return tags;
    }

    private static string ExtractVisibleTextFromMarkup(string html)
    {
        var tags = ScanHtmlStartTags(html);
        if (tags.Count == 0) return html;
        var builder = new System.Text.StringBuilder(html.Length);
        var stack = new List<(string Name, bool Suppressed)>();
        var suppressedDepth = 0;
        var cursor = 0;
        foreach (var tag in tags)
        {
            if (tag.Start > cursor && suppressedDepth == 0) builder.Append(html, cursor, tag.Start - cursor);
            var block = IsBlockElement(tag.Name);
            if (tag.IsClosing)
            {
                for (var index = stack.Count - 1; index >= 0; index--)
                {
                    var frame = stack[index];
                    stack.RemoveAt(index);
                    if (frame.Suppressed) suppressedDepth--;
                    if (frame.Name.Equals(tag.Name, StringComparison.OrdinalIgnoreCase)) break;
                }
                if (block && suppressedDepth == 0) builder.Append('。');
            }
            else
            {
                if (block && suppressedDepth == 0) builder.Append('。');
                var suppressed = IsHiddenElement(tag.Attributes);
                if (!tag.IsSelfClosing && !IsVoidElement(tag.Name))
                {
                    stack.Add((tag.Name, suppressed));
                    if (suppressed) suppressedDepth++;
                }
            }
            cursor = tag.End;
        }
        if (cursor < html.Length && suppressedDepth == 0) builder.Append(html, cursor, html.Length - cursor);
        return builder.ToString();
    }

    private static bool IsHiddenElement(string attributes)
    {
        if (HasHtmlAttribute(attributes, "hidden")) return true;
        if (string.Equals(ReadHtmlAttribute(attributes, "aria-hidden")?.Trim(), "true", StringComparison.OrdinalIgnoreCase)) return true;
        var style = System.Net.WebUtility.HtmlDecode(ReadHtmlAttribute(attributes, "style") ?? string.Empty);
        return System.Text.RegularExpressions.Regex.IsMatch(
            style,
            @"(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)",
            RegexOptions,
            TimeSpan.FromSeconds(1));
    }

    private static bool IsBlockElement(string name) =>
        System.Text.RegularExpressions.Regex.IsMatch(
            name,
            @"^(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)$",
            RegexOptions,
            TimeSpan.FromSeconds(1));

    private static bool IsVoidElement(string name) =>
        System.Text.RegularExpressions.Regex.IsMatch(
            name,
            @"^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$",
            RegexOptions,
            TimeSpan.FromSeconds(1));


    private static void EnsureSensitiveFactsAreSupported(string visibleText, string evidenceText)
    {
        var supported = ExtractSensitiveFacts(evidenceText);
        foreach (var fact in ExtractSensitiveFacts(visibleText))
        {
            if (!supported.Contains(fact))
                throw new InvalidOperationException(
                    $"生成页面包含知识与指令未支持的日期、联系方式或网址：{fact}。已停止保存，请删除或改回来源中的准确内容。");
        }
    }

    private static HashSet<string> ExtractSensitiveFacts(string text)
    {
        var facts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                     text ?? string.Empty,
                     @"https?://[^\s<>\""']+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)",
                     RegexOptions))
        {
            facts.Add(match.Value.TrimEnd('.', ',', ';', ':', '，', '。', '；', '：', ')', ']', '}', '>', '`').ToLowerInvariant());
        }
        return facts;
    }

    private static string? ReadHtmlAttribute(string attributes, string name)
        => ParseHtmlAttributes(attributes).TryGetValue(name, out var value) ? value : null;

    private static bool HasHtmlAttribute(string attributes, string name) =>
        ParseHtmlAttributes(attributes).ContainsKey(name);

    private static Dictionary<string, string?> ParseHtmlAttributes(string attributes)
    {
        var parsed = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var index = 0;
        while (index < attributes.Length)
        {
            while (index < attributes.Length && (char.IsWhiteSpace(attributes[index]) || attributes[index] == '/')) index++;
            var nameStart = index;
            while (index < attributes.Length
                   && !char.IsWhiteSpace(attributes[index])
                   && attributes[index] != '='
                   && attributes[index] != '>') index++;
            if (index == nameStart)
            {
                index++;
                continue;
            }
            var attributeName = attributes[nameStart..index];
            while (index < attributes.Length && char.IsWhiteSpace(attributes[index])) index++;
            string? value = null;
            if (index < attributes.Length && attributes[index] == '=')
            {
                index++;
                while (index < attributes.Length && char.IsWhiteSpace(attributes[index])) index++;
                if (index < attributes.Length && attributes[index] is '"' or '\'')
                {
                    var quote = attributes[index++];
                    var valueStart = index;
                    while (index < attributes.Length && attributes[index] != quote) index++;
                    value = attributes[valueStart..Math.Min(index, attributes.Length)];
                    if (index < attributes.Length) index++;
                }
                else
                {
                    var valueStart = index;
                    while (index < attributes.Length
                           && !char.IsWhiteSpace(attributes[index])
                           && attributes[index] != '>') index++;
                    value = attributes[valueStart..index];
                }
            }
            parsed.TryAdd(attributeName, value);
        }
        return parsed;
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
