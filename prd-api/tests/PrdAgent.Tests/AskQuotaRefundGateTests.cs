using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「这一次失败该不该退配额」的判据守卫（Codex 第二十四轮 P2）。
///
/// 原来这三个条件埋在控制器的一个局部函数里，其中「已经退过就别再退」那条压根不存在：
/// 两条内层失败出口退完款之后都要写一条 SSE error，而那两处的写入没有吞
/// ObjectDisposedException——访客此时已断开的话它抛出来、落到外层 catch，退款第二次执行，
/// 而「没有产出」「扣成过」两个条件照旧成立，于是退了两次。
///
/// 后果不对称：站点那个计数是所有访客共用的，多退一次抹掉的是**别人**的用量，
/// 配额闸从此漏；少退一次只是这个用户少一次额度。所以宁可少退也不能多退。
/// </summary>
public class AskQuotaRefundGateTests
{
    [Fact]
    public void 一个字都没产出且扣成过_该退()
    {
        Assert.True(AskAccessPolicy.ShouldRefundQuota(alreadyRefunded: false, producedLength: 0, consumed: true));
    }

    /// <summary>核心用例：第二条失败出口不许再退一遍。</summary>
    [Fact]
    public void 已经退过_不许再退()
    {
        Assert.False(AskAccessPolicy.ShouldRefundQuota(alreadyRefunded: true, producedLength: 0, consumed: true));
    }

    [Fact]
    public void 答到一半断掉_token已经花了_不退()
    {
        Assert.False(AskAccessPolicy.ShouldRefundQuota(false, producedLength: 120, consumed: true));
    }

    [Fact]
    public void 进场压根没扣成_没什么可退()
    {
        // 退了反而是从别人的计数里扣
        Assert.False(AskAccessPolicy.ShouldRefundQuota(false, producedLength: 0, consumed: false));
    }

    [Fact]
    public void 三个条件互不替代()
    {
        // 任意一条不满足就不退，不存在「两条成立就放行」的组合
        Assert.False(AskAccessPolicy.ShouldRefundQuota(true, 0, false));
        Assert.False(AskAccessPolicy.ShouldRefundQuota(true, 5, true));
        Assert.False(AskAccessPolicy.ShouldRefundQuota(false, 5, false));
    }
}
