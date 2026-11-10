using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Reflection;
using System.Runtime.CompilerServices;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ShortVideoMaterialProcessorTests
{
    [Fact]
    public void RequireResolvedVideoUrl_ShouldRejectMissingVideoUrl()
    {
        var ex = Should.Throw<InvalidOperationException>(() => ShortVideoMaterialProcessor.RequireResolvedVideoUrl(null));

        ex.Message.ShouldContain("未返回可下载的视频文件地址");
    }

    [Theory]
    [InlineData("/video.mp4")]
    [InlineData("file:///tmp/video.mp4")]
    public void RequireResolvedVideoUrl_ShouldRejectInvalidVideoUrl(string videoUrl)
    {
        var ex = Should.Throw<InvalidOperationException>(() => ShortVideoMaterialProcessor.RequireResolvedVideoUrl(videoUrl));

        ex.Message.ShouldContain("视频文件地址无效");
    }

    [Fact]
    public void RequireResolvedVideoUrl_ShouldReturnTrimmedHttpVideoUrl()
    {
        var result = ShortVideoMaterialProcessor.RequireResolvedVideoUrl(" https://cdn.example.test/video.mp4 ");

        result.ShouldBe("https://cdn.example.test/video.mp4");
    }

    [Theory]
    [InlineData("这不是链接")]
    [InlineData("/video.mp4")]
    [InlineData("file:///tmp/video.mp4")]
    [InlineData("https:///missing-host")]
    public void IsHttpUrl_ShouldRejectNonPublicUrl(string value)
    {
        ShortVideoMaterialProcessor.IsHttpUrl(value).ShouldBeFalse();
    }

    [Theory]
    [InlineData("https://www.bilibili.com/video/BV1test")]
    [InlineData(" http://example.test/video ")]
    public void IsHttpUrl_ShouldAcceptCompleteHttpUrl(string value)
    {
        ShortVideoMaterialProcessor.IsHttpUrl(value).ShouldBeTrue();
    }
    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("running", "original-owner", "original-permit", "original-user", true)]
    [InlineData("done", "original-owner", "original-permit", "original-user", false)]
    [InlineData("failed", "original-owner", "original-permit", "original-user", false)]
    [InlineData("cancelled", "original-owner", "original-permit", "original-user", false)]
    [InlineData("running", "new-owner", "original-permit", "original-user", false)]
    [InlineData("running", "original-owner", "new-permit", "original-user", false)]
    [InlineData("running", "original-owner", "original-permit", "another-user", false)]
    [InlineData(null, null, null, null, false)]
    public async Task ProcessingSaveConsumer_RejectsLostOwnershipAndNeverRecreatesRun(
        string? status, string? owner, string? permit, string? user, bool shouldMatch)
    {
        var pending = new ShortVideoMaterialRun { Id = "synthetic-run", Status = "done",
            OwnerInstanceId = "original-owner", TaskPermitId = "original-permit", UserId = "original-user" };
        var stored = status is null ? null : new ShortVideoMaterialRun { Id = pending.Id,
            Status = status, OwnerInstanceId = owner, TaskPermitId = permit, UserId = user! };
        SetProcessingToken(pending, "original-processing");
        if (stored is not null) SetProcessingToken(stored, "original-processing");
        var rows = new Mock<IMongoCollection<ShortVideoMaterialRun>>(MockBehavior.Strict);
        FilterDefinition<ShortVideoMaterialRun>? captured = null; ReplaceOptions? options = null;
        rows.Setup(x => x.ReplaceOneAsync(It.IsAny<FilterDefinition<ShortVideoMaterialRun>>(), pending,
            It.IsAny<ReplaceOptions>(), CancellationToken.None))
            .Returns<FilterDefinition<ShortVideoMaterialRun>, ShortVideoMaterialRun, ReplaceOptions, CancellationToken>(
                (query, _, supplied, _) =>
                {
                    captured = query; options = supplied;
                    var filter = query.Render(new RenderArgs<ShortVideoMaterialRun>(
                        BsonSerializer.LookupSerializer<ShortVideoMaterialRun>(), BsonSerializer.SerializerRegistry)).AsBsonDocument;
                    var match = stored is not null && MatchesStoredRun(filter, stored.ToBsonDocument());
                    return Task.FromResult<ReplaceOneResult>(new ReplaceOneResult.Acknowledged(match ? 1 : 0, match ? 1 : 0, null));
                });
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<ShortVideoMaterialRun>("short_video_material_runs", null)).Returns(rows.Object);
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(context, database.Object);
        var services = new Mock<IServiceProvider>(MockBehavior.Strict);
        var documents = new Mock<IDocumentService>(MockBehavior.Strict);
        var processor = new ShortVideoMaterialProcessor(context, documents.Object, new ConfigurationBuilder().Build(),
            services.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger<ShortVideoMaterialProcessor>.Instance);
        var method = typeof(ShortVideoMaterialProcessor).GetMethod("SaveRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var failure = await Record.ExceptionAsync(async () => await (Task)method.Invoke(processor, [pending])!);
        if (shouldMatch) failure.ShouldBeNull();
        else failure.ShouldBeOfType<InvalidOperationException>();
        options.ShouldNotBeNull(); options.IsUpsert.ShouldBeFalse(); captured.ShouldNotBeNull();
        services.VerifyNoOtherCalls(); documents.VerifyNoOtherCalls();
    }

    private static void SetProcessingToken(ShortVideoMaterialRun run, string? token)
        => typeof(ShortVideoMaterialRun).GetProperty("ProcessingToken")?.SetValue(run, token);

    private static bool MatchesStoredRun(BsonDocument filter, BsonDocument stored)
        => filter.All(field => field.Name == "$and"
            ? field.Value.AsBsonArray.All(child => MatchesStoredRun(child.AsBsonDocument, stored))
            : !field.Name.StartsWith('$') && stored.GetValue(field.Name, BsonNull.Value) == field.Value);

    [Fact]
    [Trait("Category", "Unit")]
    public Task ErrorCompletionConsumer_DoesNotOverwriteReplacementOwner()
        => AssertErrorCompletionKeepsReplacementAsync(true);

    [Fact]
    [Trait("Category", "Unit")]
    public Task ErrorCompletionConsumer_DoesNotOverwriteNewProcessingInSameOwner()
        => AssertErrorCompletionKeepsReplacementAsync(false);

    [Fact]
    [Trait("Category", "Unit")]
    public Task ErrorCompletionConsumer_CompletesOriginalProcessing()
        => AssertErrorCompletionKeepsReplacementAsync(false, false);

    private static async Task AssertErrorCompletionKeepsReplacementAsync(bool changedOwner, bool replacement = true)
    {
        var claimed = new ShortVideoMaterialRun { Id = "synthetic-run", UserId = "synthetic-user",
            OwnerInstanceId = "original-owner", TaskPermitId = "original-permit", Status = "running" };
        var stored = new ShortVideoMaterialRun { Id = claimed.Id, UserId = claimed.UserId,
            OwnerInstanceId = changedOwner ? "new-owner" : "original-owner", TaskPermitId = claimed.TaskPermitId, Status = "running" };
        SetProcessingToken(claimed, "original-processing"); SetProcessingToken(stored, replacement ? "replacement-processing" : "original-processing");
        var rows = new Mock<IMongoCollection<ShortVideoMaterialRun>>(MockBehavior.Strict);
        rows.Setup(x => x.FindOneAndUpdateAsync(It.IsAny<FilterDefinition<ShortVideoMaterialRun>>(),
            It.IsAny<UpdateDefinition<ShortVideoMaterialRun>>(), It.IsAny<FindOneAndUpdateOptions<ShortVideoMaterialRun, ShortVideoMaterialRun>>(),
            CancellationToken.None)).ReturnsAsync(claimed);
        var reads = 0; var writes = 0;
        rows.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<ShortVideoMaterialRun>>(),
            It.IsAny<FindOptions<ShortVideoMaterialRun, ShortVideoMaterialRun>>(), CancellationToken.None))
            .Returns<FilterDefinition<ShortVideoMaterialRun>, FindOptions<ShortVideoMaterialRun, ShortVideoMaterialRun>, CancellationToken>((query, _, _) =>
            {
                var result = ++reads == 1 ? claimed : MatchesStoredRun(query.Render(new RenderArgs<ShortVideoMaterialRun>(
                    BsonSerializer.LookupSerializer<ShortVideoMaterialRun>(), BsonSerializer.SerializerRegistry)).AsBsonDocument,
                    stored.ToBsonDocument()) ? stored : null;
                return Task.FromResult(CursorFor(result));
            });
        rows.Setup(x => x.ReplaceOneAsync(It.IsAny<FilterDefinition<ShortVideoMaterialRun>>(),
            It.IsAny<ShortVideoMaterialRun>(), It.IsAny<ReplaceOptions>(), CancellationToken.None))
            .Returns<FilterDefinition<ShortVideoMaterialRun>, ShortVideoMaterialRun, ReplaceOptions, CancellationToken>((_, _, _, _) =>
            { writes++; return Task.FromResult<ReplaceOneResult>(new ReplaceOneResult.Acknowledged(1, 1, null)); });
        var context = ContextForRows(rows.Object);
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        coordinator.Setup(x => x.AcquireAsync(claimed.TaskPermitId, claimed.Id, CancellationToken.None))
            .ThrowsAsync(new InvalidOperationException("synthetic pre-I/O processing failure"));
        var processor = new ShortVideoMaterialProcessor(context, new Mock<IDocumentService>(MockBehavior.Strict).Object,
            new ConfigurationBuilder().Build(), new Mock<IServiceProvider>(MockBehavior.Strict).Object,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<ShortVideoMaterialProcessor>.Instance, coordinator.Object);
        using var services = new ServiceCollection().AddSingleton<IConfiguration>(new ConfigurationBuilder().Build())
            .AddSingleton(context).AddSingleton(processor).BuildServiceProvider();
        using var worker = new ShortVideoMaterialWorker(services.GetRequiredService<IServiceScopeFactory>(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<ShortVideoMaterialWorker>.Instance);
        await (Task)typeof(ShortVideoMaterialWorker).GetMethod("ProcessNextRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, null)!;
        writes.ShouldBe(replacement ? 0 : 1); stored.Status.ShouldBe(replacement ? "running" : "failed"); stored.OwnerInstanceId.ShouldBe(changedOwner ? "new-owner" : "original-owner");
        coordinator.Verify(x => x.AcquireAsync(claimed.TaskPermitId, claimed.Id, CancellationToken.None), Times.Once);
    }

    [Fact]
    [Trait("Category", "Unit")]
    public Task StopCompletionConsumer_DoesNotFailReplacementOwner()
        => AssertStopCompletionKeepsReplacementAsync(true);

    [Fact]
    [Trait("Category", "Unit")]
    public Task StopCompletionConsumer_DoesNotFailNewProcessingInSameOwner()
        => AssertStopCompletionKeepsReplacementAsync(false);

    [Fact]
    [Trait("Category", "Unit")]
    public Task StopCompletionConsumer_CompletesOriginalProcessing()
        => AssertStopCompletionKeepsReplacementAsync(false, false);

    private static async Task AssertStopCompletionKeepsReplacementAsync(bool changedOwner, bool replacement = true)
    {
        var claimed = new ShortVideoMaterialRun { Id = "synthetic-run", UserId = "synthetic-user",
            OwnerInstanceId = "original-owner", TaskPermitId = "original-permit", Status = "running" };
        var stored = new ShortVideoMaterialRun { Id = claimed.Id, UserId = claimed.UserId,
            OwnerInstanceId = changedOwner ? "new-owner" : "original-owner", TaskPermitId = claimed.TaskPermitId, Status = "running" };
        SetProcessingToken(claimed, "original-processing"); SetProcessingToken(stored, replacement ? "replacement-processing" : "original-processing");
        var rows = new Mock<IMongoCollection<ShortVideoMaterialRun>>(MockBehavior.Strict); var writes = 0;
        rows.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<ShortVideoMaterialRun>>(),
            It.IsAny<UpdateDefinition<ShortVideoMaterialRun>>(), null, CancellationToken.None))
            .Returns<FilterDefinition<ShortVideoMaterialRun>, UpdateDefinition<ShortVideoMaterialRun>, UpdateOptions, CancellationToken>((query, _, _, _) =>
            {
                var match = MatchesStoredRun(query.Render(new RenderArgs<ShortVideoMaterialRun>(
                    BsonSerializer.LookupSerializer<ShortVideoMaterialRun>(), BsonSerializer.SerializerRegistry)).AsBsonDocument, stored.ToBsonDocument());
                if (match) { writes++; stored.Status = "failed"; }
                return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(match ? 1 : 0, match ? 1 : 0, null));
            });
        using var services = new ServiceCollection().AddSingleton(ContextForRows(rows.Object)).BuildServiceProvider();
        using var worker = new ShortVideoMaterialWorker(services.GetRequiredService<IServiceScopeFactory>(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<ShortVideoMaterialWorker>.Instance);
        typeof(ShortVideoMaterialWorker).GetField("_currentRunId", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(worker, claimed.Id);
        typeof(ShortVideoMaterialWorker).GetField("_currentRun", BindingFlags.Instance | BindingFlags.NonPublic)?.SetValue(worker, claimed);
        await (Task)typeof(ShortVideoMaterialWorker).GetMethod("MarkCurrentRunFailedAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, ["synthetic normal stop"] )!;
        writes.ShouldBe(replacement ? 0 : 1); stored.Status.ShouldBe(replacement ? "running" : "failed");
    }

    private static MongoDbContext ContextForRows(IMongoCollection<ShortVideoMaterialRun> rows)
    {
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<ShortVideoMaterialRun>("short_video_material_runs", null)).Returns(rows);
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(context, database.Object);
        return context;
    }

    private static IAsyncCursor<ShortVideoMaterialRun> CursorFor(ShortVideoMaterialRun? run)
    {
        var cursor = new Mock<IAsyncCursor<ShortVideoMaterialRun>>(MockBehavior.Strict);
        cursor.SetupGet(x => x.Current).Returns(run is null ? Array.Empty<ShortVideoMaterialRun>() : [run]);
        cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
        cursor.Setup(x => x.Dispose()); return cursor.Object;
    }

}
