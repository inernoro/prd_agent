using PrdAgent.Core.Helpers;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 作品广场热度排序公式测试（CI 可运行，纯函数无需 Mongo）。
///
/// 这是 SubmissionsController 聚合管道排序的权威公式锚点：
/// 管道里的 (LikeCount*LikeWeight + ViewCount) / pow(ageHours+2, Gravity)
/// 必须与 GalleryRanking.HotScore 行为一致。
/// </summary>
public class GalleryRankingTests
{
    [Fact]
    public void NewWork_WithFewerLikes_CanOutrank_OldViralWork()
    {
        // 老爆款：100 赞，发布 30 天前（720 小时）
        var oldViral = GalleryRanking.HotScore(likeCount: 100, viewCount: 500, ageHours: 720);
        // 新作品：10 赞，刚发布 1 小时
        var freshWork = GalleryRanking.HotScore(likeCount: 10, viewCount: 20, ageHours: 1);

        Assert.True(freshWork > oldViral,
            $"新作品应能冒泡到老爆款之上 (fresh={freshWork}, oldViral={oldViral})");
    }

    [Fact]
    public void SameEngagement_OlderWork_ScoresLower()
    {
        var younger = GalleryRanking.HotScore(50, 100, ageHours: 2);
        var older = GalleryRanking.HotScore(50, 100, ageHours: 200);

        Assert.True(younger > older, "相同互动量下，越旧的作品热度越低（时间衰减单调）");
    }

    [Fact]
    public void MoreLikes_SameAge_ScoresHigher()
    {
        var low = GalleryRanking.HotScore(5, 0, ageHours: 10);
        var high = GalleryRanking.HotScore(50, 0, ageHours: 10);

        Assert.True(high > low, "同龄作品点赞越多热度越高");
    }

    [Fact]
    public void LikeIsWeightedHeavierThanView()
    {
        // 1 个赞应当显著重于 1 次浏览（LikeWeight = 3）
        var oneLike = GalleryRanking.HotScore(likeCount: 1, viewCount: 0, ageHours: 5);
        var oneView = GalleryRanking.HotScore(likeCount: 0, viewCount: 1, ageHours: 5);

        Assert.Equal(GalleryRanking.LikeWeight, oneLike / oneView, precision: 6);
    }

    [Fact]
    public void NegativeAge_IsClampedToZero_NoFutureBoost()
    {
        // 未来时间（负 ageHours）不应刷出更高分，按 0 处理
        var future = GalleryRanking.HotScore(10, 10, ageHours: -100);
        var atZero = GalleryRanking.HotScore(10, 10, ageHours: 0);

        Assert.Equal(atZero, future, precision: 9);
    }

    [Fact]
    public void DateTimeOverload_MatchesAgeHoursOverload()
    {
        var now = new DateTime(2026, 5, 17, 12, 0, 0, DateTimeKind.Utc);
        var createdAt = now.AddHours(-48);

        var viaDate = GalleryRanking.HotScore(20, 40, createdAt, now);
        var viaHours = GalleryRanking.HotScore(20, 40, ageHours: 48);

        Assert.Equal(viaHours, viaDate, precision: 9);
    }
}
