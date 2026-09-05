using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests;

public sealed class DesignArtifactWorkspaceBrokerSecurityTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RuntimeTicketCannotReadOrCommitAnotherRun()
    {
        await using var fixture = await BrokerFixture.CreateAsync();
        var first = await fixture.PrepareAsync("run-ticket-a");
        var second = await fixture.PrepareAsync("run-ticket-b");
        var result = BuildResult("run-ticket-b", second.BaseRevision, "合法结果");

        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            fixture.Broker.ReadInputPackageAsync("run-ticket-b", first.TransferToken, CancellationToken.None));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            fixture.Broker.CommitResultAsync("run-ticket-b", first.TransferToken, result, CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResultCommitAcceptsExactReplayAndRejectsChangedReplay()
    {
        await using var fixture = await BrokerFixture.CreateAsync();
        var workspace = await fixture.PrepareAsync("run-replay");
        var original = BuildResult("run-replay", workspace.BaseRevision, "第一份结果");
        var changed = BuildResult("run-replay", workspace.BaseRevision, "被替换的结果");
        var objectsBeforeCommit = fixture.AssetObjectCount;

        var first = await fixture.Broker.CommitResultAsync(
            "run-replay",
            workspace.TransferToken,
            original,
            CancellationToken.None);
        var replay = await fixture.Broker.CommitResultAsync(
            "run-replay",
            workspace.TransferToken,
            original,
            CancellationToken.None);
        var rejected = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.Broker.CommitResultAsync(
                "run-replay",
                workspace.TransferToken,
                changed,
                CancellationToken.None));

        Assert.False(first.Idempotent);
        Assert.True(replay.Idempotent);
        Assert.Equal(first.ResultSha256, replay.ResultSha256);
        Assert.Contains("已经提交过不同结果", rejected.Message, StringComparison.Ordinal);
        Assert.Equal(objectsBeforeCommit + 1, fixture.AssetObjectCount);
        var persisted = await fixture.Db.DesignArtifactRuns
            .Find(run => run.Id == "run-replay")
            .FirstAsync();
        Assert.Equal(first.ResultSha256, persisted.WorkspaceResultSha256);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ConcurrentDifferentResultLosesReservationBeforeObjectWrite()
    {
        await using var fixture = await BrokerFixture.CreateAsync();
        var workspace = await fixture.PrepareAsync("run-concurrent-result");
        var firstPackage = BuildResult("run-concurrent-result", workspace.BaseRevision, "获胜结果");
        var competingPackage = BuildResult("run-concurrent-result", workspace.BaseRevision, "竞争结果");
        var objectsBeforeCommit = fixture.AssetObjectCount;
        fixture.Storage.BlockNextSave();

        var winningCommit = fixture.Broker.CommitResultAsync(
            "run-concurrent-result",
            workspace.TransferToken,
            firstPackage,
            CancellationToken.None);
        await fixture.Storage.WaitUntilBlockedAsync();

        var rejected = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.Broker.CommitResultAsync(
                "run-concurrent-result",
                workspace.TransferToken,
                competingPackage,
                CancellationToken.None));
        Assert.Contains("已经提交过不同结果", rejected.Message, StringComparison.Ordinal);
        Assert.Equal(1, fixture.Storage.BlockedSaveAttempts);

        fixture.Storage.ReleaseBlockedSave();
        var committed = await winningCommit;

        Assert.False(committed.Idempotent);
        Assert.Equal(objectsBeforeCommit + 1, fixture.AssetObjectCount);
        var persisted = await fixture.Db.DesignArtifactRuns
            .Find(run => run.Id == "run-concurrent-result")
            .FirstAsync();
        Assert.Equal(committed.ResultSha256, persisted.WorkspaceResultSha256);
        Assert.NotNull(persisted.WorkspaceResultAssetKey);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    [Trait("Category", TestCategories.Integration)]
    public async Task ResultWrittenWhileRunBecomesInactiveIsDeletedAndReservationReleased(bool terminal)
    {
        await using var fixture = await BrokerFixture.CreateAsync();
        var runId = terminal ? "run-terminal-during-save" : "run-lease-expired-during-save";
        var workspace = await fixture.PrepareAsync(runId);
        var result = BuildResult(runId, workspace.BaseRevision, "不应接纳的晚到结果");
        var objectsBeforeCommit = fixture.AssetObjectCount;
        fixture.Storage.BlockNextSave();

        var committing = fixture.Broker.CommitResultAsync(
            runId,
            workspace.TransferToken,
            result,
            CancellationToken.None);
        await fixture.Storage.WaitUntilBlockedAsync();
        var revoke = terminal
            ? Builders<DesignArtifactRun>.Update
                .Set(run => run.Status, RunStatuses.Error)
                .Set(run => run.LeaseExpiresAt, null)
            : Builders<DesignArtifactRun>.Update
                .Set(run => run.LeaseExpiresAt, DateTime.UtcNow.AddSeconds(-1));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(run => run.Id == runId, revoke);

        fixture.Storage.ReleaseBlockedSave();
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => committing);

        Assert.Equal(objectsBeforeCommit, fixture.AssetObjectCount);
        Assert.Single(fixture.Storage.DeletedKeys);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == runId).FirstAsync();
        Assert.Null(persisted.WorkspaceResultAssetKey);
        Assert.Null(persisted.WorkspaceResultSha256);
        Assert.Null(persisted.WorkspaceRejectedResultAssetKey);
        Assert.Null(persisted.WorkspaceRejectedResultCleanupAttemptedAt);
        Assert.Null(persisted.WorkspaceRejectedResultCleanupError);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task FailedLateResultDeletionIsRecoveredFromPersistedRunState()
    {
        await using var fixture = await BrokerFixture.CreateAsync();
        var runId = "run-late-result-cleanup-recovery";
        var workspace = await fixture.PrepareAsync(runId);
        var result = BuildResult(runId, workspace.BaseRevision, "需要恢复器回收的晚到结果");
        var objectsBeforeCommit = fixture.AssetObjectCount;
        fixture.Storage.BlockNextSave();
        fixture.Storage.FailNextDeletes(1);

        var committing = fixture.Broker.CommitResultAsync(
            runId,
            workspace.TransferToken,
            result,
            CancellationToken.None);
        await fixture.Storage.WaitUntilBlockedAsync();
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            run => run.Id == runId,
            Builders<DesignArtifactRun>.Update
                .Set(run => run.Status, RunStatuses.Error)
                .Set(run => run.LeaseExpiresAt, null));

        fixture.Storage.ReleaseBlockedSave();
        await Assert.ThrowsAsync<IOException>(() => committing);

        Assert.Equal(objectsBeforeCommit + 1, fixture.AssetObjectCount);
        var pending = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == runId).FirstAsync();
        Assert.Null(pending.WorkspaceResultAssetKey);
        Assert.NotNull(pending.WorkspaceResultSha256);
        Assert.NotNull(pending.WorkspaceRejectedResultAssetKey);
        Assert.NotNull(pending.WorkspaceRejectedResultCleanupAttemptedAt);
        Assert.Contains("模拟对象删除失败", pending.WorkspaceRejectedResultCleanupError ?? string.Empty, StringComparison.Ordinal);

        var recovered = await HostedSiteEditRunWorker.RecoverRejectedWorkspaceResultsAsync(
            fixture.Db,
            fixture.Storage,
            DateTime.UtcNow,
            CancellationToken.None);

        Assert.Equal(1, recovered);
        Assert.Equal(objectsBeforeCommit, fixture.AssetObjectCount);
        var cleaned = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == runId).FirstAsync();
        Assert.Null(cleaned.WorkspaceResultAssetKey);
        Assert.Null(cleaned.WorkspaceResultSha256);
        Assert.Null(cleaned.WorkspaceRejectedResultAssetKey);
        Assert.Null(cleaned.WorkspaceRejectedResultCleanupAttemptedAt);
        Assert.Null(cleaned.WorkspaceRejectedResultCleanupError);
        Assert.Equal(2, fixture.Storage.DeletedKeys.Count);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    [Trait("Category", TestCategories.Integration)]
    public async Task ExactReplayCannotBypassRevocationAfterResultWasCommitted(bool terminal)
    {
        await using var fixture = await BrokerFixture.CreateAsync();
        var runId = terminal ? "run-replay-terminal" : "run-replay-expired-lease";
        var workspace = await fixture.PrepareAsync(runId);
        var result = BuildResult(runId, workspace.BaseRevision, "已提交结果");
        await fixture.Broker.CommitResultAsync(runId, workspace.TransferToken, result, CancellationToken.None);
        var objectsAfterCommit = fixture.AssetObjectCount;
        var revoke = terminal
            ? Builders<DesignArtifactRun>.Update
                .Set(run => run.Status, RunStatuses.Error)
                .Set(run => run.LeaseExpiresAt, null)
            : Builders<DesignArtifactRun>.Update
                .Set(run => run.LeaseExpiresAt, DateTime.UtcNow.AddSeconds(-1));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(run => run.Id == runId, revoke);

        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            fixture.Broker.CommitResultAsync(runId, workspace.TransferToken, result, CancellationToken.None));

        Assert.Equal(objectsAfterCommit, fixture.AssetObjectCount);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == runId).FirstAsync();
        Assert.NotNull(persisted.WorkspaceResultAssetKey);
        Assert.NotNull(persisted.WorkspaceResultSha256);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    [Trait("Category", TestCategories.Integration)]
    public async Task RevokedOrExpiredRunCannotReadInputOrCommitLateResult(bool terminal)
    {
        await using var fixture = await BrokerFixture.CreateAsync();
        var workspace = await fixture.PrepareAsync(terminal ? "run-terminal" : "run-expired-lease");
        var runId = terminal ? "run-terminal" : "run-expired-lease";
        var update = terminal
            ? Builders<DesignArtifactRun>.Update
                .Set(run => run.Status, RunStatuses.Error)
                .Set(run => run.LeaseExpiresAt, null)
            : Builders<DesignArtifactRun>.Update
                .Set(run => run.LeaseExpiresAt, DateTime.UtcNow.AddSeconds(-1));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(run => run.Id == runId, update);
        var result = BuildResult(runId, workspace.BaseRevision, "过期结果");

        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            fixture.Broker.ReadInputPackageAsync(runId, workspace.TransferToken, CancellationToken.None));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            fixture.Broker.CommitResultAsync(runId, workspace.TransferToken, result, CancellationToken.None));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            fixture.Broker.ValidateModelTicketAsync(runId, workspace.ModelToken, CancellationToken.None));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            fixture.Broker.ReserveModelCallAsync(runId, workspace.ModelToken, CancellationToken.None));
        var persisted = await fixture.Db.DesignArtifactRuns.Find(run => run.Id == runId).FirstAsync();
        Assert.Null(persisted.WorkspaceResultAssetKey);
        Assert.Null(persisted.WorkspaceResultSha256);
        Assert.Null(persisted.WorkspaceRejectedResultAssetKey);
        Assert.Equal(0, persisted.RuntimeModelCallCount);
    }

    private static byte[] BuildResult(string runId, string baseRevision, string body)
    {
        var html = Encoding.UTF8.GetBytes($"<!doctype html><html><body>{body}</body></html>");
        var htmlFile = new DesignWorkspaceFile(
            "index.html",
            Convert.ToBase64String(html),
            Hash(html),
            html.LongLength,
            "text/html");
        var manifestValue = new DesignArtifactManifest(
            DesignArtifactWorkspaceBroker.ManifestSchemaVersion,
            baseRevision,
            "index.html",
            [new DesignArtifactManifestFile(htmlFile.Path, htmlFile.Sha256, htmlFile.Size, htmlFile.MediaType)]);
        var manifest = JsonSerializer.SerializeToUtf8Bytes(
            manifestValue,
            DesignArtifactWorkspaceContract.JsonOptions);
        var manifestFile = new DesignWorkspaceFile(
            "manifest.json",
            Convert.ToBase64String(manifest),
            Hash(manifest),
            manifest.LongLength,
            "application/json");
        return JsonSerializer.SerializeToUtf8Bytes(
            new DesignWorkspacePackage(
                DesignArtifactWorkspaceBroker.SchemaVersion,
                runId,
                baseRevision,
                [htmlFile, manifestFile]),
            DesignArtifactWorkspaceContract.JsonOptions);
    }

    private static string Hash(byte[] content) =>
        Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();

    private sealed class BrokerFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;
        private readonly string _assetRoot;
        private readonly string _keyRoot;

        private BrokerFixture(
            MongoClient client,
            string connectionString,
            string databaseName,
            string assetRoot,
            string keyRoot)
        {
            _client = client;
            _databaseName = databaseName;
            _assetRoot = assetRoot;
            _keyRoot = keyRoot;
            Db = new MongoDbContext(connectionString, databaseName);
            Storage = new BlockingAssetStorage(new LocalAssetStorage(assetRoot));
            Broker = new DesignArtifactWorkspaceBroker(
                Db,
                Storage,
                DataProtectionProvider.Create(new DirectoryInfo(keyRoot)),
                new ConfigurationBuilder()
                    .AddInMemoryCollection(new Dictionary<string, string?>
                    {
                        ["DesignArtifactRuntime:PublicBaseUrl"] = "https://map.example.test",
                    })
                    .Build());
        }

        internal MongoDbContext Db { get; }
        internal DesignArtifactWorkspaceBroker Broker { get; }
        internal BlockingAssetStorage Storage { get; }
        internal int AssetObjectCount => Directory.GetFiles(_assetRoot, "*", SearchOption.AllDirectories).Length;

        internal static async Task<BrokerFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var databaseName = $"design_workspace_broker_test_{Guid.NewGuid():N}";
            var assetRoot = Path.Combine(Path.GetTempPath(), $"design-workspace-assets-{Guid.NewGuid():N}");
            var keyRoot = Path.Combine(Path.GetTempPath(), $"design-workspace-keys-{Guid.NewGuid():N}");
            Directory.CreateDirectory(assetRoot);
            Directory.CreateDirectory(keyRoot);
            return new BrokerFixture(client, connectionString, databaseName, assetRoot, keyRoot);
        }

        internal async Task<PreparedDesignArtifactWorkspace> PrepareAsync(string runId)
        {
            var now = DateTime.UtcNow;
            var run = new DesignArtifactRun
            {
                Id = runId,
                UserId = "user-1",
                Status = RunStatuses.Running,
                LeaseOwnerId = "worker-1",
                LeaseExpiresAt = now.AddMinutes(5),
                Instruction = "生成页面",
                KnowledgeReferences = [],
            };
            await Db.DesignArtifactRuns.InsertOneAsync(run);
            return await Broker.PrepareAsync(run, null, CancellationToken.None);
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
            if (Directory.Exists(_assetRoot)) Directory.Delete(_assetRoot, recursive: true);
            if (Directory.Exists(_keyRoot)) Directory.Delete(_keyRoot, recursive: true);
        }
    }

    internal sealed class BlockingAssetStorage(IAssetStorage inner) : IAssetStorage
    {
        private TaskCompletionSource? _saveStarted;
        private TaskCompletionSource? _releaseSave;
        private int _remainingDeleteFailures;

        internal int BlockedSaveAttempts { get; private set; }
        internal List<string> DeletedKeys { get; } = [];

        internal void BlockNextSave()
        {
            _saveStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _releaseSave = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            BlockedSaveAttempts = 0;
        }

        internal Task WaitUntilBlockedAsync() => _saveStarted?.Task
            ?? throw new InvalidOperationException("尚未启用存储阻塞");

        internal void ReleaseBlockedSave() => _releaseSave?.TrySetResult();

        internal void FailNextDeletes(int count) => _remainingDeleteFailures = count;

        public async Task<StoredAsset> SaveAsync(
            byte[] bytes,
            string mime,
            CancellationToken ct,
            string? domain = null,
            string? type = null,
            string? fileName = null,
            string? extensionHint = null)
        {
            if (_saveStarted != null && _releaseSave != null)
            {
                BlockedSaveAttempts++;
                _saveStarted.TrySetResult();
                await _releaseSave.Task.WaitAsync(ct);
            }
            return await inner.SaveAsync(bytes, mime, ct, domain, type, fileName, extensionHint);
        }

        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(
            string sha256,
            CancellationToken ct,
            string? domain = null,
            string? type = null) => inner.TryReadByShaAsync(sha256, ct, domain, type);

        public Task<AssetReadHandle?> TryOpenReadByShaAsync(
            string sha256,
            CancellationToken ct,
            string? domain = null,
            string? type = null) => inner.TryOpenReadByShaAsync(sha256, ct, domain, type);

        public Task DeleteByShaAsync(
            string sha256,
            CancellationToken ct,
            string? domain = null,
            string? type = null) => inner.DeleteByShaAsync(sha256, ct, domain, type);

        public string? TryBuildUrlBySha(
            string sha256,
            string mime,
            string? domain = null,
            string? type = null) => inner.TryBuildUrlBySha(sha256, mime, domain, type);

        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct) =>
            inner.TryDownloadBytesAsync(key, ct);

        public Task<bool> ExistsAsync(string key, CancellationToken ct) => inner.ExistsAsync(key, ct);

        public Task UploadToKeyAsync(
            string key,
            byte[] bytes,
            string? contentType,
            CancellationToken ct,
            string? cacheControl = null) => inner.UploadToKeyAsync(key, bytes, contentType, ct, cacheControl);

        public string BuildUrlForKey(string key) => inner.BuildUrlForKey(key);

        public string BuildUrlForLogicalKey(string logicalKey) => inner.BuildUrlForLogicalKey(logicalKey);

        public async Task DeleteByKeyAsync(string key, CancellationToken ct)
        {
            DeletedKeys.Add(key);
            if (Interlocked.Decrement(ref _remainingDeleteFailures) >= 0)
                throw new IOException("模拟对象删除失败");
            await inner.DeleteByKeyAsync(key, ct);
        }

        public string BuildSiteKey(string siteId, string filePath) => inner.BuildSiteKey(siteId, filePath);
    }
}
