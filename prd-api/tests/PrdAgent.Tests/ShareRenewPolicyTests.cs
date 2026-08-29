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
}
