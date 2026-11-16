using PrdAgent.Api.Services.ModelLeaderboard;
using PrdAgent.Core.Models;
using Xunit;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

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

    [Fact]
    public void 同一发布批次重复同步保留上一批次名次()
    {
        var previous = new List<ModelLeaderboardEntry> { new() { Name = "Model", Rank = 1, PreviousRank = 4 } };
        var current = new List<ModelLeaderboardEntry> { new() { Name = "Model", Rank = 1 } };
        ModelLeaderboardSyncService.ApplyPreviousRanks(current, previous, samePublication: true);
        Assert.Equal(4, current[0].PreviousRank);
    }

    [Fact]
    public async Task 已有Html抓取时间不阻止官方发布入库_较旧发布不能覆盖新发布()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var database = "leaderboard_publication_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        try
        {
            var db = new MongoDbContext(connection, database);
            var scope = ModelLeaderboardScope.Current;
            var published = DateTime.UtcNow.Date;
            var oldFetched = published.AddTicks(TimeSpan.TicksPerMillisecond);
            var id = ModelLeaderboardScope.DocumentId("agent", scope);
            var rows = Enumerable.Range(0, 5).Select(i => new ModelLeaderboardEntry { Name = "Model " + i, Rank = i + 2 }).ToList();
            await db.ModelLeaderboardSnapshots.InsertOneAsync(new()
            {
                Id = id, Board = "agent", DeploymentSlug = scope, FetchedAt = oldFetched,
                SourceUrl = ArenaLeaderboardFetcher.BuildUrl("agent"), Entries = rows,
            });
            var fresh = rows.Select(e => new ModelLeaderboardEntry { Name = e.Name, Rank = e.Rank - 1 }).ToList();
            var source = new FixedSource(new(BoardKind.Agent, fresh, null, null, PublishedAt: published));
            var service = new ModelLeaderboardSyncService(db, null!, new ConfigurationBuilder().Build(), NullLogger<ModelLeaderboardSyncService>.Instance);
            await service.SyncBoardAsync(source, "agent", "test", default);
            var saved = await db.ModelLeaderboardSnapshots.Find(e => e.Id == id).SingleAsync();
            Assert.Equal(published, saved.PublishedAt);
            Assert.True(saved.FetchedAt > oldFetched);
            Assert.Equal(1, saved.Entries[0].Rank);
            Assert.Equal(2, saved.Entries[0].PreviousRank);

            source.Result = source.Result with { PublishedAt = published.AddDays(-1) };
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.SyncBoardAsync(source, "agent", "test", default));
            var after = await db.ModelLeaderboardSnapshots.Find(e => e.Id == id).SingleAsync();
            Assert.Equal(saved.FetchedAt, after.FetchedAt);
            Assert.Equal(published, after.PublishedAt);
        }
        finally { await client.DropDatabaseAsync(database); }
    }

    private sealed class FixedSource(ArenaLeaderboardFetcher.ParseResult result) : IModelLeaderboardFetcher
    {
        public ArenaLeaderboardFetcher.ParseResult Result { get; set; } = result;
        public Task<ArenaLeaderboardFetcher.ParseResult> FetchAsync(string board, CancellationToken ct) => Task.FromResult(Result);
    }
}
