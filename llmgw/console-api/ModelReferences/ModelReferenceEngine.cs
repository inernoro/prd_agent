using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.LlmGw.ModelReferences;

public sealed class ModelReferenceEngine(IModelReferenceStore store, string internalTenantId,
    IRuntimeModelReferenceSnapshotProvider? runtimeSnapshots = null, IModelReferenceTargetValidator? targetValidator = null)
{
    public ModelReferenceEngine(MongoDB.Driver.IMongoDatabase gateway, MongoDB.Driver.IMongoDatabase map,
        string internalTenantId, IRuntimeModelReferenceSnapshotProvider? runtimeSnapshots = null,
        IModelReferenceTargetValidator? targetValidator = null)
        : this(new MongoModelReferenceStore(gateway, map, internalTenantId), internalTenantId, runtimeSnapshots, targetValidator) { }

    public async Task<ReferenceCoverage> InspectAsync(ReferenceMigrationMapping mapping, CancellationToken ct = default)
        => (await InspectCoreAsync(mapping, ct)).Coverage;
    public Task<ReferenceCoverage> FindDeleteBlockersAsync(ReferenceMigrationMapping mapping, CancellationToken ct = default)
        => InspectForDeleteAsync(mapping, ct);
    private async Task<ReferenceCoverage> InspectForDeleteAsync(ReferenceMigrationMapping mapping, CancellationToken ct)
        => (await InspectCoreAsync(mapping, ct, forDelete: true)).Coverage;
    private static void ValidateMapping(ReferenceMigrationMapping m)
    {
        var values = new[] { m.ModelType, m.ScopeConsumerKey, m.ScopeRecordId, m.ScopePath, m.TenantId, m.Source.LogicalId, m.Source.PublicId, m.Source.ProviderId, m.Source.PhysicalModelId,
            m.Source.UpstreamModelId, m.Source.OfferingId, m.Source.OfferingFingerprint, m.Target.LogicalId, m.Target.PublicId, m.Target.ProviderId,
            m.Target.PhysicalModelId, m.Target.UpstreamModelId, m.Target.OfferingId, m.Target.OfferingFingerprint }.Concat(m.Source.Aliases).Concat(m.Source.PoolIds).Concat(m.Target.Aliases).Concat(m.Target.PoolIds);
        var scopeParts = new[] { m.ScopeConsumerKey, m.ScopeRecordId, m.ScopePath }.Count(x => !string.IsNullOrEmpty(x));
        if (scopeParts is > 0 and < 3 || scopeParts == 3 && (string.IsNullOrWhiteSpace(m.ModelType)
            || !ModelReferenceRegistry.Collections.Any(x => x.Key == m.ScopeConsumerKey)))
            throw new ModelReferenceException("INVALID_REFERENCE_SCOPE", "孤立引用修复必须由服务端指定完整的用途、配置位置与模型类型。");
        if (string.IsNullOrWhiteSpace(m.TenantId) || values.Any(x => x is not null && (x.Length > 200 || x.Any(char.IsControl)))
            || !new[] { m.Source.LogicalId, m.Source.PublicId, m.Source.PhysicalModelId, m.Source.OfferingId }.Any(x => !string.IsNullOrWhiteSpace(x)))
            throw new ModelReferenceException("INVALID_REFERENCE_MAPPING", "请提供当前组织及明确的原模型身份；不能按名称相似程度迁移。");
    }
    private async Task<(ReferenceCoverage Coverage, List<ReferenceDocumentChange> Changes)> InspectCoreAsync(ReferenceMigrationMapping m, CancellationToken ct, bool forDelete = false)
    {
        ValidateMapping(m);
        m = await ExpandMappingAsync(m, ct);
        var coverage = new ReferenceCoverage(); var changes = new List<ReferenceDocumentChange>();
        foreach (var definition in ModelReferenceRegistry.Collections)
        {
            if (definition.Database == "map" && m.TenantId != internalTenantId) continue;
            try
            {
                var docs = await store.ReadAsync(definition, m.TenantId, ct);
                var paths = await store.SelectionPathsAsync(definition, m.TenantId, ct);
                if (forDelete && definition.Mode == "wire" && !string.IsNullOrEmpty(m.Source.LogicalId))
                    docs = docs.Where(d => d.GetValue("LogicalModelId", BsonNull.Value) != new BsonString(m.Source.LogicalId)).ToArray();
                var analyzed = ModelReferenceAnalysis.Analyze(definition, docs, paths, m);
                coverage.Consumers.Add(analyzed.Result); coverage.Items.AddRange(analyzed.Items); changes.AddRange(analyzed.Changes);
            }
            catch (OperationCanceledException) { throw; }
            catch
            {
                coverage.Consumers.Add(new() { Key = definition.Key, Unknown = 1, Reasons = ["无法完成此配置域的只读扫描，原引用未修改；恢复存储连接后重新检查。"] });
                coverage.Items.Add(new() { ConsumerKey = definition.Key, Collection = definition.Collection, Status = "unknown", Reason = "REFERENCE_SCAN_UNAVAILABLE" });
            }
        }
        if (m.TenantId == internalTenantId)
        {
            var result = new ReferenceConsumerResult { Key = "runtime.external-configurations" };
            try
            {
                var snapshot = runtimeSnapshots is null ? null : await runtimeSnapshots.ReadAsync(m, ct);
                if (snapshot is null || !snapshot.Complete)
                {
                    result.Unknown++; result.Reasons.Add("未能取得 MAP 实际部署与独立运行时的完整模型引用快照，请先完成只读核对或明确人工确认。");
                }
                if (snapshot is not null) foreach (var item in snapshot.Items)
                {
                    result.Count++;
                    var matches = MongoRuntimeModelReferenceSnapshotProvider.Matches(ModelReferenceAnalysis.SelectionIdentity(m), item);
                    if (!matches || MongoRuntimeModelReferenceSnapshotProvider.Matches(m.Target, item)) continue;
                    result.Affected++; result.Blocked++; result.Residual++;
                    coverage.Items.Add(new() { ConsumerKey = item.ConsumerKey, Collection = "runtime", Path = item.Path, Status = "blocked", Reason = "RUNTIME_REFERENCE_REQUIRES_AUTHORIZED_CONFIGURATION_UPDATE" });
                }
            }
            catch (OperationCanceledException) { throw; }
            catch { result.Unknown++; result.Reasons.Add("运行配置快照不可达，请恢复只读核对后重试；不能把不可达视为没有引用。"); }
            coverage.Consumers.Add(result);
        }
        return (coverage, changes);
    }
    public Task<ReferenceMigrationPlan> PlanAsync(ReferenceMigrationMapping mapping, string actorId, CancellationToken ct = default)
        => PlanAsync(mapping, actorId, Guid.NewGuid().ToString("N"), ct);
    private static string RequestId(string tenantId, string actorId, string clientRequestId)
    {
        if (!Guid.TryParse(clientRequestId, out var request)) throw new ModelReferenceException("INVALID_CLIENT_REQUEST_ID", "请提供本次操作的唯一请求标识；结果未知时请查询原请求，不要重复提交。");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(new BsonArray { tenantId, actorId, request.ToString("N") }.ToJson()))).ToLowerInvariant();
    }
    public Task<ReferenceMigrationPlan?> GetByRequestAsync(string tenantId, string actorId, string clientRequestId, CancellationToken ct = default)
        => store.ReadPlanAsync(RequestId(tenantId, actorId, clientRequestId), tenantId, ct);
    public Task<ReferenceMigrationPlan> GetAsync(string intentId, string tenantId, CancellationToken ct = default)
        => RequiredPlanAsync(intentId, tenantId, ct);
    private static bool SameMapping(ReferenceMigrationMapping left, ReferenceMigrationMapping right)
        => left.ToBsonDocument().Equals(right.ToBsonDocument());
    public async Task<ReferenceMigrationPlan> PlanAsync(ReferenceMigrationMapping mapping, string actorId, string clientRequestId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(actorId)) throw new ModelReferenceException("ACTOR_REQUIRED", "请使用当前已授权管理员身份建立迁移计划。");
        mapping = await ExpandMappingAsync(mapping, ct);
        var id = RequestId(mapping.TenantId, actorId, clientRequestId);
        var existing = await store.ReadPlanAsync(id, mapping.TenantId, ct);
        if (existing is not null)
        {
            if (!SameMapping(existing.Mapping, mapping)) throw new ModelReferenceException("REFERENCE_REQUEST_MAPPING_CHANGED", "同一请求标识不能用于另一组模型迁移，请核对原计划。");
            return existing;
        }
        var (coverage, changes) = await InspectCoreAsync(mapping, ct);
        var plan = new ReferenceMigrationPlan { Id = id, TenantId = mapping.TenantId, ActorId = actorId, ClientRequestId = clientRequestId, Mapping = mapping, Coverage = coverage, Changes = changes, AffectedFindings = coverage.Items.Where(x => x.Status == "affected").ToList() };
        await ValidateTargetAsync(plan, ct);
        if (!plan.Coverage.CanComplete) plan.Status = "blocked";
        // The required durable journal is created before any business configuration writes.
        try { await store.InsertPlanAsync(plan, ct); }
        catch
        {
            var raced = await store.ReadPlanAsync(id, mapping.TenantId, CancellationToken.None);
            if (raced is null) throw;
            if (!SameMapping(raced.Mapping, mapping)) throw new ModelReferenceException("REFERENCE_REQUEST_MAPPING_CHANGED", "原请求已有不同迁移计划，请核对原计划后继续。");
            return raced;
        }
        return plan;
    }
    private async Task ValidateTargetAsync(ReferenceMigrationPlan plan, CancellationToken ct)
    {
        try
        {
            IReadOnlyList<string> reasons = targetValidator is null ? new[] { "未接入目标模型的组织、调用用途与能力校验，本次不会迁移配置。" }
                : await targetValidator.ValidateFindingsAsync(plan.Mapping, plan.AffectedFindings, ct);
            if (reasons.Count > 0) plan.Coverage.Consumers.Add(new() { Key = "target.authorization-capabilities", Blocked = reasons.Count, Reasons = reasons.ToList() });
        }
        catch (OperationCanceledException) { throw; }
        catch { plan.Coverage.Consumers.Add(new() { Key = "target.authorization-capabilities", Unknown = 1, Reasons = ["无法重新核对目标模型的授权与能力，验证结果已失效；恢复目录连接后重试核对原计划。"] }); }
    }

    private async Task SaveAsync(ReferenceMigrationPlan plan, CancellationToken ct)
    {
        var revision = plan.Revision;
        plan.Revision++; plan.UpdatedAt = DateTime.UtcNow;
        if (!await store.SavePlanAsync(plan, revision, ct)) throw new ModelReferenceException("REFERENCE_JOURNAL_CONFLICT", "迁移执行权已变化，请刷新原计划继续核对；不要重新创建并重复改写配置。");
    }
    private async Task<ReferenceMigrationPlan> RequiredPlanAsync(string intentId, string tenantId, CancellationToken ct)
        => await store.ReadPlanAsync(intentId, tenantId, ct) ?? throw new ModelReferenceException("REFERENCE_PLAN_NOT_FOUND", "迁移计划不存在或不属于当前组织。");
    public async Task<ReferenceMigrationPlan> ApplyAsync(string intentId, string tenantId, long expectedRevision, CancellationToken ct = default)
    {
        var plan = await RequiredPlanAsync(intentId, tenantId, ct);
        if (plan.Revision != expectedRevision || plan.LeaseUntil > DateTime.UtcNow)
            throw new ModelReferenceException("REFERENCE_PLAN_BUSY", "计划已变化或正在执行，请刷新后从同一计划继续。");
        if (plan.Coverage.RegistryHash != ModelReferenceRegistry.Hash) throw new ModelReferenceException("REFERENCE_REGISTRY_CHANGED", "引用注册表已更新，请重新生成完整检查计划。");
        if (plan.Status == "completed") return plan;
        var current = await InspectCoreAsync(plan.Mapping, ct);
        plan.Coverage = current.Coverage;
        await ValidateTargetAsync(plan, ct);
        if (!plan.Coverage.CanComplete) { plan.Status = "blocked"; await SaveAsync(plan, ct); return plan; }
        // A newly saved old reference must be planned explicitly, not silently appended to an approved intent.
        var originalPaths = plan.Changes.SelectMany(d => d.Fields.Select(f => $"{d.Database}/{d.Collection}/{d.RecordId}/{f.Path}")).ToHashSet(StringComparer.Ordinal);
        if (current.Changes.Any(d => d.Fields.Any(f => !originalPaths.Contains($"{d.Database}/{d.Collection}/{d.RecordId}/{f.Path}"))))
        {
            plan.Status = "conflict";
            plan.Coverage.Consumers.Add(new() { Key = "concurrency.new-reference", Blocked = 1, Reasons = ["生成计划后新增了原模型引用，请重新检查并明确更新计划。"] });
            await SaveAsync(plan, ct); return plan;
        }
        plan.LeaseToken = Guid.NewGuid().ToString("N"); plan.LeaseUntil = DateTime.UtcNow.AddMinutes(3); plan.Status = "applying";
        await SaveAsync(plan, ct);
        try
        {
            foreach (var change in plan.Changes)
            {
                if (change.Status == "applied") continue;
                if (await store.IsAppliedAsync(change, tenantId, ct)) change.Status = "applied";
                else if (await store.CompareAndSwapAsync(change, tenantId, ct)) change.Status = "applied";
                else
                {
                    change.Status = "conflict"; plan.Status = "conflict";
                    plan.Coverage.Consumers.Add(new() { Key = change.ConsumerKey + ".concurrency", Blocked = 1, Reasons = ["配置在检查后已被编辑，本次没有覆盖其修改；请从同一计划核对冲突。"] });
                    await SaveAsync(plan, ct); return plan;
                }
                plan.LeaseUntil = DateTime.UtcNow.AddMinutes(3);
                await SaveAsync(plan, ct);
            }
            plan.Coverage = await InspectAsync(plan.Mapping, ct);
            await ValidateTargetAsync(plan, ct);
            await AddGlobalScopeGateAsync(plan, ct);
            plan.Coverage.Migrated = plan.Changes.Count(x => x.Status == "applied");
            foreach (var result in plan.Coverage.Consumers) result.Migrated = plan.Changes.Count(x => x.ConsumerKey == result.Key && x.Status == "applied");
            MarkVerified(plan.Coverage);
            plan.Status = plan.Coverage.Verified ? "completed" : "blocked";
            return plan;
        }
        catch
        {
            plan.Status = "blocked";
            plan.Coverage = new ReferenceCoverage { Consumers = [new() { Key = "apply.reconciliation-required", Unknown = 1,
                Reasons = ["本次配置写入或确认未完成，不能判断为全量成功；请查询同一计划并核对已记录的配置结果，系统不会覆盖并发修改。"] }] };
            throw;
        }
        finally
        {
            plan.LeaseToken = null; plan.LeaseUntil = null;
            await SaveAsync(plan, CancellationToken.None);
        }
    }
    private async Task AddGlobalScopeGateAsync(ReferenceMigrationPlan plan, CancellationToken ct)
    {
        if (plan.Mapping.ScopeConsumerKey is null) return;
        var global = BsonSerializer.Deserialize<ReferenceMigrationMapping>(plan.Mapping.ToBson());
        global.ScopeConsumerKey = null; global.ScopeRecordId = null; global.ScopePath = null;
        var remaining = await InspectAsync(global, ct);
        if (remaining.Residual > 0 || remaining.Unknown > 0 || remaining.Blocked > 0)
        {
            plan.Coverage.Consumers.Add(new() { Key = "scope.global-old-identity", Count = remaining.Consumers.Sum(x => x.Count),
                Affected = remaining.Affected, Residual = remaining.Residual, Unknown = remaining.Unknown,
                Blocked = remaining.Blocked + (remaining.Residual > 0 ? 1 : 0),
                Reasons = ["当前位置的迁移已单独核对，但其他使用处仍有原模型引用或未完成的核对；尚不能宣称全量升级完成，请继续处理所列配置。"] });
            plan.Coverage.Items.AddRange(remaining.Items.Where(x => x.Status is "affected" or "blocked" or "unknown"));
        }
    }
    private static void MarkVerified(ReferenceCoverage coverage)
    {
        coverage.Verified = coverage.CanComplete && coverage.Residual == 0;
        coverage.VerifiedAt = coverage.Verified ? DateTime.UtcNow : null;
        coverage.ValidUntil = coverage.VerifiedAt?.AddMinutes(10);
    }
    private async Task<ReferenceMigrationMapping> ExpandMappingAsync(ReferenceMigrationMapping mapping, CancellationToken ct)
    {
        ValidateMapping(mapping);
        var m = BsonSerializer.Deserialize<ReferenceMigrationMapping>(mapping.ToBson());
        var definition = ModelReferenceRegistry.Collections.Single(x => x.Mode == "roles");
        var rows = await store.ReadAsync(definition, m.TenantId, ct);
        foreach (var identity in new[] { m.Source, m.Target })
        {
            if (string.IsNullOrEmpty(identity.LogicalId)) continue;
            var logical = rows.SingleOrDefault(d => d.GetValue("_id", BsonNull.Value) == new BsonString(identity.LogicalId));
            if (logical is null) continue;
            var publicId = logical.GetValue("PublicId", BsonNull.Value);
            if (publicId.IsString)
            {
                if (!string.IsNullOrEmpty(identity.PublicId) && !string.Equals(identity.PublicId.Trim(), publicId.AsString.Trim(), StringComparison.OrdinalIgnoreCase))
                    throw new ModelReferenceException("REFERENCE_IDENTITY_CHANGED", "逻辑模型与公开名称不一致，请刷新模型目录后重新检查。");
                identity.PublicId = publicId.AsString;
            }
            foreach (var (field, list) in new[] { ("Aliases", identity.Aliases), ("MigratedFromPoolIds", identity.PoolIds) })
            {
                if (logical.GetValue(field, BsonNull.Value) is BsonArray array)
                    foreach (var value in array.Where(x => x.IsString)) if (!list.Contains(value.AsString, StringComparer.Ordinal)) list.Add(value.AsString);
            }
            identity.Aliases = identity.Aliases.OrderBy(x => x, StringComparer.Ordinal).ToList();
            identity.PoolIds = identity.PoolIds.OrderBy(x => x, StringComparer.Ordinal).ToList();
        }
        return m;
    }
    public async Task<ReferenceMigrationPlan> VerifyPlanAsync(string intentId, string tenantId, long expectedRevision, CancellationToken ct = default)
    {
        var plan = await RequiredPlanAsync(intentId, tenantId, ct);
        if (plan.Revision != expectedRevision || plan.LeaseUntil > DateTime.UtcNow || plan.Status == "applying")
            throw new ModelReferenceException("REFERENCE_PLAN_BUSY", "计划正在执行或已变化，请等待原计划完成并刷新后核对。");
        if (plan.Coverage.RegistryHash != ModelReferenceRegistry.Hash)
        {
            plan.Coverage.Verified = false; plan.Coverage.VerifiedAt = null; plan.Coverage.ValidUntil = null;
            plan.Coverage.Consumers.RemoveAll(x => x.Key == "registry.changed");
            plan.Coverage.Consumers.Add(new() { Key = "registry.changed", Unknown = 1, Reasons = ["模型使用位置注册表已更新，旧证明已失效，请重新建立完整计划；旧计划不会按新规则直接执行。"] });
            plan.Status = "blocked";
            // Retain the original registry hash, so Apply cannot reuse old approved changes with a new schema.
            await SaveAsync(plan, CancellationToken.None);
            return plan;
        }
        try
        {
            plan.Coverage = await InspectAsync(plan.Mapping, ct);
            await ValidateTargetAsync(plan, ct);
            await AddGlobalScopeGateAsync(plan, ct);
        }
        catch
        {
            plan.Coverage = new ReferenceCoverage { Consumers = [new() { Key = "verification.unavailable", Unknown = 1, Reasons = ["本次全量复核未能完成，旧验证结果已失效；请恢复连接后核对原计划。"] }] };
        }
        plan.Coverage.Migrated = plan.Changes.Count(x => x.Status == "applied");
        foreach (var result in plan.Coverage.Consumers) result.Migrated = plan.Changes.Count(x => x.ConsumerKey == result.Key && x.Status == "applied");
        MarkVerified(plan.Coverage);
        plan.Status = plan.Coverage.Verified ? "completed" : "blocked";
        await SaveAsync(plan, CancellationToken.None);
        return plan;
    }
    public async Task<ReferenceCoverage> VerifyAsync(string intentId, string tenantId, CancellationToken ct = default)
    {
        var plan = await RequiredPlanAsync(intentId, tenantId, ct);
        return (await VerifyPlanAsync(intentId, tenantId, plan.Revision, ct)).Coverage;
    }
}
