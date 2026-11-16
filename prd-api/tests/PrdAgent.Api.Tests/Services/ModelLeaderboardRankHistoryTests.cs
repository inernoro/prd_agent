using PrdAgent.Api.Services.ModelLeaderboard;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ModelLeaderboardRankHistoryTests
{
    [Theory]
    [InlineData(false, "arena_unreachable")]
    [InlineData(true, "arena_markup_changed")]
    public void 用户错误保留稳定分类且不泄露上游诊断(bool invalidData, string expectedCode)
    {
        Exception error = invalidData ? new InvalidOperationException("hf_private_secret") : new HttpRequestException("hf_private_secret");
        var method = typeof(ModelLeaderboardSyncService).GetMethod("ClassifyFailure", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
        var (code, message) = ((string, string))method.Invoke(null, new object[] { error })!;
        Assert.Equal(expectedCode, code);
        Assert.Contains("上一份快照", message);
        Assert.Contains("重试", message);
        Assert.DoesNotContain("hf_private_secret", message);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void 同名变体不编造升降_唯一名称仍保留历史(bool duplicateInCurrent)
    {
        var previous = new List<ModelLeaderboardEntry> { new() { Name = "Variant", Rank = 2 }, new() { Name = "Unique", Rank = 5 } };
        var current = new List<ModelLeaderboardEntry> { new() { Name = "Variant", Rank = 1 }, new() { Name = "Unique", Rank = 3 } };
        (duplicateInCurrent ? current : previous).Add(new() { Name = "Variant", Rank = 4 });
        ModelLeaderboardSyncService.ApplyPreviousRanks(current, previous);
        Assert.All(current.Where(e => e.Name == "Variant"), e => Assert.Null(e.PreviousRank));
        Assert.Equal(5, current.Single(e => e.Name == "Unique").PreviousRank);
    }
}
