using System.Linq;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 目标 OKR 进度数学测试（CI 可运行，纯函数免 DB）。
///
/// 覆盖 PmKeyResult.ComputeProgress 的关键边界：
/// - percent / number 正向区间归一
/// - 递减型 KR（StartValue &gt; TargetValue，如「缺陷 100 → 0」）
/// - span=0（起止相等）
/// - 越界裁剪（current 低于 start / 高于 target）
/// - binary（是/否）
/// 以及叶子目标「KR 均值」汇总（EffectiveProgress 自动模式的 KR 来源）。
/// </summary>
public class PmGoalProgressTests
{
    private static PmKeyResult Kr(string type, double start, double target, double current)
        => new() { Type = type, StartValue = start, TargetValue = target, CurrentValue = current };

    [Theory]
    // 正向百分比：0→100，当前 50 → 50%
    [InlineData(PmKeyResultType.Percent, 0, 100, 50, 50)]
    [InlineData(PmKeyResultType.Percent, 0, 100, 0, 0)]
    [InlineData(PmKeyResultType.Percent, 0, 100, 100, 100)]
    // 数值区间：起 20 目标 70，当前 45 → (45-20)/(70-20)=50%
    [InlineData(PmKeyResultType.Number, 20, 70, 45, 50)]
    // 越界裁剪
    [InlineData(PmKeyResultType.Number, 20, 70, 10, 0)]   // 低于起点
    [InlineData(PmKeyResultType.Number, 20, 70, 999, 100)] // 高于目标
    // 递减型 KR：100 → 0，当前 40 → (40-100)/(0-100)=60%
    [InlineData(PmKeyResultType.Number, 100, 0, 40, 60)]
    [InlineData(PmKeyResultType.Number, 100, 0, 0, 100)]   // 达成（降到 0）
    [InlineData(PmKeyResultType.Number, 100, 0, 100, 0)]   // 起点
    public void ComputeProgress_NumericRanges(string type, double start, double target, double current, int expected)
    {
        Assert.Equal(expected, Kr(type, start, target, current).ComputeProgress());
    }

    [Fact]
    public void ComputeProgress_SpanZero_TreatedAsBinaryAtTarget()
    {
        // 起止相等：达到/超过目标算 100，否则 0
        Assert.Equal(100, Kr(PmKeyResultType.Number, 50, 50, 50).ComputeProgress());
        Assert.Equal(100, Kr(PmKeyResultType.Number, 50, 50, 60).ComputeProgress());
        Assert.Equal(0, Kr(PmKeyResultType.Number, 50, 50, 40).ComputeProgress());
    }

    [Theory]
    [InlineData(0, 0)]   // 未完成
    [InlineData(1, 100)] // 已完成
    [InlineData(2, 100)] // 任意 >=1 视为完成
    public void ComputeProgress_Binary(double current, int expected)
    {
        Assert.Equal(expected, Kr(PmKeyResultType.Binary, 0, 1, current).ComputeProgress());
    }

    [Fact]
    public void ComputeProgress_DefaultsToPercentForUnknownType()
    {
        // 未知类型按数值区间处理（与 MapKeyResults 归一一致：非法 type 落 percent）
        var kr = Kr("weird", 0, 200, 100);
        Assert.Equal(50, kr.ComputeProgress());
    }

    [Fact]
    public void LeafGoal_KrAverage_IsRoundedMean()
    {
        // 叶子目标自动进度 = 各 KR 完成度均值（ListGoals.EffectiveProgress 的 KR 分支）
        var krs = new[]
        {
            Kr(PmKeyResultType.Percent, 0, 100, 100), // 100
            Kr(PmKeyResultType.Number, 0, 10, 3),     // 30
            Kr(PmKeyResultType.Binary, 0, 1, 0),      // 0
        };
        var avg = (int)System.Math.Round(krs.Average(k => k.ComputeProgress()));
        Assert.Equal(43, avg); // (100+30+0)/3 = 43.33 → 43
    }
}
