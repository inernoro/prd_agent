using PrdAgent.Core.Diagnostics;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 构建身份对账守卫。
///
/// 这组用例锁死的是 2026-08-04 那次真实事故的形状：版本端点只报一个 commit，
/// 取自可被平台改写的环境变量，于是「镜像还是旧的」和「新代码已上线」在端点上
/// 长得一模一样。判据必须是双值对账，且缺证据时只能判 Unknown，不许乐观判 Match。
/// </summary>
public class BuildIdentityTests
{
    [Theory]
    [InlineData("1.0.0+8c739e684c961cbf5d51a2b5866c3bb10f3f8741", "8c739e684c961cbf5d51a2b5866c3bb10f3f8741")]
    [InlineData("1.0.0+abc1234", "abc1234")]
    [InlineData("1.0.0", null)]           // 没传 SourceRevisionId 的旧镜像
    [InlineData("1.0.0+", null)]          // 传了空值
    [InlineData("", null)]
    [InlineData(null, null)]
    public void ParseBakedCommit_只认编译期烤进来的后缀(string? informational, string? expected)
    {
        Assert.Equal(expected, BuildIdentity.ParseBakedCommit(informational));
    }

    [Fact]
    public void 实际值与期待值一致时判_Match()
    {
        var sha = "854e6c5b1234567890abcdef1234567890abcdef";
        Assert.Equal(BuildIdentity.MatchState.Match, BuildIdentity.Compare(sha, sha));
    }

    [Fact]
    public void 短SHA与长SHA同源时仍判_Match()
    {
        Assert.Equal(BuildIdentity.MatchState.Match,
            BuildIdentity.Compare("854e6c5b1234567890abcdef1234567890abcdef", "854e6c5b"));
    }

    [Fact]
    public void 事故场景_二进制旧而部署声明新_必须判_Mismatch()
    {
        // 容器跑的是 8c739e68 的镜像，平台却把 env 刷成了 9fb68489
        var state = BuildIdentity.Compare(
            "8c739e684c961cbf5d51a2b5866c3bb10f3f8741",
            "9fb6848994ab6b6bb282b75aff306209c89dfef6");

        Assert.Equal(BuildIdentity.MatchState.Mismatch, state);
        var warning = BuildIdentity.DescribeMismatch(state,
            "8c739e684c961cbf5d51a2b5866c3bb10f3f8741",
            "9fb6848994ab6b6bb282b75aff306209c89dfef6");
        Assert.NotNull(warning);
        Assert.Contains("8c739e68", warning);
        Assert.Contains("9fb68489", warning);
    }

    [Theory]
    [InlineData(null, "9fb68489")]   // 旧镜像没烤 commit
    [InlineData("9fb68489", null)]   // 没注入部署声明
    [InlineData(null, null)]
    [InlineData("", "  ")]
    public void 缺任一边只能判_Unknown_不许乐观判_Match(string? actual, string? declared)
    {
        Assert.Equal(BuildIdentity.MatchState.Unknown, BuildIdentity.Compare(actual, declared));
    }

    [Fact]
    public void 只有_Mismatch_才产生告警文案()
    {
        Assert.Null(BuildIdentity.DescribeMismatch(BuildIdentity.MatchState.Match, "a", "a"));
        Assert.Null(BuildIdentity.DescribeMismatch(BuildIdentity.MatchState.Unknown, null, "a"));
    }

    [Theory]
    [InlineData(BuildIdentity.MatchState.Match, "match")]
    [InlineData(BuildIdentity.MatchState.Mismatch, "mismatch")]
    [InlineData(BuildIdentity.MatchState.Unknown, "unknown")]
    public void 出参用稳定的小写字符串(BuildIdentity.MatchState state, string expected)
    {
        Assert.Equal(expected, BuildIdentity.ToWireValue(state));
    }
}
