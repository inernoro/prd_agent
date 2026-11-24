using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", "Integration")]
public sealed class ShortVideoArtifactRecoveryTests : IAsyncLifetime
{
    private MongoClient _client = null!;
    private IMongoDatabase _database = null!;
    private MongoDbContext _db = null!;
    private readonly string _files = Path.Combine(Path.GetTempPath(), "short-video-owned-artifacts-" + Guid.NewGuid().ToString("N"));
    private readonly Mock<IDocumentService> _documents = new(MockBehavior.Strict);
    private readonly Mock<ICacheManager> _cache = new(MockBehavior.Strict);
    private LocalAssetStorage _local = null!;
    private readonly Mock<IAssetStorage> _storage = new(MockBehavior.Strict);
    private ServiceProvider _services = null!;
    private string? _failure;
    private int _outboundCalls;
    private string? _runId;
    private string? _durableUploadIntent;
    private bool _denyDelete;
    private Func<Task>? _beforeDocumentFailure;

    public Task InitializeAsync()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("须显式提供本机合成测试 Mongo 地址");
        Assert.StartsWith("mongodb://127.0.0.1:", connection);
        BsonClassMapRegistration.Register();
        _client = new MongoClient(connection);
        _database = _client.GetDatabase("short_video_artifact_" + Guid.NewGuid().ToString("N"));
        _db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_db, _database);
        _local = new LocalAssetStorage(_files);
        _storage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), "workflow-agent", "doc", null, null))
            .Returns<byte[], string, CancellationToken, string?, string?, string?, string?>(async (bytes, mime, ct, domain, type, _, _) =>
            {
                var result = await _local.SaveAsync(bytes, mime, ct, domain, type);
                if (_failure == "cancel-after-upload-ack")
                    await _db.ShortVideoMaterialRuns.UpdateOneAsync(x => x.Id == _runId, Builders<ShortVideoMaterialRun>.Update.Set(x => x.CancelRequested, true));
                if (_failure == "upload-result-unknown") throw new IOException("本机模拟写入回执未知");
                return result;
            });
        _storage.Setup(x => x.TryBuildContentAddressedKey(It.IsAny<byte[]>(), It.IsAny<string>(), "workflow-agent", "doc", null, null))
            .Returns<byte[], string, string?, string?, string?, string?>((bytes, mime, domain, type, _, _) => _local.TryBuildContentAddressedKey(bytes, mime, domain, type));
        _storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>())).Returns<string>(_local.BuildUrlForKey);
        _storage.Setup(x => x.BuildUrlForLogicalKey(It.IsAny<string>())).Returns<string>(_local.BuildUrlForKey);
        _storage.Setup(x => x.UploadToKeyAsync(It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), null))
            .Returns<string, byte[], string, CancellationToken, string?>(async (key, bytes, mime, ct, _) =>
            {
                _durableUploadIntent = (await _db.ShortVideoMaterialRuns.Find(x => x.Id == _runId).SingleAsync()).ArtifactReceipt?.PhysicalState;
                await _local.UploadToKeyAsync(key, bytes, mime, ct);
                if (_failure == "cancel-after-upload-ack")
                    await _db.ShortVideoMaterialRuns.UpdateOneAsync(x => x.Id == _runId, Builders<ShortVideoMaterialRun>.Update.Set(x => x.CancelRequested, true));
                if (_failure == "upload-result-unknown") throw new IOException("本机模拟写入回执未知");
            });
        _storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None))
            .Returns<string, CancellationToken>((key, ct) => _denyDelete
                ? Task.FromException(new InvalidOperationException("本机模拟现有存储策略拒绝删除"))
                : _local.DeleteByKeyAsync(key, ct));
        _documents.Setup(x => x.ParseAsync(It.IsAny<string>())).ReturnsAsync((string text) => new ParsedPrd { RawContent = text });
        _documents.Setup(x => x.SaveAsync(It.IsAny<ParsedPrd>())).Returns<ParsedPrd>(async doc =>
        {
            if (_failure == "transcript-save")
            {
                if (_beforeDocumentFailure != null) await _beforeDocumentFailure();
                throw new IOException("本机模拟文字保存失败");
            }
            await _db.Documents.InsertOneAsync(doc);
            return doc;
        });
        _cache.Setup(x => x.RemoveAsync(It.IsAny<string>())).Returns(Task.CompletedTask);
        var services = new ServiceCollection();
        services.AddSingleton(_cache.Object);
        services.AddSingleton(_storage.Object);
        services.AddSingleton(_db.ApiRequestLogs);
        var validator = new Mock<ISafeOutboundUrlValidator>(MockBehavior.Strict);
        validator.Setup(x => x.EnsureSafeHttpUrlAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((string url, string _, CancellationToken _) => new Uri(url));
        services.AddSingleton(validator.Object);
        services.AddHttpClient("SafeOutbound").ConfigurePrimaryHttpMessageHandler(() => new LocalReply(() => _outboundCalls++));
        _services = services.BuildServiceProvider();
        return Task.CompletedTask;
    }

    private ShortVideoMaterialProcessor Processor() => new(_db, _documents.Object, new ConfigurationBuilder().Build(),
        _services, NullLogger<ShortVideoMaterialProcessor>.Instance);

    private async Task<ShortVideoMaterialRun> Seed()
    {
        var store = new DocumentStore { OwnerId = "local-artifact-owner", Name = "本机合成素材库" };
        await _db.DocumentStores.InsertOneAsync(store);
        var run = new ShortVideoMaterialRun
        {
            UserId = store.OwnerId, StoreId = store.Id, Status = "running", OwnerInstanceId = "local-artifact-instance",
            ProcessingToken = Guid.NewGuid().ToString("N"), TaskPermitId = "synthetic-no-provider-permit-" + Guid.NewGuid().ToString("N"),
            VideoUrl = "https://fixture.invalid/synthetic.mp4", InputSourceText = "明示本机合成文字，不请求转写服务", Title = "本机产物责任测试",
        };
        await _db.ShortVideoMaterialRuns.InsertOneAsync(run);
        _runId = run.Id;
        return run;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TranscriptFailure_RemovesOnlyThisAttemptEntriesAndAttachment_PreservesPublishedFile(bool foreignEntryWithSameRunId)
    {
        _failure = "transcript-save";
        var run = await Seed();
        DocumentEntry? foreign = null;
        if (foreignEntryWithSameRunId)
        {
            foreign = new DocumentEntry { StoreId = run.StoreId!, CreatedBy = run.UserId,
                Title = "已有独立条目，不能按runId泛删", Metadata = new() { ["runId"] = run.Id } };
            await _db.DocumentEntries.InsertOneAsync(foreign);
            await _db.DocumentStores.UpdateOneAsync(x => x.Id == run.StoreId,
                Builders<DocumentStore>.Update.Set(x => x.DocumentCount, 1).Set(x => x.PrimaryEntryId, foreign.Id));
        }
        await Assert.ThrowsAsync<IOException>(() => Processor().ProcessAsync(run.Id));
        Assert.Equal(foreign == null ? 0 : 1, await _db.DocumentEntries.CountDocumentsAsync(x => x.CreatedBy == run.UserId));
        Assert.Equal(0, await _db.Attachments.CountDocumentsAsync(x => x.UploaderId == run.UserId));
        var store = await _db.DocumentStores.Find(x => x.Id == run.StoreId).SingleAsync();
        Assert.Equal(foreign == null ? 0 : 1, store.DocumentCount);
        Assert.Equal(foreign?.Id, store.PrimaryEntryId);
        Assert.Single(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        Assert.Equal(1, _outboundCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task KnownUploadThenCancellation_ReclaimsOnlyUnpublishedAttemptKey_LeavesExistingSharedBytes(bool hasSharedFile)
    {
        var shared = hasSharedFile ? await _local.SaveAsync(Mp4(), "video/mp4", CancellationToken.None, "workflow-agent", "doc") : null;
        _failure = "cancel-after-upload-ack";
        var run = await Seed();
        await Assert.ThrowsAnyAsync<Exception>(() => Processor().ProcessAsync(run.Id));
        if (shared != null) Assert.Equal(Mp4(), await _local.TryDownloadBytesAsync(shared.Key!, CancellationToken.None));
        Assert.Equal(hasSharedFile ? 1 : 0, Directory.GetFiles(_files, "*", SearchOption.AllDirectories).Length);
        Assert.Equal(0, await _db.DocumentEntries.CountDocumentsAsync(FilterDefinition<DocumentEntry>.Empty));
        Assert.Equal(1, _outboundCalls);
    }

    [Fact]
    public async Task FailureDoesNotRemoveAnEntryAlreadyEditedByItsUser()
    {
        _failure = "transcript-save";
        var run = await Seed();
        _beforeDocumentFailure = async () =>
        {
            var source = await _db.DocumentEntries.Find(Builders<DocumentEntry>.Filter.Eq("Metadata.runId", run.Id)).SingleAsync();
            await _db.DocumentEntries.UpdateOneAsync(x => x.Id == source.Id,
                Builders<DocumentEntry>.Update.Set(x => x.Title, "用户已保留并改名的素材")
                    .Set(x => x.UpdatedAt, source.UpdatedAt.AddSeconds(1)));
        };
        await Assert.ThrowsAsync<IOException>(() => Processor().ProcessAsync(run.Id));
        var retained = await _db.DocumentEntries.Find(x => x.CreatedBy == run.UserId).SingleAsync();
        Assert.Equal("用户已保留并改名的素材", retained.Title);
        Assert.Equal(1, await _db.Attachments.CountDocumentsAsync(x => x.AttachmentId == retained.AttachmentId));
        Assert.Equal(1, (await _db.DocumentStores.Find(x => x.Id == run.StoreId).SingleAsync()).DocumentCount);
        Assert.Single(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task UnknownUploadOutcome_KeepsResponsibilityAndFile_WithoutAttemptingPhysicalDelete()
    {
        _failure = "upload-result-unknown";
        var run = await Seed();
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => Processor().ProcessAsync(run.Id));
        Assert.DoesNotContain("本机模拟", ex.Message);
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.True(actual.CleanupPending);
        Assert.Equal("upload-outcome-unknown", actual.ArtifactReceipt!.PhysicalState);
        Assert.Single(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        _storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None), Times.Never);
        Assert.Equal(1, _outboundCalls);
    }

    [Fact]
    public async Task ExistingDeletePolicyDenial_KeepsExactReceiptAndFile_WithoutClaimingPhysicalRemoval()
    {
        _failure = "cancel-after-upload-ack"; _denyDelete = true;
        var run = await Seed();
        await Assert.ThrowsAnyAsync<Exception>(() => Processor().ProcessAsync(run.Id));
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.True(actual.CleanupPending);
        Assert.Equal("delete-pending", actual.ArtifactReceipt!.PhysicalState);
        Assert.Single(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        _storage.Verify(x => x.DeleteByKeyAsync(actual.ArtifactReceipt.StorageKey!, CancellationToken.None), Times.Once);
    }

    [Theory]
    [InlineData("done")]
    [InlineData("other-owner")]
    [InlineData("other-permit")]
    [InlineData("other-processing")]
    [InlineData("other-user")]
    [InlineData("missing")]
    public async Task CleanupFence_PreservesCompletedOrReplacementExecutionAndItsArtifacts(string changed)
    {
        var run = await Seed();
        var identity = new ShortVideoMaterialRun { Id = run.Id, UserId = run.UserId, OwnerInstanceId = run.OwnerInstanceId,
            TaskPermitId = run.TaskPermitId, ProcessingToken = run.ProcessingToken };
        var attachment = new Attachment { UploaderId = run.UserId, Url = "https://fixture.invalid/retained.mp4" };
        await _db.Attachments.InsertOneAsync(attachment);
        var entry = new DocumentEntry { StoreId = run.StoreId!, CreatedBy = run.UserId, AttachmentId = attachment.AttachmentId,
            Metadata = new() { ["runId"] = run.Id } };
        await _db.DocumentEntries.InsertOneAsync(entry);
        run.ArtifactReceipt = new() { ProcessingToken = run.ProcessingToken!, PublicationStarted = true,
            Entries = [new() { EntryId = entry.Id, StoreId = run.StoreId!, AttachmentId = attachment.AttachmentId }] };
        if (changed == "done") { run.Status = "done"; run.ProcessingToken = null; }
        if (changed == "other-owner") run.OwnerInstanceId = "another-instance";
        if (changed == "other-permit") run.TaskPermitId = "replacement-permit";
        if (changed == "other-processing") run.ProcessingToken = Guid.NewGuid().ToString("N");
        if (changed == "other-user") run.UserId = "another-local-owner";
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        if (changed == "missing") await _db.ShortVideoMaterialRuns.DeleteOneAsync(x => x.Id == run.Id);
        var method = typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await (Task)method.Invoke(Processor(), [run, identity])!;
        Assert.Equal(1, await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == entry.Id));
        Assert.Equal(1, await _db.Attachments.CountDocumentsAsync(x => x.AttachmentId == attachment.AttachmentId));
        _storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None), Times.Never);
        var after = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync();
        if (changed == "missing") Assert.Null(after);
        else { Assert.False(after!.ArtifactCleanupStarted); Assert.Equal(run.TaskPermitId, after.TaskPermitId); Assert.Equal(run.ProcessingToken, after.ProcessingToken); }
    }

    [Fact]
    public async Task CleanupCannotAdoptAnExistingSharedShaKeyAsAttemptOwnership()
    {
        var shared = await _local.SaveAsync(Mp4(), "video/mp4", CancellationToken.None, "workflow-agent", "doc");
        var run = await Seed();
        run.ArtifactReceipt = new() { ProcessingToken = run.ProcessingToken!, PhysicalState = "uploaded",
            StorageKey = shared.Key, PredictedKey = shared.Key, Url = shared.Url };
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        var method = typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await (Task)method.Invoke(Processor(), [run, run])!;
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.True(actual.CleanupPending);
        Assert.Equal("ownership-unconfirmed", actual.ArtifactReceipt!.PhysicalState);
        Assert.Equal(Mp4(), await _local.TryDownloadBytesAsync(shared.Key!, CancellationToken.None));
        _storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None), Times.Never);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ProductionLifecycleWrapper_CleansOriginalArtifactsAfterLeaseExitWithoutNewAdmission(bool cancellation)
    {
        var run = await Seed();
        _failure = cancellation ? "cancel-after-upload-ack" : "transcript-save";
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        var proof = new TaskExecutionLeaseProof(run.TaskPermitId!, run.Id, "local-artifact-lease", 1);
        var revoked = false; var completed = false; var cleanupWrites = 0;
        coordinator.Setup(x => x.AcquireAsync(run.TaskPermitId!, run.Id, CancellationToken.None))
            .ReturnsAsync(() => new TaskExecutionLease(coordinator.Object, proof));
        coordinator.Setup(x => x.ValidateAsync(proof, It.IsAny<bool>(), CancellationToken.None)).ReturnsAsync(() => !revoked);
        coordinator.Setup(x => x.RenewAsync(proof, It.IsAny<CancellationToken>())).ReturnsAsync(() => !revoked);
        coordinator.Setup(x => x.CompleteAsync(proof, CancellationToken.None)).Callback(() => completed = true).ReturnsAsync(() => !revoked);
        coordinator.Setup(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None))
            .Callback(() => revoked = true).Returns(Task.CompletedTask);
        var wrapped = TaskLifecycleMongoDatabase.Wrap(_database, () =>
        {
            if (TaskExecutionContext.Current == null) { Assert.True(completed); cleanupWrites++; }
            return coordinator.Object;
        });
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_db, wrapped);
        var processor = new ShortVideoMaterialProcessor(_db, _documents.Object, new ConfigurationBuilder().Build(),
            _services, NullLogger<ShortVideoMaterialProcessor>.Instance, coordinator.Object);
        await Assert.ThrowsAnyAsync<Exception>(() => processor.ProcessAsync(run.Id));
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.True(actual.ArtifactCleanupStarted); Assert.True(completed); Assert.True(cleanupWrites >= 2);
        Assert.Equal(0, await _db.DocumentEntries.CountDocumentsAsync(x => x.CreatedBy == run.UserId));
        Assert.Equal(cancellation ? 0 : 1, Directory.GetFiles(_files, "*", SearchOption.AllDirectories).Length);
        coordinator.Verify(x => x.AcquireAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        coordinator.Verify(x => x.CompleteAsync(proof, CancellationToken.None), Times.Once);
        Assert.DoesNotContain(coordinator.Invocations, call => call.Method.Name == "RegisterAsync");
    }

    private async Task<ShortVideoMaterialRun> SeedUploadedAttempt()
    {
        var run = await Seed();
        var predicted = _local.TryBuildContentAddressedKey(Mp4(), "video/mp4", "workflow-agent", "doc")!;
        var key = predicted[..predicted.LastIndexOf('/')] + $"/short-video/{run.Id}/{run.ProcessingToken}/{Path.GetFileName(predicted)}";
        await _local.UploadToKeyAsync(key, Mp4(), "video/mp4", CancellationToken.None);
        run.CleanupPending = true;
        run.ArtifactReceipt = new() { ProcessingToken = run.ProcessingToken!, PredictedKey = predicted,
            StorageKey = key, Url = _local.BuildUrlForKey(key), PhysicalState = "uploaded" };
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        return run;
    }

    [Fact]
    public async Task CancelRejectsPublicationIntentBeforeAnyMetadataWrite_ReclaimsUnpublishedAcknowledgedFile()
    {
        var run = await SeedUploadedAttempt();
        await _db.ShortVideoMaterialRuns.UpdateOneAsync(x => x.Id == run.Id,
            Builders<ShortVideoMaterialRun>.Update.Set(x => x.CancelRequested, true));
        var processor = Processor();
        var method = typeof(ShortVideoMaterialProcessor).GetMethod("CreateVideoEntryAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var parameters = method.GetParameters();
        var video = Activator.CreateInstance(parameters[4].ParameterType, [run.ArtifactReceipt!.Url, "video/mp4", 4L, "synthetic-sha"]);
        var parsed = Activator.CreateInstance(parameters[5].ParameterType, [null, null, "direct-video", "synthetic", null, "https://fixture.invalid/source", null]);
        var task = (Task)method.Invoke(processor, [new DocumentStore { Id = run.StoreId! }, run.UserId, "本机合成用户",
            "合成素材", video, parsed, "https://fixture.invalid/source", "unknown", run, DateTime.UtcNow])!;
        await Assert.ThrowsAnyAsync<Exception>(() => task);
        await (Task)typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(processor, [run, run])!;
        Assert.Empty(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        Assert.Equal(0, await _db.Attachments.CountDocumentsAsync(FilterDefinition<Attachment>.Empty));
        Assert.Equal(0, await _db.DocumentEntries.CountDocumentsAsync(FilterDefinition<DocumentEntry>.Empty));
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.False(actual.CleanupPending); Assert.Equal("deleted", actual.ArtifactReceipt!.PhysicalState);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(true, true, true)]
    public async Task OriginalWorkerRecovery_ReclaimsKnownUnpublishedReceiptBeforeClearingExecution(bool stale, bool cancelled, bool wrapped)
    {
        var run = await SeedUploadedAttempt();
        var configuration = new ConfigurationBuilder().Build();
        run.OwnerInstanceId = InstanceIdentity.Get(configuration);
        run.CancelRequested = cancelled; run.UpdatedAt = DateTime.UtcNow.AddMinutes(-16);
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        var foreign = new ShortVideoMaterialRun { UserId = run.UserId, Status = "running", OwnerInstanceId = "another-instance",
            ProcessingToken = Guid.NewGuid().ToString("N"), TaskPermitId = "another-synthetic-permit", UpdatedAt = run.UpdatedAt };
        await _db.ShortVideoMaterialRuns.InsertOneAsync(foreign);
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        coordinator.Setup(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None)).Returns(Task.CompletedTask);
        if (wrapped) typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(_db, TaskLifecycleMongoDatabase.Wrap(_database, () => coordinator.Object));
        await using var provider = new ServiceCollection().AddSingleton(_db).AddSingleton<IConfiguration>(configuration)
            .AddSingleton(_documents.Object).AddSingleton(_storage.Object)
            .AddSingleton<ShortVideoMaterialProcessor>(sp => new(_db, _documents.Object, configuration, sp,
                NullLogger<ShortVideoMaterialProcessor>.Instance, coordinator.Object)).BuildServiceProvider();
        var worker = new ShortVideoMaterialWorker(provider.GetRequiredService<IServiceScopeFactory>(), NullLogger<ShortVideoMaterialWorker>.Instance);
        await (Task)typeof(ShortVideoMaterialWorker).GetMethod(stale ? "RecoverStaleRunningRunsAsync" : "RecoverRunningRunsAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, null)!;
        Assert.Empty(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(cancelled ? "cancelled" : "failed", actual.Status); Assert.Null(actual.ProcessingToken);
        Assert.False(actual.CleanupPending); Assert.Equal("deleted", actual.ArtifactReceipt!.PhysicalState);
        var other = await _db.ShortVideoMaterialRuns.Find(x => x.Id == foreign.Id).SingleAsync();
        Assert.Equal(foreign.Status, other.Status); Assert.Equal(foreign.ProcessingToken, other.ProcessingToken);
        coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.AtLeastOnce);
        Assert.DoesNotContain(coordinator.Invocations, call => call.Method.Name is "AcquireAsync" or "RegisterAsync");
        Assert.Equal(0, _outboundCalls);
    }

    [Fact]
    public async Task CancelBeforeUploadIntentIsAccepted_DoesNotCreateAnUnknownUploadResponsibility()
    {
        var run = await Seed();
        await _db.ShortVideoMaterialRuns.UpdateOneAsync(x => x.Id == run.Id,
            Builders<ShortVideoMaterialRun>.Update.Set(x => x.CancelRequested, true));
        var processor = Processor();
        var upload = typeof(ShortVideoMaterialProcessor).GetMethod("StoreAttemptVideoAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await Assert.ThrowsAnyAsync<Exception>(() => (Task)upload.Invoke(processor, [run, Mp4(), "video/mp4", CancellationToken.None])!);
        await (Task)typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(processor, [run, run])!;
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.False(actual.CleanupPending); Assert.Empty(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        _storage.Verify(x => x.UploadToKeyAsync(It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), null), Times.Never);
    }

    [Fact]
    public async Task UploadAcceptance_AlreadyHasDurableUnknownOutcomeResponsibility()
    {
        var run = await Seed();
        await Processor().ProcessAsync(run.Id);
        Assert.Equal("upload-started", _durableUploadIntent);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task OriginalRecovery_PreservesUnknownUploadOrPublicationIntent(bool stale, bool publication)
    {
        var run = await SeedUploadedAttempt();
        var configuration = new ConfigurationBuilder().Build();
        run.OwnerInstanceId = InstanceIdentity.Get(configuration); run.UpdatedAt = DateTime.UtcNow.AddMinutes(-16);
        if (publication) run.ArtifactReceipt!.Entries.Add(new() { EntryId = Guid.NewGuid().ToString("N"),
            StoreId = run.StoreId!, AttachmentId = Guid.NewGuid().ToString("N"), UnconfirmedWrite = true });
        else run.ArtifactReceipt!.PhysicalState = "upload-started";
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        coordinator.Setup(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None)).Returns(Task.CompletedTask);
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(_db, TaskLifecycleMongoDatabase.Wrap(_database, () => coordinator.Object));
        await using var provider = new ServiceCollection().AddSingleton(_db).AddSingleton<IConfiguration>(configuration)
            .AddSingleton<ShortVideoMaterialProcessor>(sp => new(_db, _documents.Object, configuration, _services,
                NullLogger<ShortVideoMaterialProcessor>.Instance, coordinator.Object)).BuildServiceProvider();
        var worker = new ShortVideoMaterialWorker(provider.GetRequiredService<IServiceScopeFactory>(), NullLogger<ShortVideoMaterialWorker>.Instance);
        await (Task)typeof(ShortVideoMaterialWorker).GetMethod(stale ? "RecoverStaleRunningRunsAsync" : "RecoverRunningRunsAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, null)!;
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal("failed", actual.Status); Assert.Null(actual.ProcessingToken); Assert.True(actual.CleanupPending);
        Assert.Equal(publication ? "retained-published" : "upload-started", actual.ArtifactReceipt!.PhysicalState);
        Assert.Single(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        _storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None), Times.Never);
        Assert.DoesNotContain(coordinator.Invocations, call => call.Method.Name is "AcquireAsync" or "RegisterAsync");
        Assert.Equal(0, _outboundCalls);
    }

    [Theory]
    [InlineData("delete-pending")]
    [InlineData("ownership-unconfirmed")]
    public async Task ReenteredCleanup_PreservesUnresolvedPhysicalResponsibility(string state)
    {
        var run = await SeedUploadedAttempt(); run.ArtifactReceipt!.PhysicalState = state;
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        var cleanup = typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            run = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
            await (Task)cleanup.Invoke(Processor(), [run, run])!;
            var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
            Assert.True(actual.CleanupPending); Assert.Equal(state, actual.ArtifactReceipt!.PhysicalState);
        }
        Assert.Single(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        _storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None), Times.Never);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ReenteredCleanup_ConsumesDurableCountTokenAfterInterruptedAcknowledgements(bool entryAlreadyDeleted, bool hasForeignEntry)
    {
        var run = await Seed(); run.CleanupPending = true;
        var entry = new DocumentEntry { StoreId = run.StoreId!, CreatedBy = run.UserId, Metadata = new() { ["runId"] = run.Id } };
        if (!entryAlreadyDeleted) await _db.DocumentEntries.InsertOneAsync(entry);
        if (hasForeignEntry) await _db.DocumentEntries.InsertOneAsync(new() { StoreId = run.StoreId!, CreatedBy = "another-author" });
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == run.StoreId,
            Builders<DocumentStore>.Update.Set(x => x.DocumentCount, hasForeignEntry ? 2 : 1).Set(x => x.PrimaryEntryId, entry.Id)
                .AddToSet("ShortVideoCountedEntryIds", entry.Id));
        run.SourceEntryId = entry.Id;
        run.ArtifactReceipt = new() { ProcessingToken = run.ProcessingToken!, PhysicalState = "retained-published", PublicationStarted = true,
            Entries = [new() { EntryId = entry.Id, StoreId = run.StoreId!, EntryCreatedAt = entry.UpdatedAt }] };
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        var cleanup = typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            run = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
            await (Task)cleanup.Invoke(Processor(), [run, run])!;
            var store = await _db.DocumentStores.Find(x => x.Id == run.StoreId).SingleAsync();
            Assert.Equal(hasForeignEntry ? 1 : 0, store.DocumentCount);
            Assert.Equal(hasForeignEntry ? 1 : 0, await _db.DocumentEntries.CountDocumentsAsync(x => x.StoreId == run.StoreId));
            Assert.NotEqual(entry.Id, store.PrimaryEntryId);
            Assert.Null((await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync()).SourceEntryId);
        }
        Assert.Equal(0, _outboundCalls);
    }

    [Fact]
    public async Task FailureCleanup_DoesNotCountAnOrdinaryEntryWhoseIncrementIsStillPending()
    {
        var run = await Seed(); run.CleanupPending = true;
        var own = new DocumentEntry { StoreId = run.StoreId!, CreatedBy = run.UserId, Metadata = new() { ["runId"] = run.Id } };
        await _db.DocumentEntries.InsertOneAsync(own);
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == run.StoreId,
            Builders<DocumentStore>.Update.Set(x => x.DocumentCount, 1).AddToSet("ShortVideoCountedEntryIds", own.Id));
        run.ArtifactReceipt = new() { ProcessingToken = run.ProcessingToken!, PublicationStarted = true,
            Entries = [new() { EntryId = own.Id, StoreId = run.StoreId!, EntryCreatedAt = own.UpdatedAt }] };
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        // 原 AddEntry 契约先插入、后 $inc；把两步间的真实窗口留给补偿，不改该写入者。
        await _db.DocumentEntries.InsertOneAsync(new() { StoreId = run.StoreId!, CreatedBy = "ordinary-add-entry" });
        await (Task)typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(Processor(), [run, run])!;
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == run.StoreId, Builders<DocumentStore>.Update.Inc(x => x.DocumentCount, 1));
        Assert.Equal(1, (await _db.DocumentStores.Find(x => x.Id == run.StoreId).SingleAsync()).DocumentCount);
        Assert.Equal(1, await _db.DocumentEntries.CountDocumentsAsync(x => x.StoreId == run.StoreId));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task OriginalDeleteConsumer_AndFailureCleanupShareOneCountDecrement(bool userDeletesFirst, bool mixedBatch)
    {
        var run = await Seed(); run.CleanupPending = true;
        var own = new DocumentEntry { StoreId = run.StoreId!, CreatedBy = run.UserId, Metadata = new() { ["runId"] = run.Id } };
        var other = new DocumentEntry { StoreId = run.StoreId!, CreatedBy = "ordinary-entry" };
        await _db.DocumentEntries.InsertManyAsync([own, other]);
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == run.StoreId,
            Builders<DocumentStore>.Update.Set(x => x.DocumentCount, 2).AddToSet("ShortVideoCountedEntryIds", own.Id));
        run.ArtifactReceipt = new() { ProcessingToken = run.ProcessingToken!, PublicationStarted = true,
            Entries = [new() { EntryId = own.Id, StoreId = run.StoreId!, EntryCreatedAt = own.UpdatedAt }] };
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        async Task DeleteOriginal()
        {
            var receipt = await PrdAgent.Api.Controllers.Api.DocumentStoreController.BeginEntryDeletionAsync(
                _db, run.StoreId!, mixedBatch ? [own.Id, other.Id] : [own.Id]);
            await PrdAgent.Api.Controllers.Api.DocumentStoreController.CompleteEntryDeletionCountsAsync(_db, receipt, DateTime.UtcNow);
        }
        async Task Cleanup() => await (Task)typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(Processor(), [run, run])!;
        if (userDeletesFirst) { await DeleteOriginal(); await Cleanup(); }
        else { await Cleanup(); await DeleteOriginal(); }
        Assert.Equal(mixedBatch ? 0 : 1, (await _db.DocumentStores.Find(x => x.Id == run.StoreId).SingleAsync()).DocumentCount);
        Assert.Equal(mixedBatch ? 0 : 1, await _db.DocumentEntries.CountDocumentsAsync(x => x.StoreId == run.StoreId));
        Assert.Empty(await ShortVideoMaterialProcessor.ReadCountedEntryIdsAsync(_db.DocumentStores, run.StoreId!, [own.Id]));
        Assert.Equal(0, _outboundCalls);
    }

    [Fact]
    public async Task ProductionHashedParserAndPersistence_UseOwnedBodyWithoutChangingSharedDocument_AndClearItsCache()
    {
        var parser = new Mock<IMarkdownParser>(MockBehavior.Strict);
        parser.Setup(x => x.Parse(It.IsAny<string>())).Returns((string text) => new ParsedPrd { RawContent = text });
        var cached = new Dictionary<string, ParsedPrd>();
        _cache.Setup(x => x.SetAsync(It.IsAny<string>(), It.IsAny<ParsedPrd>(), null))
            .Callback<string, ParsedPrd, TimeSpan?>((key, doc, _) => cached[key] = doc).Returns(Task.CompletedTask);
        _cache.Setup(x => x.RemoveAsync(It.IsAny<string>())).Callback<string>(key => cached.Remove(key)).Returns(Task.CompletedTask);
        var repository = new Mock<IPrdDocumentRepository>(MockBehavior.Strict);
        repository.Setup(x => x.UpsertAsync(It.IsAny<ParsedPrd>())).Returns<ParsedPrd>(async doc =>
            await _db.Documents.ReplaceOneAsync(x => x.Id == doc.Id, doc, new ReplaceOptions { IsUpsert = true }));
        var production = new PrdAgent.Core.Services.DocumentService(_cache.Object, parser.Object, repository.Object);
        string? sharedId = null; string? savedId = null;
        _documents.Setup(x => x.ParseAsync(It.IsAny<string>())).Returns<string>(async text =>
        {
            var parsed = await production.ParseAsync(text); sharedId = parsed.Id;
            Assert.Matches("^[a-f0-9]{64}$", parsed.Id);
            await _db.Documents.InsertOneAsync(new() { Id = parsed.Id, RawContent = text, Title = "原共享正文标题" });
            return parsed;
        });
        _documents.Setup(x => x.SaveAsync(It.IsAny<ParsedPrd>())).Returns<ParsedPrd>(async doc =>
        {
            savedId = doc.Id; var result = await production.SaveAsync(doc);
            await _db.ShortVideoMaterialRuns.UpdateOneAsync(x => x.Id == _runId,
                Builders<ShortVideoMaterialRun>.Update.Set(x => x.CancelRequested, true));
            return result;
        });
        var run = await Seed();
        await Assert.ThrowsAnyAsync<Exception>(() => Processor().ProcessAsync(run.Id));
        Assert.NotNull(savedId); Assert.True(Guid.TryParse(savedId, out _)); Assert.NotEqual(sharedId, savedId);
        Assert.Equal(0, await _db.Documents.CountDocumentsAsync(x => x.Id == savedId));
        Assert.Equal("原共享正文标题", (await _db.Documents.Find(x => x.Id == sharedId).SingleAsync()).Title);
        Assert.False(cached.ContainsKey(CacheKeys.ForDocument(savedId!)));
        Assert.Equal(1, _outboundCalls);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task OwnedBody_PreservesPublishedOrStillReferencedContent(bool published, bool referenced)
    {
        var run = await Seed(); var body = new ParsedPrd { RawContent = "本机合成正文" };
        await _db.Documents.InsertOneAsync(body);
        if (referenced) await _db.DocumentEntries.InsertOneAsync(new() { StoreId = "another-store", DocumentId = body.Id, CreatedBy = "another-user" });
        run.ArtifactReceipt = new() { ProcessingToken = run.ProcessingToken!, Entries = [new() { EntryId = Guid.NewGuid().ToString("N"),
            StoreId = run.StoreId!, DocumentId = body.Id, DocumentCreatedNew = true, DocumentPublicationStarted = published }] };
        run.CleanupPending = true;
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        await (Task)typeof(ShortVideoMaterialProcessor).GetMethod("CleanupArtifactsAfterFailureAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(Processor(), [run, run])!;
        Assert.Equal(1, await _db.Documents.CountDocumentsAsync(x => x.Id == body.Id));
        Assert.Equal(published, (await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync()).CleanupPending);
        _cache.Verify(x => x.RemoveAsync(CacheKeys.ForDocument(body.Id)), Times.Never);
    }

    [Fact]
    public async Task DeferredCountFailure_HappensAfterLinkedArtifactsAreRemoved()
    {
        var run = await Seed(); var body = new ParsedPrd { RawContent = "本机合成正文" };
        var attachment = new Attachment { UploaderId = run.UserId };
        var entry = new DocumentEntry { StoreId = run.StoreId!, CreatedBy = run.UserId, DocumentId = body.Id, AttachmentId = attachment.AttachmentId };
        var bodies = _db.Documents; var attachments = _db.Attachments;
        await bodies.InsertOneAsync(body); await attachments.InsertOneAsync(attachment); await _db.DocumentEntries.InsertOneAsync(entry);
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == run.StoreId,
            Builders<DocumentStore>.Update.Set(x => x.DocumentCount, 1).AddToSet("ShortVideoCountedEntryIds", entry.Id));
        var receipt = await PrdAgent.Api.Controllers.Api.DocumentStoreController.BeginEntryDeletionAsync(_db, run.StoreId!, [entry.Id]);
        Assert.Equal(1, (await _db.DocumentStores.Find(x => x.Id == run.StoreId).SingleAsync()).DocumentCount);
        await bodies.DeleteOneAsync(x => x.Id == body.Id); await attachments.DeleteOneAsync(x => x.AttachmentId == attachment.AttachmentId);
        var failedStores = new Mock<IMongoCollection<DocumentStore>>(MockBehavior.Strict);
        failedStores.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<DocumentStore>>(), It.IsAny<UpdateDefinition<DocumentStore>>(),
            It.IsAny<UpdateOptions>(), CancellationToken.None)).ThrowsAsync(new TimeoutException("本机计数回执未确认"));
        var failedDb = new Mock<IMongoDatabase>(MockBehavior.Strict);
        failedDb.Setup(x => x.GetCollection<DocumentStore>("document_stores", null)).Returns(failedStores.Object);
        var field = typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!;
        field.SetValue(_db, failedDb.Object);
        try { await Assert.ThrowsAsync<TimeoutException>(() => PrdAgent.Api.Controllers.Api.DocumentStoreController.CompleteEntryDeletionCountsAsync(_db, receipt, DateTime.UtcNow)); }
        finally { field.SetValue(_db, _database); }
        Assert.Equal(0, await bodies.CountDocumentsAsync(x => x.Id == body.Id));
        Assert.Equal(0, await attachments.CountDocumentsAsync(x => x.AttachmentId == attachment.AttachmentId));
    }

    [Fact]
    public async Task SuccessfulManualPipeline_KeepsBothCommittedEntriesAndFile_WithoutProviderCalls()
    {
        var run = await Seed();
        await Processor().ProcessAsync(run.Id);
        var actual = await _db.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal("done", actual.Status);
        Assert.Null(actual.ProcessingToken);
        Assert.Equal(2, await _db.DocumentEntries.CountDocumentsAsync(x => x.CreatedBy == run.UserId));
        Assert.Equal(2, (await _db.DocumentStores.Find(x => x.Id == run.StoreId).SingleAsync()).DocumentCount);
        Assert.Single(Directory.GetFiles(_files, "*", SearchOption.AllDirectories));
        Assert.Equal(1, _outboundCalls);
    }

    public async Task DisposeAsync()
    {
        if (_services != null) await _services.DisposeAsync();
        if (_database != null) await _client.DropDatabaseAsync(_database.DatabaseNamespace.DatabaseName);
        // 留存本人临时文件供核对；生产对象、其他目录和任何远端均不触碰。
    }

    private static byte[] Mp4()
    {
        var payload = Encoding.ASCII.GetBytes("isom").Concat(new byte[4]).Concat(Encoding.ASCII.GetBytes("mp42avc1")).ToArray();
        return BitConverter.GetBytes(IPAddress.HostToNetworkOrder(payload.Length + 8))
            .Concat(Encoding.ASCII.GetBytes("ftyp")).Concat(payload).ToArray();
    }
    private sealed class LocalReply(Action counted) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal("fixture.invalid", request.RequestUri!.Host);
            counted();
            var content = new ByteArrayContent(Mp4()); content.Headers.ContentType = new MediaTypeHeaderValue("video/mp4");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }
    }
}
