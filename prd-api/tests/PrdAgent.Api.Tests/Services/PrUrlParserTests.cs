using PrdAgent.Infrastructure.GitHub;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// PR Review V2：URL 解析器 + SSRF 白名单的单测。
/// 覆盖 happy path、边界、以及可能的注入向量。
/// </summary>
public class PrUrlParserTests
{
    [Theory]
    [InlineData("https://github.com/owner/repo/pull/123", "owner", "repo", 123)]
    [InlineData("https://github.com/owner/repo/pull/123/", "owner", "repo", 123)]
    [InlineData("https://github.com/owner/repo/pull/123?foo=bar", "owner", "repo", 123)]
    [InlineData("https://github.com/owner/repo/pull/123#files", "owner", "repo", 123)]
    [InlineData("http://github.com/OWNER/REPO/pull/999", "OWNER", "REPO", 999)]
    [InlineData("https://www.github.com/owner/repo/pull/1", "owner", "repo", 1)]
    [InlineData("  https://github.com/owner/repo/pull/42  ", "owner", "repo", 42)]
    [InlineData("https://github.com/octocat/Hello-World/pull/1347", "octocat", "Hello-World", 1347)]
    [InlineData("https://github.com/my-org/my.repo.name/pull/1", "my-org", "my.repo.name", 1)]
    [InlineData("https://github.com/a/b/pull/1", "a", "b", 1)]
    public void TryParse_ValidUrls_ShouldSucceed(
        string url,
        string expectedOwner,
        string expectedRepo,
        int expectedNumber)
    {
        var ok = PrUrlParser.TryParse(url, out var result, out var error);

        Assert.True(ok, $"Expected parse success but got error: {error}");
        Assert.NotNull(result);
        Assert.Null(error);
        Assert.Equal(expectedOwner, result!.Owner);
        Assert.Equal(expectedRepo, result.Repo);
        Assert.Equal(expectedNumber, result.Number);
        Assert.Equal($"https://github.com/{expectedOwner}/{expectedRepo}/pull/{expectedNumber}", result.HtmlUrl);
    }

    [Theory]
    [InlineData("", "PR 链接不能为空")]
    [InlineData("   ", "PR 链接不能为空")]
    [InlineData("not-a-url", "格式错误")]
    [InlineData("ftp://github.com/owner/repo/pull/1", "协议")]
    [InlineData("javascript:alert(1)", "格式错误")]
    public void TryParse_InvalidInputs_ShouldFailWithHint(string url, string errorHint)
    {
        var ok = PrUrlParser.TryParse(url, out var result, out var error);

        Assert.False(ok);
        Assert.Null(result);
        Assert.NotNull(error);
        Assert.Contains(errorHint, error!, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://gitlab.com/owner/repo/pull/1")]            // 非 github.com
    [InlineData("https://github.com.evil.tld/owner/repo/pull/1")]   // 伪造 host
    [InlineData("https://evil.com/github.com/owner/repo/pull/1")]   // 路径里伪装
    public void TryParse_NonGitHubHost_ShouldFail(string url)
    {
        var ok = PrUrlParser.TryParse(url, out var result, out var error);

        Assert.False(ok);
        Assert.Null(result);
        Assert.NotNull(error);
        Assert.Contains("github.com", error!);
    }

    [Theory]
    [InlineData("https://github.com/owner/repo/issues/1")]     // issues 不是 pull
    [InlineData("https://github.com/owner/repo/commit/abc")]   // commit 不是 pull
    [InlineData("https://github.com/owner/repo")]              // 不含 pull 段
    [InlineData("https://github.com/owner")]                   // 段数不够
    public void TryParse_WrongPathShape_ShouldFail(string url)
    {
        var ok = PrUrlParser.TryParse(url, out var result, out var error);

        Assert.False(ok);
        Assert.Null(result);
        Assert.NotNull(error);
    }

    [Theory]
    [InlineData("https://github.com/owner/repo/pull/not-a-number")]
    [InlineData("https://github.com/owner/repo/pull/0")]
    [InlineData("https://github.com/owner/repo/pull/-1")]
    public void TryParse_InvalidPrNumber_ShouldFail(string url)
    {
        var ok = PrUrlParser.TryParse(url, out var result, out var error);

        Assert.False(ok);
        Assert.Null(result);
        Assert.NotNull(error);
        Assert.Contains("编号", error!);
    }

    [Theory]
    [InlineData("https://github.com/-bad/repo/pull/1")]        // owner 连字符开头
    [InlineData("https://github.com/bad-/repo/pull/1")]        // owner 连字符结尾
    [InlineData("https://github.com/owner/../pull/1")]         // 路径逃逸
    [InlineData("https://github.com/owner/repo%2F../pull/1")]  // URL 编码绕过
    [InlineData("https://github.com/a_b/repo/pull/1")]         // owner 不允许下划线
    public void TryParse_InvalidOwnerChars_ShouldFailForSsrfGuards(string url)
    {
        var ok = PrUrlParser.TryParse(url, out var result, out var error);

        Assert.False(ok);
        Assert.Null(result);
        Assert.NotNull(error);
    }

    [Theory]
    [InlineData("owner", "repo", true)]
    [InlineData("octocat", "Hello-World", true)]
    [InlineData("my-org", "my.repo.name", true)]
    [InlineData("a", "b", true)]
    [InlineData("", "repo", false)]
    [InlineData("owner", "", false)]
    [InlineData("-bad", "repo", false)]
    [InlineData("bad-", "repo", false)]
    [InlineData("owner", "repo/../../etc", false)]
    [InlineData("owner with space", "repo", false)]
    [InlineData("owner", "repo with space", false)]
    public void IsSafeOwnerRepo_ShouldEnforceWhitelist(string owner, string repo, bool expected)
    {
        Assert.Equal(expected, PrUrlParser.IsSafeOwnerRepo(owner, repo));
    }
}
