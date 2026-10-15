using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Security;

/// <summary>业务身份、次数、撤销和有界子执行同文档裁决，不依赖实例内锁或额外索引。</summary>
public sealed class TaskExecutionCoordinator(LlmGatewayDataContext data) : ITaskExecutionCoordinator
{
    public const int ContractVersion = 2;
    public const int LeaseMilliseconds = 45_000;
    private IMongoCollection<GatewayTaskPermitRecord> Permits =>
        data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
    private IMongoCollection<TaskAuthorizationRevocationRecord> Authorizations =>
        data.Database.GetCollection<TaskAuthorizationRevocationRecord>(TaskAuthorizationRevocationRecord.CollectionName);

    public static string Fingerprint(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static string BusinessId(string tenantId, string actorId, string operation, string key)
        => Fingerprint(System.Text.Json.JsonSerializer.Serialize(new[] { tenantId, actorId, operation, key }))[..32];
    public static string OwnerHash(string token) => Fingerprint(token);

    public Task<TaskExecutionAdmission> RegisterAsync(GatewayTaskPermitRecord permit, bool inline, CancellationToken ct)
        => GuardAsync<TaskExecutionAdmission>(async () =>
        {
            if (permit.ExecutionContractVersion != ContractVersion || string.IsNullOrWhiteSpace(permit.BusinessKeyHash)
                || string.IsNullOrWhiteSpace(permit.RequestFingerprint) || !TaskExecutionAuthorizer.ValidPermitId(permit.Id))
                throw Denied("TASK_BUSINESS_IDENTITY_REQUIRED", "任务缺少平台业务身份，已停止执行；请从正常入口重新提交。");
            var versions = await ReadAuthorizationVersionsAsync(permit.TenantId, permit.ActorUserId, permit.TriggerCredentialId, ct);
            permit.ActorAuthorizationVersion = versions.Actor;
            permit.CredentialAuthorizationVersion = versions.Credential;
            var token = Guid.NewGuid().ToString("N");
            permit.AdmissionOwnerHash = OwnerHash(token);
            var proof = new TaskExecutionLeaseProof(permit.Id, null, token, 1);
            var initial = permit.ToBsonDocument();
            initial["CreatedAt"] = "$$NOW";
            initial["ExpiresAt"] = AddMilliseconds((long)GatewayTaskPermitRecord.MaximumLifetime.TotalMilliseconds);
            initial["Executions"] = inline ? new BsonArray { NewExecution(string.Empty, OwnerHash(token), 1) } : new BsonArray();
            var stage = new BsonDocument("$replaceWith", new BsonDocument("$cond", new BsonArray
            {
                new BsonDocument("$eq", new BsonArray { new BsonDocument("$type", "$BusinessKeyHash"), "missing" }),
                new BsonDocument("$literal", initial), "$$ROOT"
            }));
            // literal 保护用户来源字段；仅这几个平台时间表达式在服务端求值。
            initial.Remove("CreatedAt"); initial.Remove("ExpiresAt"); initial.Remove("Executions");
            stage["$replaceWith"]["$cond"][1] = new BsonDocument("$mergeObjects", new BsonArray
            {
                new BsonDocument("$literal", initial),
                new BsonDocument
                {
                    ["CreatedAt"] = "$$NOW",
                    ["ExpiresAt"] = AddMilliseconds((long)GatewayTaskPermitRecord.MaximumLifetime.TotalMilliseconds),
                    ["Executions"] = inline ? new BsonArray { NewExecution(string.Empty, OwnerHash(token), 1) } : new BsonArray()
                }
            });
            GatewayTaskPermitRecord stored;
            try
            {
                stored = await Permits.FindOneAndUpdateAsync(Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.Id, permit.Id), Pipeline(stage),
                    new FindOneAndUpdateOptions<GatewayTaskPermitRecord> { IsUpsert = true, ReturnDocument = ReturnDocument.After }, ct);
            }
            catch (MongoException e) when (IsDuplicate(e))
            {
                stored = await Permits.Find(x => x.Id == permit.Id).FirstOrDefaultAsync(ct)
                    ?? throw Unavailable();
            }
            if (stored.TenantId != permit.TenantId || stored.ActorUserId != permit.ActorUserId
                || stored.SourceTask != permit.SourceTask || stored.BusinessKeyHash != permit.BusinessKeyHash
                || stored.RequestFingerprint != permit.RequestFingerprint)
                throw Denied("TASK_IDEMPOTENCY_CONFLICT", "这次提交标识已用于不同内容，未启动新任务；请使用新的操作标识重新提交。", 409);
            var own = inline && stored.AdmissionOwnerHash == OwnerHash(token);
            var newlyScheduled = !inline && stored.AdmissionOwnerHash == OwnerHash(token);
            return new(stored, !own && !newlyScheduled, own ? new TaskExecutionLease(this, proof) : null);
        });

    public Task<TaskExecutionLease> AcquireAsync(string permitId, string? runId, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var key = NormalizeRun(runId);
            if (TaskExecutionContext.Current is { Lease: { } existing } current
                && current.PermitId == permitId && NormalizeRun(existing.RunId) == key
                && await ValidateAsync(existing, false, ct))
                return new TaskExecutionLease(this, existing, borrowed: true);
            var permit = await Permits.Find(x => x.Id == permitId).FirstOrDefaultAsync(ct);
            if (permit is null || permit.ExecutionContractVersion != ContractVersion)
                throw Denied("TASK_EXECUTION_NOT_ADMITTED", "任务没有有效的平台执行记录，已停止；请重新明确提交。");
            await AssertAuthorizationAsync(permit, ct);
            if (key.Length == 0) throw Denied("TASK_EXECUTION_IDENTITY_REQUIRED", "后台任务缺少业务执行对象，已停止；请核对任务配置。");
            var baseFilter = LivePermit(permitId);
            var absent = baseFilter & new BsonDocument("Executions.RunId", new BsonDocument("$ne", key))
                & new BsonDocument("$expr", new BsonDocument("$lt", new BsonArray
                { new BsonDocument("$size", new BsonDocument("$filter", new BsonDocument
                    { ["input"] = "$Executions", ["as"] = "e", ["cond"] = new BsonDocument("$ne", new BsonArray { "$$e.RunId", "" }) })), "$MaxRuns" }));
            await Permits.UpdateOneAsync(absent, new BsonDocument
            {
                ["$push"] = new BsonDocument("Executions", new BsonDocument { ["RunId"] = key,
                    ["State"] = TaskExecutionLeaseStates.Pending, ["OwnerHash"] = "", ["Fence"] = 0L,
                    ["LeaseUntil"] = DateTime.UnixEpoch, ["DispatchCount"] = 0 }),
                ["$addToSet"] = new BsonDocument("BoundRunIds", key)
            }, cancellationToken: ct);
            var token = Guid.NewGuid().ToString("N");
            var eligible = new BsonDocument("$and", new BsonArray
            {
                new BsonDocument("$eq", new BsonArray { "$$e.RunId", key }),
                new BsonDocument("$or", new BsonArray
                {
                    new BsonDocument("$eq", new BsonArray { "$$e.State", TaskExecutionLeaseStates.Pending }),
                    new BsonDocument("$and", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$$e.State", TaskExecutionLeaseStates.Running }),
                        new BsonDocument("$lte", new BsonArray { "$$e.LeaseUntil", "$$NOW" }),
                        new BsonDocument("$eq", new BsonArray { "$$e.DispatchCount", 0 })
                    })
                })
            });
            var filter = baseFilter & AnyExecution(eligible);
            var patch = new BsonDocument { ["State"] = TaskExecutionLeaseStates.Running, ["OwnerHash"] = OwnerHash(token),
                ["Fence"] = new BsonDocument("$add", new BsonArray { "$$e.Fence", 1L }), ["LeaseUntil"] = AddMilliseconds(LeaseMilliseconds) };
            var claimed = await Permits.FindOneAndUpdateAsync(filter, MapExecutions(eligible, patch),
                new FindOneAndUpdateOptions<GatewayTaskPermitRecord> { ReturnDocument = ReturnDocument.After }, ct);
            if (claimed is null)
            {
                var uncertain = new BsonDocument("$and", new BsonArray
                {
                    new BsonDocument("$eq", new BsonArray { "$$e.RunId", key }),
                    new BsonDocument("$eq", new BsonArray { "$$e.State", TaskExecutionLeaseStates.Running }),
                    new BsonDocument("$lte", new BsonArray { "$$e.LeaseUntil", "$$NOW" }),
                    new BsonDocument("$gt", new BsonArray { "$$e.DispatchCount", 0 })
                });
                await Permits.UpdateOneAsync(baseFilter & AnyExecution(uncertain),
                    MapExecutions(uncertain, new BsonDocument("State", TaskExecutionLeaseStates.OutcomeUnknown)), cancellationToken: ct);
                var latest = await Permits.Find(x => x.Id == permitId).FirstOrDefaultAsync(ct);
                if (latest?.Executions.Any(x => x.RunId == key && x.State == TaskExecutionLeaseStates.OutcomeUnknown) == true)
                    throw Denied("TASK_EXECUTION_OUTCOME_UNKNOWN", "上一次执行已有外部调用但结果尚无法确认，已停止自动重跑；请核对已有结果后重新提交。", 409);
                throw Denied("TASK_EXECUTION_UNAVAILABLE", "任务已由其它执行者处理、已结束或上次结果待核对，未重复启动；请查看任务状态。", 409);
            }
            var entry = claimed.Executions.Single(x => x.RunId == key);
            return new TaskExecutionLease(this, new(permitId, runId, token, entry.Fence));
        });

    public Task<bool> RenewAsync(TaskExecutionLeaseProof proof, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var permit = await Permits.Find(x => x.Id == proof.PermitId).FirstOrDefaultAsync(ct);
            if (permit is null || permit.ExecutionContractVersion != ContractVersion || !await AuthorizationMatchesAsync(permit, ct)) return false;
            var matches = ExecutionMatches(proof.RunId, OwnerHash(proof.OwnerToken), proof.Fence);
            var result = await Permits.UpdateOneAsync(LivePermit(proof.PermitId) & AnyExecution(matches),
                MapExecutions(matches, new BsonDocument("LeaseUntil", AddMilliseconds(LeaseMilliseconds))), cancellationToken: ct);
            return result.MatchedCount == 1;
        });

    public Task<bool> ValidateAsync(TaskExecutionLeaseProof proof, bool beforeDispatch, CancellationToken ct)
        => ValidateHashAsync(proof.PermitId, proof.RunId, OwnerHash(proof.OwnerToken), proof.Fence, beforeDispatch, ct);

    public Task<bool> ValidateHashAsync(string permitId, string? runId, string ownerHash, long fence, bool beforeDispatch, CancellationToken ct, string? businessRunId = null)
        => GuardAsync(async () =>
        {
            if (string.IsNullOrWhiteSpace(ownerHash) || fence <= 0) return false;
            var permit = await Permits.Find(x => x.Id == permitId).FirstOrDefaultAsync(ct);
            if (permit is null || permit.ExecutionContractVersion != ContractVersion || !await AuthorizationMatchesAsync(permit, ct)) return false;
            var matches = ExecutionMatches(runId, ownerHash, fence);
            var filter = LivePermit(permitId) & AnyExecution(matches);
            if (!string.IsNullOrWhiteSpace(businessRunId))
                filter &= Builders<GatewayTaskPermitRecord>.Filter.Not(Builders<GatewayTaskPermitRecord>.Filter.ElemMatch(
                    x => x.Executions, e => e.RunId == businessRunId && e.State == TaskExecutionLeaseStates.Cancelled));
            // 校验也在同一文档原子触碰，不能将入口读到的租约快照当成以后仍有效。
            var patch = beforeDispatch
                ? new BsonDocument("DispatchCount", new BsonDocument("$add", new BsonArray { "$$e.DispatchCount", 1 }))
                : new BsonDocument("LastVerifiedAt", "$$NOW");
            var result = await Permits.UpdateOneAsync(filter, MapExecutions(matches, patch), cancellationToken: ct);
            return result.MatchedCount == 1;
        });

    public Task<bool> CompleteAsync(TaskExecutionLeaseProof proof, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var matches = ExecutionMatches(proof.RunId, OwnerHash(proof.OwnerToken), proof.Fence);
            var result = await Permits.UpdateOneAsync(LivePermit(proof.PermitId) & AnyExecution(matches),
                MapExecutions(matches, new BsonDocument { ["State"] = TaskExecutionLeaseStates.Completed, ["FinishedAt"] = "$$NOW" }), cancellationToken: ct);
            return result.MatchedCount == 1;
        });

    public Task RevokeAsync(string permitId, string? runId, CancellationToken ct)
        => GuardAsync(async () =>
        {
            if (runId is null)
            {
                await Permits.UpdateOneAsync(x => x.Id == permitId,
                    Pipeline(new BsonDocument("$set", new BsonDocument("RevokedAt", new BsonDocument("$ifNull", new BsonArray { "$RevokedAt", "$$NOW" })))), cancellationToken: ct);
                return true;
            }
            var key = NormalizeRun(runId);
            var missing = new BsonDocument { ["_id"] = permitId, ["Executions.RunId"] = new BsonDocument("$ne", key),
                ["$expr"] = new BsonDocument("$lte", new BsonArray { new BsonDocument("$size", new BsonDocument("$ifNull", new BsonArray { "$Executions", new BsonArray() })), "$MaxRuns" }) };
            await Permits.UpdateOneAsync(missing,
                new BsonDocument("$push", new BsonDocument("Executions", new BsonDocument { ["RunId"] = key, ["State"] = TaskExecutionLeaseStates.Cancelled,
                    ["OwnerHash"] = "", ["Fence"] = 0L, ["LeaseUntil"] = DateTime.UnixEpoch, ["DispatchCount"] = 0 })), cancellationToken: ct);
            // 有界空间耗尽时撤销整个意图，不能丢弃取消标记后继续支付。
            await Permits.UpdateOneAsync(new BsonDocument { ["_id"] = permitId, ["Executions.RunId"] = new BsonDocument("$ne", key) },
                Builders<GatewayTaskPermitRecord>.Update.CurrentDate(x => x.RevokedAt), cancellationToken: ct);
            var matches = new BsonDocument("$eq", new BsonArray { "$$e.RunId", key });
            await Permits.UpdateOneAsync(x => x.Id == permitId, MapExecutions(matches,
                new BsonDocument { ["State"] = TaskExecutionLeaseStates.Cancelled, ["FinishedAt"] = "$$NOW" }), cancellationToken: ct);
            return true;
        });

    public Task<(long Actor, long Credential)> ReadAuthorizationVersionsAsync(string tenantId, string actorId, string credentialId, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var actor = await Authorizations.Find(x => x.Id == AuthorizationId("actor", tenantId, actorId)).FirstOrDefaultAsync(ct);
            var credential = await Authorizations.Find(x => x.Id == AuthorizationId("credential", tenantId, credentialId)).FirstOrDefaultAsync(ct);
            if (actor?.Disabled == true || credential?.Disabled == true)
                throw Denied("TASK_TRIGGER_REVOKED", "发起任务的账号或凭据已被停用，本次执行已停止；请联系管理员核对授权。");
            return (actor?.Version ?? 0, credential?.Version ?? 0);
        });

    public Task ChangeActorAuthorizationAsync(string tenantId, string actorId, bool enabled, CancellationToken ct)
        => ChangeAuthorizationAsync("actor", tenantId, actorId, !enabled, ct);
    public Task ChangeCredentialAuthorizationAsync(string tenantId, string credentialId, bool enabled, CancellationToken ct)
        => ChangeAuthorizationAsync("credential", tenantId, credentialId, !enabled, ct);
    public Task RevokeCredentialAsync(string tenantId, string credentialId, CancellationToken ct)
        => ChangeAuthorizationAsync("credential", tenantId, credentialId, true, ct);

    private Task ChangeAuthorizationAsync(string kind, string tenantId, string reference, bool disabled, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var id = AuthorizationId(kind, tenantId, reference);
            var pipeline = new BsonDocument("$set", new BsonDocument
            {
                ["Version"] = new BsonDocument("$add", new BsonArray { new BsonDocument("$ifNull", new BsonArray { "$Version", 0L }), 1L }),
                ["Disabled"] = disabled, ["ChangedAt"] = "$$NOW"
            });
            var changed = await Authorizations.FindOneAndUpdateAsync(
                Builders<TaskAuthorizationRevocationRecord>.Filter.Eq(x => x.Id, id),
                new PipelineUpdateDefinition<TaskAuthorizationRevocationRecord>(new[] { pipeline }),
                new FindOneAndUpdateOptions<TaskAuthorizationRevocationRecord> { IsUpsert = true, ReturnDocument = ReturnDocument.After }, ct);
            var affected = Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.TenantId, tenantId)
                & (kind == "actor" ? Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.ActorUserId, reference)
                    & Builders<GatewayTaskPermitRecord>.Filter.Lt(x => x.ActorAuthorizationVersion, changed.Version)
                    : Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.TriggerCredentialId, reference)
                    & Builders<GatewayTaskPermitRecord>.Filter.Lt(x => x.CredentialAuthorizationVersion, changed.Version));
            await Permits.UpdateManyAsync(affected, Builders<GatewayTaskPermitRecord>.Update.CurrentDate(x => x.RevokedAt), cancellationToken: ct);
            return true;
        });

    public Task SaveAcceptedResponseAsync(string permitId, int status, string contentType, string? body, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var proof = TaskExecutionContext.Current?.Lease;
            if (proof is null || proof.PermitId != permitId) return false;
            var filter = LivePermit(permitId) & AnyExecution(ExecutionMatches(proof.RunId, OwnerHash(proof.OwnerToken), proof.Fence));
            await Permits.UpdateOneAsync(filter, Builders<GatewayTaskPermitRecord>.Update
                .Set(x => x.AcceptedResponseStatus, status).Set(x => x.AcceptedResponseContentType, contentType)
                .Set(x => x.AcceptedResponseBody, body is { Length: <= 131072 } ? body : null), cancellationToken: ct);
            return true;
        });

    private async Task AssertAuthorizationAsync(GatewayTaskPermitRecord permit, CancellationToken ct)
    {
        if (!await AuthorizationMatchesAsync(permit, ct))
            throw Denied("TASK_TRIGGER_REVOKED", "发起任务的授权已改变，执行已停止；请重新明确提交任务。");
    }
    private async Task<bool> AuthorizationMatchesAsync(GatewayTaskPermitRecord permit, CancellationToken ct)
    {
        try
        {
            var versions = await ReadAuthorizationVersionsAsync(permit.TenantId, permit.ActorUserId, permit.TriggerCredentialId, ct);
            return versions.Actor == permit.ActorAuthorizationVersion && versions.Credential == permit.CredentialAuthorizationVersion;
        }
        catch (TaskExecutionAdmissionException e) when (e.Code == "TASK_TRIGGER_REVOKED") { return false; }
    }
    private static string AuthorizationId(string kind, string tenant, string reference)
        => Fingerprint(System.Text.Json.JsonSerializer.Serialize(new[] { kind, tenant, reference }));
    private static string NormalizeRun(string? runId)
    {
        if (runId?.Length > 256 || runId is not null && runId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_' or '.' or ':')))
            throw Denied("TASK_EXECUTION_IDENTITY_INVALID", "任务执行对象超出平台范围，已停止；请核对任务配置。");
        return runId ?? string.Empty;
    }
    private static BsonDocument AddMilliseconds(long value) => new("$add", new BsonArray { "$$NOW", value });
    private static BsonDocument NewExecution(string runId, string hash, long fence) => new()
    {
        ["RunId"] = runId, ["State"] = TaskExecutionLeaseStates.Running, ["OwnerHash"] = hash,
        ["Fence"] = fence, ["LeaseUntil"] = AddMilliseconds(LeaseMilliseconds), ["DispatchCount"] = 0
    };
    private static FilterDefinition<GatewayTaskPermitRecord> LivePermit(string id)
        => new BsonDocument { ["_id"] = id, ["ExecutionContractVersion"] = ContractVersion, ["RevokedAt"] = BsonNull.Value,
            ["$expr"] = new BsonDocument("$gt", new BsonArray { "$ExpiresAt", "$$NOW" }) };
    private static BsonDocument ExecutionMatches(string? runId, string hash, long fence) => new("$and", new BsonArray
    {
        new BsonDocument("$eq", new BsonArray { "$$e.RunId", NormalizeRun(runId) }),
        new BsonDocument("$eq", new BsonArray { "$$e.OwnerHash", hash }),
        new BsonDocument("$eq", new BsonArray { "$$e.Fence", fence }),
        new BsonDocument("$eq", new BsonArray { "$$e.State", TaskExecutionLeaseStates.Running }),
        new BsonDocument("$gt", new BsonArray { "$$e.LeaseUntil", "$$NOW" })
    });
    private static FilterDefinition<GatewayTaskPermitRecord> AnyExecution(BsonDocument condition)
        => new BsonDocument("$expr", new BsonDocument("$anyElementTrue", new BsonArray
        { new BsonDocument("$map", new BsonDocument { ["input"] = "$Executions", ["as"] = "e", ["in"] = condition }) }));
    public static FilterDefinition<GatewayTaskPermitRecord> CurrentLeaseFilter(string permitId, string? runId, string hash, long fence)
        => LivePermit(permitId) & AnyExecution(ExecutionMatches(runId, hash, fence));
    private static UpdateDefinition<GatewayTaskPermitRecord> MapExecutions(BsonDocument condition, BsonDocument patch)
        => Pipeline(new BsonDocument("$set", new BsonDocument("Executions", new BsonDocument("$map", new BsonDocument
        {
            ["input"] = "$Executions", ["as"] = "e", ["in"] = new BsonDocument("$cond", new BsonArray
            { condition, new BsonDocument("$mergeObjects", new BsonArray { "$$e", patch }), "$$e" })
        }))));
    private static UpdateDefinition<GatewayTaskPermitRecord> Pipeline(BsonDocument stage)
        => new PipelineUpdateDefinition<GatewayTaskPermitRecord>(new[] { stage });
    private static bool IsDuplicate(MongoException e)
        => e is MongoWriteException { WriteError.Category: ServerErrorCategory.DuplicateKey }
            or MongoCommandException { Code: 11000 };
    private static TaskExecutionAdmissionException Denied(string code, string message, int status = 403) => new(code, message, status);
    private static TaskExecutionAdmissionException Unavailable() => new("TASK_EXECUTION_UNAVAILABLE",
        "任务保护暂时无法核验，本次执行已停止；请稍后重试。", 503);
    private static async Task<T> GuardAsync<T>(Func<Task<T>> action)
    {
        try { return await action(); }
        catch (Exception e) when (e is MongoException or TimeoutException) { throw Unavailable(); }
    }
}
