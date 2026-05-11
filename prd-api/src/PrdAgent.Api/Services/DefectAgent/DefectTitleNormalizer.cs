using System.Net;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.DefectAgent;

public static partial class DefectTitleNormalizer
{
    private const int MaxTitleLength = 100;

    public static string? NormalizeTitle(string? title, string? content, int maxLength = MaxTitleLength)
    {
        var directTitle = CleanCandidate(title, maxLength);
        if (!string.IsNullOrWhiteSpace(directTitle))
            return directTitle;

        if (string.IsNullOrWhiteSpace(content))
            return null;

        foreach (var line in content.Split('\n'))
        {
            var extracted = CleanCandidate(line, maxLength);
            if (!string.IsNullOrWhiteSpace(extracted))
                return extracted;
        }

        return null;
    }

    private static string? CleanCandidate(string? value, int maxLength)
    {
        var raw = value?.Trim();
        if (string.IsNullOrWhiteSpace(raw))
            return null;

        var withoutLabel = LabelPrefixRegex().Replace(raw, string.Empty);
        var cleaned = StripMarkup(withoutLabel);
        if (string.IsNullOrWhiteSpace(cleaned))
            return null;
        if (SectionLabelRegex().IsMatch(cleaned))
            return null;
        if (ImageLabelRegex().IsMatch(cleaned))
            return null;
        if (MarkdownImageRegex().IsMatch(raw))
            return null;
        if (ImageFileRegex().IsMatch(cleaned))
            return null;
        if (UrlOnlyRegex().IsMatch(cleaned))
            return null;

        return cleaned.Length > maxLength ? cleaned[..maxLength] + "..." : cleaned;
    }

    private static string StripMarkup(string value)
    {
        var decoded = WebUtility.HtmlDecode(value);
        return CollapseWhitespaceRegex()
            .Replace(
                MarkdownPrefixRegex()
                    .Replace(HtmlTagRegex().Replace(decoded, " "), string.Empty)
                    .Replace("*", string.Empty)
                    .Replace("_", string.Empty)
                    .Replace("`", string.Empty)
                    .Replace("~", string.Empty),
                " ")
            .Trim();
    }

    [GeneratedRegex("^#{0,6}\\s*(?:[*_`~\\s]*)?(?:缺陷标题|问题标题|标题)(?:[*_`~\\s]*)?\\s*[：:]\\s*", RegexOptions.IgnoreCase)]
    private static partial Regex LabelPrefixRegex();

    [GeneratedRegex("^#{0,6}\\s*(?:[*_`~\\s]*)?(?:用户描述|缺陷描述|问题描述|复现步骤|实际结果|期望结果|预期结果|截图|截图信息|日志|评论|备注|影响范围)(?:[*_`~\\s]*)?\\s*(?:[：:]?\\s*)$", RegexOptions.IgnoreCase)]
    private static partial Regex SectionLabelRegex();

    [GeneratedRegex("^(?:图|图片|截图)\\s*\\d+\\s*(?:[：:].*)?$", RegexOptions.IgnoreCase)]
    private static partial Regex ImageLabelRegex();

    [GeneratedRegex("^!\\[[^\\]]*]\\([^)]+\\)$")]
    private static partial Regex MarkdownImageRegex();

    [GeneratedRegex("^[\\w.-]+\\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\\?.*)?$", RegexOptions.IgnoreCase)]
    private static partial Regex ImageFileRegex();

    [GeneratedRegex("^https?://\\S+$", RegexOptions.IgnoreCase)]
    private static partial Regex UrlOnlyRegex();

    [GeneratedRegex("<[^>]*>")]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex("^\\s*(?:#{1,6}\\s+|>\\s*|[-*+]\\s+|\\d+[.)]\\s+)")]
    private static partial Regex MarkdownPrefixRegex();

    [GeneratedRegex("\\s+")]
    private static partial Regex CollapseWhitespaceRegex();
}
