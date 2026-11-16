using System.IO.Compression;
using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>Bounded immutable log blocks. The original stays intact until remote authenticated readback succeeds.</summary>
public sealed class LogArchiveService(MongoDbContext db, LlmGatewayDataContext gateway, IAssetStorage storage,
    IAssetStorageRuntimeInfo runtime, IConfiguration config)
{
    public const string Pointer = "ColdArchiveId";
    private IMongoCollection<BsonDocument> Batches => db.Database.GetCollection<BsonDocument>("log_archive_batches");
    private IMongoCollection<BsonDocument> Policies => db.Database.GetCollection<BsonDocument>("log_archive_policies");
    private string Tenant => config["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenant ? tenant : GatewayTenantDefaults.InternalTenantId;
    private static readonly string[] Sources = ["api", "legacy-llm", "llm", "execution"];
    private static readonly Dictionary<string, string[]> Bodies = new()
    {
        ["api"] = ["RequestBody", "ResponseBody", "Curl"],
        ["legacy-llm"] = ["RequestBodyRedacted", "QuestionText", "AnswerText", "ThinkingText", "SystemPromptText", "ResponseToolCalls", "RequestHeadersRedacted", "ResponseHeaders"],
        ["llm"] = ["RequestBodyRedacted", "QuestionText", "AnswerText", "ThinkingText", "SystemPromptText", "ResponseToolCalls", "RequestHeadersRedacted", "ResponseHeaders"],
        ["execution"] = ["ResponseJson"]
    };
    private byte[] Key()
    {
        var key = Convert.FromBase64String(config["LogArchive:EncryptionKey"] ?? "");
        if (key.Length != 32) throw new InvalidOperationException("Archive encryption key unavailable");
        if (runtime.ProviderName is not ("tencentCos" or "cos" or "r2" or "cloudflareR2"))
            throw new InvalidOperationException("Remote storage required");
        return key;
    }
    public bool Ready
    {
        get { try { _ = Key(); return config.GetValue("LogArchive:KeyBackedUp", false); } catch { return false; } }
    }
    private (IMongoCollection<BsonDocument> Collection, FilterDefinition<BsonDocument> Scope, string Time) Source(string source)
    {
        return source switch
        {
            "api" => (db.Database.GetCollection<BsonDocument>("apirequestlogs"), FilterDefinition<BsonDocument>.Empty, "StartedAt"),
            "legacy-llm" when db.HasSeparateLegacyLlmRequestLogCollection => (db.Database.GetCollection<BsonDocument>("llmrequestlogs"), FilterDefinition<BsonDocument>.Empty, "StartedAt"),
            "llm" => (gateway.Database.GetCollection<BsonDocument>("llmrequestlogs"), new BsonDocument("TenantId", Tenant), "StartedAt"),
            "execution" => (gateway.Database.GetCollection<BsonDocument>("llmgw_request_executions"), new BsonDocument("TenantId", Tenant), "CreatedAt"),
            _ => throw new ArgumentException("Unsupported archive source")
        };
    }
    public async Task<BsonDocument> PolicyAsync(string owner, CancellationToken ct)
        => await Policies.Find(new BsonDocument("OwnerId", owner)).FirstOrDefaultAsync(ct)
           ?? new BsonDocument { { "Enabled", false }, { "MigrateBodies", false }, { "HotDays", 30 } };
    public async Task SetPolicyAsync(string owner, bool enabled, bool migrate, int days, CancellationToken ct)
    {
        if (days < 7 || days > 365 || (enabled && (!Ready || !migrate))) throw new InvalidOperationException("Archive setup not ready");
        if (enabled)
        {
            using var indexes = await Policies.Indexes.ListAsync(ct);
            if (!(await indexes.ToListAsync(ct)).Any(x => x.GetValue("unique", false).AsBoolean
                && x["key"].AsBsonDocument.ElementCount == 1 && x["key"].AsBsonDocument.Contains("OwnerId")))
                throw new InvalidOperationException("Archive policy uniqueness index required");
        }
        var update = Builders<BsonDocument>.Update.Set("Enabled", enabled).Set("MigrateBodies", migrate).Set("HotDays", days)
            .SetOnInsert("_id", Guid.NewGuid().ToString("N")).SetOnInsert("OwnerId", owner)
            .SetOnInsert("LeaseUntil", DateTime.MinValue).SetOnInsert("NextSource", 0);
        await Policies.UpdateOneAsync(new BsonDocument("OwnerId", owner), update, new UpdateOptions { IsUpsert = true }, ct);
    }
    public async Task<List<BsonDocument>> ListAsync(string owner, string? source, DateTime? from, DateTime? to, string? requestId, CancellationToken ct)
    {
        var f = Builders<BsonDocument>.Filter.Eq("OwnerId", owner);
        if (!string.IsNullOrWhiteSpace(source)) f &= Builders<BsonDocument>.Filter.Eq("Source", source);
        if (from.HasValue) f &= Builders<BsonDocument>.Filter.Gte("To", from.Value.ToUniversalTime());
        if (to.HasValue) f &= Builders<BsonDocument>.Filter.Lte("From", to.Value.ToUniversalTime());
        if (!string.IsNullOrWhiteSpace(requestId)) f &= Builders<BsonDocument>.Filter.Eq("Records.RequestId", requestId);
        return await Batches.Find(f).Sort(Builders<BsonDocument>.Sort.Descending("CreatedAt")).Limit(100).ToListAsync(ct);
    }
    private async Task<BsonDocument> BatchAsync(string owner, string id, CancellationToken ct)
        => await Batches.Find(new BsonDocument { { "_id", id }, { "OwnerId", owner } }).FirstOrDefaultAsync(ct)
           ?? throw new KeyNotFoundException();
    private async Task<BsonDocument> ReadAsync(BsonDocument batch, CancellationToken ct)
    {
        var bytes = await storage.TryDownloadBytesAsync(batch["StorageKey"].AsString, ct) ?? throw new IOException("Archive missing");
        if (LogArchiveCodec.Hash(bytes) != batch["CipherSha256"].AsString) throw new InvalidDataException("Archive checksum mismatch");
        var key = Key();
        if (LogArchiveCodec.Hash(key)[..16] != batch["KeyId"].AsString) throw new InvalidOperationException("Archive key version unavailable");
        var payload = LogArchiveCodec.Unpack(bytes, key);
        if (payload["BatchId"] != batch["_id"] || payload["OwnerId"] != batch["OwnerId"] || payload["Source"] != batch["Source"]
            || payload["Records"].AsBsonArray.Count != batch["Count"].ToInt32()
            || LogArchiveCodec.Hash(payload.ToBson()) != batch["PlainSha256"].AsString) throw new InvalidDataException("Archive identity mismatch");
        return payload;
    }
    public async Task VerifyAsync(string owner, string id, CancellationToken ct)
    {
        var batch = await BatchAsync(owner, id, ct);
        _ = await ReadAsync(batch, ct);
        await Batches.UpdateOneAsync(new BsonDocument { { "_id", id }, { "OwnerId", owner } }, Builders<BsonDocument>.Update.Set("VerifiedAt", DateTime.UtcNow), cancellationToken: ct);
    }
    public async Task<byte[]> DownloadAsync(string owner, string id, CancellationToken ct)
    {
        var payload = await ReadAsync(await BatchAsync(owner, id, ct), ct);
        payload.Remove("OwnerId");
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest, true)) gzip.Write(System.Text.Encoding.UTF8.GetBytes(payload.ToJson(new MongoDB.Bson.IO.JsonWriterSettings { OutputMode = MongoDB.Bson.IO.JsonOutputMode.CanonicalExtendedJson })));
        return output.ToArray();
    }
    public async Task<BsonDocument> ContentsAsync(string owner, string id, CancellationToken ct)
        => await ReadAsync(await BatchAsync(owner, id, ct), ct);

    public async Task<BsonDocument?> HydrateAsync(string owner, string source, string id, CancellationToken ct)
    {
        var target = Source(source);
        var idFilter = ObjectId.TryParse(id, out var oid)
            ? Builders<BsonDocument>.Filter.Or(new BsonDocument("_id", id), new BsonDocument("_id", oid))
            : new BsonDocument("_id", id);
        var hot = await target.Collection.Find(target.Scope & idFilter).FirstOrDefaultAsync(ct);
        if (hot == null || !hot.TryGetValue(Pointer, out var pointer)) return hot;
        var batch = await BatchAsync(owner, pointer.AsString, ct);
        if (batch["Source"].AsString != source) throw new InvalidDataException("Archive source mismatch");
        return (await ReadAsync(batch, ct))["Records"].AsBsonArray.Select(x => x.AsBsonDocument)
            .Single(x => x["_id"] == hot["_id"]);
    }
    public async Task<int> RestoreAsync(string owner, string id, CancellationToken ct)
    {
        var batch = await BatchAsync(owner, id, ct);
        var records = (await ReadAsync(batch, ct))["Records"].AsBsonArray;
        var target = Source(batch["Source"].AsString);
        var restored = 0;
        foreach (var record in records.Select(x => x.AsBsonDocument))
        {
            var hot = await target.Collection.Find(target.Scope & new BsonDocument { { "_id", record["_id"] }, { Pointer, id } }).FirstOrDefaultAsync(ct);
            if (hot == null) continue;
            // Only restore a still-unchanged cold stub. Never overwrite a live application's update.
            var expected = Stub(record, batch["Source"].AsString, id);
            if (!hot.Equals(expected)) continue;
            var replacement = record.DeepClone().AsBsonDocument;
            replacement["ColdRestoredUntil"] = DateTime.UtcNow.AddDays(7);
            restored += (int)(await target.Collection.ReplaceOneAsync(target.Scope & LogArchiveCodec.ExactVersion(hot), replacement, cancellationToken: ct)).ModifiedCount;
        }
        await Batches.UpdateOneAsync(new BsonDocument { { "_id", id }, { "OwnerId", owner } }, Builders<BsonDocument>.Update.Set("RestoredAt", DateTime.UtcNow), cancellationToken: ct);
        return restored;
    }
    private static BsonDocument Stub(BsonDocument record, string source, string id)
    {
        var stub = record.DeepClone().AsBsonDocument;
        foreach (var field in Bodies[source])
        {
            if (stub.TryGetValue(field, out var value) && value.IsString && value.AsString.Length > 0
                && field is "RequestBody" or "Curl" or "QuestionText" or "AnswerText")
                stub[field] = value.AsString[..Math.Min(200, value.AsString.Length)] + "…（正文已归档，打开详情查看）";
            else stub.Remove(field);
        }
        stub.Remove("__archiveSource");
        stub[Pointer] = id;
        return stub;
    }
    public async Task ProcessOneAsync(string owner, CancellationToken ct)
    {
        if (!Ready) return;
        var now = DateTime.UtcNow;
        var token = Guid.NewGuid().ToString("N");
        var filter = new BsonDocument { { "OwnerId", owner }, { "Enabled", true }, { "LeaseUntil", new BsonDocument("$lt", now) } };
        var policy = await Policies.FindOneAndUpdateAsync(filter, Builders<BsonDocument>.Update.Set("LeaseUntil", now.AddMinutes(5)).Set("LeaseToken", token),
            new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After }, ct);
        if (policy == null) return;
        FilterDefinition<BsonDocument> lease = new BsonDocument { { "_id", policy["_id"] }, { "OwnerId", owner }, { "LeaseToken", token } };
        BsonDocument? batch = null;
        var stage = "select";
        try
        {
            var index = policy.GetValue("NextSource", 0).ToInt32() % Sources.Length;
            var source = Sources[index];
            await Policies.UpdateOneAsync(lease, Builders<BsonDocument>.Update.Set("NextSource", (index + 1) % Sources.Length), cancellationToken: ct);
            if (source == "legacy-llm" && !db.HasSeparateLegacyLlmRequestLogCollection) return;
            var target = Source(source);
            var cutoff = now.AddDays(-policy["HotDays"].ToInt32());
            var age = new BsonDocument("$or", new BsonArray
            {
                new BsonDocument(target.Time, new BsonDocument { { "$type", "date" }, { "$lt", cutoff } }),
                new BsonDocument(target.Time, new BsonDocument { { "$type", "string" }, { "$lt", cutoff.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") } })
            });
            var eligible = target.Scope & age & new BsonDocument(Pointer, new BsonDocument("$exists", false))
                & new BsonDocument("Status", new BsonDocument("$nin", new BsonArray { "running", "queued", "processing", "streaming" }))
                & new BsonDocument("$or", new BsonArray { new BsonDocument("ColdRestoredUntil", new BsonDocument("$exists", false)), new BsonDocument("ColdRestoredUntil", new BsonDocument("$lt", now)) });
            var records = new BsonArray();
            var size = 0;
            using var cursor = await target.Collection.FindAsync(eligible, new FindOptions<BsonDocument> { Limit = 40, BatchSize = 1, MaxTime = TimeSpan.FromSeconds(10), Sort = new BsonDocument(target.Time, 1) }, ct);
            while (await cursor.MoveNextAsync(ct))
            {
                foreach (var record in cursor.Current)
                {
                    var bytes = record.ToBson().Length;
                    if (records.Count > 0 && size + bytes > 8 * 1024 * 1024) break;
                    if (record.Contains("__archiveSource")) throw new InvalidDataException("Reserved log field");
                    records.Add(record); size += bytes;
                }
                if (size >= 8 * 1024 * 1024) break;
            }
            if (records.Count == 0) return;
            var id = Guid.NewGuid().ToString("N");
            var times = records.Select(x => x[target.Time].IsString ? DateTime.Parse(x[target.Time].AsString).ToUniversalTime() : x[target.Time].ToUniversalTime()).ToArray();
            var payload = new BsonDocument { { "Version", 1 }, { "BatchId", id }, { "OwnerId", owner }, { "Source", source }, { "Records", records } };
            stage = "pack";
            var encrypted = LogArchiveCodec.Pack(payload, Key());
            batch = new BsonDocument { { "_id", id }, { "OwnerId", owner }, { "Source", source }, { "Status", "uploading" }, { "CreatedAt", now },
                { "From", times.Min() }, { "To", times.Max() }, { "Count", records.Count }, { "RawBytes", size }, { "StoredBytes", encrypted.Length },
                { "PlainSha256", LogArchiveCodec.Hash(payload.ToBson()) }, { "CipherSha256", LogArchiveCodec.Hash(encrypted) },
                { "KeyId", LogArchiveCodec.Hash(Key())[..16] }, { "Migrated", 0 },
                { "Records", new BsonArray(records.Select(x => new BsonDocument { { "Id", x["_id"] }, { "RequestId", x.AsBsonDocument.GetValue("RequestId", "") } })) } };
            await Batches.InsertOneAsync(batch, cancellationToken: ct);
            stage = "upload";
            var saved = await storage.SaveAsync(encrypted, "application/octet-stream", ct, AppDomainPaths.DomainLogs, AppDomainPaths.TypeBin, extensionHint: ".bin");
            if (string.IsNullOrWhiteSpace(saved.Key)) throw new IOException("Archive storage key missing");
            batch["StorageKey"] = saved.Key;
            await Batches.ReplaceOneAsync(new BsonDocument("_id", id), batch, cancellationToken: ct);
            stage = "readback";
            _ = await ReadAsync(batch, ct); // Remote GET, hash, authenticated decryption, BSON equality and count.
            batch["VerifiedAt"] = DateTime.UtcNow; batch["Status"] = "verified";
            await Batches.ReplaceOneAsync(new BsonDocument("_id", id), batch, cancellationToken: ct);
            stage = "migrate";
            if (policy["MigrateBodies"].AsBoolean)
            {
                foreach (var original in records.Select(x => x.AsBsonDocument))
                {
                    var current = await Policies.Find(lease & new BsonDocument { { "Enabled", true }, { "MigrateBodies", true }, { "LeaseUntil", new BsonDocument("$gt", DateTime.UtcNow) } }).AnyAsync(ct);
                    if (!current) throw new InvalidOperationException("Archive lease lost");
                    var stub = Stub(original, source, id);
                    batch["Migrated"] = batch["Migrated"].ToInt32() + (int)(await target.Collection.ReplaceOneAsync(target.Scope & LogArchiveCodec.ExactVersion(original), stub, cancellationToken: ct)).ModifiedCount;
                }
            }
            batch["Status"] = "completed";
            await Batches.ReplaceOneAsync(new BsonDocument("_id", id), batch, cancellationToken: ct);
            await Policies.UpdateOneAsync(lease, Builders<BsonDocument>.Update.Set("LastCompletedAt", DateTime.UtcNow).Unset("Error"), cancellationToken: ct);
        }
        catch (Exception error)
        {
            if (batch != null) await Batches.UpdateOneAsync(new BsonDocument("_id", batch["_id"]), Builders<BsonDocument>.Update.Set("Status", "failed").Set("FailureStage", stage).Set("FailureType", error.GetType().Name), cancellationToken: CancellationToken.None);
            await Policies.UpdateOneAsync(lease, Builders<BsonDocument>.Update.Set("Error", "归档未完成，日志仍可查回；请检查冷库连接和密钥后重试。"), cancellationToken: CancellationToken.None);
            throw;
        }
        finally { await Policies.UpdateOneAsync(lease, Builders<BsonDocument>.Update.Set("LeaseUntil", DateTime.MinValue), cancellationToken: CancellationToken.None); }
    }
}
