using System.Text.RegularExpressions;

namespace PrdAgent.Core.Helpers;

/// <summary>只用于新T识别/发号的显示名称，不修改历史记录或编号策略。</summary>
public static class ProductVersionPlanName
{
    public static string Format(string applicationName, string? tCode, string title)
    {
        var raw = title.Trim();
        var opening = raw.IndexOfAny(new[] { '（', '(' });
        var topic = raw;
        if (opening >= 0)
        {
            var depth = 0;
            for (var i = opening; i < raw.Length; i++)
            {
                if (raw[i] is '（' or '(') depth++;
                else if (raw[i] is '）' or ')')
                {
                    depth--;
                    if (depth == 0) { topic = raw[(opening + 1)..i]; break; }
                }
            }
        }
        else
        {
            if (topic.StartsWith(applicationName.Trim(), StringComparison.OrdinalIgnoreCase))
                topic = topic[applicationName.Trim().Length..].Trim();
            topic = Regex.Replace(topic, @"^(?:T\s*(?:\d+\.\d+\.\d+|待定))\s*", "", RegexOptions.IgnoreCase);
            topic = Regex.Replace(topic, @"\.(?:md|docx?|pdf)$", "", RegexOptions.IgnoreCase);
            topic = Regex.Replace(topic, @"[-_\s]*AI\s*文档(?:\s*[1-3](?:-[1-3])?稿)?$", "", RegexOptions.IgnoreCase);
        }
        return $"{applicationName.Trim()}{tCode?.Trim().ToUpperInvariant()}（{topic.Trim()}）";
    }
}
