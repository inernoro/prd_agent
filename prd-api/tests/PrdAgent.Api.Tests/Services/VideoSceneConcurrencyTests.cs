using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using System.Reflection;
using System.Runtime.CompilerServices;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public partial class VideoSceneConcurrencyTests
{
    [Fact]
    public async Task SubmittedDirectCancellation_MustPreserveReconciliationAfterGenerationLeaseRevocation()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancel-submitted-reconcile", test.OwnerId, SceneItemStatus.Draft);
        run.Mode = VideoGenMode.Direct;
        run.Status = VideoGenRunStatus.Rendering;
        run.DirectVideoJobId = "synthetic-submitted-job";
        run.DirectVideoModel = "synthetic-original-model";
        run.DirectVideoOfferingId = "synthetic-original-offering";
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var executionLease = lease;
        (await test.CreateService().CancelRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeTrue();
        (await coordinator.ValidateAsync(lease.Proof, false, default)).ShouldBeFalse();
        var cancelled = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        cancelled.DirectVideoReconciledAt.ShouldBeNull();
        test.VideoClient.Setup(x => x.GetStatusForOfferingAsync(It.IsAny<string>(), run.DirectVideoJobId,
            run.DirectVideoModel, run.DirectVideoOfferingId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new OpenRouterVideoStatus { Status = "completed", Cost = 0.43 });
        using var worker = test.CreateWorker(coordinator);
        var process = (Task)typeof(VideoGenRunWorker).GetMethod("ProcessDirectVideoGenAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, [cancelled])!;
        await process;
        test.VideoClient.Verify(x => x.GetStatusForOfferingAsync(It.IsAny<string>(), run.DirectVideoJobId,
            run.DirectVideoModel, run.DirectVideoOfferingId, It.IsAny<CancellationToken>()), Times.Once);
        test.VideoClient.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(),
            It.IsAny<CancellationToken>()), Times.Never);
        var stored = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        stored.DirectVideoJobId.ShouldBe(run.DirectVideoJobId);
        stored.DirectVideoUpstreamStatus.ShouldBe("completed");
        stored.DirectVideoCost.ShouldBe(0.43);
        stored.DirectVideoReconciledAt.ShouldNotBeNull();
    }

    [Theory]
    [InlineData("completed", 0.43, null)]
    [InlineData("completed", null, "recorded-offering")]
    [InlineData("failed", null, null)]
    [InlineData("cancelled", 0.12, "recorded-offering")]
    [InlineData("expired", null, null)]
    public async Task DirectCancellationMock_ShouldReconcileSameJobBeforeTerminal(
        string terminalStatus, double? cost, string? offering)
    {
        using var test = new DirectCancellationFixture(offering);
        var calls = 0;
        test.Status = () =>
        {
            test.Run.Status.ShouldBe(VideoGenRunStatus.Rendering);
            test.Run.EndedAt.ShouldBeNull();
            return ++calls == 1
                ? new OpenRouterVideoStatus { Status = "in_progress", Cost = 0.01 }
                : new OpenRouterVideoStatus { Status = terminalStatus, Cost = cost, VideoUrl = "https://synthetic.invalid/never-download.mp4" };
        };
        await test.ProcessAsync();
        calls.ShouldBe(2);
        test.Run.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        test.Run.DirectVideoCost.ShouldBe(cost);
        test.Field("DirectVideoUpstreamStatus").ShouldBe(terminalStatus);
        test.Field("DirectVideoReconciledAt").ShouldNotBeNull();
        test.Run.EndedAt.ShouldNotBeNull();
        test.Run.VideoAssetUrl.ShouldBeNull();
        test.AssertNoSubmitOrDownload();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DirectCancellationMock_ShouldObserveCancellationDuringStatusReadBeforeDownload(bool afterStatusRead)
    {
        using var test = new DirectCancellationFixture(null);
        test.Run.CancelRequested = false;
        test.CancelAtDownloadingPhase = afterStatusRead;
        test.Status = () =>
        {
            if (!afterStatusRead) test.Run.CancelRequested = true;
            return new OpenRouterVideoStatus { Status = "completed", Cost = null, VideoUrl = "https://synthetic.invalid/never-download.mp4" };
        };
        await test.ProcessAsync();
        test.Run.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        test.Run.DirectVideoCost.ShouldBeNull();
        test.AssertNoSubmitOrDownload();
    }

    [Fact]
    public async Task DirectCancellationMock_WindowExpiryShouldRequeueSameJobWithoutFakeTerminal()
    {
        using var test = new DirectCancellationFixture("recorded-offering");
        test.Run.CreatedAt = DateTime.UnixEpoch;
        test.Run.QueueEnteredAt = DateTime.UnixEpoch;
        test.OtherQueuedRun = new VideoGenRun { QueueEnteredAt = DateTime.UnixEpoch.AddSeconds(1) };
        var historical = new BsonDocument(test.Run.ToBsonDocument().Where(field => field.Name != nameof(VideoGenRun.QueueEnteredAt)));
        BsonSerializer.Deserialize<VideoGenRun>(historical).QueueEnteredAt.ShouldBeNull();
        await test.ProcessAsync(TimeSpan.Zero);
        test.Run.Status.ShouldBe(VideoGenRunStatus.ScopedQueued);
        test.Run.PublicStatus.ShouldBe(VideoGenRunStatus.Queued);
        test.Run.CurrentPhase.ShouldBe("videogen-reconciling");
        test.Run.DirectVideoJobId.ShouldBe("synthetic-upstream-job");
        test.Run.EndedAt.ShouldBeNull();
        test.Field("DirectVideoReconciledAt").ShouldBeNull();
        await test.ClaimAsync();
        test.OtherQueuedRun!.Status.ShouldBe(VideoGenRunStatus.Rendering);
        test.Run.Status.ShouldBe(VideoGenRunStatus.ScopedQueued);
        test.Run.PublicStatus.ShouldBe(VideoGenRunStatus.Queued);
        test.OtherQueuedRun = new VideoGenRun();
        await test.ClaimAsync();
        test.Run.Status.ShouldBe(VideoGenRunStatus.Rendering);
        test.OtherQueuedRun.Status.ShouldBe(VideoGenRunStatus.Queued);
        test.Status = () => new OpenRouterVideoStatus { Status = "completed", Cost = 0.43 };
        await test.ProcessAsync();
        test.Run.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        test.Run.DirectVideoJobId.ShouldBe("synthetic-upstream-job");
        test.AssertNoSubmitOrDownload();
    }

    [Fact]
    public async Task DirectCancellationMock_WithoutJobShouldCancelBeforeSubmitting()
    {
        using var test = new DirectCancellationFixture(null);
        test.Run.DirectVideoJobId = null;
        await test.ProcessAsync();
        test.Run.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        test.Run.EndedAt.ShouldNotBeNull();
        test.AssertNoSubmitOrDownload();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DirectCancellationMock_CancellationAtFailureWriteMustNotFakeUpstreamTerminal(bool upstreamTerminal)
    {
        using var test = new DirectCancellationFixture(null);
        test.Run.CancelRequested = false;
        test.CancelAtFailureWrite = true;
        test.Status = () => new OpenRouterVideoStatus { Status = "failed", Cost = 0.43 };
        await test.ProcessAsync(upstreamTerminal ? null : TimeSpan.Zero);
        test.FailureWriteCancellationObserved.ShouldBeTrue();
        test.Run.Status.ShouldBe(upstreamTerminal ? VideoGenRunStatus.Cancelled : VideoGenRunStatus.ScopedQueued);
        (test.Run.EndedAt != null).ShouldBe(upstreamTerminal);
        (test.Field("DirectVideoReconciledAt") != null).ShouldBe(upstreamTerminal);
        test.Run.DirectVideoJobId.ShouldBe("synthetic-upstream-job");
        test.AssertNoSubmitOrDownload();
    }

    [Fact]
    public async Task DirectCancellationMock_ExecuteFallbackMustNotTerminateJobWhenCancelArrivesAtFailureWrite()
    {
        using var test = new DirectCancellationFixture(null);
        test.Run.Status = VideoGenRunStatus.Queued;
        test.Run.CancelRequested = false;
        test.FailResumedMetadataWrite = true;
        test.CancelAtFailureWrite = true;
        await test.ProcessBackgroundFailureAsync();
        test.MetadataFailureObserved.ShouldBeTrue();
        test.FailureWriteCancellationObserved.ShouldBeTrue();
        test.Run.Status.ShouldBe(VideoGenRunStatus.ScopedQueued);
        test.Run.PublicStatus.ShouldBe(VideoGenRunStatus.Queued);
        test.Run.CurrentPhase.ShouldBe("videogen-reconciling");
        test.Run.DirectVideoJobId.ShouldBe("synthetic-upstream-job");
        test.Run.EndedAt.ShouldBeNull();
        test.Field("DirectVideoReconciledAt").ShouldBeNull();
        test.Run.DirectVideoCost.ShouldBeNull();
        test.AssertNoSubmitOrDownload();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DirectCancellationMock_RequeuedReconciliationMustYieldOtherWorkerPaths(bool metadataFailure)
    {
        using var test = new DirectCancellationFixture("recorded-offering");
        test.Run.Status = VideoGenRunStatus.Queued;
        test.ProbeScheduling = true;
        test.FailResumedMetadataWrite = metadataFailure;
        await test.ProcessBackgroundFailureAsync();

        test.SchedulingPaths.ShouldBe(new[] {
            "recover-stale-claim", "recover-expired-lease", "resume-scene", "render-scene",
            "export-task", "legacy-export", "regenerate",
        });
        test.QueuedReads.ShouldBe(1);
        test.Run.Status.ShouldBe(VideoGenRunStatus.ScopedQueued);
        test.Run.PublicStatus.ShouldBe(VideoGenRunStatus.Queued);
        test.Run.CurrentPhase.ShouldBe("videogen-reconciling");
        test.Run.DirectVideoJobId.ShouldBe("synthetic-upstream-job");
        test.Run.EndedAt.ShouldBeNull();
        test.Run.DirectVideoCost.ShouldBeNull();
        test.Field("DirectVideoReconciledAt").ShouldBeNull();
        test.MetadataFailureObserved.ShouldBe(metadataFailure);
        test.AssertNoSubmitOrDownload();
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("none", false)]
    [InlineData("none", true)]
    [InlineData("run", false)]
    [InlineData("run", true)]
    [InlineData("project", false)]
    [InlineData("project", true)]
    [InlineData("export", false)]
    [InlineData("export", true)]
    public async Task DirectAssetCompensationMock_LostWritebackDeletesOnlyUnreferencedAsset(string reference, bool failCommit)
    {
        using var test = new DirectCancellationFixture("recorded-offering");
        test.PrepareAssetCompletion(reference);
        test.ThrowOnAssetCommit = failCommit;
        await test.ProcessAsync();
        test.CommitFailureObserved.ShouldBe(failCommit);
        test.Run.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        test.Run.VideoAssetUrl.ShouldBeNull();
        test.AssetStorage.Verify(x => x.DeleteByShaAsync(test.AssetSha, CancellationToken.None,
            AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo), reference == "none" && !failCommit ? Times.Once() : Times.Never());
        if (reference == "none" && !failCommit) test.AssetLeaseHeldAtDeletion.ShouldBeTrue();
        test.Client.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        test.Client.Verify(x => x.DownloadVideoBytesForOfferingAsync(It.IsAny<string>(), "synthetic-upstream-job", 0,
            "recorded-model", "recorded-offering", CancellationToken.None), Times.Once);
    }

    // This fixture never constructs MongoClient or an application host. All persistence and upstream calls are strict mocks.
    private sealed class DirectCancellationFixture : IDisposable
    {
        public VideoGenRun Run = new()
        {
            Id = "synthetic-direct-cancellation", OwnerAdminId = "synthetic-owner", Mode = VideoGenMode.Direct,
            Status = VideoGenRunStatus.Rendering, CancelRequested = true, DirectVideoJobId = "synthetic-upstream-job",
            DirectVideoModel = "recorded-model", StartedAt = DateTime.UtcNow,
        };
        public VideoGenRun OtherQueuedRun = null!;
        public Mock<IOpenRouterVideoClient> Client { get; } = new(MockBehavior.Strict);
        public Mock<IAssetStorage> AssetStorage { get; } = new(MockBehavior.Strict);
        public string AssetSha { get; } = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(new byte[] { 1, 2, 3 })).ToLowerInvariant();
        private const string AssetUrl = "https://synthetic.invalid/generated-video.mp4";
        private string AssetReference { get; set; } = "none";
        private bool AssetLeaseHeld { get; set; }
        public bool AssetLeaseHeldAtDeletion { get; private set; }
        public bool ThrowOnAssetCommit { get; set; }
        public bool CommitFailureObserved { get; private set; }

        public void PrepareAssetCompletion(string reference)
        {
            AssetReference = reference;
            Run.CancelRequested = false;
            Status = () => new OpenRouterVideoStatus { Status = "completed", VideoUrl = "https://synthetic.invalid/never-requested", Cost = null };
            Client.Setup(x => x.DownloadVideoBytesForOfferingAsync(It.IsAny<string>(), "synthetic-upstream-job", 0,
                "recorded-model", "recorded-offering", CancellationToken.None))
                .ReturnsAsync(new OpenRouterVideoDownload { Success = true, Bytes = [1, 2, 3], ContentType = "video/mp4" });
            AssetStorage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), "video/mp4", CancellationToken.None,
                AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo, null, null))
                .Callback(() => Run.CancelRequested = true)
                .ReturnsAsync(new StoredAsset(AssetSha, AssetUrl, 3, "video/mp4"));
            AssetStorage.Setup(x => x.DeleteByShaAsync(AssetSha, CancellationToken.None,
                AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo))
                .Callback(() => AssetLeaseHeldAtDeletion = AssetLeaseHeld).Returns(Task.CompletedTask);
        }
        public bool CancelAtDownloadingPhase { get; set; }
        public bool CancelAtFailureWrite { get; set; }
        public bool FailureWriteCancellationObserved { get; private set; }
        public bool FailResumedMetadataWrite { get; set; }
        public bool MetadataFailureObserved { get; private set; }
        public bool ProbeScheduling { get; set; }
        public int QueuedReads { get; private set; }
        public List<string> SchedulingPaths { get; } = [];
        private CancellationTokenSource? _backgroundStop;
        public Func<OpenRouterVideoStatus> Status { get; set; } = () => throw new Xunit.Sdk.XunitException("Unexpected status call");
        private readonly ServiceProvider _services;
        private readonly VideoGenRunWorker _worker;

        public DirectCancellationFixture(string? offering)
        {
            BsonClassMapRegistration.Register();
            Run.DirectVideoOfferingId = offering;
            var collection = new Mock<IMongoCollection<VideoGenRun>>(MockBehavior.Strict);
            collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoGenRun>>(),
                    It.IsAny<FindOptions<VideoGenRun, VideoGenRun>>(), It.IsAny<CancellationToken>()))
                .Returns((FilterDefinition<VideoGenRun> filter, FindOptions<VideoGenRun, VideoGenRun> options, CancellationToken token) =>
                {
                    if (ProbeScheduling) ObserveSchedulingRead(filter, token);
                    var rows = new[] { Run, OtherQueuedRun }.OfType<VideoGenRun>().Where(row => Matches(filter, row));
                    if (options.Sort?.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry)) is { } order)
                        rows = rows.OrderBy(row => new BsonArray(order.Elements.Select(key => row.ToBsonDocument().GetValue(key.Name, BsonNull.Value))));
                    var cursor = new Mock<IAsyncCursor<VideoGenRun>>(MockBehavior.Strict);
                    cursor.SetupGet(x => x.Current).Returns(rows.Select(row => BsonSerializer.Deserialize<VideoGenRun>(row.ToBsonDocument())).ToArray());
                    cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
                    cursor.Setup(x => x.Dispose());
                    return Task.FromResult(cursor.Object);
                });
            collection.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoGenRun>>(),
                    It.IsAny<UpdateDefinition<VideoGenRun>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
                .Returns((FilterDefinition<VideoGenRun> filter, UpdateDefinition<VideoGenRun> update, UpdateOptions _, CancellationToken _) =>
                {
                    var sets = update.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry))["$set"].AsBsonDocument;
                    var statusName = BsonClassMap.LookupClassMap(typeof(VideoGenRun)).GetMemberMap(nameof(VideoGenRun.Status)).ElementName;
                    var jobName = BsonClassMap.LookupClassMap(typeof(VideoGenRun)).GetMemberMap(nameof(VideoGenRun.DirectVideoJobId)).ElementName;
                    if (ThrowOnAssetCommit && sets.Contains(nameof(VideoGenRun.VideoAssetSha256)))
                    {
                        CommitFailureObserved = true;
                        throw new IOException("synthetic-commit-uncertain");
                    }
                    if (FailResumedMetadataWrite && !MetadataFailureObserved && sets.Contains(jobName))
                    {
                        MetadataFailureObserved = true;
                        throw new InvalidOperationException("Synthetic resumed metadata write failure");
                    }
                    if (CancelAtFailureWrite && sets.TryGetValue(statusName, out var status) && status == VideoGenRunStatus.Failed)
                    {
                        Run.CancelRequested = true;
                        FailureWriteCancellationObserved = true;
                        _backgroundStop?.Cancel();
                    }
                    if (!Matches(filter)) return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(0, 0, null));
                    Apply(update, ref Run);
                    return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(1, 1, null));
                });
            collection.Setup(x => x.FindOneAndUpdateAsync(It.IsAny<FilterDefinition<VideoGenRun>>(),
                    It.IsAny<UpdateDefinition<VideoGenRun>>(), It.IsAny<FindOneAndUpdateOptions<VideoGenRun, VideoGenRun>>(), It.IsAny<CancellationToken>()))
                .Returns((FilterDefinition<VideoGenRun> filter, UpdateDefinition<VideoGenRun> update, FindOneAndUpdateOptions<VideoGenRun, VideoGenRun> options, CancellationToken _) =>
                {
                    options.ReturnDocument.ShouldBe(ReturnDocument.After);
                    var query = filter.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry));
                    var deletionName = BsonClassMap.LookupClassMap(typeof(VideoGenRun)).GetMemberMap(nameof(VideoGenRun.DeletionRequestedAt)).ElementName;
                    if (query.Contains(deletionName) || ProbeScheduling && query.Contains(nameof(VideoGenRun.ExportRequested)))
                    {
                        if (query.Contains(deletionName))
                            Run.DeletionRequestedAt.ShouldBeNull();
                        else
                            SchedulingPaths.Add("legacy-export");
                        return Task.FromResult<VideoGenRun>(null!);
                    }
                    if (!Matches(filter) && OtherQueuedRun != null && Matches(filter, OtherQueuedRun))
                        return Task.FromResult(Apply(update, ref OtherQueuedRun));
                    Matches(filter).ShouldBeTrue();
                    return Task.FromResult(Apply(update, ref Run));
                });
            collection.Setup(x => x.CountDocumentsAsync(It.IsAny<FilterDefinition<VideoGenRun>>(), It.IsAny<CountOptions>(), CancellationToken.None))
                .Returns((FilterDefinition<VideoGenRun> filter, CountOptions _, CancellationToken _) =>
                {
                    var query = filter.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry)).ToString();
                    query.ShouldContain(AssetSha); query.ShouldContain(AssetUrl);
                    return Task.FromResult(AssetReference == "run" ? 1L : 0L);
                });
            var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
            database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs", null)).Returns(collection.Object);
            var exports = new Mock<IMongoCollection<VideoExportTask>>(MockBehavior.Strict);
            exports.Setup(x => x.FindOneAndUpdateAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),
                    It.IsAny<UpdateDefinition<VideoExportTask>>(), It.IsAny<FindOneAndUpdateOptions<VideoExportTask, VideoExportTask>>(), It.IsAny<CancellationToken>()))
                .Returns(() =>
                {
                    ProbeScheduling.ShouldBeTrue();
                    SchedulingPaths.Add("export-task");
                    return Task.FromResult<VideoExportTask>(null!);
                });
            database.Setup(x => x.GetCollection<VideoExportTask>("video_export_tasks", null)).Returns(exports.Object);
            exports.Setup(x => x.CountDocumentsAsync(It.IsAny<FilterDefinition<VideoExportTask>>(), It.IsAny<CountOptions>(), CancellationToken.None))
                .ReturnsAsync(() => AssetReference == "export" ? 1L : 0L);
            var projects = new Mock<IMongoCollection<VideoProject>>(MockBehavior.Strict);
            projects.Setup(x => x.CountDocumentsAsync(It.IsAny<FilterDefinition<VideoProject>>(), It.IsAny<CountOptions>(), CancellationToken.None))
                .ReturnsAsync(() => AssetReference == "project" ? 1L : 0L);
            database.Setup(x => x.GetCollection<VideoProject>("video_projects", null)).Returns(projects.Object);
            var leases = new Mock<IMongoCollection<BsonDocument>>(MockBehavior.Strict);
            leases.Setup(x => x.FindOneAndUpdateAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<UpdateDefinition<BsonDocument>>(),
                It.IsAny<FindOneAndUpdateOptions<BsonDocument, BsonDocument>>(), CancellationToken.None))
                .Returns((FilterDefinition<BsonDocument> _, UpdateDefinition<BsonDocument> update, FindOneAndUpdateOptions<BsonDocument, BsonDocument> _, CancellationToken _) =>
                {
                    AssetLeaseHeld = true;
                    var patch = update.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry));
                    return Task.FromResult(new BsonDocument("owner", patch["$set"]["owner"]));
                });
            leases.Setup(x => x.DeleteOneAsync(It.IsAny<FilterDefinition<BsonDocument>>(), CancellationToken.None))
                .Callback(() => AssetLeaseHeld = false).ReturnsAsync(new DeleteResult.Acknowledged(1));
            database.Setup(x => x.GetCollection<BsonDocument>("video_asset_mutation_leases", null)).Returns(leases.Object);
            var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
            typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(context, database.Object);
            Client.Setup<Task<OpenRouterVideoStatus>>(offering == null
                ? x => x.GetStatusAsync(It.IsAny<string>(), "synthetic-upstream-job", "recorded-model", CancellationToken.None)
                : x => x.GetStatusForOfferingAsync(It.IsAny<string>(), "synthetic-upstream-job", "recorded-model", offering, CancellationToken.None))
                .Returns(() => Task.FromResult(Status()));
            _services = new ServiceCollection().AddSingleton(Client.Object)
                .AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>().BuildServiceProvider();
            var events = new Mock<IRunEventStore>(MockBehavior.Strict);
            events.Setup(x => x.AppendEventAsync(It.IsAny<string>(), Run.Id, It.IsAny<string>(), It.IsAny<object>(),
                It.IsAny<TimeSpan?>(), CancellationToken.None))
                .Callback<string, string, string, object, TimeSpan?, CancellationToken>((_, _, name, payload, _, _) =>
                {
                    if (CancelAtDownloadingPhase && name == "phase.changed" && payload.GetType().GetProperty("phase")?.GetValue(payload) is "downloading")
                        Run.CancelRequested = true;
                }).ReturnsAsync(1);
            _worker = new VideoGenRunWorker(context, _services.GetRequiredService<IServiceScopeFactory>(), events.Object,
                AssetStorage.Object, NullLogger<VideoGenRunWorker>.Instance);
        }

        private void ObserveSchedulingRead(FilterDefinition<VideoGenRun> filter, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            var query = filter.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry));
            var queueStatus = query.GetValue(nameof(VideoGenRun.Status), BsonNull.Value);
            var readsQueue = queueStatus == VideoGenRunStatus.Queued
                || queueStatus is BsonDocument choices && choices.GetValue("$in", new BsonArray()) is BsonArray values
                    && values.Contains(VideoGenRunStatus.Queued);
            if (readsQueue && ++QueuedReads == 2)
            {
                // Bound the old scheduler deterministically; never wait another real polling window.
                _backgroundStop!.Cancel();
                token.ThrowIfCancellationRequested();
            }
            if (!query.TryGetValue(nameof(VideoGenRun.Scenes), out var scenes)) return;
            var status = scenes["$elemMatch"][nameof(VideoGenScene.Status)];
            var path = status.IsBsonDocument ? "resume-scene"
                : status == SceneItemStatus.SubmittingClaimed ? "recover-stale-claim"
                : status == SceneItemStatus.PollingClaimed ? "recover-expired-lease"
                : status == SceneItemStatus.Submitting ? "render-scene"
                : status == SceneItemStatus.Generating ? "regenerate"
                : throw new InvalidOperationException("Unexpected scene scheduling filter: " + query);
            SchedulingPaths.Add(path);
            if (path == "regenerate")
            {
                _backgroundStop!.Cancel();
                token.ThrowIfCancellationRequested();
            }
        }

        private bool Matches(FilterDefinition<VideoGenRun> filter, VideoGenRun? row = null)
        {
            var actual = (row ?? Run).ToBsonDocument();
            var query = filter.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry));
            return query.All(field => field.Value is BsonDocument operation
                ? operation.ElementCount == 1 && (operation.Contains("$ne")
                    && !actual.GetValue(field.Name, BsonNull.Value).Equals(operation["$ne"])
                    || operation.TryGetValue("$in", out var choices) && choices.AsBsonArray.Contains(actual.GetValue(field.Name, BsonNull.Value)))
                : actual.GetValue(field.Name, BsonNull.Value).Equals(field.Value));
        }
        private VideoGenRun Apply(UpdateDefinition<VideoGenRun> update, ref VideoGenRun row)
        {
            var body = row.ToBsonDocument();
            var rendered = update.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry));
            rendered.AsBsonDocument.ElementCount.ShouldBe(1);
            foreach (var field in rendered["$set"].AsBsonDocument) body[field.Name] = field.Value;
            row = BsonSerializer.Deserialize<VideoGenRun>(body);
            return BsonSerializer.Deserialize<VideoGenRun>(row.ToBsonDocument());
        }
        public Task ClaimAsync() => (Task)typeof(VideoGenRunWorker).GetMethod("ClaimQueuedRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(_worker, [CancellationToken.None])!;
        public object? Field(string name) => typeof(VideoGenRun).GetProperty(name)!.GetValue(Run);
        public async Task ProcessBackgroundFailureAsync()
        {
            using var stop = new CancellationTokenSource();
            _backgroundStop = stop;
            typeof(VideoGenRunWorker).GetProperty("DirectVideoPollingWindow", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_worker, TimeSpan.Zero);
            var task = (Task)typeof(VideoGenRunWorker).GetMethod("ExecuteAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(_worker, [stop.Token])!;
            try { await task.WaitAsync(TimeSpan.FromSeconds(3)); }
            finally
            {
                stop.Cancel();
                try { await task.WaitAsync(TimeSpan.FromSeconds(3)); }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
                _backgroundStop = null;
            }
        }
        public Task ProcessAsync(TimeSpan? window = null)
        {
            typeof(VideoGenRunWorker).GetProperty("DirectVideoPollInterval", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_worker, TimeSpan.Zero);
            typeof(VideoGenRunWorker).GetProperty("DirectVideoPollingWindow", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_worker, window ?? TimeSpan.FromSeconds(1));
            return (Task)typeof(VideoGenRunWorker).GetMethod("ProcessDirectVideoGenAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(_worker, [Run])!;
        }
        public void AssertNoSubmitOrDownload()
        {
            Client.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
            Client.Verify(x => x.DownloadVideoBytesAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<int>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
            Client.Verify(x => x.DownloadVideoBytesForOfferingAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<int>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
        }
        public void Dispose() { _worker.Dispose(); _services.Dispose(); }
    }

    [Theory]
    [InlineData(VideoGenRunStatus.Rendering)]
    [InlineData(VideoGenRunStatus.Scripting)]
    public async Task CancelActiveRunRevokesLeaseAndLeavesTerminalDeletableTask(string status)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync("video-agent", test.OwnerId,
            new CreateVideoProjectRequest { Title = "synthetic-cancellation" });
        var run = NewRun("cancel-active", test.OwnerId, SceneItemStatus.Draft);
        run.Status = status; run.ProjectId = project.Id;
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var executionLease = lease;
        await test.Context.VideoProjects.UpdateOneAsync(x => x.Id == project.Id,
            Builders<VideoProject>.Update.Set(x => x.LatestRunId, run.Id).Set(x => x.Status, VideoProjectStatus.Rendering));

        (await service.CancelRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeTrue();

        var cancelled = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        cancelled.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        cancelled.CancelRequested.ShouldBeTrue(); cancelled.EndedAt.ShouldNotBeNull();
        (await coordinator.ValidateAsync(lease.Proof, false, default)).ShouldBeFalse();
        (await test.Context.VideoProjects.Find(x => x.Id == project.Id).SingleAsync()).Status.ShouldBe(VideoProjectStatus.Draft);
        using (TaskExecutionContext.Enter(lease.Identity))
        {
            foreach (var lateStatus in new[] { VideoGenRunStatus.Completed, VideoGenRunStatus.Failed })
            {
                var rejected = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => test.Context.VideoGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id, Builders<VideoGenRun>.Update.Set(x => x.Status, lateStatus)));
                rejected.Code.ShouldBe("TASK_EXECUTION_LEASE_INVALID");
            }
        }
        (await service.CancelRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeTrue();
        test.AssertCancellationEventOnce(run.Id);
        var deleted = await service.DeleteRunAsync(run.Id, test.OwnerId, appKey: run.AppKey);
        deleted.ShouldNotBeNull(); deleted.Deleted.ShouldBeTrue();
    }

    [Theory]
    [InlineData(VideoGenRunStatus.Completed)]
    [InlineData(VideoGenRunStatus.Failed)]
    [InlineData(VideoGenRunStatus.Cancelled)]
    public async Task CancelRequestPreservesAnAlreadyTerminalOutcome(string status)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancel-terminal", test.OwnerId, SceneItemStatus.Draft);
        var endedAt = DateTime.UtcNow.AddMinutes(-1);
        run.Status = status; run.EndedAt = endedAt;
        await test.SaveRunAsync(run);
        (await test.CreateService().CancelRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeTrue();
        var stored = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        stored.Status.ShouldBe(status);
        Assert.NotNull(stored.EndedAt);
        stored.EndedAt.Value.ShouldBe(endedAt, TimeSpan.FromMilliseconds(1));
    }

    [Fact]
    public async Task UnownedCancellationCannotRevokeAnotherVideosLease()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancel-owner-boundary", test.OwnerId, SceneItemStatus.Draft);
        run.Status = VideoGenRunStatus.Rendering;
        var (coordinator, lease) = await test.SaveAuthorizedRunAsync(run);
        await using var executionLease = lease;
        (await test.CreateService().CancelRunAsync(run.Id, "other-owner", run.AppKey)).ShouldBeFalse();
        (await test.CreateService().CancelRunAsync(run.Id, test.OwnerId, "other-app")).ShouldBeFalse();
        (await coordinator.ValidateAsync(lease.Proof, false, default)).ShouldBeTrue();
    }

    [Fact]
    public async Task DeleteCompletedRun_ShouldRemoveOwnedArtifactRunExportAndEmptyProject()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync(
            "video-agent",
            test.OwnerId,
            new CreateVideoProjectRequest { Title = "稳定冒烟视频", SourceMarkdown = "测试" });
        var sha = new string('a', 64);
        var run = NewRun("delete-completed", test.OwnerId, SceneItemStatus.Done);
        run.ProjectId = project.Id;
        run.Status = VideoGenRunStatus.Completed;
        run.VideoAssetUrl = "https://assets.example/video-agent/video/test.mp4";
        run.VideoAssetSha256 = sha;
        await test.SaveRunAsync(run);
        await test.Context.VideoProjects.UpdateOneAsync(
            item => item.Id == project.Id,
            Builders<VideoProject>.Update.Set(item => item.LatestRunId, run.Id));
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask
        {
            ProjectId = project.Id,
            RunId = run.Id,
            OwnerAdminId = test.OwnerId,
        });

        var result = await service.DeleteRunAsync(run.Id, test.OwnerId, deleteEmptyProject: true, appKey: run.AppKey);

        result.ShouldNotBeNull();
        result.Deleted.ShouldBeTrue();
        result.ProjectDeleted.ShouldBeTrue();
        result.ArtifactsDeleted.ShouldBe(1);
        (await test.Context.VideoGenRuns.CountDocumentsAsync(item => item.Id == run.Id)).ShouldBe(0);
        (await test.Context.VideoExportTasks.CountDocumentsAsync(item => item.RunId == run.Id)).ShouldBe(0);
        (await test.Context.VideoProjects.CountDocumentsAsync(item => item.Id == project.Id)).ShouldBe(0);
        test.AssetStorage.Verify(storage => storage.DeleteByShaAsync(
            sha,
            It.IsAny<CancellationToken>(),
            AppDomainPaths.DomainVideoAgent,
            AppDomainPaths.TypeVideo), Times.Once);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DeleteCompletedRun_ShouldPreserveArtifactReferencedByProject(
        bool useTimelineReference)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync(
            "video-agent",
            test.OwnerId,
            new CreateVideoProjectRequest { Title = "引用保留测试", SourceMarkdown = "测试" });
        var sha = new string('b', 64);
        const string assetUrl = "https://assets.example/video-agent/video/shared.mp4";
        var run = NewRun("delete-referenced", test.OwnerId, SceneItemStatus.Done);
        run.ProjectId = project.Id;
        run.Status = VideoGenRunStatus.Completed;
        run.VideoAssetUrl = assetUrl;
        run.VideoAssetSha256 = sha;
        await test.SaveRunAsync(run);

        if (useTimelineReference)
        {
            project.TimelineTracks.First(track => track.Type == VideoTrackType.Video).Clips.Add(
                new VideoTimelineClip { AssetUrl = assetUrl });
        }
        else
        {
            project.Assets.Add(new VideoProjectAsset { Url = assetUrl, Name = "共享视频" });
        }
        project.LatestRunId = run.Id;
        await test.Context.VideoProjects.ReplaceOneAsync(item => item.Id == project.Id, project);

        var result = await service.DeleteRunAsync(
            run.Id,
            test.OwnerId,
            deleteEmptyProject: false,
            appKey: run.AppKey);

        result.ShouldNotBeNull();
        result.Deleted.ShouldBeTrue();
        result.ProjectDeleted.ShouldBeFalse();
        result.ArtifactsDeleted.ShouldBe(0);
        (await test.Context.VideoProjects.CountDocumentsAsync(item => item.Id == project.Id)).ShouldBe(1);
        test.AssetStorage.Verify(storage => storage.DeleteByShaAsync(
            It.IsAny<string>(),
            It.IsAny<CancellationToken>(),
            It.IsAny<string?>(),
            It.IsAny<string?>()), Times.Never);
    }

    [Fact]
    public async Task ConcurrentQueueRequests_ShouldOnlyTransitionOnce_AndNeverClearAnExistingClaim()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("concurrent-queue", test.OwnerId, SceneItemStatus.Done);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        var queued = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            service.TryQueueSceneRenderAsync(run.Id, run.OwnerAdminId, 0, run.AppKey, false)));

        queued.Count(result => result).ShouldBe(1);
        var worker = test.CreateWorker();
        var claims = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            worker.ClaimEditingSceneRenderAsync(CancellationToken.None)));
        var claimed = claims.Where(result => result != null).Select(result => result!).ToList();
        claimed.Count.ShouldBe(1,
            string.Join(", ", claimed.Select(result => $"{result.ClaimId}:{result.ResumeExistingJob}")));
        var claim = claimed[0];
        claim.ResumeExistingJob.ShouldBeFalse();

        var staleRetries = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            service.TryQueueSceneRenderAsync(run.Id, run.OwnerAdminId, 0, run.AppKey, false)));
        staleRetries.ShouldAllBe(result => result == false);

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.SubmittingClaimed);
        persisted.Scenes[0].JobId.ShouldBe(claim.ClaimId);
    }

    [Fact]
    public async Task ConcurrentBatchRequests_ShouldQueueEachEligibleSceneExactlyOnce()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("concurrent-batch", test.OwnerId, SceneItemStatus.Draft, SceneItemStatus.Error);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        var counts = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ =>
            service.RenderScenesAsync(run.Id, run.OwnerAdminId, appKey: run.AppKey)));

        counts.Sum().ShouldBe(2);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes.ShouldAllBe(scene => scene.Status == SceneItemStatus.Submitting);
        persisted.Scenes.ShouldAllBe(scene => scene.SubmissionStartedAt.HasValue);
    }

    [Fact]
    public async Task ExpiredRenderLease_ShouldHaveOnePollingOwner_WithoutSubmittingAnotherJob()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("expired-lease", test.OwnerId, SceneItemStatus.PollingClaimed);
        run.Scenes[0].JobId = "upstream-job-1";
        run.Scenes[0].Model = "recorded-video-model";
        run.Scenes[0].RenderLeaseId = "lease:expired";
        run.Scenes[0].RenderLeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1);
        await test.SaveRunAsync(run);

        var worker = test.CreateWorker();
        var recoveries = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            worker.RecoverExpiredSceneRenderLeaseAsync(CancellationToken.None)));
        recoveries.Count(result => result).ShouldBe(1);

        var claims = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            worker.ClaimEditingSceneRenderAsync(CancellationToken.None)));
        var claimed = claims.Where(result => result != null).Select(result => result!).ToList();
        claimed.Count.ShouldBe(1,
            string.Join(", ", claimed.Select(result => $"{result.ClaimId}:{result.ResumeExistingJob}")));
        var claim = claimed[0];
        claim.ResumeExistingJob.ShouldBeTrue();
        claim.Run.Scenes[0].JobId.ShouldBe("upstream-job-1");

        var activeLeaseClaims = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ =>
            worker.ClaimEditingSceneRenderAsync(CancellationToken.None)));
        activeLeaseClaims.ShouldAllBe(result => result == null);

        var client = test.VideoClient;
        client.Setup(x => x.GetStatusAsync(
                It.IsAny<string>(),
                "upstream-job-1",
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new OpenRouterVideoStatus { Status = "failed", ErrorMessage = "模拟上游失败" });

        await worker.ProcessSceneRenderAsync(claim.Run, 0, claim.ClaimId, resumeExistingJob: true);

        client.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        client.Verify(x => x.GetStatusAsync(
            It.IsAny<string>(), "upstream-job-1", "recorded-video-model", It.IsAny<CancellationToken>()), Times.Once);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Error);
        persisted.Scenes[0].RenderLeaseId.ShouldBeNull();
    }

    [Fact]
    public async Task StalePreSubmitClaim_ShouldBecomeActionableError_InsteadOfAutoResubmitting()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("stale-claim", test.OwnerId, SceneItemStatus.SubmittingClaimed);
        run.Scenes[0].JobId = "claim:orphaned";
        run.Scenes[0].SubmissionStartedAt = DateTime.UtcNow.AddMinutes(-3);
        await test.SaveRunAsync(run);
        var worker = test.CreateWorker();

        var recovered = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ =>
            worker.RecoverStaleSceneClaimAsync(CancellationToken.None)));

        recovered.Count(result => result).ShouldBe(1);
        test.VideoClient.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Error);
        persisted.Scenes[0].JobId.ShouldBeNull();
        persisted.Scenes[0].ErrorMessage.ShouldNotBeNull();
        persisted.Scenes[0].ErrorMessage!.ShouldContain("避免重复扣费");
    }

    [Fact]
    public async Task LeaseLostDuringStatusCheck_ShouldStopBeforeDownloadingOrPersistingAVersion()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("lease-lost", test.OwnerId, SceneItemStatus.PollingClaimed);
        run.Scenes[0].JobId = "upstream-job-lease-lost";
        run.Scenes[0].RenderLeaseId = "lease:original";
        run.Scenes[0].RenderLeaseExpiresAt = DateTime.UtcNow.AddMinutes(2);
        run.Scenes[0].SubmissionStartedAt = DateTime.UtcNow;
        await test.SaveRunAsync(run);

        test.VideoClient.Setup(x => x.GetStatusAsync(
                It.IsAny<string>(),
                "upstream-job-lease-lost",
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                await test.Context.VideoGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<VideoGenRun>.Update
                        .Set("Scenes.0.RenderLeaseId", "lease:new-owner")
                        .Set("Scenes.0.RenderLeaseExpiresAt", DateTime.UtcNow.AddMinutes(2)));
                return new OpenRouterVideoStatus
                {
                    Status = "completed",
                    VideoUrl = "https://example.invalid/video.mp4",
                };
            });

        var worker = test.CreateWorker();
        await worker.ProcessSceneRenderAsync(run, 0, "lease:original", resumeExistingJob: true);

        test.VideoClient.Verify(x => x.SubmitAsync(
            It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        test.VideoClient.Verify(x => x.DownloadVideoBytesAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<int>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Versions.ShouldBeEmpty();
        persisted.Scenes[0].RenderLeaseId.ShouldBe("lease:new-owner");
    }

    [Fact]
    public async Task WrongOwnerOrApp_ShouldNotQueueOrMutateTheScene()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("ownership", test.OwnerId, SceneItemStatus.Draft);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        (await service.TryQueueSceneRenderAsync(
            run.Id, "another-owner", 0, run.AppKey, false)).ShouldBeFalse();
        (await service.TryQueueSceneRenderAsync(
            run.Id, run.OwnerAdminId, 0, "another-app", false)).ShouldBeFalse();

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Draft);
        persisted.Scenes[0].JobId.ShouldBeNull();
    }

    [Fact]
    public async Task InvalidBatchIndex_ShouldFailBeforeQueuingAnyScene()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("invalid-index", test.OwnerId, SceneItemStatus.Draft, SceneItemStatus.Error);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        await Should.ThrowAsync<ArgumentOutOfRangeException>(() =>
            service.RenderScenesAsync(run.Id, run.OwnerAdminId, [-1, 0], appKey: run.AppKey));

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Draft);
        persisted.Scenes[1].Status.ShouldBe(SceneItemStatus.Error);
    }

    [Fact]
    public async Task CompletedRunRetry_ShouldAtomicallyReopenEditingAndQueueTheScene()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("completed-retry", test.OwnerId, SceneItemStatus.Error);
        run.Status = VideoGenRunStatus.Completed;
        run.CurrentPhase = "completed";
        run.VideoAssetUrl = "https://example.invalid/old-export.mp4";
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        (await service.TryQueueSceneRenderAsync(
            run.Id, run.OwnerAdminId, 0, run.AppKey, reopenCompletedRun: true)).ShouldBeTrue();

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Status.ShouldBe(VideoGenRunStatus.Editing);
        persisted.CurrentPhase.ShouldBe("editing");
        persisted.VideoAssetUrl.ShouldBeNull();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Submitting);
    }

    private static VideoGenRun NewRun(string id, string ownerId, params string[] sceneStatuses) => new()
    {
        Id = $"video-scene-test-{id}",
        AppKey = "video-agent",
        OwnerAdminId = ownerId,
        Status = VideoGenRunStatus.Editing,
        Mode = VideoGenMode.Storyboard,
        CurrentPhase = "editing",
        Scenes = sceneStatuses.Select((status, index) => new VideoGenScene
        {
            Index = index,
            Topic = $"镜头 {index + 1}",
            Prompt = $"测试镜头 {index + 1}",
            Status = status,
        }).ToList(),
    };

    private sealed class VideoSceneTestDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;
        private readonly ServiceProvider _services;
        private readonly Mock<IRunEventStore> _runStore;
        private readonly Mock<IAssetStorage> _assetStorage;

        private VideoSceneTestDatabase(
            MongoDbContext context,
            MongoClient client,
            string databaseName,
            ServiceProvider services,
            Mock<IRunEventStore> runStore,
            Mock<IOpenRouterVideoClient> videoClient,
            Mock<IAssetStorage> assetStorage)
        {
            Context = context;
            _client = client;
            _databaseName = databaseName;
            _services = services;
            _runStore = runStore;
            VideoClient = videoClient;
            _assetStorage = assetStorage;
            OwnerId = $"video-scene-concurrency-tests-{Guid.NewGuid():N}";
        }

        public MongoDbContext Context { get; }
        public LlmGatewayDataContext Data => new(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")!, _databaseName);
        public Mock<IOpenRouterVideoClient> VideoClient { get; }
        public Mock<IAssetStorage> AssetStorage => _assetStorage;
        public string OwnerId { get; }

        public Task SaveRunAsync(VideoGenRun run) => Context.VideoGenRuns.InsertOneAsync(run);

        public async Task<(TaskExecutionCoordinator Coordinator, TaskExecutionLease Lease)> SaveAuthorizedRunAsync(VideoGenRun run)
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? throw new InvalidOperationException("租约取消回归必须提供独占Mongo");
            var coordinator = new TaskExecutionCoordinator(new LlmGatewayDataContext(connection, _databaseName));
            var key = Guid.NewGuid().ToString("N");
            var permit = new GatewayTaskPermitRecord
            {
                Id = TaskExecutionCoordinator.BusinessId(GatewayTenantDefaults.InternalTenantId, OwnerId, "video-cancellation-fixture", key),
                ExecutionContractVersion = TaskExecutionCoordinator.ContractVersion,
                BusinessKeyHash = TaskExecutionCoordinator.Fingerprint(key), RequestFingerprint = TaskExecutionCoordinator.Fingerprint("synthetic-video"),
                TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = OwnerId, SubjectUserIds = [OwnerId],
                TriggerCredentialId = "synthetic-session", Origin = TaskExecutionOrigins.Interactive,
                SourceDeployment = "synthetic-deployment", SourceTask = "video-cancellation-fixture",
                AllowedAppCallerCodes = [run.Mode == VideoGenMode.Direct
                    ? AppCallerRegistry.VideoAgent.VideoGen.Generate : AppCallerRegistry.VideoAgent.Script.Chat], MaxRuns = 2, MaxCalls = 4,
                CreatedAt = DateTime.UtcNow, ExpiresAt = DateTime.UtcNow.AddHours(1),
            };
            await coordinator.RegisterAsync(permit, false, default);
            run.TaskPermitId = permit.Id; await SaveRunAsync(run);
            var lease = await coordinator.AcquireAsync(permit.Id, run.Id, default)
                ?? throw new InvalidOperationException("合成视频租约未领取成功");
            return (coordinator, lease);
        }

        public void AssertCancellationEventOnce(string runId)
            => _runStore.Verify(x => x.AppendEventAsync(RunKinds.VideoGen, runId, "run.cancelled", It.IsAny<object>(),
                It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Once);

        public static async Task<VideoSceneTestDatabase> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var databaseName = $"video_scene_concurrency_{Guid.NewGuid():N}";
            var context = new MongoDbContext(connectionString, databaseName);
            var runStore = new Mock<IRunEventStore>();
            runStore.Setup(x => x.AppendEventAsync(
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<object>(),
                    It.IsAny<TimeSpan?>(),
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync(1);
            var videoClient = new Mock<IOpenRouterVideoClient>();
            var assetStorage = new Mock<IAssetStorage>();
            var services = new ServiceCollection()
                .AddSingleton(videoClient.Object)
                .AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>()
                .BuildServiceProvider();
            return new VideoSceneTestDatabase(
                context,
                client,
                databaseName,
                services,
                runStore,
                videoClient,
                assetStorage);
        }

        public VideoGenService CreateService() => new(
            Context,
            _runStore.Object,
            _assetStorage.Object,
            NullLogger<VideoGenService>.Instance);

        public VideoGenRunWorker CreateWorker(ITaskExecutionCoordinator? coordinator = null) => new(
            Context,
            _services.GetRequiredService<IServiceScopeFactory>(),
            _runStore.Object,
            _assetStorage.Object,
            NullLogger<VideoGenRunWorker>.Instance, coordinator);

        public async ValueTask DisposeAsync()
        {
            await _services.DisposeAsync();
            await _client.DropDatabaseAsync(_databaseName);
        }
    }
}
