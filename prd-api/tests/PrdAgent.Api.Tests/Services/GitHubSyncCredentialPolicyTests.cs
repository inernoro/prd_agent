using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.GitHub;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// GitHub 目录同步的凭据判据。
///
/// 2026-09-09 验收 P1 的根因就锁在这里：条目盖了连接身份、token 却解不出来时，
/// 旧实现静默退回匿名请求——公开仓照拉、私有仓收到一个和「目录不存在」
/// 长得一模一样的 404，用户等了 312 秒什么都没有也无从诊断。
/// 这几条断言把「降级不许静默」钉死。
/// </summary>
public class GitHubSyncCredentialPolicyTests
{
    private const string UserId = "u-1";

    [Fact]
    public void 没盖连接身份的历史条目仍走匿名()
    {
        var credential = GitHubSyncCredentialPolicy.Decide(null, null, null);

        Assert.Equal("anonymous", credential.Mode);
        Assert.Null(credential.BlockReason);
        Assert.False(credential.HasConnection);
    }

    [Fact]
    public void 解得出token就带授权()
    {
        var credential = GitHubSyncCredentialPolicy.Decide(UserId, "gho_token", null);

        Assert.Equal("authorized", credential.Mode);
        Assert.Equal("gho_token", credential.Token);
        Assert.Null(credential.BlockReason);
    }

    [Fact]
    public void 连接已断开时阻断而不是退回匿名()
    {
        var credential = GitHubSyncCredentialPolicy.Decide(UserId, null, GitHubException.NotConnected());

        Assert.Equal("blocked", credential.Mode);
        Assert.Null(credential.Token);
        Assert.Equal(GitHubSyncCredentialPolicy.DisconnectedReason, credential.BlockReason);
        Assert.Contains("重新连接", credential.BlockReason!);
    }

    [Fact]
    public void token失效时阻断并说清要重新连接()
    {
        var credential = GitHubSyncCredentialPolicy.Decide(UserId, null, GitHubException.TokenExpired());

        Assert.Equal("blocked", credential.Mode);
        Assert.Equal(GitHubSyncCredentialPolicy.ExpiredReason, credential.BlockReason);
    }

    [Fact]
    public void 密文解不开时同样阻断()
    {
        // 非领域异常（密钥轮换导致解密失败）也不许退回匿名
        var credential = GitHubSyncCredentialPolicy.Decide(UserId, null, null);

        Assert.Equal("blocked", credential.Mode);
        Assert.Equal(GitHubSyncCredentialPolicy.UnreadableReason, credential.BlockReason);
    }

    [Fact]
    public void 空白连接身份等同于没盖()
    {
        Assert.False(GitHubSyncCredentialPolicy.HasConnectionStamp("   "));
        Assert.Equal("anonymous", GitHubSyncCredentialPolicy.Decide("  ", null, GitHubException.NotConnected()).Mode);
    }

    [Fact]
    public void 已撤销的连接不许盖到手贴订阅上()
    {
        // 盖了就必然带 token 同步；连接已被用户在 GitHub 侧撤销时，
        // 公开仓本来匿名能同步，盖上去反而每天 401——把能用的路径改坏了。
        Assert.False(GitHubSyncCredentialPolicy.ShouldStampConnection(
            true, GitHubSyncCredentialPolicy.ConnectionUsability.Revoked));
    }

    [Fact]
    public void 问不出结论时保持盖章()
    {
        // 网络抖动不是「不可用」。当成不可用会把私有仓订阅静默降成匿名，
        // 而匿名访问私有仓拿到的是 404，与「目录不存在」无法区分（形状 10）。
        Assert.True(GitHubSyncCredentialPolicy.ShouldStampConnection(
            true, GitHubSyncCredentialPolicy.ConnectionUsability.Unknown));
        Assert.True(GitHubSyncCredentialPolicy.ShouldStampConnection(
            true, GitHubSyncCredentialPolicy.ConnectionUsability.Usable));
    }

    [Fact]
    public void 压根没连过就不存在盖章问题()
    {
        Assert.False(GitHubSyncCredentialPolicy.ShouldStampConnection(
            false, GitHubSyncCredentialPolicy.ConnectionUsability.Usable));
    }
}
