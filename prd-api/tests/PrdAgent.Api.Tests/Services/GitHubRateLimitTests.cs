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

    [Fact]
    public void 二级限额也算限额_主配额没用完照样要等()
    {
        // GitHub 的二级限额（短时间打得太快）是 403 + Retry-After，而主配额没用完，
        // Remaining 仍非零。只看 Remaining 会把它判成「无权限」，于是提示用户去改仓库权限，
        // 而他改什么都没用——正确的动作是等一会儿再来。
        using var secondary = Response(
            HttpStatusCode.Forbidden,
            ("X-RateLimit-Remaining", "4321"),
            ("Retry-After", "60"));

        Assert.True(GitHubRateLimit.IsExhausted(secondary));
    }

    [Fact]
    public void 二级限额的等待时长取Retry_After而不是主配额重置时刻()
    {
        // 此时 X-RateLimit-Reset 指向的是主配额的重置时刻（这里 50 分钟后），
        // 远晚于 GitHub 真正要求的等待时间（60 秒）。给前者等于让用户白等。
        var resetAt = DateTimeOffset.UtcNow.AddMinutes(50).ToUnixTimeSeconds();
        using var secondary = Response(
            HttpStatusCode.Forbidden,
            ("X-RateLimit-Remaining", "4321"),
            ("X-RateLimit-Reset", resetAt.ToString()),
            ("Retry-After", "60"));

        Assert.Equal("约 1 分钟", GitHubRateLimit.ResetHint(secondary));
    }

    [Fact]
    public void 别的状态码带Retry_After不算限额()
    {
        // 503 + Retry-After 是「服务在维护」，不是限额；判成限额会给出误导的等待提示。
        using var maintenance = Response(
            HttpStatusCode.ServiceUnavailable,
            ("X-RateLimit-Remaining", "4321"),
            ("Retry-After", "60"));

        Assert.False(GitHubRateLimit.IsExhausted(maintenance));
    }
}
