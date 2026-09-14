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
        var scopes = GitHubOAuthService.ResolveScopes(configured);

        scopes.ShouldContain("repo", customMessage: "缺了 repo，私有仓会一律 404");
        scopes.ShouldContain("read:user", customMessage: "缺了 read:user，拿不到连接账号的信息");
    }

    [Fact]
    public void 显式配置原样使用并去掉首尾空白()
    {
        GitHubOAuthService.ResolveScopes("  public_repo,read:user  ")
            .ShouldBe("public_repo,read:user");
    }
}
