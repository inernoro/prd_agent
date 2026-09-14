using PrdAgent.Infrastructure.GitHub;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// Device Flow 申请的 OAuth scope。
///
/// 事故形状：docker-compose 把这一项写成 `${GitHubOAuth__Scopes:-}`，没在 .env 显式给值时
/// 注入的是**空字符串**而不是缺失，于是 `?? 默认值` 不生效，拿到一把没有任何 scope 的 token。
/// 公开仓照样能读，私有仓一律 404——而 GitHub 对无权访问的私有仓返回的正是 404，
/// 和「仓库不存在」无法区分，整条私有仓同步的承诺就此静默落空。
/// </summary>
public class GitHubOAuthScopesTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void 没配或配成空白时回落到默认scope(string? configured)
    {
        // 按逗号切开逐个比对，不做子串匹配：`public_repo` 里也含 "repo"，
        // 而它恰恰**不给**私有仓权限——子串断言会在有人把默认值换成 public_repo 时
        // 保持绿色，等于把这条私有仓承诺的守卫废掉（形状 4a）。
        var granted = GitHubOAuthService.ResolveScopes(configured)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        granted.ShouldContain("repo", customMessage: "缺了完整的 repo scope，私有仓会一律 404");
        granted.ShouldContain("read:user", customMessage: "缺了 read:user，拿不到连接账号的信息");
    }

    [Fact]
    public void public_repo不算数——它不给私有仓权限()
    {
        // 这条是上一条的对照：证明那个断言真的能红，而不是被子串匹配蒙混过去。
        var granted = GitHubOAuthService.ResolveScopes("public_repo,read:user")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        granted.ShouldNotContain("repo");
    }

    [Fact]
    public void 显式配置原样使用并去掉首尾空白()
    {
        GitHubOAuthService.ResolveScopes("  public_repo,read:user  ")
            .ShouldBe("public_repo,read:user");
    }
}
