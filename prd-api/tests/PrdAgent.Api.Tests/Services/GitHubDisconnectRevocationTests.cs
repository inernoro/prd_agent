using System.Net;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Infrastructure.GitHub;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 断开连接时向 GitHub 撤销授权的判据（2026-09-15 对抗审查 P2）。
///
/// 旧实现只删本地那条记录：用户点完「断开」，GitHub 的已授权应用列表里那一条还在，
/// 那把 token 对 GitHub 仍然有效。按钮说的是「断开」，做的却只是「本地忘掉」。
/// 撤销失败不阻断本地删除，但**必须让用户知道 GitHub 那边没撤掉、下一步该去哪**。
/// </summary>
public class GitHubDisconnectRevocationTests
{
    [Fact]
    public void 状态码204算撤销成功()
        => Assert.Equal(
            GitHubTokenRevocation.Revoked,
            GitHubOAuthService.MapRevocationStatus(HttpStatusCode.NoContent));

    [Fact]
    public void 状态码404说明这把令牌本来就没了()
        // 用户自己在 GitHub 上移除过：结果与撤销成功等价，不该报成失败吓人一跳。
        => Assert.Equal(
            GitHubTokenRevocation.AlreadyInvalid,
            GitHubOAuthService.MapRevocationStatus(HttpStatusCode.NotFound));

    [Fact]
    public void 其余状态码一律算撤销失败()
    {
        // 401/403 常见于应用密钥配错；500 是 GitHub 侧的问题。两者都不能当成功。
        Assert.Equal(GitHubTokenRevocation.Failed,
            GitHubOAuthService.MapRevocationStatus(HttpStatusCode.Unauthorized));
        Assert.Equal(GitHubTokenRevocation.Failed,
            GitHubOAuthService.MapRevocationStatus(HttpStatusCode.InternalServerError));
    }

    [Fact]
    public void 撤销成功时不多说一句话()
    {
        Assert.Null(GitHubConnectController.DescribeRevocation(GitHubTokenRevocation.Revoked));
        Assert.Null(GitHubConnectController.DescribeRevocation(GitHubTokenRevocation.AlreadyInvalid));
    }

    [Fact]
    public void 撤销没成时必须告诉用户去哪儿手动移除()
    {
        foreach (var failed in new[] { GitHubTokenRevocation.NotConfigured, GitHubTokenRevocation.Failed })
        {
            var hint = GitHubConnectController.DescribeRevocation(failed);
            Assert.NotNull(hint);
            // 「发生了什么 + 下一步」：本地删了要说，GitHub 那边没撤也要说，还要说清去哪儿撤。
            Assert.Contains("已删除", hint!);
            Assert.Contains("GitHub", hint);
            Assert.Contains("移除", hint);
        }
    }
}
