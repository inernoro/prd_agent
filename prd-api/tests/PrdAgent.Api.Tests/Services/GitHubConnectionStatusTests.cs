using PrdAgent.Api.Controllers.Api;
using PrdAgent.Infrastructure.GitHub;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 连接状态三态的线上契约（2026-09-15 对抗审查 P2）。
///
/// 旧实现只回 connected（库里有没有这条记录）。用户在 GitHub 那边撤销授权之后记录还在，
/// 于是界面显示「已连接」，一点仓库就是 401——错误出现在第二步，该修的事在第一步。
/// unknown 必须原样透出：把「没问出结论」压成「已失效」会把正常连接挡在门外。
/// </summary>
public class GitHubConnectionStatusTests
{
    [Theory]
    [InlineData(GitHubUserConnectionService.GitHubConnectionUsability.Usable, "usable")]
    [InlineData(GitHubUserConnectionService.GitHubConnectionUsability.Revoked, "revoked")]
    [InlineData(GitHubUserConnectionService.GitHubConnectionUsability.Unknown, "unknown")]
    public void 三态逐个映射到线上字符串(
        GitHubUserConnectionService.GitHubConnectionUsability probed, string expected)
        => Assert.Equal(expected, GitHubConnectController.DescribeUsability(probed));
}
