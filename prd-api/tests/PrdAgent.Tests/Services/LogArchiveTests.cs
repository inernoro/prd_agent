using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Tests.Services;

public class LogArchiveCodecTests
{
    [Fact]
    public void RoundtripPreservesBsonTypesAndRejectsTampering()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var data = new BsonDocument { { "_id", ObjectId.GenerateNewId() }, { "at", DateTime.UtcNow }, { "body", "完整日志" }, { "amount", new Decimal128(1.25m) } };
        var packed = LogArchiveCodec.Pack(data, key);
        Assert.Equal(data, LogArchiveCodec.Unpack(packed, key));
        Assert.ThrowsAny<CryptographicException>(() => LogArchiveCodec.Unpack(packed, RandomNumberGenerator.GetBytes(32)));
        packed[^1] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => LogArchiveCodec.Unpack(packed, key));
    }
}

/// <summary>Named integration suite: owns fresh databases in CI Mongo or a loopback process, never uses production credentials.</summary>
[Trait("Category", "Integration")]
public sealed class LogArchiveIntegrationTests : IAsyncLifetime
{
    private Process? _process;
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "map-log-archive-test-" + Guid.NewGuid().ToString("N"));
    private MongoDbContext _db = null!;
    private LlmGatewayDataContext _gw = null!;
    private LogArchiveService _service = null!;
    private StorageProxy _store = null!;
    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        var uri = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION");
        var ci = Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true";
        if (ci && !string.IsNullOrWhiteSpace(uri))
        {
            var endpoint = new Uri(uri);
            if (endpoint.Host is not ("127.0.0.1" or "localhost") || !string.IsNullOrEmpty(endpoint.UserInfo))
                throw new InvalidOperationException("Only the credential-free CI loopback fixture is permitted");
        }
        else
        {
            var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
            if (port == 27017) throw new InvalidOperationException("Refusing default Mongo port");
            var info = new ProcessStartInfo("mongod") { UseShellExecute = false };
            foreach (var arg in new[] { "--dbpath", _dir, "--bind_ip", "127.0.0.1", "--port", port.ToString(), "--nounixsocket", "--wiredTigerCacheSizeGB", "0.25", "--setParameter", "ttlMonitorEnabled=false", "--logpath", Path.Combine(_dir, "mongo.log") }) info.ArgumentList.Add(arg);
            _process = Process.Start(info)!;
            uri = "mongodb://127.0.0.1:" + port + "/?serverSelectionTimeoutMS=1000";
            for (var i = 0; i < 60; i++)
            {
                try { await new MongoClient(uri).GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1)); break; }
                catch { if (i == 59) throw; await Task.Delay(200); }
            }
        }
        var prefix = "log_archive_test_" + Guid.NewGuid().ToString("N");
        _db = new MongoDbContext(uri!, prefix + "_business", prefix + "_gateway");
        _gw = new LlmGatewayDataContext(uri!, prefix + "_gateway");
        await _db.Database.GetCollection<BsonDocument>("log_archive_policies").Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(new BsonDocument("OwnerId", 1), new CreateIndexOptions { Unique = true }));
        foreach (var name in new[] { "apirequestlogs", "llmrequestlogs" })
            await _db.Database.GetCollection<BsonDocument>(name).Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(new BsonDocument { { "ColdArchiveId", 1 }, { "StartedAt", 1 } }));
        foreach (var name in new[] { "llmrequestlogs", "llmgw_request_executions" })
            await _gw.Database.GetCollection<BsonDocument>(name).Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(new BsonDocument { { "TenantId", 1 }, { "ColdArchiveId", 1 }, { name == "llmrequestlogs" ? "StartedAt" : "CreatedAt", 1 } }));
        var storage = DispatchProxy.Create<IAssetStorage, StorageProxy>();
        _store = (StorageProxy)storage;
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LogArchive:EncryptionKey"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
            ["LogArchive:KeyBackedUp"] = "true", ["LlmGateway:InternalTenantId"] = "map-test"
        }).Build();
        _service = new LogArchiveService(_db, _gw, storage, new Remote(), configuration);
        await _service.SetPolicyAsync("test-owner", true, true, 30, default);
    }
    public async Task DisposeAsync()
    {
        if (_process == null && _db != null)
        {
            await _db.Database.Client.DropDatabaseAsync(_db.Database.DatabaseNamespace.DatabaseName);
            await _gw.Database.Client.DropDatabaseAsync(_gw.Database.DatabaseNamespace.DatabaseName);
        }
        if (_process is { HasExited: false }) { _process.Kill(); _process.WaitForExit(10000); }
        _process?.Dispose();
        Directory.Delete(_dir, true);
    }
    private static BsonDocument Log(string id) => new() { { "_id", id }, { "RequestId", "request-" + id }, { "StartedAt", DateTime.UtcNow.AddDays(-60) }, { "Status", "completed" }, { "RequestBody", "请求原文" }, { "ResponseBody", "响应原文" } };
    [Fact]
    public async Task CannotEnableArchiveWithoutBoundedSourceIndexes()
    {
        await _service.SetPolicyAsync("test-owner", false, false, 30, default);
        await _gw.Database.GetCollection<BsonDocument>("llmgw_request_executions").Indexes.DropOneAsync("TenantId_1_ColdArchiveId_1_CreatedAt_1");
        await Assert.ThrowsAsync<LogArchiveSetupException>(() => _service.SetPolicyAsync("test-owner", true, true, 30, default));
        Assert.False((await _service.PolicyAsync("test-owner", default))["Enabled"].AsBoolean);
    }
    [Fact]
    public async Task InterruptedMigrationKeepsConfirmedCountAndRestoresOnlyMigratedRecord()
    {
        var logs = _db.Database.GetCollection<BsonDocument>("apirequestlogs");
        var first = Log("first");
        var second = Log("second"); second["StartedAt"] = first["StartedAt"].ToUniversalTime().AddSeconds(1);
        await logs.InsertManyAsync([first, second]);
        // Let the first migration commit, then reject only the second cold stub.
        await _db.Database.RunCommandAsync<BsonDocument>(new BsonDocument
        {
            { "collMod", "apirequestlogs" },
            { "validator", new BsonDocument("$or", new BsonArray
                { new BsonDocument("_id", new BsonDocument("$ne", "second")), new BsonDocument("ColdArchiveId", new BsonDocument("$exists", false)) }) },
            { "validationLevel", "strict" }
        });
        await Assert.ThrowsAnyAsync<Exception>(() => _service.ProcessOneAsync("test-owner", default));
        var batch = Assert.Single(await _service.ListAsync("test-owner", "api", null, null, null, default));
        Assert.Equal("failed", batch["Status"].AsString);
        Assert.Equal(1, batch["Migrated"].ToInt32());
        Assert.Equal(second, await logs.Find(new BsonDocument("_id", "second")).SingleAsync());
        Assert.Equal(first, await _service.HydrateAsync("test-owner", "api", "first", default));
        Assert.Equal(1, await _service.RestoreAsync("test-owner", batch["_id"].AsString, default));
        var restored = await logs.Find(new BsonDocument("_id", "first")).SingleAsync();
        Assert.False(restored.Contains(LogArchiveService.Pointer));
        Assert.Equal(first["ResponseBody"], restored["ResponseBody"]);
    }
    [Fact]
    public async Task ArchiveReadDownloadAndRestorePreserveCompleteRecord()
    {
        var logs = _db.Database.GetCollection<BsonDocument>("apirequestlogs");
        var original = Log("sample"); await logs.InsertOneAsync(original);
        await _service.ProcessOneAsync("test-owner", default);
        var batches = await _service.ListAsync("test-owner", "api", null, null, "request-sample", default);
        var batch = Assert.Single(batches); var id = batch["_id"].AsString;
        Assert.Equal("completed", batch["Status"]); Assert.Equal(1, batch["Migrated"].ToInt32());
        var stub = await logs.Find(new BsonDocument("_id", "sample")).FirstAsync();
        Assert.False(stub.Contains("ResponseBody")); Assert.Equal(id, stub[LogArchiveService.Pointer].AsString);
        Assert.Equal(original, await _service.HydrateAsync("test-owner", "api", "sample", default));
        await _service.VerifyAsync("test-owner", id, default);
        Assert.NotEmpty(await _service.DownloadAsync("test-owner", id, default));
        await Assert.ThrowsAsync<KeyNotFoundException>(() => _service.ContentsAsync("another-owner", id, default));
        Assert.Equal(1, await _service.RestoreAsync("test-owner", id, default));
        var restored = await logs.Find(new BsonDocument("_id", "sample")).FirstAsync();
        Assert.Equal("响应原文", restored["ResponseBody"]); Assert.False(restored.Contains(LogArchiveService.Pointer));
    }
    [Fact]
    public async Task CorruptRemoteCopyLeavesOriginalUntouched()
    {
        var logs = _db.Database.GetCollection<BsonDocument>("apirequestlogs");
        var original = Log("corrupt"); await logs.InsertOneAsync(original); _store.Corrupt = true;
        await Assert.ThrowsAnyAsync<Exception>(() => _service.ProcessOneAsync("test-owner", default));
        Assert.Equal(original, await logs.Find(new BsonDocument("_id", "corrupt")).FirstAsync());
        Assert.Equal("failed", Assert.Single(await _service.ListAsync("test-owner", null, null, null, null, default))["Status"]);
        Assert.Contains("日志仍可查回", (await _service.PolicyAsync("test-owner", default))["Error"].AsString);
    }
    [Fact]
    public async Task ConcurrentUpdateIsNotOverwrittenByMigration()
    {
        var logs = _db.Database.GetCollection<BsonDocument>("apirequestlogs");
        await logs.InsertOneAsync(Log("changed"));
        _store.OnSave = () => logs.UpdateOneAsync(new BsonDocument("_id", "changed"), Builders<BsonDocument>.Update.Set("ResponseBody", "新的写入"));
        await _service.ProcessOneAsync("test-owner", default);
        var current = await logs.Find(new BsonDocument("_id", "changed")).FirstAsync();
        Assert.Equal("新的写入", current["ResponseBody"]); Assert.False(current.Contains(LogArchiveService.Pointer));
    }
    [Fact]
    public async Task GatewayArchiveNeverTouchesOtherTenant()
    {
        var logs = _gw.Database.GetCollection<BsonDocument>("llmrequestlogs");
        var mine = Log("mine"); mine["TenantId"] = "map-test"; mine["AnswerText"] = new string('a', 800);
        mine["RequestBodyRedacted"] = "完整请求"; mine["ThinkingText"] = "完整思考";
        mine["RequestHeadersRedacted"] = new BsonDocument("x-request", "complete");
        mine["ResponseHeaders"] = new BsonDocument("x-response", "complete");
        var other = Log("other"); other["TenantId"] = "other-tenant"; other["AnswerText"] = "别人的正文";
        await logs.InsertManyAsync(new[] { mine, other });
        for (var i = 0; i < 3; i++) await _service.ProcessOneAsync("test-owner", default);
        Assert.Equal(other, await logs.Find(new BsonDocument("_id", "other")).FirstAsync());
        var current = await logs.Find(new BsonDocument("_id", "mine")).FirstAsync();
        Assert.True(current.Contains(LogArchiveService.Pointer));
        current.Remove(LogArchiveService.Pointer);
        Assert.Equal(mine, current); // Existing gateway console readers retain every original field.
        var batch = Assert.Single(await _service.ListAsync("test-owner", "llm", null, null, null, default));
        Assert.True(batch["HotBodiesRetained"].AsBoolean);
        Assert.Equal(0, batch["Migrated"].ToInt32());
        Assert.Equal(mine, await _service.HydrateAsync("test-owner", "llm", "mine", default));
        Assert.Null(await _service.HydrateAsync("another-reader", "llm", "other", default));
    }
    [Fact]
    public async Task SharedDataReaderHydratesPointerWithoutAcquiringBatchManagement()
    {
        var logs = _db.Database.GetCollection<BsonDocument>("apirequestlogs");
        var original = Log("shared"); await logs.InsertOneAsync(original);
        await _service.ProcessOneAsync("test-owner", default);
        var batch = Assert.Single(await _service.ListAsync("test-owner", "api", null, null, null, default));
        var id = batch["_id"].AsString;
        Assert.Equal(original, await _service.HydrateAsync("another-reader", "api", "shared", default));
        Assert.Empty(await _service.ListAsync("another-reader", "api", null, null, null, default));
        await Assert.ThrowsAsync<KeyNotFoundException>(() => _service.ContentsAsync("another-reader", id, default));
        await Assert.ThrowsAsync<KeyNotFoundException>(() => _service.RestoreAsync("another-reader", id, default));
    }
    [Fact]
    public async Task ExecutionArchivePreservesCompletedReplayResponse()
    {
        var logs = _gw.Database.GetCollection<BsonDocument>("llmgw_request_executions");
        var original = Log("replay"); original["TenantId"] = "map-test";
        original["CreatedAt"] = original["StartedAt"]; original["ResponseJson"] = "{\"answer\":\"complete replay response\"}";
        original["Fingerprint"] = "request-fingerprint"; original["Operation"] = "text";
        await logs.InsertOneAsync(original);
        for (var i = 0; i < 4; i++) await _service.ProcessOneAsync("test-owner", default);
        var current = await logs.Find(new BsonDocument("_id", "replay")).SingleAsync();
        Assert.Equal("completed", current["Status"]);
        Assert.Equal(original["ResponseJson"], current["ResponseJson"]);
        current.Remove(LogArchiveService.Pointer);
        Assert.Equal(original, current);
        Assert.Equal(0, Assert.Single(await _service.ListAsync("test-owner", "execution", null, null, null, default))["Migrated"].ToInt32());
    }
    [Fact]
    public async Task VersionOneExecutionStubRemainsSafelyRestorable()
    {
        var logs = _gw.Database.GetCollection<BsonDocument>("llmgw_request_executions");
        var original = Log("old-replay"); original["TenantId"] = "map-test";
        original["CreatedAt"] = original["StartedAt"]; original["ResponseJson"] = "{\"answer\":\"historic full response\"}";
        await logs.InsertOneAsync(original);
        for (var i = 0; i < 4; i++) await _service.ProcessOneAsync("test-owner", default);
        var batch = Assert.Single(await _service.ListAsync("test-owner", "execution", null, null, null, default));
        var id = batch["_id"].AsString;
        // Freeze the deployed v1 shape: replay JSON absent, ownership and encrypted archive intact.
        var oldStub = original.DeepClone().AsBsonDocument; oldStub.Remove("ResponseJson"); oldStub[LogArchiveService.Pointer] = id;
        await logs.ReplaceOneAsync(new BsonDocument("_id", "old-replay"), oldStub);
        await _db.Database.GetCollection<BsonDocument>("log_archive_batches").UpdateOneAsync(new BsonDocument("_id", id),
            Builders<BsonDocument>.Update.Unset("StubVersion").Unset("HotBodiesRetained"));
        Assert.Equal(1, await _service.RestoreAsync("test-owner", id, default));
        var restored = await logs.Find(new BsonDocument("_id", "old-replay")).SingleAsync();
        Assert.Equal(original["ResponseJson"], restored["ResponseJson"]);
        Assert.False(restored.Contains(LogArchiveService.Pointer));
    }
    [Fact]
    public async Task OversizedRecordStaysHotWithoutBlockingLaterArchives()
    {
        var logs = _db.Database.GetCollection<BsonDocument>("apirequestlogs");
        var huge = Log("oversized"); huge["RequestBody"] = new string('x', 10 * 1024 * 1024);
        var next = Log("next"); next["StartedAt"] = huge["StartedAt"].ToUniversalTime().AddSeconds(1);
        await logs.InsertManyAsync(new[] { huge, next });
        for (var i = 0; i < 8; i++) await _service.ProcessOneAsync("test-owner", default);
        Assert.Equal(huge, await logs.Find(new BsonDocument("_id", "oversized")).SingleAsync());
        var batch = Assert.Single(await _service.ListAsync("test-owner", "api", null, null, null, default));
        Assert.Equal(1, batch["Count"].ToInt32());
        Assert.Equal("next", batch["Records"][0]["Id"].AsString);
        Assert.True(batch["RawBytes"].ToInt32() <= 8 * 1024 * 1024);
        Assert.Equal(next, await _service.HydrateAsync("test-owner", "api", "next", default));
    }
    private sealed class Remote : IAssetStorageRuntimeInfo { public string ProviderName => "tencentCos"; }
    public class StorageProxy : DispatchProxy
    {
        private readonly Dictionary<string, byte[]> _objects = new();
        public bool Corrupt;
        public Func<Task>? OnSave;
        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method!.Name == nameof(IAssetStorage.SaveAsync))
            {
                _ = AppDomainPaths.NormDomain((string?)args![3]);
                _ = AppDomainPaths.NormType((string?)args[4]);
                return Save((byte[])args[0]!);
            }
            if (method.Name == nameof(IAssetStorage.TryDownloadBytesAsync))
            {
                var bytes = _objects[(string)args![0]!].ToArray(); if (Corrupt) bytes[^1] ^= 1;
                return Task.FromResult<byte[]?>(bytes);
            }
            throw new NotSupportedException(method.Name);
        }
        private async Task<StoredAsset> Save(byte[] bytes)
        {
            var key = Guid.NewGuid().ToString("N"); _objects[key] = bytes.ToArray();
            if (OnSave != null) await OnSave();
            return new StoredAsset(LogArchiveCodec.Hash(bytes), "https://invalid.example/ciphertext", bytes.Length, "application/octet-stream", key);
        }
    }
}
