using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>仅归一化产品申领输入的方案字段，不改变通知模板或共享登记解析行为。</summary>
public static class ProductVersionNoticeParser
{
    private static readonly Regex Field = new(
        @"^(?:[-*]\s+)?(?<labelStart>\*\*)?(?<label>产品立项方案名称|立项方案名称|产品方案名称|上线方案名称|方案名称|产品方案地址|方案地址|产品方案链接|方案链接)(?<labelEnd>\*\*)?\s*[：:]\s*(?<value>.*)$",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(200));
    private static readonly Regex MarkdownLink = new(
        @"^\[(?<title>[^\r\n]*)\]\((?<url>https?://[^\r\n]+)\)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(200));

    public static VersionRegistrationMessageParseResult Parse(string? text, string? kind)
    {
        var lines = (text ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        string? titleUrl = null;
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i].Trim();
            var field = Field.Match(line);
            if (!field.Success) continue;
            var label = field.Groups["label"].Value;
            var isUrl = label.EndsWith("地址", StringComparison.Ordinal) || label.EndsWith("链接", StringComparison.Ordinal);
            var value = field.Groups["value"].Value.Trim();
            if (field.Groups["labelStart"].Success && !field.Groups["labelEnd"].Success)
            {
                if (value.StartsWith("**", StringComparison.Ordinal)) value = value[2..].TrimStart();
                else if (value.EndsWith("**", StringComparison.Ordinal)) value = value[..^2].TrimEnd();
            }
            value = Unbold(value);
            if (value.Length == 0)
            {
                var next = i + 1;
                while (next < lines.Length && string.IsNullOrWhiteSpace(lines[next])) next++;
                if (next < lines.Length)
                {
                    var candidate = Unbold(lines[next].Trim());
                    var canRead = isUrl ? ReadUrl(candidate) != null
                        : MarkdownLink.IsMatch(candidate) || !candidate.StartsWith("【", StringComparison.Ordinal)
                          && !Regex.IsMatch(candidate, @"^[^：:]{1,40}[：:]|^[TV]\d+\.\d+\.\d+$", RegexOptions.CultureInvariant);
                    if (canRead) { value = candidate; lines[next] = string.Empty; }
                }
            }
            var link = MarkdownLink.Match(value);
            if (isUrl)
                lines[i] = "方案地址：" + (ReadUrl(value) ?? string.Empty);
            else
            {
                if (link.Success && ReadUrl(link.Groups["url"].Value) is { } url)
                {
                    value = link.Groups["title"].Value;
                    titleUrl ??= url;
                }
                lines[i] = label + "：" + value;
            }
        }
        var result = VersionRegistrationMessageParser.Parse(string.Join("\n", lines), kind);
        if (string.IsNullOrWhiteSpace(result.PlanUrl) && titleUrl != null)
        {
            result.PlanUrl = titleUrl;
            if (!result.MatchedFields.Contains("planUrl")) result.MatchedFields.Add("planUrl");
        }
        return result;
    }

    private static string Unbold(string value) => value.Length >= 4 && value.StartsWith("**", StringComparison.Ordinal)
        && value.EndsWith("**", StringComparison.Ordinal) ? value[2..^2].Trim() : value;

    private static string? ReadUrl(string value)
    {
        value = Unbold(value.Trim());
        var link = MarkdownLink.Match(value);
        if (link.Success) value = link.Groups["url"].Value;
        if (value.StartsWith('<') && value.EndsWith('>')) value = value[1..^1];
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp) ? value : null;
    }
}
