using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed partial class ModelUpgradeService
{
    private async Task RequireDrainedAsync(ModelUpgradeState s, BsonDocument logical)
    {
        if (s.TenantId == internalTenantId)
        {
            var publicId = logical.GetStringOrEmpty("PublicId");
            var runs = map.GetCollection<BsonDocument>("image_gen_runs");
            if (await runs.Find(F.And(F.Nin("Status", new[] { 2, 3, 4 }), F.Or(F.Eq("LogicalModelPublicId", publicId),
                    F.And(F.Eq("PlatformId", "logical-model"), F.Eq("ModelId", publicId))))).AnyAsync(CancellationToken.None))
                throw new ModelUpgradeException("ACTIVE_IMAGE_TASKS", "该稳定模型仍有进行中的生图任务，已推迟切换；等待任务结束后重试。");
        }
        // Durable GW rows do not contain a resolved offering snapshot. Conservatively drain the tenant.
        if (await gateway.GetCollection<BsonDocument>("llmgw_request_executions").Find(Scope(s.TenantId,
                F.And(F.In("Status", new[] { "running", "unknown" }), F.Gt("ExpiresAt", DateTime.UtcNow)))).AnyAsync(CancellationToken.None))
            throw new ModelUpgradeException("ACTIVE_GATEWAY_TASKS", "当前组织仍有执行中或结果未知的网关请求，已推迟切换；请等待结束或核对未知请求。");
    }
    private static FilterDefinition<BsonDocument> Snapshot(BsonDocument doc, string tenant)
        => Scope(tenant, F.And(F.Eq("_id", doc.GetStringOrEmpty("_id")),
            doc.TryGetValue("UpdatedAt", out var time) ? F.Eq("UpdatedAt", time) : F.Exists("UpdatedAt", false)));
    private async Task RenewLeaseAsync(ModelUpgradeState s)
    {
        var until = DateTime.UtcNow.AddMinutes(3);
        var result = await States.UpdateOneAsync(x => x.Id == s.Id && x.TenantId == s.TenantId && x.Version == s.Version
                && x.LeaseToken == s.LeaseToken && x.LeaseUntil > DateTime.UtcNow,
            Builders<ModelUpgradeState>.Update.Set(x => x.LeaseUntil, until), cancellationToken: CancellationToken.None);
        if (result.MatchedCount != 1) throw new ModelUpgradeException("LEASE_LOST", "后台执行权已变化，本次未继续改动线路；请刷新状态。");
        s.LeaseUntil = until;
    }
    private async Task SwitchAsync(ModelUpgradeState s, bool rollback)
    {
        var logical = await LogicalAsync(s.TenantId, s.LogicalModelId);
        if (!ModelUpgradeRules.IsStable(logical)) throw new ModelUpgradeException("FIXED_MODEL", "固定版本不参与切换。");
        await RequireDrainedAsync(s, logical);
        if (s.PendingSwitch is not null)
        {
            await RecoverSwitchAsync(s);
            throw new ModelUpgradeException("INTERRUPTED_SWITCH", "上次切换已恢复至保留版本，请刷新并重新确认晋级。");
        }
        var current = await CurrentAsync(s.TenantId, s.LogicalModelId) ?? throw new ModelUpgradeException("CURRENT_REQUIRED", "当前没有可切换线路。");
        if (await Offerings.CountDocumentsAsync(Scope(s.TenantId, F.And(F.Eq("LogicalModelId", s.LogicalModelId), F.Eq("Enabled", true))), cancellationToken: CancellationToken.None) != 1)
            throw new ModelUpgradeException("MULTIPLE_ACTIVE_ROUTES", "稳定模型有多条启用线路，请先明确唯一当前版本再切换；系统不会隐式替换其他线路。");
        var old = await RequiredAsync(Offerings, s.TenantId, current.OfferingId);
        BsonDocument next;
        if (rollback)
        {
            var previous = s.LastPromotion ?? throw new ModelUpgradeException("ROLLBACK_UNAVAILABLE", "没有保留版本可回滚。");
            if (previous.RolledBack || previous.NewOfferingId != current.OfferingId) throw new ModelUpgradeException("CONFIG_CHANGED", "当前线路已被其他操作更改，请人工核对保留版本。");
            next = await RequiredAsync(Offerings, s.TenantId, previous.PreviousOfferingId);
            var target = await RequiredAsync(Models, s.TenantId, next.GetStringOrEmpty("TargetId"));
            var provider = await RequiredAsync(Providers, s.TenantId, target.GetStringOrEmpty("PlatformId"));
            if (!target.GetValue("Enabled", false).ToBoolean() || !provider.GetValue("Enabled", false).ToBoolean())
                throw new ModelUpgradeException("ROLLBACK_TARGET_DISABLED", "保留版本的型号或 Provider 已停用，请先恢复该线路依赖再回滚。");
        }
        else
        {
            var (_, candidateProvider, model) = await CandidateAsync(s);
            if (!ModelUpgradeRules.CanPromote(s, s.ExecutionRequestedBy == "scheduled", DateTime.UtcNow))
                throw new ModelUpgradeException("GATES_REQUIRED", "验收或自动晋级门禁未通过，原线路未改变。");
            if (current.ModelId == s.Candidate!.ModelId && current.UpstreamModelId == s.Candidate.UpstreamModelId)
                throw new ModelUpgradeException("ALREADY_CURRENT", "候选已是当前线路，无需重复晋级。");
            next = old.DeepClone().AsBsonDocument;
            next["_id"] = Guid.NewGuid().ToString("N"); next["TargetId"] = s.Candidate.ModelId;
            next["UpstreamModelId"] = model.GetStringOrEmpty("ModelName");
            next["Protocol"] = model.AsNullableString("Protocol") ?? candidateProvider.GetStringOrEmpty("PlatformType");
            next.Remove("EndpointPath"); next["HealthStatus"] = 0; next["ConsecutiveFailures"] = 0;
            next.Remove("HalfOpenLeaseUntil"); next.Remove("LastFailedAt");
            next["Enabled"] = false; next["CreatedAt"] = DateTime.UtcNow; next["UpdatedAt"] = DateTime.UtcNow;
            next["SupersededByOfferingId"] = "staging";
            // New records preserve old target identities for resolved requests and idempotent replay.
        }
        var operation = Guid.NewGuid().ToString("N");
        s.PendingAction = rollback ? "rollback" : "promote";
        s.PendingSwitch = new ModelUpgradeSwitch { OperationId = operation, PreviousOfferingId = old.GetStringOrEmpty("_id"), NewOfferingId = next.GetStringOrEmpty("_id"), RolledBack = rollback };
        await PersistAsync(s);
        await RenewLeaseAsync(s);
        if (!rollback) { next["UpgradeOperationId"] = operation; await Offerings.InsertOneAsync(next, cancellationToken: CancellationToken.None); }
        try
        {
            // Activate first to avoid a no-route interval. A durable intent makes a crash retry recoverable.
            await RenewLeaseAsync(s);
            var enabled = await Offerings.UpdateOneAsync(Snapshot(next, s.TenantId), Builders<BsonDocument>.Update
                .Set("Enabled", true).Unset("SupersededByOfferingId").Set("UpgradeOperationId", operation).Set("UpdatedAt", DateTime.UtcNow), cancellationToken: CancellationToken.None);
            if (enabled.ModifiedCount != 1) throw new ModelUpgradeException("VERSION_CONFLICT", "候选线路已变化，切换已停止，请刷新。");
            await RenewLeaseAsync(s);
            var disabled = await Offerings.UpdateOneAsync(Snapshot(old, s.TenantId) & F.Eq("Enabled", true), Builders<BsonDocument>.Update
                .Set("Enabled", false).Set("SupersededByOfferingId", "upgrade-retired:" + operation).Set("UpgradeOperationId", operation).Set("UpdatedAt", DateTime.UtcNow), cancellationToken: CancellationToken.None);
            if (disabled.ModifiedCount != 1) throw new ModelUpgradeException("VERSION_CONFLICT", "当前线路已被其他操作修改，正在恢复保留版本，请刷新。");
            if (rollback) s.LastPromotion!.RolledBack = true;
            else s.LastPromotion = s.PendingSwitch;
            s.PendingSwitch = null; s.PendingAction = ""; s.Phase = rollback ? "rolled_back" : "promoted";
            s.Message = rollback ? "已切回保留版本；稳定标识与别名保持不变。" : "已晋级到通过验收的候选，旧线路记录已保留以供回滚。";
            s.Current = await CurrentAsync(s.TenantId, s.LogicalModelId);
            await PersistAsync(s);
        }
        catch { await RecoverSwitchAsync(s); throw; }
    }
    private async Task RecoverSwitchAsync(ModelUpgradeState s)
    {
        var intent = s.PendingSwitch;
        if (intent is null) return;
        await RenewLeaseAsync(s);
        // Only compensate records still owned by this operation; never overwrite another administrator.
        await Offerings.UpdateOneAsync(Scope(s.TenantId, F.And(F.Eq("_id", intent.NewOfferingId), F.Eq("UpgradeOperationId", intent.OperationId))),
            Builders<BsonDocument>.Update.Set("Enabled", false).Set("SupersededByOfferingId", "upgrade-recovered:" + intent.OperationId).Set("UpdatedAt", DateTime.UtcNow), cancellationToken: CancellationToken.None);
        await Offerings.UpdateOneAsync(Scope(s.TenantId, F.And(F.Eq("_id", intent.PreviousOfferingId), F.Eq("UpgradeOperationId", intent.OperationId))),
            Builders<BsonDocument>.Update.Set("Enabled", true).Unset("SupersededByOfferingId").Set("UpdatedAt", DateTime.UtcNow), cancellationToken: CancellationToken.None);
        var restored = await RequiredAsync(Offerings, s.TenantId, intent.PreviousOfferingId);
        var replacement = await Offerings.Find(Scope(s.TenantId, F.Eq("_id", intent.NewOfferingId))).FirstOrDefaultAsync(CancellationToken.None);
        if (!restored.GetValue("Enabled", false).ToBoolean() || restored.Contains("SupersededByOfferingId")
            || replacement?.GetValue("Enabled", false).ToBoolean() == true)
            throw new ModelUpgradeException("RECOVERY_CONFLICT", "其他配置操作与切换恢复发生冲突，未覆盖其变更；请核对两条保留线路后重试恢复。");
        s.PendingSwitch = null;
        await PersistAsync(s);
    }
}
