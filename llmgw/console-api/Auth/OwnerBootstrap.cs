using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Auth;

// The singleton _id is the cross-process claim. Never delete this record to recover an account.
public sealed class OwnerBootstrap(IMongoDatabase database)
{
    private readonly IMongoCollection<BsonDocument> state = database.GetCollection<BsonDocument>("llmgw_owner_bootstrap").WithWriteConcern(WriteConcern.WMajority);
    private readonly IMongoCollection<LlmGwUser> users = database.GetCollection<LlmGwUser>("llmgw_console_users").WithWriteConcern(WriteConcern.WMajority);

    public async Task<string?> InitializeAsync(string? password, CancellationToken ct = default)
    {
        var record = await state.Find(new BsonDocument("_id", "owner")).FirstOrDefaultAsync(ct);
        if (record is null)
        {
            var existing = await users.Find(FilterDefinition<LlmGwUser>.Empty).Limit(1).AnyAsync(ct);
            if (!existing && string.IsNullOrWhiteSpace(password)) return null;
            if (!existing) ValidatePassword(password);
            var legacy = existing ? await users.Find(x => x.Username == "admin").FirstOrDefaultAsync(ct) : null;
            var user = existing ? null : new LlmGwUser
            {
                Username = "admin", DisplayName = "admin", PasswordHash = PasswordHasher.Hash(password!),
                MustChangePassword = true, Scopes = ["logs:read"]
            };
            record = new BsonDocument
            {
                { "_id", "owner" }, { "State", existing ? "complete" : "prepared" },
                { "UserId", (BsonValue?)user?.Id ?? (BsonValue?)legacy?.Id ?? BsonNull.Value },
                { "Provisioned", existing }, { "CreatedAt", DateTime.UtcNow }, { "Action", existing ? "admin.bootstrap_adopt" : "admin.bootstrap" }
            };
            if (user is not null) record["User"] = user.ToBsonDocument();
            try { await state.InsertOneAsync(record, cancellationToken: ct); }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            { record = await state.Find(new BsonDocument("_id", "owner")).FirstOrDefaultAsync(ct); }
        }
        if (record["State"] == "prepared")
        {
            // Persisted candidate survives a crash; competing starts use the same ID and hash.
            var candidate = BsonSerializer.Deserialize<LlmGwUser>(record["User"].AsBsonDocument);
            try { await users.InsertOneAsync(candidate, cancellationToken: ct); }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            {
                if (!await users.Find(x => x.Id == candidate.Id).AnyAsync(ct)) throw;
            }
            await state.UpdateOneAsync(new BsonDocument("_id", "owner"),
                new BsonDocument { { "$set", new BsonDocument { { "State", "complete" }, { "CompletedAt", DateTime.UtcNow } } }, { "$unset", new BsonDocument("User", 1) } }, cancellationToken: ct);
        }
        return record["UserId"].IsString ? record["UserId"].AsString : null;
    }

    public async Task<bool> NeedsProvisioningAsync(CancellationToken ct = default) =>
        await state.Find(new BsonDocument { { "_id", "owner" }, { "Provisioned", false } }).AnyAsync(ct);

    public Task CompleteProvisioningAsync(CancellationToken ct = default) =>
        state.UpdateOneAsync(new BsonDocument("_id", "owner"),
            new BsonDocument("$set", new BsonDocument("Provisioned", true)), cancellationToken: ct);

    public async Task RecoverAsync(string targetId, string operationId, string? password, CancellationToken ct = default)
    {
        ValidatePassword(password);
        if (!Guid.TryParseExact(operationId, "N", out _) || !Guid.TryParseExact(targetId, "N", out _))
            throw new InvalidOperationException("恢复必须指定不可变账号 ID 和新的 32 位操作编号。");
        var id = "recovery:" + operationId;
        var record = await state.Find(new BsonDocument("_id", id)).FirstOrDefaultAsync(ct);
        if (record is null)
        {
            var user = await users.Find(x => x.Id == targetId).FirstOrDefaultAsync(ct)
                ?? throw new InvalidOperationException("恢复目标不存在；恢复不会创建新账号。");
            record = new BsonDocument
            {
                { "_id", id }, { "Action", "admin.force_reset" }, { "State", "prepared" },
                { "UserId", user.Id }, { "BeforeVersion", user.SecurityVersion }, { "BeforeHash", user.PasswordHash }, { "AfterHash", PasswordHasher.Hash(password!) },
                { "CreatedAt", DateTime.UtcNow }
            };
            try { await state.InsertOneAsync(record, cancellationToken: ct); }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            { record = await state.Find(new BsonDocument("_id", id)).FirstOrDefaultAsync(ct); }
        }
        if (record["UserId"] != targetId) throw new InvalidOperationException("恢复操作编号已绑定其他账号。");
        if (record["State"] == "conflict")
            throw new InvalidOperationException("该恢复操作已冲突；请核对账号后使用新的恢复操作编号。");
        if (record["State"] != "prepared") return;
        var before = record["BeforeHash"].AsString;
        var after = record["AfterHash"].AsString;
        var result = await users.UpdateOneAsync(x => x.Id == targetId && x.PasswordHash == before && x.SecurityVersion == record["BeforeVersion"].ToInt64(),
            Builders<LlmGwUser>.Update.Set(x => x.PasswordHash, after).Set(x => x.MustChangePassword, true)
                .Set(x => x.IsActive, true).Set(x => x.PasswordChangedByUser, false)
                .Inc(x => x.SecurityVersion, 1).Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
        var applied = result.ModifiedCount == 1 || await users.Find(x => x.Id == targetId && x.PasswordHash == after).AnyAsync(ct);
        await state.UpdateOneAsync(new BsonDocument("_id", id),
            new BsonDocument { { "$set", new BsonDocument { { "State", applied ? "complete" : "conflict" }, { "CompletedAt", DateTime.UtcNow } } },
                { "$unset", new BsonDocument { { "BeforeHash", 1 }, { "AfterHash", 1 } } } }, cancellationToken: ct);
        if (!applied) throw new InvalidOperationException("账号在恢复期间已变化；请核对账号后使用新的恢复操作编号。");
    }

    private static void ValidatePassword(string? password)
    {
        if (!GwPasswordPolicy.MeetsMinimumLength(password) || password!.Length > 1024)
            throw new InvalidOperationException("引导或恢复需要显式配置 12 至 1024 位独立强口令；无默认口令。");
    }
}
