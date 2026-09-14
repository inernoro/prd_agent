using System;
using System.Net;
using System.Net.Http;
using PrdAgent.Infrastructure.GitHub;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// GitHub 限额判据（唯一定义，PR 审查与目录同步共用）。
///
/// 两条口径各自出过事故：403 被一律说成「拒绝访问」（限额耗尽也报 403），
/// 以及重试提示按容器时区格式化成时刻——镜像不配时区，UTC+8 的用户看到的时刻差八小时。
/// </summary>
public class GitHubRateLimitTests
{
    private static HttpResponseMessage Response(HttpStatusCode status, params (string name, string value)[] headers)
    {
        var resp = new HttpResponseMessage(status);
        foreach (var (name, value) in headers) resp.Headers.TryAddWithoutValidation(name, value);
        return resp;
    }

    [Fact]
    public void 额度归零才算限额耗尽()
    {
        using var exhausted = Response(HttpStatusCode.Forbidden, ("X-RateLimit-Remaining", "0"));
        using var plenty = Response(HttpStatusCode.Forbidden, ("X-RateLimit-Remaining", "37"));
        using var noHeader = Response(HttpStatusCode.Forbidden);

        Assert.True(GitHubRateLimit.IsExhausted(exhausted));
        Assert.False(GitHubRateLimit.IsExhausted(plenty));
        Assert.False(GitHubRateLimit.IsExhausted(noHeader));
    }

    [Fact]
    public void 重试提示给的是时长不是时刻()
    {
        var resetAt = DateTimeOffset.UtcNow.AddMinutes(12).ToUnixTimeSeconds();
        using var resp = Response(HttpStatusCode.Forbidden, ("X-RateLimit-Reset", resetAt.ToString()));

        var hint = GitHubRateLimit.ResetHint(resp);

        Assert.NotNull(hint);
        Assert.Contains("分钟", hint);
        // 时刻会带上容器时区（镜像里是 UTC），用户读到的就是错的
        Assert.DoesNotContain(":", hint);
    }

    [Fact]
    public void 拿不到重置头就不编时间()
    {
        using var resp = Response(HttpStatusCode.Forbidden);
        Assert.Null(GitHubRateLimit.ResetHint(resp));
    }
}
