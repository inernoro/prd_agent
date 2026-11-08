using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Infrastructure.Security;

public sealed partial class TaskExecutionCoordinator
{
    /// <summary>仅由持久任务生命周期守卫从取消前的真实文档绑定；不接受 HTTP 自报目标。</summary>
    public Task BindVideoReceiptAsync(string permitId, string runId, VideoReceiptTarget target, string tenantId, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var permit = await Permits.Find(x => x.Id == permitId).FirstOrDefaultAsync(ct);
            if (permit is null || permit.TenantId != tenantId || permit.ExecutionContractVersion != ContractVersion
                || !await AuthorizationMatchesAsync(permit, ct)
                || !permit.BoundRunIds.Contains(runId, StringComparer.Ordinal)
                || !permit.SubjectUserIds.Contains(target.OwnerId, StringComparer.Ordinal)
                || !permit.AllowedAppCallerCodes.Contains(target.AppCallerCode, StringComparer.Ordinal)
                || target.AppCallerCode is not (AppCallerRegistry.VideoAgent.VideoGen.Generate or AppCallerRegistry.VisualAgent.VideoGen.Generate)
                || string.IsNullOrWhiteSpace(target.JobId) || target.JobId.Length > 256
                || string.IsNullOrWhiteSpace(target.Model) || string.IsNullOrWhiteSpace(target.OfferingId)) return false;
            var entry = permit.Executions.SingleOrDefault(x => x.RunId == runId);
            if (entry is null || entry.VideoReceiptRevoked || entry.VideoReceipt is not null && entry.VideoReceipt != target) return false;
            var condition = new BsonDocument("$and", new BsonArray
            {
                new BsonDocument("$eq", new BsonArray { "$$e.RunId", NormalizeRun(runId) }),
                new BsonDocument("$ne", new BsonArray { new BsonDocument("$ifNull", new BsonArray { "$$e.VideoReceiptRevoked", false }), true }),
                new BsonDocument("$or", new BsonArray
                {
                    new BsonDocument("$eq", new BsonArray { new BsonDocument("$ifNull", new BsonArray { "$$e.VideoReceipt", BsonNull.Value }), BsonNull.Value }),
                    new BsonDocument("$eq", new BsonArray { "$$e.VideoReceipt", target.ToBsonDocument() })
                })
            });
            await Permits.UpdateOneAsync(LivePermit(permitId) & AnyExecution(condition),
                MapExecutions(condition, new BsonDocument("VideoReceipt", new BsonDocument("$literal", target.ToBsonDocument()))), cancellationToken: ct);
            return true;
        });

    public Task<TaskExecutionLease> AcquireVideoReceiptAsync(string permitId, string runId, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var permit = await Permits.Find(x => x.Id == permitId).FirstOrDefaultAsync(ct);
            if (permit is null || permit.ExecutionContractVersion != ContractVersion
                || !await AuthorizationMatchesAsync(permit, ct) || permit.CallCount >= permit.MaxCalls)
                throw Denied("TASK_VIDEO_RECEIPT_UNAVAILABLE", "原任务核账权限已失效，未发起上游查询。", 409);
            var entry = permit.Executions.SingleOrDefault(x => x.RunId == NormalizeRun(runId));
            if (entry?.VideoReceipt is not { } target || entry.VideoReceiptRevoked
                || entry.State is not (TaskExecutionLeaseStates.Cancelled or TaskExecutionLeaseStates.VideoReceipt))
                throw Denied("TASK_VIDEO_RECEIPT_UNAVAILABLE", "任务没有可用的原作业核账记录，未发起上游查询。", 409);
            var token = Guid.NewGuid().ToString("N");
            var condition = new BsonDocument("$and", new BsonArray
            {
                ReceiptMatches(runId, null, null, target),
                new BsonDocument("$lte", new BsonArray { "$$e.LeaseUntil", "$$NOW" })
            });
            var claimed = await Permits.FindOneAndUpdateAsync(LivePermit(permitId) & AnyExecution(condition),
                MapExecutions(condition, new BsonDocument { ["State"] = TaskExecutionLeaseStates.VideoReceipt, ["OwnerHash"] = OwnerHash(token),
                    ["Fence"] = new BsonDocument("$add", new BsonArray { "$$e.Fence", 1L }),
                    ["LeaseUntil"] = AddMilliseconds(LeaseMilliseconds) }),
                new FindOneAndUpdateOptions<GatewayTaskPermitRecord> { ReturnDocument = ReturnDocument.After }, ct);
            var current = claimed?.Executions.SingleOrDefault(x => x.RunId == runId);
            if (current is null || current.OwnerHash != OwnerHash(token))
                throw Denied("TASK_VIDEO_RECEIPT_UNAVAILABLE", "原作业正在由其它执行者核账，未重复查询。", 409);
            // 独立只读状态永不回到 Running；此 token 的普通生成/下载授权永远校验失败。
            return new TaskExecutionLease(this, new(permitId, runId, token, current.Fence), videoReceipt: target);
        });

    public Task<bool> ValidateVideoReceiptAsync(TaskExecutionLeaseProof proof, VideoReceiptTarget target, bool beforeDispatch, CancellationToken ct)
        => TouchVideoReceiptAsync(proof, target, beforeDispatch
            ? new BsonDocument("DispatchCount", new BsonDocument("$add", new BsonArray { "$$e.DispatchCount", 1 }))
            : new BsonDocument("LastVerifiedAt", "$$NOW"), ct);
    public Task<bool> RenewVideoReceiptAsync(TaskExecutionLeaseProof proof, VideoReceiptTarget target, CancellationToken ct)
        => TouchVideoReceiptAsync(proof, target, new BsonDocument("LeaseUntil", AddMilliseconds(LeaseMilliseconds)), ct);
    public Task<bool> ReleaseVideoReceiptAsync(TaskExecutionLeaseProof proof, VideoReceiptTarget target, CancellationToken ct)
        => TouchVideoReceiptAsync(proof, target, new BsonDocument { ["OwnerHash"] = "", ["LeaseUntil"] = DateTime.UnixEpoch }, ct);
    private Task<bool> TouchVideoReceiptAsync(TaskExecutionLeaseProof proof, VideoReceiptTarget target, BsonDocument patch, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var permit = await Permits.Find(x => x.Id == proof.PermitId).FirstOrDefaultAsync(ct);
            if (permit is null || permit.ExecutionContractVersion != ContractVersion || !await AuthorizationMatchesAsync(permit, ct)) return false;
            var condition = ReceiptMatches(proof.RunId, OwnerHash(proof.OwnerToken), proof.Fence, target);
            var updated = await Permits.UpdateOneAsync(LivePermit(proof.PermitId) & AnyExecution(condition), MapExecutions(condition, patch), cancellationToken: ct);
            return updated.MatchedCount == 1;
        });
    public Task RevokeVideoReceiptAsync(string permitId, string runId, CancellationToken ct)
        => GuardAsync(async () =>
        {
            var condition = new BsonDocument("$eq", new BsonArray { "$$e.RunId", NormalizeRun(runId) });
            await Permits.UpdateOneAsync(x => x.Id == permitId, MapExecutions(condition,
                new BsonDocument("VideoReceiptRevoked", true)), cancellationToken: ct);
            return true;
        });
    public static FilterDefinition<GatewayTaskPermitRecord> CurrentVideoReceiptFilter(
        string permitId, string? runId, string hash, long fence, VideoReceiptTarget target)
        => LivePermit(permitId) & AnyExecution(ReceiptMatches(runId, hash, fence, target));
    private static BsonDocument ReceiptMatches(string? runId, string? hash, long? fence, VideoReceiptTarget target)
    {
        var conditions = new BsonArray
        {
            new BsonDocument("$eq", new BsonArray { "$$e.RunId", NormalizeRun(runId) }),
            hash is null
                ? new BsonDocument("$in", new BsonArray { "$$e.State", new BsonArray { TaskExecutionLeaseStates.Cancelled, TaskExecutionLeaseStates.VideoReceipt } })
                : new BsonDocument("$eq", new BsonArray { "$$e.State", TaskExecutionLeaseStates.VideoReceipt }),
            new BsonDocument("$ne", new BsonArray { new BsonDocument("$ifNull", new BsonArray { "$$e.VideoReceiptRevoked", false }), true }),
            new BsonDocument("$eq", new BsonArray { "$$e.VideoReceipt", target.ToBsonDocument() })
        };
        if (hash is not null) conditions.Add(new BsonDocument("$eq", new BsonArray { "$$e.OwnerHash", hash }));
        if (fence is not null)
        {
            conditions.Add(new BsonDocument("$eq", new BsonArray { "$$e.Fence", fence.Value }));
            conditions.Add(new BsonDocument("$gt", new BsonArray { "$$e.LeaseUntil", "$$NOW" }));
        }
        return new("$and", conditions);
    }
}
