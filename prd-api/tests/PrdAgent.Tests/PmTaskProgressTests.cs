using System.Collections.Generic;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 任务进度汇总数学测试（CI 可运行，纯函数免 DB）。
///
/// 覆盖 PmTask.ComputeParentProgress 的关键边界：
/// - done=100 / cancelled=0 / 其余取各自 ProgressPercent
/// - 均值四舍五入
/// - 越界进度裁剪
/// - 无子任务返回 null（不覆盖父任务进度）
/// </summary>
public class PmTaskProgressTests
{
    private static PmTask Child(string status, int progress)
        => new() { Status = status, ProgressPercent = progress };

    [Fact]
    public void NoChildren_ReturnsNull()
    {
        Assert.Null(PmTask.ComputeParentProgress(new List<PmTask>()));
    }

    [Fact]
    public void DoneCountsAs100_CancelledAs0()
    {
        var children = new[]
        {
            Child(PmTaskStatus.Done, 0),       // 100
            Child(PmTaskStatus.Cancelled, 50), // 0
        };
        // (100 + 0) / 2 = 50
        Assert.Equal(50, PmTask.ComputeParentProgress(children));
    }

    [Fact]
    public void InProgressTakesOwnPercent_RoundedMean()
    {
        var children = new[]
        {
            Child(PmTaskStatus.Done, 100),      // 100
            Child(PmTaskStatus.InProgress, 30), // 30
            Child(PmTaskStatus.Todo, 0),        // 0
        };
        // (100 + 30 + 0) / 3 = 43.33 → 43
        Assert.Equal(43, PmTask.ComputeParentProgress(children));
    }

    [Fact]
    public void OutOfRangeProgress_IsClamped()
    {
        var children = new[]
        {
            Child(PmTaskStatus.InProgress, 200), // 裁剪到 100
            Child(PmTaskStatus.InProgress, -50), // 裁剪到 0
        };
        // (100 + 0) / 2 = 50
        Assert.Equal(50, PmTask.ComputeParentProgress(children));
    }

    [Theory]
    [InlineData(-10, 0)]
    [InlineData(0, 0)]
    [InlineData(55, 55)]
    [InlineData(100, 100)]
    [InlineData(150, 100)]
    public void ClampProgress_Bounds(int input, int expected)
    {
        Assert.Equal(expected, PmTask.ClampProgress(input));
    }
}
