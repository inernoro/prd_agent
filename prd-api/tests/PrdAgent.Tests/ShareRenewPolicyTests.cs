using PrdAgent.Core.Interfaces;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「这条链接还能不能续期」的判据守卫（Codex 第二十二轮 P2）。
///
/// 这条判据原先在三处各写了一遍 <c>AddDays(-7)</c>：续期端点的拒绝分支、分享列表的
/// inGracePeriod、数据抽屉的可续条数。改一处忘一处，界面就会承诺一件后端当场拒绝的事
/// ——数据抽屉正是这么对已撤销、过期超窗的链接说出「续期即可复活」的。
///
/// 收敛成 <see cref="ShareRenewPolicy"/> 之后，这里钉住它的语义：续期端点的两个拒绝分支
/// 与抽屉的可续计数必须同源，任何一侧漂了都要在这里变红。
/// </summary>
public class ShareRenewPolicyTests
{
    private static readonly DateTime Now = new(2026, 8, 29, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void 没有过期时间的链接一直可续()
    {
        Assert.True(ShareRenewPolicy.CanRenew(isRevoked: false, expiresAt: null, Now));
    }

    [Fact]
    public void 未过期的链接可续()
    {
        Assert.True(ShareRenewPolicy.CanRenew(false, Now.AddDays(3), Now));
    }

    [Fact]
    public void 刚过期还在宽限窗内的可续()
    {
        Assert.True(ShareRenewPolicy.CanRenew(false, Now.AddDays(-1), Now));
    }

    /// <summary>边界：正好卡在宽限窗起点上仍然可续（与续期端点的 &lt; cutoff 拒绝同源）。</summary>
    [Fact]
    public void 正好卡在宽限窗边界上可续()
    {
        Assert.True(ShareRenewPolicy.CanRenew(false, ShareRenewPolicy.GraceCutoff(Now), Now));
    }

    [Fact]
    public void 过期超出宽限窗不可续()
    {
        Assert.False(ShareRenewPolicy.CanRenew(
            false, ShareRenewPolicy.GraceCutoff(Now).AddSeconds(-1), Now));
    }

    /// <summary>已撤销与过期时间无关：撤销不可逆，续期端点无条件拒绝。</summary>
    [Fact]
    public void 已撤销的链接一律不可续()
    {
        Assert.False(ShareRenewPolicy.CanRenew(isRevoked: true, expiresAt: null, Now));
        Assert.False(ShareRenewPolicy.CanRenew(true, Now.AddDays(3), Now));
        Assert.False(ShareRenewPolicy.CanRenew(true, Now.AddDays(-1), Now));
    }

    [Fact]
    public void 宽限窗天数就是判据里那个数()
    {
        Assert.Equal(ShareRenewPolicy.GraceCutoff(Now), Now.AddDays(-ShareRenewPolicy.GraceDays));
    }

    /// <summary>
    /// 永久有效的链接（没有 ExpiresAt）不许被「续期」写上一个期限。
    ///
    /// 续期基准原先是 `ExpiresAt.HasValue && > now ? ExpiresAt : now`——null 落进 now 那一支，
    /// 于是一条永不过期的链接点一下「续期」，变成 7 天后过期。按钮写着续期，做的却是
    /// 加上期限：做的事和说的相反，比不点还糟。
    ///
    /// CanRenew 对 null 仍返回 true（它答的是「这条链接死没死」，永久链接当然没死），
    /// 危害出在续期**动作**里，所以判据钉在那一段源码上：永久链接必须提前返回，
    /// 不许走到写 ExpiresAt 那一步。
    /// </summary>
    [Fact]
    public void 永久链接续期是空动作_不许被盖上期限()
    {
        var src = File.ReadAllText(Path.Combine(LocateSrcRoot(),
            "PrdAgent.Infrastructure", "Services", "HostedSiteService.cs"));
        var i = src.IndexOf("public async Task<RenewShareResult> RenewShareAsync", StringComparison.Ordinal);
        Assert.True(i > 0, "找不到 RenewShareAsync，测试该跟着改");
        var body = src[i..];
        var head = body[..Math.Min(body.Length, 2500)];

        var guard = head.IndexOf("!share.ExpiresAt.HasValue", StringComparison.Ordinal);
        var write = head.IndexOf(".Set(x => x.ExpiresAt", StringComparison.Ordinal);
        Assert.True(guard > 0, "永久链接没有被提前挡住，点续期会给它盖上一个期限");
        Assert.True(write < 0 || guard < write, "挡永久链接那一步必须排在写 ExpiresAt 之前");
    }

    private static string LocateSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln"))) return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
