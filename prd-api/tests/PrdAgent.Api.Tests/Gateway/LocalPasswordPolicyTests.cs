using System.IO;
using PrdAgent.LlmGw.Auth;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 网关本地口令准入判定的守卫。
///
/// 起因：MAP 一键登录自动建的网关账号，用户名是 map-{hash}、口令是建号时随机生成的，
/// 两个值没有任何人知道；而改密无条件要求旧口令，于是这类账号既登不进来也改不了口令。
/// 豁免旧口令是敏感放宽，判定必须只有一处定义、且每种账号形态都钉死断言——
/// 判据一旦悄悄放宽到独立口令账号，就等于任何持有会话的人都能无凭据改密。
/// </summary>
public class LocalPasswordPolicyTests
{
    [Fact]
    public void FederatedAccount_BeforeAnyHumanClaim_SkipsOldPassword()
    {
        // 口令是建号时随机生成的，世上无人知道；要求旧口令等于永久锁死。
        Assert.False(LocalPasswordPolicy.RequiresOldPassword("map", passwordChangedByUser: false));
        Assert.False(LocalPasswordPolicy.HasUsablePassword("map", passwordChangedByUser: false));
    }

    [Fact]
    public void FederatedAccount_AfterHumanClaim_RequiresOldPasswordAgain()
    {
        // 认领之后立刻回到常规校验，豁免只发生一次。
        Assert.True(LocalPasswordPolicy.RequiresOldPassword("map", passwordChangedByUser: true));
        Assert.True(LocalPasswordPolicy.HasUsablePassword("map", passwordChangedByUser: true));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void LocalAccount_AlwaysRequiresOldPassword(string? identityProvider)
    {
        // 独立口令账号的口令来自部署环境变量，是「有人知道的」。
        // 这两条断言是安全边界：一旦放宽，持有任意会话即可无凭据改密。
        Assert.True(LocalPasswordPolicy.RequiresOldPassword(identityProvider, passwordChangedByUser: false));
        Assert.True(LocalPasswordPolicy.RequiresOldPassword(identityProvider, passwordChangedByUser: true));
    }

    [Theory]
    [InlineData("Inernoro", "inernoro")]
    [InlineData("  gw.admin  ", "gw.admin")]
    [InlineData("a_b-c9", "a_b-c9")]
    public void Username_IsNormalizedToLowercase(string raw, string expected)
    {
        // 登录查询区分大小写，不统一就会出现「看着一样却登不进」的两个账号。
        Assert.True(LocalPasswordPolicy.TryNormalizeUsername(raw, out var normalized, out var error));
        Assert.Null(error);
        Assert.Equal(expected, normalized);
    }

    [Theory]
    [InlineData("ab")]                                   // 太短
    [InlineData("this-name-is-far-too-long-to-accept-x")] // 太长
    [InlineData(".leading-dot")]                          // 非字母数字开头
    [InlineData("has space")]
    [InlineData("has@at")]
    [InlineData("中文名")]
    public void Username_RejectsMalformedInput(string raw)
    {
        Assert.False(LocalPasswordPolicy.TryNormalizeUsername(raw, out _, out var error));
        Assert.False(string.IsNullOrWhiteSpace(error));
    }

    [Theory]
    [InlineData("map-abc123")]
    [InlineData("MAP-ABC123")]
    public void Username_RejectsAutoProvisionedPrefix(string raw)
    {
        // map- 是一键登录自动建号的命名空间。放任真人占用，
        // 下一个 SSO 用户就会撞上唯一索引直接建不出账号。大小写变体同样要挡住。
        Assert.False(LocalPasswordPolicy.TryNormalizeUsername(raw, out _, out var error));
        Assert.Contains(LocalPasswordPolicy.ReservedUsernamePrefix, error);
    }
}

/// <summary>
/// 账号自助管理这条链路的接线守卫。
///
/// 上面的纯函数测试只能证明判定本身对；判定接没接进端点、页面有没有入口，
/// 删掉都不会让任何用例变红——网关此前正是这样断头的：改密逻辑一直在，
/// 只是从来没有一个入口能走到它。所以这几条按物理路径读源码钉死接线。
/// </summary>
public class AccountSelfServiceWiringTests
{
    private static string ReadRepoFile(string relative)
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "llmgw")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relative);
        Assert.True(File.Exists(full), $"找不到 {relative}");
        return File.ReadAllText(full);
    }

    [Fact]
    public void ChangePasswordEndpoint_DelegatesTheExemptionToThePolicy()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        // 端点必须走共享判定源。自己就地写一份 identityProvider == "map" 的条件，
        // 上面那组安全断言就管不到它了。
        Assert.Contains("LocalPasswordPolicy.RequiresOldPassword(user.IdentityProvider, user.PasswordChangedByUser)", program);
        Assert.Contains("if (requiresOldPassword && !PasswordHasher.Verify(oldPwd, user.PasswordHash))", program);
        // 联邦账号的自动用户名没人记得住，不能改名的话设了口令也登不进来。
        Assert.Contains("LocalPasswordPolicy.TryNormalizeUsername", program);
        Assert.Contains("\"USERNAME_TAKEN\"", program);
    }

    [Fact]
    public void AccountEndpoint_TellsTheUserWhatTheirLoginNameIs()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("\"/gw/auth/account\"", program);
        // 任何角色都要能管自己的凭据，不能挂在按角色收窄的策略上。
        var idx = program.IndexOf("\"/gw/auth/account\"", System.StringComparison.Ordinal);
        var block = program[idx..System.Math.Min(program.Length, idx + 2200)];
        Assert.Contains(".RequireAuthorization();", block);
    }

    [Fact]
    public void Console_HasAReachableEntryToAccountSecurity()
    {
        // 断头的那一半：后端能改密，但用户菜单里没有任何入口能走到。
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");
        Assert.Contains("/account", layout);

        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        Assert.Contains("path=\"/account\"", app);
        Assert.Contains("AccountSecurityPage", app);
    }
}
