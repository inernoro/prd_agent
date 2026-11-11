using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.LogicalModels;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed partial class ModelUpgradeService(IMongoDatabase gateway, IMongoDatabase map, IModelUpgradeDiscovery discovery,
    string internalTenantId, ILogger<ModelUpgradeService> logger)
{
    public const string CollectionName = "llmgw_model_upgrade_policies";
    public const string ValidationCollectionName = "llmgw_model_upgrade_validation_runs";
    private IMongoCollection<ModelUpgradeState> States => gateway.GetCollection<ModelUpgradeState>(CollectionName);
    private IMongoCollection<BsonDocument> Logicals => gateway.GetCollection<BsonDocument>("llmgw_logical_models");
    private IMongoCollection<BsonDocument> Offerings => gateway.GetCollection<BsonDocument>("llmgw_model_offerings");
    private IMongoCollection<BsonDocument> Models => gateway.GetCollection<BsonDocument>("llmgw_models");
    private IMongoCollection<BsonDocument> Providers => gateway.GetCollection<BsonDocument>("llmgw_platforms");
    private IMongoCollection<BsonDocument> Logs => gateway.GetCollection<BsonDocument>("llmrequestlogs");
    private IMongoCollection<BsonDocument> ValidationRuns => gateway.GetCollection<BsonDocument>(ValidationCollectionName);
    private IMongoCollection<BsonDocument> Audits => gateway.GetCollection<BsonDocument>("llmgw_operation_audits");
    private static FilterDefinitionBuilder<BsonDocument> F => Builders<BsonDocument>.Filter;
    private static FilterDefinition<BsonDocument> Scope(string tenant, FilterDefinition<BsonDocument>? filter = null)
        => F.And(F.Eq("TenantId", tenant), filter ?? F.Empty);
    private async Task<BsonDocument> LogicalAsync(string tenant, string id)
        => await Logicals.Find(Scope(tenant, F.Eq("_id", id))).FirstOrDefaultAsync(CancellationToken.None)
           ?? throw new ModelUpgradeException("NOT_FOUND", "模型不存在或不属于当前组织。", 404);
    private async Task<ModelUpgradeState?> StateAsync(string tenant, string id)
        => await States.Find(x => x.Id == ModelUpgradeRules.StateId(tenant, id) && x.TenantId == tenant).FirstOrDefaultAsync(CancellationToken.None);
    private static bool Busy(ModelUpgradeState s) => s.PendingAction.Length > 0 || s.PendingSwitch is not null || s.LeaseUntil > DateTime.UtcNow;

    private async Task<ModelUpgradeTarget?> CurrentAsync(string tenant, string logicalId)
    {
        var route = await Offerings.Find(Scope(tenant, F.And(F.Eq("LogicalModelId", logicalId), F.Eq("Enabled", true),
                F.Exists("SupersededByOfferingId", false))))
            .Sort(Builders<BsonDocument>.Sort.Ascending("Priority").Ascending("_id")).FirstOrDefaultAsync(CancellationToken.None);
        if (route is null || (route.AsNullableString("TargetKind") ?? "model") != "model") return null;
        var model = await Models.Find(Scope(tenant, F.Eq("_id", route.GetStringOrEmpty("TargetId")))).FirstOrDefaultAsync(CancellationToken.None);
        return model is null ? null : new ModelUpgradeTarget
        {
            OfferingId = route.GetStringOrEmpty("_id"), ModelId = model.GetStringOrEmpty("_id"),
            ProviderId = model.GetStringOrEmpty("PlatformId"),
            UpstreamModelId = route.AsNullableString("UpstreamModelId") ?? model.GetStringOrEmpty("ModelName"),
        };
    }

    public async Task<ModelUpgradeView> ReadAsync(string tenant, string logicalId)
    {
        var logical = await LogicalAsync(tenant, logicalId);
        var s = await StateAsync(tenant, logicalId);
        var stable = ModelUpgradeRules.IsStable(logical);
        var current = await CurrentAsync(tenant, logicalId);
        var canPromote = stable && s is not null && !Busy(s) && current?.ModelId != s.Candidate?.ModelId && ModelUpgradeRules.CanPromote(s, false, DateTime.UtcNow);
        return new ModelUpgradeView
        {
            LogicalModelId = logicalId, PublicId = logical.GetStringOrEmpty("PublicId"), Name = logical.GetStringOrEmpty("Name"),
            ModelType = logical.GetStringOrEmpty("ModelType"), IdentityKind = logical.AsNullableString("IdentityKind") ?? "fixed",
            Aliases = ModelUpgradeRules.Strings(logical, "Aliases"), Version = s?.Version ?? 0, Policy = s?.Policy ?? new(),
            Current = current, Candidate = s?.Candidate, Gates = s?.Gates ?? new(),
            Discoveries = s?.Discoveries ?? [], ValidationStatus = s?.ValidationStatus ?? "not-run",
            Phase = s?.Phase ?? "idle", Message = s?.Message ?? "尚未配置自动更新策略。",
            UpdatedAt = s?.UpdatedAt, LastCheckedAt = s?.LastCheckedAt, NextCheckAt = s?.NextCheckAt, History = s?.History ?? [],
            CanPromote = canPromote, CanRollback = stable && s?.LastPromotion is { RolledBack: false } && !Busy(s),
            ActionDisabledReason = !stable ? "固定版本标识不参与升级，请配置稳定业务模型。" : s is not null && Busy(s)
                ? "任务正在执行，请等待状态更新。" : s?.OutcomeUnknown == true ? "上次验收结果未知，请先提供对应真实请求证据；禁止自动重试。" : canPromote ? null : "候选尚未通过真实验收，原线路保持不变。",
        };
    }
    public async Task<List<ModelUpgradeView>> ListAsync(string tenant)
    {
        var logicals = await Logicals.Find(Scope(tenant, F.Eq("IdentityKind", "stable"))).Limit(200).ToListAsync(CancellationToken.None);
        var result = new List<ModelUpgradeView>();
        foreach (var logical in logicals) result.Add(await ReadAsync(tenant, logical.GetStringOrEmpty("_id")));
        return result;
    }

    public async Task<ModelUpgradeView> SavePolicyAsync(TenantAccessContext actor, string id, ModelUpgradePolicyWrite write)
    {
        ModelUpgradeRules.ValidatePolicy(write);
        var logical = await LogicalAsync(actor.TenantId, id);
        if (!ModelUpgradeRules.IsStable(logical)) throw new ModelUpgradeException("FIXED_MODEL", "固定版本型号不能启用升级；请使用稳定业务标识。", 400);
        foreach (var successor in write.Successors)
        {
            var provider = await Providers.Find(Scope(actor.TenantId, F.Eq("_id", successor.ProviderId))).FirstOrDefaultAsync(CancellationToken.None)
                ?? throw new ModelUpgradeException("PROVIDER_NOT_FOUND", "继任关系中的官方 Provider 不存在或不属于本组织。", 400);
            ModelUpgradeDiscovery.RequireOfficial(provider);
        }
        var state = await StateAsync(actor.TenantId, id);
        if (state is null)
        {
            if (write.Version != 0) throw new ModelUpgradeException("VERSION_CONFLICT", "策略已变化，请刷新后重试。");
            state = new() { Id = ModelUpgradeRules.StateId(actor.TenantId, id), TenantId = actor.TenantId, LogicalModelId = id };
            try { await States.InsertOneAsync(state, cancellationToken: CancellationToken.None); }
            catch (MongoWriteException e) when (e.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            { throw new ModelUpgradeException("VERSION_CONFLICT", "其他管理员已建立策略，请刷新后重试。"); }
        }
        if (state.Version != write.Version || Busy(state)) throw new ModelUpgradeException("VERSION_CONFLICT", "策略正在执行或已更新，请刷新后重试。");
        state.ActorConsoleUserId = actor.UserId; state.ActorUserId = actor.ExternalUserId ?? actor.UserId; state.ActorUsername = actor.Username;
        var audit = await AuditBeginAsync(state, "policy.update");
        state.Policy = new ModelUpgradePolicy
        {
            Enabled = write.Enabled, Mode = write.Mode, AutoValidate = write.AutoValidate, CheckIntervalHours = write.CheckIntervalHours,
            MaxValidationCostUsd = write.MaxValidationCostUsd, CanaryUnitCostUpperBoundUsd = write.CanaryUnitCostUpperBoundUsd, MaxDailyCostUsd = write.MaxDailyCostUsd,
            MaxPriceIncreasePercent = write.MaxPriceIncreasePercent, ValidationAppCallerCode = (write.ValidationAppCallerCode ?? "").Trim(), Successors = write.Successors,
        };
        state.ActorConsoleUserId = actor.UserId; state.ActorUserId = actor.ExternalUserId ?? actor.UserId; state.ActorUsername = actor.Username;
        if (!state.OutcomeUnknown) { state.Candidate = null; state.Gates = new(); state.Phase = "idle"; }
        state.NextCheckAt = state.Policy.Enabled ? ModelUpgradeRules.NextCheckAt(null, DateTime.UtcNow, state.Policy.CheckIntervalHours) : null;
        state.Message = "策略已保存；只有明确继任关系与真实验收均满足时才会更新线路。";
        History(state, "policy.update", "succeeded", state.Message);
        try { await PersistAsync(state); await AuditCompleteAsync(state, audit, true); }
        catch { await AuditCompleteAsync(state, audit, false); throw; }
        return await ReadAsync(actor.TenantId, id);
    }

    public async Task<ModelUpgradeView> QueueAsync(TenantAccessContext actor, string id, string action, ModelUpgradeAction request)
    {
        var logical = await LogicalAsync(actor.TenantId, id);
        if (!ModelUpgradeRules.IsStable(logical)) throw new ModelUpgradeException("FIXED_MODEL", "固定版本型号不参与升级。", 400);
        var state = await StateAsync(actor.TenantId, id) ?? throw new ModelUpgradeException("POLICY_REQUIRED", "请先保存更新策略。");
        if (state.Version != request.Version || Busy(state)) throw new ModelUpgradeException("VERSION_CONFLICT", "策略正在执行或已更新，请刷新后重试。");
        if (state.OutcomeUnknown && !(action == "validate" && !string.IsNullOrWhiteSpace(request.RequestId)))
            throw new ModelUpgradeException("OUTCOME_UNKNOWN", "上次验收结果未知，禁止重发。请提供该请求的真实日志 ID 继续核验。");
        if (action is "validate" or "promote" && state.Candidate is null) throw new ModelUpgradeException("CANDIDATE_REQUIRED", "请先检查并确认候选型号。");
        if (action == "promote" && !ModelUpgradeRules.CanPromote(state, false, DateTime.UtcNow))
            throw new ModelUpgradeException("VALIDATION_REQUIRED", "候选尚未通过近期真实验收，原线路未改变。");
        if (action == "rollback" && state.LastPromotion is not { RolledBack: false }) throw new ModelUpgradeException("ROLLBACK_UNAVAILABLE", "没有可回滚的本策略晋级版本。");
        if (request.RequestId?.Length > 200) throw new ModelUpgradeException("INVALID_REQUEST_ID", "请求 ID 过长。", 400);
        if (action == "validate" && (request.Mode is not ("evidence" or "canary") || request.Mode == "evidence" && string.IsNullOrWhiteSpace(request.RequestId)))
            throw new ModelUpgradeException("EVIDENCE_REQUIRED", "请选择真实请求证据并填写请求 ID，或明确选择受预算验收。", 400);
        state.ValidationMode = request.Mode; state.ExecutionRequestedBy = "manual";
        state.PendingAction = action; state.EvidenceRequestId = request.RequestId?.Trim();
        state.ActorConsoleUserId = actor.UserId; state.ActorUserId = actor.ExternalUserId ?? actor.UserId; state.ActorUsername = actor.Username;
        state.Phase = Phase(action); state.Message = "任务已排队，正在等待后台执行；原线路尚未改变。";
        History(state, action, "queued", state.Message, state.EvidenceRequestId);
        await PersistAsync(state);
        return await ReadAsync(actor.TenantId, id);
    }

    private async Task PersistAsync(ModelUpgradeState s)
    {
        var version = s.Version;
        s.Version++; s.UpdatedAt = DateTime.UtcNow;
        var filter = Builders<ModelUpgradeState>.Filter.Where(x => x.Id == s.Id && x.TenantId == s.TenantId && x.Version == version);
        if (s.LeaseToken is not null) filter &= Builders<ModelUpgradeState>.Filter.Eq(x => x.LeaseToken, s.LeaseToken);
        var result = await States.ReplaceOneAsync(filter, s, cancellationToken: CancellationToken.None);
        if (result.ModifiedCount != 1) { s.Version = version; throw new ModelUpgradeException("VERSION_CONFLICT", "策略已变化，后台没有覆盖其他操作，请刷新后重试。"); }
    }
    private static void History(ModelUpgradeState s, string action, string status, string message, string? requestId = null)
    {
        s.History.Add(new() { Action = action, Status = status, Message = message, RequestId = requestId });
        if (s.History.Count > 40) s.History = s.History.TakeLast(40).ToList();
    }
    private static string Phase(string action) => action switch
    { "check" => "checking", "validate" or "await-validation" => "validating", "promote" => "promoting", "rollback" => "rolling_back", _ => "idle" };
    private async Task<string> AuditBeginAsync(ModelUpgradeState s, string action)
    {
        var id = Guid.NewGuid().ToString("N");
        await Audits.InsertOneAsync(new BsonDocument
        {
            { "_id", id }, { "TenantId", s.TenantId }, { "Action", "model-upgrade." + action }, { "TargetType", "llmgw_logical_model" },
            { "TargetId", s.LogicalModelId }, { "ActorUserId", s.ActorConsoleUserId }, { "ActorUsername", s.ActorUsername },
            { "Success", false }, { "State", "pending" }, { "CreatedAt", DateTime.UtcNow },
            { "Changes", new BsonDocument { { "policyVersion", s.Version }, { "candidateModelId", s.Candidate?.ModelId ?? "" } } },
        }, cancellationToken: CancellationToken.None);
        return id;
    }
    private async Task AuditCompleteAsync(ModelUpgradeState s, string audit, bool success)
    {
        var result = await Audits.UpdateOneAsync(Scope(s.TenantId, F.Eq("_id", audit)), Builders<BsonDocument>.Update
            .Set("State", success ? "completed" : "failed").Set("Success", success).Set("CompletedAt", DateTime.UtcNow), cancellationToken: CancellationToken.None);
        if (result.MatchedCount != 1) throw new ModelUpgradeException("AUDIT_WRITE_FAILED", "操作审计未能完成，请核对当前线路与审计后重试。");
    }
}
