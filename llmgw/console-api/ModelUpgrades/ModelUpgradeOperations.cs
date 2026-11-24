using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.LogicalModels;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed partial class ModelUpgradeService
{
    private async Task<BsonDocument> RequiredAsync(IMongoCollection<BsonDocument> collection, string tenant, string id)
        => await collection.Find(Scope(tenant, F.Eq("_id", id))).FirstOrDefaultAsync(CancellationToken.None)
           ?? throw new ModelUpgradeException("CONFIG_CHANGED", "型号或 Provider 已变化，请重新检查候选；原线路未被替换。");
    private async Task<(BsonDocument Logical, BsonDocument Provider, BsonDocument Model)> CandidateAsync(ModelUpgradeState s)
    {
        var c = s.Candidate ?? throw new ModelUpgradeException("CANDIDATE_REQUIRED", "请先检查候选。");
        var logical = await LogicalAsync(s.TenantId, s.LogicalModelId);
        var provider = await RequiredAsync(Providers, s.TenantId, c.ProviderId);
        var model = await RequiredAsync(Models, s.TenantId, c.ModelId);
        if (!ModelUpgradeRules.IsStable(logical) || !logical.GetValue("Enabled", false).ToBoolean()
            || !provider.GetValue("Enabled", false).ToBoolean() || !model.GetValue("Enabled", false).ToBoolean()
            || model.GetStringOrEmpty("PlatformId") != c.ProviderId || model.GetStringOrEmpty("ModelName") != c.UpstreamModelId
            || ModelUpgradeRules.Fingerprint(logical, provider, model) != c.Fingerprint)
            throw new ModelUpgradeException("CANDIDATE_CHANGED", "候选配置或稳定模型状态已改变，请重新检查并验收。");
        ModelUpgradeDiscovery.RequireOfficial(provider);
        return (logical, provider, model);
    }
    private async Task CheckAsync(ModelUpgradeState s, CancellationToken ct)
    {
        var logical = await LogicalAsync(s.TenantId, s.LogicalModelId);
        if (!ModelUpgradeRules.IsStable(logical)) throw new ModelUpgradeException("FIXED_MODEL", "固定版本不参与升级。");
        s.Current = await CurrentAsync(s.TenantId, s.LogicalModelId)
            ?? throw new ModelUpgradeException("CURRENT_REQUIRED", "稳定模型没有启用的物理线路，请先配置当前线路。");
        s.LastCheckedAt = DateTime.UtcNow;
        var directories = new Dictionary<string, Dictionary<string, long?>>(StringComparer.Ordinal);
        s.Discoveries = [];
        var configured = await Providers.Find(Scope(s.TenantId, F.Eq("Enabled", true))).Limit(100).ToListAsync(ct);
        foreach (var p in configured)
        {
            try { ModelUpgradeDiscovery.RequireOfficial(p); } catch (ModelUpgradeException) { continue; }
            var providerId = p.GetStringOrEmpty("_id");
            await RenewLeaseAsync(s);
            Dictionary<string, long?> found;
            try { found = await discovery.DiscoverAsync(s, p, ct); }
            catch (ModelUpgradeException e)
            {
                if (e.Code == "DISCOVERY_AUDIT_FAILED") throw;
                s.Discoveries.Add(new ModelUpgradeDiscoveryItem { ProviderId = providerId, Status = "blocked", Message = e.Message });
                continue;
            }
            directories[providerId] = found;
            var imported = await Models.Find(Scope(s.TenantId, F.Eq("PlatformId", providerId))).Project(new BsonDocument("ModelName", 1)).ToListAsync(ct);
            var existing = imported.Select(x => x.GetStringOrEmpty("ModelName")).ToHashSet(StringComparer.Ordinal);
            s.Discoveries.AddRange(found.Keys.Where(x => !existing.Contains(x)).OrderBy(x => x, StringComparer.Ordinal).Take(100)
                .Select(x => new ModelUpgradeDiscoveryItem { ProviderId = providerId, UpstreamModelId = x }));
        }
        s.Discoveries = s.Discoveries.Take(100).ToList();
        var relation = s.Policy.Family is { } family
            ? FamilySuccessor(s.Current, family, directories, logical)
            : s.Policy.Successors.SingleOrDefault(x => x.FromModel == s.Current.UpstreamModelId)
            ?? throw new ModelUpgradeException("SUCCESSOR_REQUIRED", "已检查官方目录；当前型号没有明确继任关系。新发现仅待确认，不会按名称猜测或自动切换。");
        var provider = await RequiredAsync(Providers, s.TenantId, relation.ProviderId);
        var names = directories.GetValueOrDefault(relation.ProviderId)
            ?? throw new ModelUpgradeException("DISCOVERY_UNAVAILABLE", "候选 Provider 的目录发现未完成，请核对启用状态、密钥权限和发现诊断后重试。");
        if (!names.ContainsKey(relation.ToModel)) throw new ModelUpgradeException("CANDIDATE_NOT_DISCOVERED", "官方模型目录尚未发现明确候选，保留当前型号；缺失不代表官方退役。");
        var models = await Models.Find(Scope(s.TenantId, F.And(F.Eq("PlatformId", relation.ProviderId), F.Eq("ModelName", relation.ToModel), F.Eq("Enabled", true)))).Limit(2).ToListAsync(ct);
        if (models.Count != 1) throw new ModelUpgradeException("CANDIDATE_IMPORT_REQUIRED", "请在该官方 Provider 导入并启用唯一候选型号，然后重新检查；不会自动发布未经授权的模型。");
        var model = models[0];
        var fingerprint = ModelUpgradeRules.Fingerprint(logical, provider, model);
        var previous = s.Candidate;
        if (previous?.Fingerprint != fingerprint) s.ValidationStatus = "not-run";
        s.Candidate = new ModelUpgradeCandidate { ModelId = model.GetStringOrEmpty("_id"), ProviderId = relation.ProviderId,
            UpstreamModelId = relation.ToModel, DocumentationUrl = relation.DocumentationUrl, DiscoveredAt = DateTime.UtcNow, Fingerprint = fingerprint,
            ValidatedAt = previous?.Fingerprint == fingerprint ? previous.ValidatedAt : null,
            ValidationRequestId = previous?.Fingerprint == fingerprint ? previous.ValidationRequestId : null,
            ValidationRoute = previous?.Fingerprint == fingerprint ? previous.ValidationRoute : null,
            BusinessSmokeSamples = previous?.Fingerprint == fingerprint ? previous.BusinessSmokeSamples : null,
            BusinessSmokeRejected = previous?.Fingerprint == fingerprint && previous.BusinessSmokeRejected,
            TrafficTrialPassedAt = previous?.Fingerprint == fingerprint ? previous.TrafficTrialPassedAt : null };
        if (s.Candidate.ValidatedAt is not null)
        {
            try { await ReadValidatedRouteAsync(s, logical, provider, model); }
            catch (ModelUpgradeException) { s.Candidate.ValidatedAt = null; s.Candidate.ValidationRoute = null; s.Candidate.TrafficTrialPassedAt = null; s.ValidationStatus = "not-run"; }
        }
        var currentModel = await RequiredAsync(Models, s.TenantId, s.Current.ModelId);
        var priorBudgetGranted = s.Candidate.ValidatedAt > DateTime.UtcNow.AddHours(-24) && s.Gates.Budget;
        s.Gates = new ModelUpgradeGates { Capabilities = ModelUpgradeRules.CandidateCapabilitiesPass(logical, relation, model),
            Price = ModelUpgradeRules.PricePass(currentModel, model, logical.GetStringOrEmpty("ModelType"), s.Policy.MaxPriceIncreasePercent),
            Budget = priorBudgetGranted || ModelUpgradeRules.BudgetPass(s, s.Policy.CanaryUnitCostUpperBoundUsd, DateTime.UtcNow),
            Validation = s.Candidate.ValidatedAt > DateTime.UtcNow.AddHours(-24) };
        s.LastCheckedAt = DateTime.UtcNow;
        s.Phase = !s.Gates.Capabilities ? "blocked" : s.Gates.Validation ? "validated" : "candidate";
        s.Message = s.Gates.Capabilities ? "已发现明确候选，等待真实服务验收；价格未知会阻止自动晋级。" : "候选能力声明不足，请核对能力，原线路保持不变。";
        s.PendingAction = ModelUpgradeRules.NextAutomaticAction(s, DateTime.UtcNow);
        if (s.PendingAction == "validate") { s.ValidationMode = "canary"; s.EvidenceRequestId = null; }
        if (s.PendingAction == "promote") s.Message = "现有候选验收仍有效，已排队晋级，不会再次发起付费验收。";
        else if (s.Candidate.BusinessSmokeRejected) s.Message = "该候选已暂停。请查看最近的验证、灰度或回滚记录。";
        else if (ModelUpgradeRules.RequiresTapdSmoke(s.Policy)) s.Message = $"TAPD 草稿观察已记录 {(s.Candidate.BusinessSmokeSamples?.Count ?? 0)} 次通过，晋级需要覆盖 48 小时。";
    }

    private static ModelSuccessor FamilySuccessor(ModelUpgradeTarget current, ModelUpgradeFamily family,
        IReadOnlyDictionary<string, Dictionary<string, long?>> directories, BsonDocument logical)
    {
        if (!directories.TryGetValue(family.ProviderId, out var catalog))
            throw new ModelUpgradeException("DISCOVERY_UNAVAILABLE", "系列上游目录不可用，请查看发现诊断。");
        var latest = ModelUpgradeRules.LatestFamilyCandidate(family, current, catalog)
            ?? throw new ModelUpgradeException("NEWER_FAMILY_MODEL_UNCONFIRMED", "目录尚未提供比当前版本更新且时间可核实的唯一同系列候选，继续使用当前版本。");
        return new ModelSuccessor { ProviderId = family.ProviderId, FromModel = current.UpstreamModelId,
            ToModel = latest, DocumentationUrl = family.DocumentationUrl, Capabilities = ModelUpgradeRules.Strings(logical, "Capabilities") };
    }

    private async Task RequireImageSmokeAsync(ModelUpgradeState state, BsonDocument logical)
    {
        if (logical.GetStringOrEmpty("ModelType") != "generation" || state.Candidate?.ValidationRoute is not { } route) return;
        var capabilities = LogicalModelCapabilityPolicy.Normalize("generation", ModelUpgradeRules.Strings(logical, "Capabilities"));
        foreach (var (capability, caller, referenceRequired) in new[]
        {
            ("text2img", "visual-agent.image.text2img::generation", false),
            ("img2img", "visual-agent.image.img2img::generation", true),
        })
        {
            if (!capabilities.Contains(capability)) continue;
            var logs = await Logs.Find(Scope(state.TenantId, F.And(F.Eq("AppCallerCode", caller),
                F.Eq("OfferingId", route.OfferingId), F.Eq("Status", "succeeded"), F.Gte("EndedAt", DateTime.UtcNow.AddHours(-24)))))
                .Sort(Builders<BsonDocument>.Sort.Descending("EndedAt")).Limit(30).ToListAsync(CancellationToken.None);
            if (!logs.Any(log => ImageSmokePasses(log, state.TenantId, state.Candidate, route, referenceRequired)))
                throw new ModelUpgradeException("IMAGE_SMOKE_REQUIRED", referenceRequired
                    ? "候选缺少近期真实图生图证据。请用参考图生成一张可用图片后再切换。"
                    : "候选缺少近期真实文生图证据。请通过文生图入口生成一张可用图片后再切换。");
        }
    }

    internal static bool ImageSmokePasses(BsonDocument log, string tenantId, ModelUpgradeCandidate candidate,
        ModelUpgradeRouteSnapshot route, bool referenceRequired)
        => ModelUpgradeRules.EvidencePasses(log, tenantId, candidate, "generation")
           && log.GetStringOrEmpty("OfferingId") == route.OfferingId
           && string.Equals(log.GetStringOrEmpty("Protocol"), route.Protocol, StringComparison.OrdinalIgnoreCase)
           && log.GetValue("OutputImages", BsonNull.Value) is BsonArray { Count: > 0 }
           && (referenceRequired == (log.GetValue("ImageReferences", BsonNull.Value) is BsonArray { Count: > 0 }));

    private async Task ValidateAsync(ModelUpgradeState s)
    {
        var (logical, provider, model) = await CandidateAsync(s);
        if (!s.Gates.Capabilities) throw new ModelUpgradeException("CAPABILITIES_REQUIRED", "候选能力尚未满足，请重新检查。");
        if (s.ValidationMode == "evidence")
        {
            if (ModelUpgradeRules.RequiresTapdSmoke(s.Policy))
                throw new ModelUpgradeException("BUSINESS_SMOKE_REQUIRED", "单条成功日志不能替代 TAPD 草稿专项冒烟。");
            var evidence = await Logs.Find(Scope(s.TenantId, F.Eq("RequestId", s.EvidenceRequestId ?? ""))).Sort(Builders<BsonDocument>.Sort.Descending("EndedAt")).Limit(20).ToListAsync(CancellationToken.None);
            var matching = evidence.Where(x => ModelUpgradeRules.EvidencePasses(x, s.TenantId, s.Candidate!, logical.GetStringOrEmpty("ModelType"))).ToList();
            if (matching.Count == 0)
                throw new ModelUpgradeException("SERVICE_EVIDENCE_REQUIRED", "该请求没有匹配候选、组织和近期成功输出的真实日志；HTTP 响应或模型登记不能代替服务验收。");
            await CaptureEvidenceWireAsync(s, logical, provider, model, matching);
            CompleteValidation(s, s.EvidenceRequestId!);
            return;
        }
        if (s.TenantId != internalTenantId) throw new ModelUpgradeException("CANARY_INTERNAL_ONLY", "受预算后台验收目前仅支持内部组织，请使用真实请求证据。");
        var estimate = s.Policy.CanaryUnitCostUpperBoundUsd;
        if (estimate is not > 0 || model.AsNullableDecimal("PricePerCall") > estimate || !ModelUpgradeRules.HasKnownPrice(model)
            || !ModelUpgradeRules.BudgetPass(s, estimate, DateTime.UtcNow))
            throw new ModelUpgradeException("CANARY_BUDGET_REQUIRED", "候选缺少近期美元价格或独立验收上界/预算不足；请补全价格与预算，或使用已有真实请求证据。");
        if (logical.GetStringOrEmpty("ModelType") == "generation" && !ModelUpgradeRules.HasCanaryEnvelope(s.Candidate!.UpstreamModelId, estimate.Value,
                model.AsNullableDecimal("InputPricePerMillion") ?? 0, model.AsNullableDecimal("OutputPricePerMillion") ?? 0))
            throw new ModelUpgradeException("CANARY_SPEC_REQUIRED", "该图片型号尚未登记安全验收规格，或费用上界低于已知规格；请先核对规格与预算，或使用已有真实请求证据。");
        if (string.IsNullOrWhiteSpace(s.Policy.ValidationAppCallerCode)) throw new ModelUpgradeException("CALLER_REQUIRED", "请先配置已有授权调用用途。");
        var routes = await Offerings.Find(Scope(s.TenantId, F.And(F.Eq("TargetKind", "model"), F.Eq("TargetId", s.Candidate!.ModelId), F.Eq("Enabled", true), F.Exists("SupersededByOfferingId", false)))).ToListAsync(CancellationToken.None);
        BsonDocument? candidateLogical = null; BsonDocument? candidateRoute = null;
        foreach (var route in routes)
        {
            var l = await Logicals.Find(Scope(s.TenantId, F.And(F.Eq("_id", route.GetStringOrEmpty("LogicalModelId")), F.Eq("Enabled", true)))).FirstOrDefaultAsync(CancellationToken.None);
            if (l is not null && ModelUpgradeRules.IsFixedValidationTarget(l, logical.GetStringOrEmpty("ModelType"))) { candidateLogical = l; candidateRoute = route; break; }
        }
        if (candidateLogical is null || candidateRoute is null) throw new ModelUpgradeException("CANDIDATE_ROUTE_REQUIRED", "请先通过正常模型管理为候选登记可验收线路与用途授权，再发起验收。");
        s.Candidate!.ValidationRoute = ModelUpgradeWire.Capture(candidateRoute, model, provider);
        var now = DateTime.UtcNow;
        var requestId = "model-upgrade-" + Guid.NewGuid().ToString("N");
        s.Candidate!.ValidationRequestId = requestId;
        if (s.BudgetDate != now.ToString("yyyy-MM-dd")) { s.ReservedCostUsd = 0; s.BudgetDate = now.ToString("yyyy-MM-dd"); }
        // Reserve before publishing; a crash cannot issue an unreserved paid request.
        s.ReservedCostUsd += estimate.Value;
        s.PendingAction = "await-validation"; s.Phase = "validating"; s.ValidationStatus = "pending";
        s.Message = "受预算验收已登记，等待授权任务通道执行一次；结果未知时不会重发。";
        await PersistAsync(s);
        var job = new BsonDocument { { "_id", requestId }, { "RequestId", requestId }, { "TenantId", s.TenantId },
            { "LogicalModelId", s.LogicalModelId }, { "PolicyId", s.Id }, { "PolicyVersion", s.Version },
            { "ProviderId", s.Candidate.ProviderId }, { "ModelId", s.Candidate.ModelId }, { "UpstreamModelId", s.Candidate.UpstreamModelId },
            { "ModelType", logical.GetStringOrEmpty("ModelType") }, { "Capabilities", new BsonArray(ModelUpgradeRules.Strings(logical, "Capabilities")) },
            { "ActorConsoleUserId", s.ActorConsoleUserId }, { "ActorUserId", s.ActorUserId }, { "ActorUsername", s.ActorUsername },
            { "AppCallerCode", s.Policy.ValidationAppCallerCode }, { "MaxCostUsd", new Decimal128(s.Policy.MaxValidationCostUsd!.Value) },
            { "MaxDailyCostUsd", new Decimal128(s.Policy.MaxDailyCostUsd!.Value) }, { "EstimatedCostUsd", new Decimal128(estimate.Value) },
            { "CandidateFingerprint", s.Candidate.Fingerprint }, { "CandidateLogicalModelPublicId", candidateLogical.GetStringOrEmpty("PublicId") },
            { "CandidateOfferingId", s.Candidate.ValidationRoute.OfferingId }, { "OfferingVersion", s.Candidate.ValidationRoute.OfferingVersion },
            { "EndpointPath", (BsonValue?)s.Candidate.ValidationRoute.EndpointPath ?? BsonNull.Value }, { "Protocol", s.Candidate.ValidationRoute.Protocol },
            { "Provider", provider.GetStringOrEmpty("Name") }, { "UnitCostUpperBoundUsd", new Decimal128(estimate.Value) }, { "PricingBasis", model.AsNullableDecimal("PricePerCall") is not null ? "per-call" : "token" },
            { "PriceVersion", model.AsNullableUtcDateTime("UpdatedAt")?.ToString("O") ?? "" }, { "ExecutionRequestedBy", s.ExecutionRequestedBy },
            { "Status", "pending" }, { "CreatedAt", now }, { "UpdatedAt", now }, { "ExpiresAt", now.AddMinutes(10) } };
        if (ModelUpgradeRules.RequiresTapdSmoke(s.Policy))
        {
            var previousSample = s.Candidate.BusinessSmokeSamples?.LastOrDefault(sample => sample.OfferingVersion == s.Candidate.ValidationRoute.OfferingVersion);
            job["TapdSmokeScenario"] = previousSample is null ? 0 : (previousSample.Scenario + 1) % 3;
        }
        try { await ValidationRuns.InsertOneAsync(job, cancellationToken: CancellationToken.None); }
        catch
        {
            s.OutcomeUnknown = true; s.ValidationStatus = "unknown";
            throw new ModelUpgradeException("CANARY_PUBLISH_UNKNOWN", "验收登记结果未确定，已保留请求 ID 和预算；禁止重发，请核对该请求日志与任务记录。");
        }
    }
    private static void CompleteValidation(ModelUpgradeState s, string requestId)
    {
        s.Candidate!.ValidatedAt = DateTime.UtcNow; s.Candidate.ValidationRequestId = requestId;
        s.Gates.Validation = true; s.ValidationStatus = "passed"; s.OutcomeUnknown = false; s.Phase = "validated";
        s.Message = s.Gates.Price ? "候选已有匹配的真实成功输出，可按策略晋级。" : "真实服务验收通过；价格未知或涨幅未通过，只允许管理员明确手动晋级。";
        if (ModelUpgradeRules.RequiresTapdSmoke(s.Policy) && !ModelUpgradeRules.TapdSmokePasses(s.Candidate, DateTime.UtcNow))
            s.Message = $"本次 TAPD 草稿冒烟通过。已记录 {(s.Candidate.BusinessSmokeSamples?.Count ?? 0)} 次通过，继续观察至覆盖 48 小时。";
        s.PendingAction = ModelUpgradeRules.NextAutomaticAction(s, DateTime.UtcNow);
    }
    private async Task<bool> ExpireUnsentValidationAsync(ModelUpgradeState s, BsonDocument job, DateTime now)
    {
        if (s.TenantId != internalTenantId || job.GetStringOrEmpty("PolicyId") != s.Id) return false;
        var id = job.GetStringOrEmpty("_id");
        var audit = await AuditBeginAsync(s, "validate.expire-unused");
        if (!(job.GetStringOrEmpty("Status") == "failed" && (job.GetValue("ExpiredUnsent", false) == true || job.GetValue("UnsentConfirmed", false) == true)))
        {
            var cancelled = await ValidationRuns.UpdateOneAsync(Scope(s.TenantId, F.And(F.Eq("_id", id), F.Eq("PolicyId", s.Id),
                    F.Eq("Status", "pending"), F.Lt("ExpiresAt", now))), Builders<BsonDocument>.Update
                .Set("Status", "failed").Set("ExpiredUnsent", true).Set("UnsentConfirmed", true).Set("Message", "排队已过期，已确认未发送；可重新验收。")
                .Set("UpdatedAt", now).Set("ExpiryAuditId", audit), cancellationToken: CancellationToken.None);
            if (cancelled.ModifiedCount != 1) { await AuditCompleteAsync(s, audit, false); return false; }
        }
        // Persist the refund and a request-scoped marker in the same state CAS; recovery cannot refund twice.
        if (!s.History.Any(x => x.Action == "validate.expire-unused" && x.Status == "succeeded" && x.RequestId == id))
        {
            var amount = job.AsNullableDecimal("EstimatedCostUsd");
            if (s.BudgetDate == now.ToString("yyyy-MM-dd") && job.AsNullableUtcDateTime("CreatedAt")?.ToString("yyyy-MM-dd") == s.BudgetDate && amount is > 0)
                s.ReservedCostUsd = Math.Max(0, s.ReservedCostUsd - amount.Value);
            History(s, "validate.expire-unused", "succeeded", "已确认排队过期且未发送；对应当日内部预占已释放，可重新验收。", id);
        }
        s.OutcomeUnknown = false; s.ValidationStatus = "not-run"; s.Gates.Validation = false; s.Candidate!.ValidatedAt = null;
        await PersistAsync(s);
        await AuditCompleteAsync(s, audit, true);
        return true;
    }
    private async Task PollValidationAsync(ModelUpgradeState s)
    {
        var id = s.Candidate?.ValidationRequestId ?? "";
        var previouslyUnknown = s.OutcomeUnknown;
        s.OutcomeUnknown = true; s.ValidationStatus = "unknown";
        // Reconcile the original job before loading mutable candidate configuration.
        var job = await ValidationRuns.Find(Scope(s.TenantId, F.Eq("_id", id))).FirstOrDefaultAsync(CancellationToken.None);
        var status = job?.GetStringOrEmpty("Status");
        if (job is not null && (status == "pending" && job.AsNullableUtcDateTime("ExpiresAt") < DateTime.UtcNow
            || status == "failed" && (job.GetValue("ExpiredUnsent", false) == true || job.GetValue("UnsentConfirmed", false) == true)))
        {
            if (await ExpireUnsentValidationAsync(s, job, DateTime.UtcNow))
                throw new ModelUpgradeException("CANARY_EXPIRED_UNSENT", "验收未发送；当日内部预占已释放，可修复配置后重新验收。原请求 ID 已保留供审计。");
            throw new ModelUpgradeException("CANARY_OUTCOME_UNKNOWN", "任务可能已被消费，未退还预算且禁止重发；请按原请求 ID 核对日志。");
        }
        var (logical, provider, model) = await CandidateAsync(s);
        if (logical.GetStringOrEmpty("ModelType") == "generation" && job?.GetStringOrEmpty("FailureKind") == "invalid_output")
            throw new ModelUpgradeException("CANARY_FAILED", "候选未生成可解码图片，保留当前型号。");
        var logs = await Logs.Find(Scope(s.TenantId, F.Eq("RequestId", id))).Limit(20).ToListAsync(CancellationToken.None);
        var tapdSmoke = ModelUpgradeRules.RequiresTapdSmoke(s.Policy);
        var matchingLog = s.Candidate!.ValidationRoute is { } wire ? logs.FirstOrDefault(x => ModelUpgradeRules.EvidencePasses(x, s.TenantId, s.Candidate, logical.GetStringOrEmpty("ModelType")) && ModelUpgradeWire.LogMatches(wire, x)) : null;
        if (tapdSmoke && job?.GetValue("TapdSmokePassed", BsonNull.Value) == BsonBoolean.False && matchingLog is not null)
        {
            s.Candidate.BusinessSmokeRejected = true;
            s.Gates.Validation = false;
            s.OutcomeUnknown = false;
            throw new ModelUpgradeException("BUSINESS_SMOKE_FAILED", "TAPD 草稿未满足字段正确性检查，已暂停此候选；原线路继续服务。");
        }
        if (matchingLog is not null && (!tapdSmoke || status == "succeeded" && job!.GetValue("TapdSmokePassed", BsonNull.Value) == BsonBoolean.True
            && job.GetValue("TapdSmokeScenario", BsonNull.Value) is BsonInt32 { Value: >= 0 and < 3 }))
        {
            var route = await ReadValidatedRouteAsync(s, logical, provider, model);
            // The finite wire fingerprint excludes health counters, timestamps and priority.
            s.Candidate.ValidationRoute = ModelUpgradeWire.Capture(route, model, provider);
            if (tapdSmoke && s.Candidate.BusinessSmokeSamples?.Any(sample => sample.RequestId == id) != true)
            {
                var routeVersion = s.Candidate.ValidationRoute.OfferingVersion;
                var passedAt = matchingLog.AsNullableUtcDateTime("EndedAt")!.Value;
                s.Candidate.BusinessSmokeSamples = (s.Candidate.BusinessSmokeSamples ?? [])
                    .Where(sample => sample.OfferingVersion == routeVersion && sample.PassedAt >= passedAt.AddHours(-96)).TakeLast(11).ToList();
                s.Candidate.BusinessSmokeSamples.Add(new(id, routeVersion, job!["TapdSmokeScenario"].AsInt32, passedAt));
            }
            s.PendingAction = ""; CompleteValidation(s, id); return;
        }
        s.OutcomeUnknown = previouslyUnknown;
        s.ValidationStatus = previouslyUnknown ? "unknown" : "pending";
        if (status == "failed") throw new ModelUpgradeException("CANARY_FAILED", "受预算验收失败，原线路保持不变；请检查管理诊断后重新验收。");
        if (status == "unknown" || job is null || job.AsNullableUtcDateTime("ExpiresAt") < DateTime.UtcNow)
        { s.OutcomeUnknown = true; s.ValidationStatus = "unknown"; throw new ModelUpgradeException("CANARY_OUTCOME_UNKNOWN", "验收未取得确定结果，禁止自动重发；请按该请求 ID 核对真实日志后继续。"); }
        if (status == "succeeded") throw new ModelUpgradeException("OUTPUT_EVIDENCE_MISSING", "验收任务结束但尚无匹配成功输出，不能认定服务可用；请核对该请求日志。");
    }
}
