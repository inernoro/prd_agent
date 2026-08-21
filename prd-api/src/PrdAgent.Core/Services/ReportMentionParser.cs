namespace PrdAgent.Core.Services;

/// <summary>
/// 周报评论 @ 提醒解析（服务端唯一判据）。
/// 与前端 MentionTextarea.extractMentionIds 保持同一规则：按候选名长度降序做最长优先匹配，
/// 避免「张三」抢走「张三丰」的 @。前端传入的 ID 只作补充，最终以本解析器 + 团队成员集合为准。
/// </summary>
public static class ReportMentionParser
{
    /// <summary>@ 候选人（一个用户可有多个可被 @ 的名字：显示名 / 用户名）</summary>
    public sealed class MentionCandidate
    {
        public string UserId { get; init; } = string.Empty;

        /// <summary>可被 @ 的名字，按优先级给出（显示名优先），空名自动忽略</summary>
        public IReadOnlyList<string> Names { get; init; } = Array.Empty<string>();
    }

    /// <summary>
    /// 从评论正文解析被 @ 的用户 ID。
    /// </summary>
    /// <param name="content">评论正文</param>
    /// <param name="candidates">候选人集合（通常是该周报所属团队的成员）</param>
    /// <returns>命中的用户 ID（去重，长名优先占位）</returns>
    public static List<string> Extract(string? content, IEnumerable<MentionCandidate>? candidates)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(content) || candidates == null) return result;

        // 展开成 (名字, userId) 对后按名字长度降序：长名优先命中，短名不再抢占已匹配区间
        var pairs = candidates
            .SelectMany(c => (c.Names ?? Array.Empty<string>())
                .Where(n => !string.IsNullOrWhiteSpace(n))
                .Select(n => (Name: n.Trim(), c.UserId)))
            .Where(p => !string.IsNullOrWhiteSpace(p.UserId))
            .OrderByDescending(p => p.Name.Length)
            .ToList();

        // 已被更长的名字占用的字符区间不再参与匹配，用掩码标记
        var consumed = new bool[content.Length];

        foreach (var (name, userId) in pairs)
        {
            var token = "@" + name;
            var searchFrom = 0;
            while (searchFrom <= content.Length - token.Length)
            {
                var index = content.IndexOf(token, searchFrom, StringComparison.Ordinal);
                if (index < 0) break;

                var overlapped = false;
                for (var i = index; i < index + token.Length; i++)
                {
                    if (consumed[i]) { overlapped = true; break; }
                }

                if (!overlapped)
                {
                    for (var i = index; i < index + token.Length; i++) consumed[i] = true;
                    if (!result.Contains(userId, StringComparer.Ordinal)) result.Add(userId);
                }

                searchFrom = index + 1;
            }
        }

        return result;
    }
}
