using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.ProjectRouteAgent;

/// <summary>
/// 从 routemap *.md 文件内容里用正则扫描出所有第三方 git 仓库 URL。
///
/// 支持的 URL 形态：
///   - https://github.com/owner/repo.git
///   - https://github.com/owner/repo
///   - http(s)://gitlab.com / gitee.com / bitbucket.org / codeup.aliyun.com / 自建 host
///   - git@github.com:owner/repo.git
///   - ssh://git@host/owner/repo.git
///
/// 仅扫 .md 后缀的文件。命中后归一化 URL（去末尾 / 与 .git），按归一化后的字符串去重。
/// </summary>
public static class ThirdPartyRepoExtractor
{
    /// <summary>
    /// 扫一组 (filePath, content) 二元组，返回去重的 git URL 清单（保持出现顺序）。
    /// 非 .md 文件直接跳过。
    /// </summary>
    public static List<string> Extract(IEnumerable<(string Path, string? Content)> files)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (path, content) in files)
        {
            if (string.IsNullOrWhiteSpace(content)) continue;
            if (!path.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;
            ScanInto(content!, result, seen);
        }
        return result;
    }

    /// <summary>扫单个文本，append 到 result（已去重）。</summary>
    public static void ScanInto(string text, List<string> result, HashSet<string> seen)
    {
        foreach (Match m in HttpUrlRegex.Matches(text))
        {
            TryAdd(m.Value, result, seen);
        }
        foreach (Match m in SshUrlRegex.Matches(text))
        {
            TryAdd(m.Value, result, seen);
        }
        foreach (Match m in ScpStyleRegex.Matches(text))
        {
            TryAdd(m.Value, result, seen);
        }
    }

    private static void TryAdd(string raw, List<string> result, HashSet<string> seen)
    {
        var url = Normalize(raw);
        if (string.IsNullOrEmpty(url)) return;
        if (!LooksLikeRepoUrl(url)) return;
        if (seen.Add(url)) result.Add(url);
    }

    private static string Normalize(string raw)
    {
        var t = raw.Trim().TrimEnd(',', '.', ';', '；', '，', '。', ')', '）', ']', '】', '>', '"', '\'');
        // 去 markdown 链接尾部的 ")"，但保留 "/" 末尾的标准化交给消费方
        return t;
    }

    /// <summary>
    /// 排除明显非仓库的 URL（如 raw 文件、issue 链接、文档链接）。
    /// </summary>
    private static bool LooksLikeRepoUrl(string url)
    {
        // 包含 /issues/, /pull/, /blob/, /raw/, /actions, /releases, /wiki, /tree/ 等路径片段的不算
        var excludePaths = new[] { "/issues/", "/issues?", "/pull/", "/pulls?", "/blob/", "/raw/", "/actions",
            "/releases", "/wiki", "/tree/", "/commits/", "/commit/", "/discussions" };
        foreach (var ex in excludePaths)
        {
            if (url.Contains(ex, StringComparison.OrdinalIgnoreCase)) return false;
        }
        // 必须包含 / 形式的 owner/repo 段
        var lastColon = url.LastIndexOf(':');
        var probe = lastColon > 8 ? url[(lastColon + 1)..] : url; // git@host:owner/repo
        var slashes = probe.Count(c => c == '/');
        return slashes >= 2 || url.EndsWith(".git", StringComparison.OrdinalIgnoreCase);
    }

    // https?://host/...（最贪婪到空白 / 引号 / 括号截止）
    private static readonly Regex HttpUrlRegex = new(
        @"https?://[A-Za-z0-9.\-_]+/[A-Za-z0-9._\-/]+(?:\.git)?",
        RegexOptions.Compiled);

    // ssh://git@host/owner/repo.git
    private static readonly Regex SshUrlRegex = new(
        @"ssh://[A-Za-z0-9_\-]+@[A-Za-z0-9.\-_]+/[A-Za-z0-9._\-/]+(?:\.git)?",
        RegexOptions.Compiled);

    // git@host:owner/repo.git
    private static readonly Regex ScpStyleRegex = new(
        @"git@[A-Za-z0-9.\-_]+:[A-Za-z0-9._\-/]+(?:\.git)?",
        RegexOptions.Compiled);
}
