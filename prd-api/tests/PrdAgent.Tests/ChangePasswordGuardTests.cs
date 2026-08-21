using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 自助改密的两条不变量，源码扫描钉住。
///
/// 这两条删掉之后编译过、全量测试全绿，而线上后果一个是停用形同虚设、一个是
/// 「改密码会踢掉其它设备」这句承诺落空——正是需要机械守卫的那种形状。
/// </summary>
public class ChangePasswordGuardTests
{
    private static string ChangePasswordSource()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var path = Path.Combine(dir!.FullName, "prd-api", "src", "PrdAgent.Api", "Controllers", "AuthController.cs");
        Assert.True(File.Exists(path), $"守卫要扫的源码不在预期位置：{path}");
        var source = File.ReadAllText(path);
        var start = source.IndexOf("public async Task<IActionResult> ChangePassword", StringComparison.Ordinal);
        Assert.True(start > 0, "找不到 ChangePassword —— 改过名字就要同步改这条守卫");
        var rest = source[start..];
        var end = rest.IndexOf("\n    [Http", StringComparison.Ordinal);
        return end > 0 ? rest[..end] : rest;
    }

    /// <summary>
    /// 停用的账号不许在这里续命：停用后既有 access token 还在有效期内，
    /// 放它改密码就会拿到一套全新令牌，然后在每次过期前再改一次，永远登着。
    /// </summary>
    [Fact]
    public void 停用账号不许改密码()
    {
        var body = ChangePasswordSource();
        Assert.Contains("user.Status != UserStatus.Active", body);

        // 判定必须排在换密码**之前**，放后面等于已经改完了。
        var gate = body.IndexOf("user.Status != UserStatus.Active", StringComparison.Ordinal);
        var replace = body.IndexOf("TryReplacePasswordAsync", StringComparison.Ordinal);
        Assert.True(replace > gate, "停用判定必须排在换密码之前");
    }

    /// <summary>
    /// 并发改密只许一个赢。校验旧密码和写新密码之间有窗口，两个会话可以同时通过校验；
    /// 都无条件写下去的话，两边接着各自清会话、各自签发新会话——没写赢的那一方仍然登着。
    /// </summary>
    [Fact]
    public void 并发改密只许一个赢()
    {
        var body = ChangePasswordSource();
        Assert.Contains("TryReplacePasswordAsync", body);
        Assert.Contains("PASSWORD_CHANGED_ELSEWHERE", body);
        // 无条件写就是那个 bug。
        Assert.DoesNotContain("_userService.UpdatePasswordAsync(user.UserId", body);
    }

    /// <summary>
    /// 发新令牌之前要再确认一次账号还是启用的。
    ///
    /// 换密那句已经是原子的，但它管不到之后：管理员在换密成功与签发之间把人停掉，
    /// 后面这段会照着换密那一刻的快照继续走——先推高会话版本（盖过管理员刚做的踢下线），
    /// 再签一套当前版本的新令牌，被停用的账号又拿到完整凭据。
    /// </summary>
    [Fact]
    public void 签发新令牌前要重新确认账号还启用()
    {
        var body = ChangePasswordSource();

        var replaceAt = body.IndexOf("TryReplacePasswordAsync", StringComparison.Ordinal);
        var recheckAt = body.IndexOf("stillActive", StringComparison.Ordinal);
        var issueAt = body.IndexOf("CreateRefreshSessionAsync", StringComparison.Ordinal);

        Assert.True(recheckAt > replaceAt, "重新确认要排在换密之后");
        Assert.True(issueAt > recheckAt, "重新确认要排在签发之前");
        // 发现已停用时只吊销、不签发。
        Assert.Contains("USER_DISABLED", body[recheckAt..issueAt]);
    }

    /// <summary>条件更新的谓词必须真的带上旧散列，只改方法名不算。</summary>
    [Fact]
    public void 条件更新必须比对旧散列()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))) dir = dir.Parent;
        var repo = Path.Combine(dir!.FullName, "prd-api", "src", "PrdAgent.Infrastructure", "Repositories", "UserRepository.cs");
        var source = File.ReadAllText(repo);
        var body = source[source.IndexOf("TryReplacePasswordAsync", StringComparison.Ordinal)..];
        body = body[..body.IndexOf("\n    public", StringComparison.Ordinal)];

        Assert.Matches(new Regex(@"Eq\(u => u\.PasswordHash, expectedHash\)"), body);
        // 状态也要在这个原子谓词里。控制器那道 Active 检查读的是更早的快照——
        // 管理员在「读到还是启用」和「这句更新执行」之间把人停掉，更新照样成功，
        // 端点接着签发一整套新令牌，停用输给了改密。
        Assert.Matches(new Regex(@"Eq\(u => u\.Status, UserStatus\.Active\)"), body);
        Assert.Contains("ModifiedCount > 0", body);
    }
}
