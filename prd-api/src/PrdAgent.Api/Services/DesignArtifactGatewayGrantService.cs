using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Diagnostics;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Api.Services.MdToPpt;

namespace PrdAgent.Api.Services;

public sealed record DesignArtifactGatewayGrant(
    string Id,
    string BaseUrl,
    string ApiKey,
    string Model,
    string AppCallerCode,
    DateTime ExpiresAt);

public sealed record DesignArtifactGatewayGrantUsage(
    int CallCount,
    string? Model,
    string? Platform);

public interface IDesignArtifactGatewayGrantService
{
    Task<DesignArtifactGatewayGrant> IssueAsync(DesignArtifactRun run, DateTime expiresAt, CancellationToken ct);
    Task<DesignArtifactGatewayGrantUsage> ObserveAsync(string grantId, DesignArtifactRun run, CancellationToken ct);
    Task RevokeAsync(string grantId, CancellationToken ct);
}

/// <summary>
/// 为 OpenDesign 的单次任务签发短期 LLMGW 凭据。明文只返回给当前执行调用栈；Mongo 只保存哈希，
/// 网关再从记录恢复 run、user、appCaller 和冻结模型策略，设计容器拿到 key 也不能扩大权限。
/// </summary>
public sealed class DesignArtifactGatewayGrantService : IDesignArtifactGatewayGrantService
{
    private const int MaxCallsPerRun = 256;
    private readonly LlmGatewayDataContext _gateway;
    private readonly MongoDbContext _map;
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ITaskExecutionAuthorizer _taskAuthorizer;

    public DesignArtifactGatewayGrantService(
        LlmGatewayDataContext gateway,
        MongoDbContext map,
        IConfiguration configuration,
        IHostEnvironment environment,
        ITaskExecutionAuthorizer taskAuthorizer)
    {
        _gateway = gateway;
        _map = map;
        _configuration = configuration;
        _environment = environment;
        _taskAuthorizer = taskAuthorizer;
    }

    public async Task<DesignArtifactGatewayGrant> IssueAsync(
        DesignArtifactRun run,
        DateTime expiresAt,
        CancellationToken ct)
    {
        var baseUrl = (_configuration["LlmGateway:ServeBaseUrl"] ?? string.Empty).Trim().TrimEnd('/');
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var parsed)
            || parsed.Scheme is not ("http" or "https"))
            throw new InvalidOperationException("设计模型网关地址未配置，无法启动 OpenDesign 任务");

        var selection = DesignArtifactModelSelection.ForRun(run, _configuration);
        var model = selection.ForDirectGatewayClient();
        if (string.IsNullOrWhiteSpace(model))
            throw new InvalidOperationException("当前设计任务没有冻结可用的逻辑模型，无法启动 OpenDesign 任务");

        var policy = selection.Policy;
        var caller = CallerFor(run);
        if (string.IsNullOrWhiteSpace(run.TaskPermitId))
            throw new TaskExecutionAdmissionException("TASK_EXECUTION_NOT_ADMITTED",
                "本次设计任务没有获得执行许可，已停止模型调用；请重新明确提交操作。");
        using var taskExecutionScope = TaskExecutionContext.Enter(TaskExecutionContext.ForRun(run.TaskPermitId, run.Id));
        using var admissionRequest = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/gw/v1/responses");
        await _taskAuthorizer.AuthorizeOutboundAsync(admissionRequest, caller, new GatewayRequestContext
        {
            RunId = run.Id,
            SessionId = run.Id,
            UserId = run.UserId,
        }, ct);

        var keyBytes = RandomNumberGenerator.GetBytes(32);
        var plainKey = "gwrg_" + Convert.ToBase64String(keyBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plainKey))).ToLowerInvariant();
        var id = Guid.NewGuid().ToString("N");
        var now = DateTime.UtcNow;
        var budgetBinding = await ResolveTaskBudgetScopeAsync(run, ct);
        var budgetScope = budgetBinding?.Scope;
        var record = new GatewayRuntimeGrantRecord
        {
            Id = id,
            TenantId = _configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenantId
                ? tenantId
                : GatewayTenantDefaults.InternalTenantId,
            // 运行日志里只允许出现哈希前缀，绝不保存或展示明文 key 的任何片段。
            KeyPrefix = hash[..12],
            KeyHash = hash,
            RunId = run.Id,
            TaskPermitId = run.TaskPermitId,
            TaskLeaseRunId = TaskExecutionContext.Current!.Lease!.RunId,
            TaskLeaseOwnerHash = PrdAgent.Infrastructure.Security.TaskExecutionCoordinator.OwnerHash(TaskExecutionContext.Current.Lease.OwnerToken),
            TaskLeaseFence = TaskExecutionContext.Current.Lease.Fence,
            UserId = run.UserId,
            AppCallerCode = caller,
            Environment = NormalizeEnvironment(_environment.EnvironmentName),
            Model = model,
            ModelPoolId = selection.ModelPoolId,
            PinnedPlatformId = policy?.PinnedPlatformId,
            PinnedModelId = policy?.PinnedModelId,
            Temperature = policy?.Temperature,
            TopP = policy?.TopP,
            ReasoningMode = policy?.ReasoningMode,
            ReasoningEffort = policy?.ReasoningEffort,
            OutputTokenMode = policy?.OutputTokenMode,
            RequireDeclaredParameters = policy?.RequireDeclaredParameters == true,
            MaxCalls = budgetBinding is null
                ? MaxCallsPerRun
                : Math.Max(0, budgetBinding.Stage.MaxPhysicalCalls - budgetBinding.Stage.UsedPhysicalCalls),
            BudgetScopeId = budgetScope?.Id,
            BudgetMaxOutputTokens = budgetBinding?.Stage.MaxOutputTokens ?? budgetScope?.MaxOutputTokens,
            PptCompletionId = budgetBinding?.Completion.Id,
            PptCompletionPhase = budgetBinding?.Phase,
            ExpiresAt = expiresAt,
            CreatedAt = now,
        };
        await _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .InsertOneAsync(record, cancellationToken: ct);
        return new(id, $"{baseUrl}/gw/v1", plainKey, model, caller, expiresAt);
    }

    private sealed record PptBudgetBinding(
        GatewayRuntimeBudgetScopeRecord Scope,
        GatewayPptCompletionBudgetRecord Completion,
        GatewayPptCompletionStageBudgetRecord Stage,
        string Phase);

    private async Task<PptBudgetBinding?> ResolveTaskBudgetScopeAsync(
        DesignArtifactRun run,
        CancellationToken ct)
    {
        if (run.ArtifactType != DesignArtifactTypes.HtmlPpt) return null;
        var scopes = _gateway.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var currentId = run.Id;
        string? rootOutlineRunId = null;
        for (var depth = 0; depth < 16 && !string.IsNullOrWhiteSpace(currentId); depth++)
        {
            var compatibility = await _map.MdToPptRuns
                .Find(item => item.Id == currentId && item.UserId == run.UserId)
                .FirstOrDefaultAsync(ct);
            if (compatibility is null) break;
            if (!string.IsNullOrWhiteSpace(compatibility.ParentOutlineRunId))
            {
                rootOutlineRunId = compatibility.ParentOutlineRunId.Trim();
                break;
            }
            currentId = compatibility.ParentRunId;
        }
        if (string.IsNullOrWhiteSpace(rootOutlineRunId))
        {
            await RejectProtectedTraceLossAsync(run, scopes, ct);
            return null;
        }
        var root = await _map.MdToPptRuns.Find(item => item.Id == rootOutlineRunId
                && item.UserId == run.UserId
                && item.Op == "outline"
                && item.Status == "done")
            .FirstOrDefaultAsync(ct);
        if (root is null)
        {
            await RejectProtectedTraceLossAsync(run, scopes, ct);
            return null;
        }
        if (root.SourcePlanVersion == 0
            && string.IsNullOrWhiteSpace(root.SourcePlanJson)
            && string.IsNullOrWhiteSpace(root.SourcePlanHash))
        {
            await RejectProtectedTraceLossAsync(run, scopes, ct);
            return null;
        }
        if (root.SourcePlanVersion != MdToPptSourcePlan.Version)
            throw new MdToPptSourcePlanException(
                "source_plan_invalid",
                "冻结来源目录版本无效，不能在无额度保护的情况下继续设计任务");
        var sourceFingerprint = MdToPptSourcePlan.RestoreFingerprint(root.SourcePlanJson, root.SourcePlanHash);
        var now = DateTime.UtcNow;
        var matched = !string.IsNullOrWhiteSpace(run.RuntimeBudgetScopeId)
            ? await scopes.Find(item => item.Id == run.RuntimeBudgetScopeId).FirstOrDefaultAsync(ct)
            : await scopes.Find(item => item.RootOutlineRunId == root.Id
                          && item.UserId == run.UserId
                          && item.SourcePlanHash == sourceFingerprint
                          && item.Status == "active"
                          && item.ExpiresAt > now)
            .FirstOrDefaultAsync(ct);
        if (matched is not null)
        {
            if (matched.Status != "active" || matched.ExpiresAt <= now
                || matched.RootOutlineRunId != root.Id || matched.UserId != run.UserId
                || !string.Equals(matched.SourcePlanHash, sourceFingerprint, StringComparison.OrdinalIgnoreCase))
                throw BudgetFailure("task_budget_inactive", "本次任务的额度保护已关闭、过期或与冻结来源不一致，未发送模型请求");
            if (matched.PptCompletion is null)
                throw BudgetFailure("task_budget_completion_contract_missing", "本次 PPT 任务缺少完整阶段额度合同，未发送模型请求");

            var bound = await BindCompletionPhaseAsync(scopes, matched, run, root, ct);
            run.RuntimeBudgetScopeId = bound.Scope.Id;
            run.PptCompletionId = bound.Completion.Id;
            await _map.DesignArtifactRuns.UpdateOneAsync(
                item => item.DeploymentSlug == DeploymentScope.Current && item.Id == run.Id && item.UserId == run.UserId,
                Builders<DesignArtifactRun>.Update
                    .Set(item => item.RuntimeBudgetScopeId, bound.Scope.Id)
                    .Set(item => item.PptCompletionId, bound.Completion.Id),
                cancellationToken: ct);
            return bound;
        }
        var boundScope = await scopes.Find(item => item.RootOutlineRunId == root.Id && item.UserId == run.UserId)
            .FirstOrDefaultAsync(ct);
        if (boundScope is not null)
            throw BudgetFailure("task_budget_inactive", "本次任务的额度保护已关闭、过期或与冻结来源不一致，未发送模型请求");
        return null;
    }

    private async Task RejectProtectedTraceLossAsync(
        DesignArtifactRun run,
        IMongoCollection<GatewayRuntimeBudgetScopeRecord> scopes,
        CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(run.RuntimeBudgetScopeId)
            || !string.IsNullOrWhiteSpace(run.PptCompletionId))
            throw BudgetFailure("task_budget_chain_invalid", "受保护的 PPT 任务父链缺失，未发送模型请求");

        var sourcePlanJson = run.PresentationInput?.SourcePlanJson;
        if (string.IsNullOrWhiteSpace(sourcePlanJson)) return;
        string stableSourceHash;
        try
        {
            stableSourceHash = MdToPptSourcePlan.RestoreFingerprint(
                sourcePlanJson,
                run.PresentationInput?.SourcePlanHash);
        }
        catch (MdToPptSourcePlanException)
        {
            return;
        }
        var protectedScopeExists = await scopes.CountDocumentsAsync(
            item => item.UserId == run.UserId
                    && item.SourcePlanHash == stableSourceHash
                    && item.Status != "closed",
            cancellationToken: ct) > 0;
        if (protectedScopeExists)
            throw BudgetFailure("task_budget_chain_invalid", "受保护的 PPT 任务父链缺失，未发送模型请求");
    }

    private async Task<PptBudgetBinding> BindCompletionPhaseAsync(
        IMongoCollection<GatewayRuntimeBudgetScopeRecord> scopes,
        GatewayRuntimeBudgetScopeRecord scope,
        DesignArtifactRun run,
        MdToPptRun root,
        CancellationToken ct)
    {
        var completion = scope.PptCompletion
                         ?? throw BudgetFailure("task_budget_completion_contract_missing", "本次 PPT 任务缺少完整阶段额度合同，未发送模型请求");
        var now = DateTime.UtcNow;
        if (completion.ExpiresAt <= now
            || completion.StableSourceHash != scope.SourcePlanHash
            || (!string.IsNullOrWhiteSpace(completion.RootOutlineRunId) && completion.RootOutlineRunId != root.Id))
            throw BudgetFailure("task_budget_completion_contract_mismatch", "PPT 完成阶段额度合同与冻结来源不一致，未发送模型请求");
        if (BuildIdentity.Compare(ActualRuntimeCommit(), completion.CandidateCommit) != BuildIdentity.MatchState.Match)
            throw BudgetFailure("task_budget_candidate_commit_mismatch", "PPT 完成阶段额度合同与当前受信服务版本不一致，未发送模型请求");

        if (run.Operation == DesignArtifactOperations.Edit)
        {
            var compatibility = await _map.MdToPptRuns.Find(item => item.Id == run.Id && item.UserId == run.UserId)
                .FirstOrDefaultAsync(ct);
            var parent = string.IsNullOrWhiteSpace(compatibility?.ParentRunId)
                ? null
                : await _map.MdToPptRuns.Find(item => item.Id == compatibility.ParentRunId
                                                     && item.UserId == run.UserId
                                                     && item.Status == "done")
                    .FirstOrDefaultAsync(ct);
            var parentArtifact = string.IsNullOrWhiteSpace(parent?.Id)
                ? null
                : await _map.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current
                                                              && item.Id == parent.Id
                                                              && item.UserId == run.UserId
                                                              && item.ArtifactType == DesignArtifactTypes.HtmlPpt
                                                              && item.Status == RunStatuses.Done)
                    .FirstOrDefaultAsync(ct);
            var parentHtmlHash = parent?.HtmlHash?.Trim().ToLowerInvariant();
            var parentPackageHash = parentArtifact?.WorkspaceResultSha256?.Trim().ToLowerInvariant();
            if (compatibility is null || parent is null || parentArtifact is null
                || string.IsNullOrWhiteSpace(parentHtmlHash) || string.IsNullOrWhiteSpace(parentPackageHash)
                || !string.Equals(completion.GenerationRunId, parent.Id, StringComparison.Ordinal)
                || !string.Equals(run.PresentationInput?.ParentRunId, parent.Id, StringComparison.Ordinal)
                || !string.Equals(compatibility.ParentRunId, parent.Id, StringComparison.Ordinal)
                || !string.Equals(compatibility.ParentHtmlHash, parentHtmlHash, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(run.PresentationInput?.ParentPackageHash, parentPackageHash, StringComparison.OrdinalIgnoreCase))
                throw BudgetFailure("task_budget_manual_parent_invalid", "人工保存父稿不属于本次受保护完成链，未发送模型请求");

            if (completion.Status == GatewayPptCompletionStatuses.ManualActive
                && completion.ManualRunId == run.Id
                && string.Equals(completion.ParentArtifactHash, parentHtmlHash, StringComparison.OrdinalIgnoreCase)
                && string.Equals(completion.ParentPackageHash, parentPackageHash, StringComparison.OrdinalIgnoreCase))
            {
                if (completion.ManualSave.UsedPhysicalCalls >= completion.ManualSave.MaxPhysicalCalls)
                    throw BudgetFailure("task_budget_manual_phase_exhausted", "人工保存阶段调用额度已用尽，未发送模型请求");
                return new(scope, completion, completion.ManualSave, GatewayPptCompletionPhases.ManualSave);
            }

            if (completion.Status != GatewayPptCompletionStatuses.GenerationActive)
                throw BudgetFailure("task_budget_manual_phase_unavailable", "人工保存阶段尚未准入或已被其他任务占用，未发送模型请求");
            var remainingGenerationCalls = Math.Max(
                0,
                completion.GenerationAndRepairs.MaxPhysicalCalls
                - completion.GenerationAndRepairs.UsedPhysicalCalls);
            var releasableGenerationHold = remainingGenerationCalls
                                           * completion.GenerationAndRepairs.PerCallUpperUsd;

            var filter = Builders<GatewayRuntimeBudgetScopeRecord>.Filter.And(
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Id, scope.Id),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Status, "active"),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq("PptCompletion.Id", completion.Id),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq("PptCompletion.Status", GatewayPptCompletionStatuses.GenerationActive),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq("PptCompletion.GenerationRunId", parent.Id),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(
                    "PptCompletion.GenerationAndRepairs.UsedPhysicalCalls",
                    completion.GenerationAndRepairs.UsedPhysicalCalls),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Gte(
                    "PptCompletion.FutureHeldUsd",
                    releasableGenerationHold),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Not(
                    Builders<GatewayRuntimeBudgetScopeRecord>.Filter.ElemMatch(
                        item => item.Reservations,
                        reservation => reservation.Status == "reserved")),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.In(
                    "PptCompletion.ManualRunId", new BsonValue[] { BsonNull.Value, string.Empty, run.Id }));
            var updated = await scopes.FindOneAndUpdateAsync(
                filter,
                Builders<GatewayRuntimeBudgetScopeRecord>.Update
                    .Inc("PptCompletion.FutureHeldUsd", -releasableGenerationHold)
                    .Set("PptCompletion.RootOutlineRunId", root.Id)
                    .Set("PptCompletion.ManualRunId", run.Id)
                    .Set("PptCompletion.ParentArtifactHash", parentHtmlHash)
                    .Set("PptCompletion.ParentPackageHash", parentPackageHash)
                    .Set("PptCompletion.Status", GatewayPptCompletionStatuses.ManualActive)
                    .Set(item => item.UpdatedAt, now),
                new FindOneAndUpdateOptions<GatewayRuntimeBudgetScopeRecord> { ReturnDocument = ReturnDocument.After },
                ct);
            if (updated?.PptCompletion is null)
            {
                var latest = await scopes.Find(item => item.Id == scope.Id).FirstOrDefaultAsync(ct);
                if (latest?.PptCompletion?.Status == GatewayPptCompletionStatuses.ManualActive
                    && latest.PptCompletion.ManualRunId == run.Id
                    && string.Equals(latest.PptCompletion.ParentArtifactHash, parentHtmlHash, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(latest.PptCompletion.ParentPackageHash, parentPackageHash, StringComparison.OrdinalIgnoreCase))
                    updated = latest;
                else
                    throw BudgetFailure("task_budget_manual_phase_unavailable", "人工保存阶段尚未准入或已被其他任务占用，未发送模型请求");
            }
            if (updated.PptCompletion.ManualSave.UsedPhysicalCalls >= updated.PptCompletion.ManualSave.MaxPhysicalCalls)
                throw BudgetFailure("task_budget_manual_phase_exhausted", "人工保存阶段调用额度已用尽，未发送模型请求");
            return new(updated, updated.PptCompletion, updated.PptCompletion.ManualSave, GatewayPptCompletionPhases.ManualSave);
        }

        if (run.Operation != DesignArtifactOperations.Generate)
            throw BudgetFailure("task_budget_completion_phase_invalid", "PPT 完成阶段无法识别，未发送模型请求");
        var isInitial = completion.Status == GatewayPptCompletionStatuses.Pending
                        && string.IsNullOrWhiteSpace(completion.GenerationRunId);
        var isReentry = completion.Status == GatewayPptCompletionStatuses.GenerationActive
                        && completion.GenerationRunId == run.Id;
        var isTrustedRestart = completion.Status == GatewayPptCompletionStatuses.GenerationActive
                               && completion.GenerationRunId == run.RestartedFromRunId;
        if (isTrustedRestart)
        {
            var failedParent = await _map.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current
                                                                           && item.Id == run.RestartedFromRunId
                                                                           && item.UserId == run.UserId
                                                                           && item.ArtifactType == DesignArtifactTypes.HtmlPpt
                                                                           && (item.Status == RunStatuses.Error
                                                                               || item.Status == RunStatuses.Cancelled))
                .FirstOrDefaultAsync(ct);
            if (failedParent is null
                || !string.Equals(
                    failedParent.PresentationInput?.SourcePlanHash,
                    run.PresentationInput?.SourcePlanHash,
                    StringComparison.OrdinalIgnoreCase)
                || !string.Equals(
                    failedParent.PresentationInput?.SourcePlanJson,
                    run.PresentationInput?.SourcePlanJson,
                    StringComparison.Ordinal))
                throw BudgetFailure("task_budget_generation_restart_invalid", "继续打磨任务与受保护失败父稿不一致，未发送模型请求");
        }
        if (!isInitial && !isReentry && !isTrustedRestart)
            throw BudgetFailure("task_budget_generation_phase_unavailable", "生成阶段已被其他任务占用或父链不一致，未发送模型请求");
        var generationFilter = Builders<GatewayRuntimeBudgetScopeRecord>.Filter.And(
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Id, scope.Id),
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Status, "active"),
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq("PptCompletion.Id", completion.Id),
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq("PptCompletion.Status", completion.Status),
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq("PptCompletion.GenerationRunId", completion.GenerationRunId),
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(
                "PptCompletion.GenerationAndRepairs.UsedPhysicalCalls",
                completion.GenerationAndRepairs.UsedPhysicalCalls),
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Not(
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.ElemMatch(
                    item => item.Reservations,
                    reservation => reservation.Status == "reserved")));
        var generationUpdated = await scopes.FindOneAndUpdateAsync(
            generationFilter,
            Builders<GatewayRuntimeBudgetScopeRecord>.Update
                .Set("PptCompletion.RootOutlineRunId", root.Id)
                .Set("PptCompletion.GenerationRunId", run.Id)
                .Set("PptCompletion.Status", GatewayPptCompletionStatuses.GenerationActive)
                .Set(item => item.UpdatedAt, now),
            new FindOneAndUpdateOptions<GatewayRuntimeBudgetScopeRecord> { ReturnDocument = ReturnDocument.After },
            ct);
        if (generationUpdated?.PptCompletion is null)
            throw BudgetFailure("task_budget_generation_phase_unavailable", "生成阶段原子认领失败，未发送模型请求");
        if (generationUpdated.PptCompletion.GenerationAndRepairs.UsedPhysicalCalls
            >= generationUpdated.PptCompletion.GenerationAndRepairs.MaxPhysicalCalls)
            throw BudgetFailure("task_budget_generation_phase_exhausted", "生成与有限修复调用额度已用尽，未发送模型请求");
        return new(
            generationUpdated,
            generationUpdated.PptCompletion,
            generationUpdated.PptCompletion.GenerationAndRepairs,
            GatewayPptCompletionPhases.Generation);
    }

    private static MdToPptSourcePlanException BudgetFailure(string code, string message) => new(code, message);

    internal static string? ActualRuntimeCommit()
    {
        var informationalVersion = typeof(DesignArtifactGatewayGrantService).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        return BuildIdentity.ParseBakedCommit(informationalVersion);
    }

    public async Task<DesignArtifactGatewayGrantUsage> ObserveAsync(
        string grantId,
        DesignArtifactRun run,
        CancellationToken ct)
    {
        var grant = await _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .Find(x => x.Id == grantId && x.RunId == run.Id && x.UserId == run.UserId)
            .FirstOrDefaultAsync(ct);
        var callCount = Math.Max(0, grant?.CallCount ?? 0);
        if (callCount > 0)
        {
            await _map.DesignArtifactRuns.UpdateOneAsync(
                item => item.DeploymentSlug == DeploymentScope.Current && item.Id == run.Id,
                Builders<DesignArtifactRun>.Update.Max(item => item.RuntimeModelCallCount, callCount),
                cancellationToken: ct);
        }

        var caller = CallerFor(run);
        var latest = await _gateway.LlmRequestLogs
            .Find(item => item.ServiceKeyId == grantId
                          && item.RunId == run.Id
                          && item.UserId == run.UserId
                          && item.SourceSystem == "map"
                          && item.AppCallerCode == caller
                          && item.Model != "")
            .SortByDescending(item => item.StartedAt)
            .FirstOrDefaultAsync(ct);
        return new DesignArtifactGatewayGrantUsage(
            callCount,
            latest?.Model,
            latest?.PlatformName ?? latest?.Provider);
    }

    public Task RevokeAsync(string grantId, CancellationToken ct) =>
        _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .DeleteOneAsync(x => x.Id == grantId, ct);

    internal static string CallerFor(DesignArtifactRun run)
    {
        if (run.ArtifactType == DesignArtifactTypes.HtmlPpt)
            return run.Operation == DesignArtifactOperations.Edit
                ? AppCallerRegistry.MdToPptAgent.Generation.Patch
                : AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate;
        return run.Operation == DesignArtifactOperations.Edit
            ? AppCallerRegistry.Admin.WebHosting.EditHtml
            : AppCallerRegistry.Admin.WebHosting.GenerateHtml;
    }

    private static string NormalizeEnvironment(string value) => value.Trim().ToLowerInvariant() switch
    {
        "development" => "development",
        "test" or "testing" => "test",
        "staging" => "staging",
        _ => "production",
    };
}
