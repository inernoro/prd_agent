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
    private LocalAssetStorage _local = null!;
    private readonly Mock<IAssetStorage> _storage = new(MockBehavior.Strict);
    private ServiceProvider _services = null!;
    private string? _failure;
    private int _outboundCalls;
    private string? _runId;
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
        var services = new ServiceCollection();
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
