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
        // 按空格切开逐个比对，不做子串匹配：`public_repo` 里也含 "repo"，
        // 而它恰恰**不给**私有仓权限——子串断言会在有人把默认值换成 public_repo 时
        // 保持绿色，等于把这条私有仓承诺的守卫废掉（形状 4a）。
        var granted = Granted(configured);

        granted.ShouldContain("repo", customMessage: "缺了完整的 repo scope，私有仓会一律 404");
        granted.ShouldContain("read:user", customMessage: "缺了 read:user，拿不到连接账号的信息");
    }

    [Fact]
    public void public_repo不算数_它不给私有仓权限()
    {
        // 这条是上一条的对照：证明那个断言真的能红，而不是被子串匹配蒙混过去。
        Granted("public_repo,read:user").ShouldNotContain("repo");
    }

    [Theory]
    [InlineData("  public_repo,read:user  ")]
    [InlineData("public_repo read:user")]
    [InlineData("public_repo,  read:user")]
    public void 发出去的scope按空格分隔_逗号写法一并归一(string configured)
    {
        // GitHub 的 scope 参数是空格分隔的（本仓库另一个 GitHub 客户端发的也是 `repo read:user`）。
        // 逗号写法会被当成一个没见过的 scope，授权可能被拒、或拿到一把不含 repo 的 token。
        GitHubOAuthService.ResolveScopes(configured).ShouldBe("public_repo read:user");
    }

    /// <summary>按 GitHub 的分隔符（空格）切出实际申请到的 scope 列表。</summary>
    private static string[] Granted(string? configured)
        => GitHubOAuthService.ResolveScopes(configured)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
