using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// GitHub PR URL 解析与 SSRF 白名单校验。
///
/// 职责：
/// 1. 从 GitHub PR 链接中抽取 (owner, repo, number) 三元组
/// 2. 以正则白名单限制 owner / repo 字符集，阻断 SSRF/路径注入尝试
/// 3. 不做任何 HTTP 调用——纯函数，便于单测
///
/// 白名单来自 GitHub 官方命名规则：
///   - owner (user/org)：字母数字 + 连字符，不能连字符开头或结尾，最长 39
///   - repo：字母数字 + 点 + 下划线 + 连字符，最长 100
/// </summary>
public static class PrUrlParser
{
    /// <summary>GitHub 用户/组织名允许字符 (login)</summary>
    private static readonly Regex OwnerRegex =
        new(@"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$", RegexOptions.Compiled);

    /// <summary>GitHub 仓库名允许字符</summary>
    private static readonly Regex RepoRegex =
        new(@"^[A-Za-z0-9._-]{1,100}$", RegexOptions.Compiled);

    /// <summary>
    /// 尝试解析一个 GitHub PR URL。
    /// 返回 true 时 result 非空；返回 false 时 errorMessage 非空。
    /// </summary>
    public static bool TryParse(string? url, out PrUrlParseResult? result, out string? errorMessage)
    {
        result = null;
        errorMessage = null;

        if (string.IsNullOrWhiteSpace(url))
        {
            errorMessage = "PR 链接不能为空";
            return false;
        }

        var trimmed = url.Trim();

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            errorMessage = "PR 链接格式错误，应为 https://github.com/{owner}/{repo}/pull/{number}";
            return false;
        }

        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            errorMessage = "PR 链接必须使用 http 或 https 协议";
            return false;
        }

        // 严格限定 host，防止 http://github.com.evil.tld/... 绕过
        if (!string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Host, "www.github.com", StringComparison.OrdinalIgnoreCase))
        {
            errorMessage = "仅支持 github.com 上的 PR 链接";
            return false;
        }

        // 标准化 path：去头尾斜杠，按段切分
        var segments = uri.AbsolutePath
            .Trim('/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries);

        if (segments.Length < 4)
        {
            errorMessage = "PR 链接结构错误，应包含 /{owner}/{repo}/pull/{number}";
            return false;
        }

        var owner = segments[0];
        var repo = segments[1];
        var kind = segments[2];
        var numberSegment = segments[3];

        if (!string.Equals(kind, "pull", StringComparison.Ordinal))
        {
            errorMessage = "仅支持 /pull/ 类型的链接，issues/commits 不适用";
            return false;
        }

        if (!OwnerRegex.IsMatch(owner))
        {
            errorMessage = "owner 名称不符合 GitHub 命名规范";
            return false;
        }

        if (!RepoRegex.IsMatch(repo))
        {
            errorMessage = "repo 名称不符合 GitHub 命名规范";
            return false;
        }

        if (!int.TryParse(numberSegment, out var number) || number <= 0)
        {
            errorMessage = "PR 编号必须是大于 0 的整数";
            return false;
        }

        result = new PrUrlParseResult(owner, repo, number);
        return true;
    }

    /// <summary>
    /// 独立校验 owner/repo 字符白名单。服务层用它守卫来自数据库的字段二次使用场景，
    /// 确保永远不会把未经白名单的字符串拼进 GitHub API URL。
    /// </summary>
    public static bool IsSafeOwnerRepo(string owner, string repo)
    {
        return !string.IsNullOrEmpty(owner)
            && !string.IsNullOrEmpty(repo)
            && OwnerRegex.IsMatch(owner)
            && RepoRegex.IsMatch(repo);
    }
}

/// <summary>解析成功的结果</summary>
public sealed record PrUrlParseResult(string Owner, string Repo, int Number)
{
    /// <summary>规范化后的 GitHub PR canonical URL</summary>
    public string HtmlUrl => $"https://github.com/{Owner}/{Repo}/pull/{Number}";
}
