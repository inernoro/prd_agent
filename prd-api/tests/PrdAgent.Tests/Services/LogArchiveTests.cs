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

/// <summary>Named integration suite: owns a fresh loopback Mongo process, never uses production credentials.</summary>
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
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        if (port == 27017) throw new InvalidOperationException("Refusing default Mongo port");
        var info = new ProcessStartInfo("mongod") { UseShellExecute = false };
        foreach (var arg in new[] { "--dbpath", _dir, "--bind_ip", "127.0.0.1", "--port", port.ToString(), "--nounixsocket", "--wiredTigerCacheSizeGB", "0.25", "--setParameter", "ttlMonitorEnabled=false", "--logpath", Path.Combine(_dir, "mongo.log") }) info.ArgumentList.Add(arg);
        _process = Process.Start(info)!;
        var uri = "mongodb://127.0.0.1:" + port + "/?serverSelectionTimeoutMS=1000";
        for (var i = 0; i < 60; i++)
        {
            try { await new MongoClient(uri).GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1)); break; }
            catch { if (i == 59) throw; await Task.Delay(200); }
        }
        _db = new MongoDbContext(uri, "business", "gateway");
        _gw = new LlmGatewayDataContext(uri, "gateway");
        await _db.Database.GetCollection<BsonDocument>("log_archive_policies").Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(new BsonDocument("OwnerId", 1), new CreateIndexOptions { Unique = true }));
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
    public Task DisposeAsync()
    {
        if (_process is { HasExited: false }) { _process.Kill(); _process.WaitForExit(10000); }
        _process?.Dispose();
        Directory.Delete(_dir, true);
        return Task.CompletedTask;
    }
    private static BsonDocument Log(string id) => new() { { "_id", id }, { "RequestId", "request-" + id }, { "StartedAt", DateTime.UtcNow.AddDays(-60) }, { "Status", "completed" }, { "RequestBody", "请求原文" }, { "ResponseBody", "响应原文" } };
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
        var mine = Log("mine"); mine["TenantId"] = "map-test"; mine["AnswerText"] = "自己的正文";
        var other = Log("other"); other["TenantId"] = "other-tenant"; other["AnswerText"] = "别人的正文";
        await logs.InsertManyAsync(new[] { mine, other });
        for (var i = 0; i < 3; i++) await _service.ProcessOneAsync("test-owner", default);
        Assert.Equal(other, await logs.Find(new BsonDocument("_id", "other")).FirstAsync());
        Assert.Contains("正文已归档", (await logs.Find(new BsonDocument("_id", "mine")).FirstAsync())["AnswerText"].AsString);
        Assert.Equal(mine, await _service.HydrateAsync("test-owner", "llm", "mine", default));
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
