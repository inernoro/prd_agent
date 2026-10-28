using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.MdToPpt;

public sealed record HtmlPptResolvedEditContext(HtmlPptEditContext Context, string Html);
public sealed record HtmlPptModificationAdmission(
    string RunId, string ScopeId, string CompletionId, string RequestHash,
    HtmlPptResolvedEditContext Base);

public sealed record HtmlPptCurrentModificationPolicy(
    GatewayRuntimeBudgetScopeRecord Policy,
    string PolicyId, DateTime? ValidUntilUtc, TimeSpan OperationLifetime, string Fingerprint,
    string PriceBasis, string PriceSource, string PriceSourceUrl, DateTime PriceObservedAtUtc, bool IsEstimate);

/// <summary>服务端明确登记的当前 PPT 修改包络；没有从历史合同回填的默认值。</summary>
internal sealed class HtmlPptModificationBudgetPolicy
{
    public string PolicyId { get; set; } = string.Empty;
    public bool Active { get; set; }
    public DateTime? ValidUntilUtc { get; set; }
    public int OperationLifetimeHours { get; set; }
    public string LogicalModelPublicId { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string FallbackEstimateProvider { get; set; } = string.Empty;
    public string PriceCurrency { get; set; } = string.Empty;
    public string EstimateSource { get; set; } = string.Empty;
    public string SourceUrl { get; set; } = string.Empty;
    public bool IsEstimate { get; set; }
    public DateTime PriceObservedAtUtc { get; set; }
    public decimal EstimatedInputUsdPerMillion { get; set; }
    public decimal EstimatedOutputUsdPerMillion { get; set; }
    public long LongContextThresholdTokens { get; set; }
    public decimal LongPriceInputMultiplier { get; set; }
    public decimal LongPriceOutputMultiplier { get; set; }
    public int DocumentedMaxOutputTokens { get; set; }
    public int MaxOutputTokens { get; set; }
    public GatewayPptCompletionStageBudgetRecord GenerationAndRepairs { get; set; } = new();
    public GatewayPptCompletionStageBudgetRecord ManualSave { get; set; } = new();
    public decimal? TailHeldUsd { get; set; }
}

public sealed class HtmlPptContinuationException(string code, string message) : InvalidOperationException(message)
{
    public string Code { get; } = code;
}

public interface IHtmlPptContinuationService
{
    Task<HtmlPptResolvedEditContext> ResolveCurrentEditContextAsync(string sourceRunId, string userId, CancellationToken ct);
    Task<HtmlPptResolvedEditContext> ValidateFrozenContextAsync(HtmlPptEditContext expected, string userId, CancellationToken ct);
    Task<HtmlPptModificationAdmission> AdmitModificationAsync(string sourceRunId, string userId,
        HtmlPptEditContext expected, string idempotencyKey, string requestHash, CancellationToken ct, bool isManualSave = false);
}

/// <summary>只处理现有演示稿续编辑的来源与准入；不生成内容，不变更历史稿或旧完成合同。</summary>
public sealed class HtmlPptContinuationService(
    MongoDbContext db, LlmGatewayDataContext gateway, IConfiguration configuration,
    ILlmGateway? currentGateway = null) : IHtmlPptContinuationService
{
    public async Task<HtmlPptResolvedEditContext> ResolveCurrentEditContextAsync(
        string sourceRunId, string userId, CancellationToken ct)
    {
        var source = await db.MdToPptRuns.Find(x => x.Id == sourceRunId && x.UserId == userId && x.Status == "done")
            .FirstOrDefaultAsync(ct) ?? throw Failure("ppt_edit_source_missing", "演示稿来源不存在或无权访问");
        var artifact = await db.DesignArtifactRuns.Find(x => x.Id == sourceRunId && x.UserId == userId
                && x.DeploymentSlug == DeploymentScope.Current && x.ArtifactType == DesignArtifactTypes.HtmlPpt
                && x.Status == RunStatuses.Done)
            .FirstOrDefaultAsync(ct) ?? throw Failure("ppt_edit_source_missing", "演示稿来源缺少已完成的设计产物");
        var site = await db.HostedSites.Find(x => x.Id == artifact.ProducedArtifactSiteId && x.OwnerUserId == userId
                && x.SourceType == "design-agent").FirstOrDefaultAsync(ct)
            ?? throw Failure("ppt_edit_source_missing", "演示稿站点不存在或无权访问");
        async Task<HostedSiteRevision> ReadRevision(string id) => await db.HostedSiteRevisions
            .Find(x => x.Id == id && x.SiteId == site.Id && x.CreatedByUserId == userId)
            .FirstOrDefaultAsync(ct) ?? throw Failure("ppt_edit_source_missing", "演示稿版本不存在或无权访问");
        var origin = await ReadRevision(artifact.ProducedArtifactRevisionId ?? string.Empty);
        var current = origin.Status == HostedSiteRevisionStatuses.Draft
            ? origin
            : await ReadRevision(site.PublishedRevisionId ?? string.Empty);
        var chain = new List<HostedSiteRevision> { current };
        var seen = new HashSet<string>(StringComparer.Ordinal) { current.Id };
        var step = current;
        while (step.Id != origin.Id && step.Source == HostedSiteRevisionSources.Rollback)
        {
            if (chain.Count >= 16 || string.IsNullOrWhiteSpace(step.RollbackTargetRevisionId)
                || !seen.Add(step.RollbackTargetRevisionId))
                throw Failure("ppt_edit_source_invalid", "演示稿恢复关系不完整，原版本仍然保留");
            step = await ReadRevision(step.RollbackTargetRevisionId);
            chain.Add(step);
        }
        return ResolveSnapshot(source, artifact, site, origin, current, chain, userId);
    }

    public async Task<HtmlPptResolvedEditContext> ValidateFrozenContextAsync(
        HtmlPptEditContext expected, string userId, CancellationToken ct)
    {
        var actual = await ResolveCurrentEditContextAsync(expected.SourceRunId, userId, ct);
        if (!string.Equals(ContextFingerprint(actual.Context), ContextFingerprint(expected), StringComparison.Ordinal))
            throw Failure("ppt_edit_base_changed", "演示稿版本已发生变化，原稿和修改要求已保留，请重新载入当前版本");
        return actual;
    }

    public async Task<HtmlPptModificationAdmission> AdmitModificationAsync(
        string sourceRunId, string userId, HtmlPptEditContext expected,
        string idempotencyKey, string requestHash, CancellationToken ct, bool isManualSave = false)
    {
        if (expected.SourceRunId != sourceRunId || !Guid.TryParse(idempotencyKey, out _) || !Hex(requestHash, 64))
            throw Failure("ppt_edit_request_invalid", "修改请求缺少有效的版本或操作身份，原稿未改变");
        var tenant = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } configured
            ? configured : GatewayTenantDefaults.InternalTenantId;
        var runId = OperationRunId(tenant, userId, idempotencyKey);
        var scopes = gateway.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var scopeId = "pptb_m_" + runId;
        var existing = await scopes.Find(x => x.Id == scopeId && x.TenantId == tenant && x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            CheckReplay(existing, expected, runId, requestHash);
            // 重放取回同一操作，不重新准入、续期或清零；已经排队的运行自行继续。
            return new(runId, existing.Id, existing.PptCompletion!.Id, requestHash, new(expected, string.Empty));
        }
        var manualReplay = await scopes.Find(x => x.UserId == userId && x.TenantId == tenant
                && x.PptPendingManualRunId == runId).FirstOrDefaultAsync(ct);
        if (manualReplay != null)
        {
            CheckManualReplay(manualReplay, expected, runId, requestHash);
            return new(runId, manualReplay.Id, manualReplay.PptCompletion!.Id, requestHash, new(expected, string.Empty));
        }
        var resolved = await ValidateFrozenContextAsync(expected, userId, ct);
        if (isManualSave)
        {
            var parentArtifact = await db.DesignArtifactRuns.Find(x => x.Id == sourceRunId && x.UserId == userId
                    && x.DeploymentSlug == DeploymentScope.Current && x.Status == RunStatuses.Done)
                .FirstOrDefaultAsync(ct);
            var parentScope = string.IsNullOrWhiteSpace(parentArtifact?.RuntimeBudgetScopeId) ? null
                : await scopes.Find(x => x.Id == parentArtifact.RuntimeBudgetScopeId && x.UserId == userId && x.TenantId == tenant)
                    .FirstOrDefaultAsync(ct);
            if (parentScope?.PptOperationPurpose == GatewayPptCompletionPurposes.Modification
                && parentScope.PptModificationRunId == sourceRunId)
            {
                var now = DateTime.UtcNow;
                if (parentScope.Status != "active" || parentScope.ExpiresAt <= now || parentScope.PptCompletion == null
                    || parentScope.PptCompletion.GenerationRunId != sourceRunId
                    || parentScope.PptCompletion.ExpiresAt <= now
                    || parentScope.PptCompletion.CandidateCommit != DesignArtifactGatewayGrantService.ActualRuntimeCommit())
                    throw Failure("ppt_manual_contract_unavailable", "本次修改的人工保存保护已失效，草稿和原稿均保留");
                var baseFingerprint = ContextFingerprint(expected);
                var claimed = await IMongoCollectionExtensions.FindOneAndUpdateAsync<GatewayRuntimeBudgetScopeRecord>(scopes,
                    x => x.Id == parentScope.Id && x.UserId == userId && x.TenantId == tenant
                        && x.Status == "active" && x.ExpiresAt > now
                        && x.PptCompletion != null && x.PptCompletion.Status == GatewayPptCompletionStatuses.GenerationActive
                        && x.PptCompletion.GenerationRunId == sourceRunId
                        && (x.PptPendingManualRunId == null || (x.PptPendingManualRunId == runId
                            && x.PptManualRequestHash == requestHash && x.PptManualBaseFingerprint == baseFingerprint)),
                    Builders<GatewayRuntimeBudgetScopeRecord>.Update
                        .Set(x => x.PptPendingManualRunId, runId)
                        .Set(x => x.PptManualRequestHash, requestHash)
                        .Set(x => x.PptManualBaseFingerprint, baseFingerprint)
                        .Set(x => x.UpdatedAt, now),
                    new FindOneAndUpdateOptions<GatewayRuntimeBudgetScopeRecord> { ReturnDocument = ReturnDocument.After },
                    CancellationToken.None);
                if (claimed == null)
                    throw Failure("ppt_manual_contract_busy", "这次修改的人工保存已由另一操作接管，草稿仍保留");
                CheckManualReplay(claimed, expected, runId, requestHash);
                return new(runId, claimed.Id, claimed.PptCompletion!.Id, requestHash, resolved);
            }
        }
        var root = await FindRootAsync(sourceRunId, userId, ct);
        var stableSource = MdToPptSourcePlan.RestoreFingerprint(root.SourcePlanJson, root.SourcePlanHash);
        var requestPolicy = DesignArtifactModelSelection.CaptureForNewRun(configuration);
        var selectedModel = DesignArtifactModelSelection.ForRun(new DesignArtifactRun { LlmRequestPolicy = requestPolicy }, configuration)
            .ForDirectGatewayClient();
        var policy = await ReadCurrentPolicyAsync(tenant, userId, root.Id, stableSource,
            selectedModel, requestPolicy, ct);
        var actualCommit = DesignArtifactGatewayGrantService.ActualRuntimeCommit();
        if (!Hex(actualCommit, 40))
            throw Failure("ppt_edit_policy_missing", "当前服务缺少受信版本身份，未创建修改任务");
        var scope = BuildModificationScope(policy, expected, runId, requestHash, DateTime.UtcNow, actualCommit!);
        try { await scopes.InsertOneAsync(scope, cancellationToken: CancellationToken.None); }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            scope = await scopes.Find(x => x.Id == scopeId && x.TenantId == tenant && x.UserId == userId)
                .FirstOrDefaultAsync(CancellationToken.None)
                ?? throw Failure("ppt_edit_request_conflict", "修改操作身份已被占用，原稿未改变");
            CheckReplay(scope, expected, runId, requestHash);
        }
        return new(runId, scope.Id, scope.PptCompletion!.Id, requestHash, resolved);
    }

    private async Task<HtmlPptCurrentModificationPolicy> ReadCurrentPolicyAsync(
        string tenant, string userId, string rootId, string sourceHash,
        string? selectedModel, DesignArtifactLlmRequestPolicy requestPolicy, CancellationToken ct)
    {
        var p = new HtmlPptModificationBudgetPolicy();
        try { configuration.GetSection("MdToPpt:ModificationBudgetPolicy").Bind(p); }
        catch (InvalidOperationException)
        { throw Failure("ppt_edit_policy_missing", "当前 PPT 修改策略格式无效，未创建修改任务"); }
        p.ValidUntilUtc = p.ValidUntilUtc?.ToUniversalTime();
        p.PriceObservedAtUtc = p.PriceObservedAtUtc.ToUniversalTime();
        var now = DateTime.UtcNow;
        if (!p.Active || string.IsNullOrWhiteSpace(p.PolicyId) || p.ValidUntilUtc <= now || p.OperationLifetimeHours <= 0)
            throw Failure("ppt_edit_policy_missing", "当前 PPT 修改策略未启用、已过期或缺少操作期限，未创建修改任务");
        if (p.LogicalModelPublicId != selectedModel || string.IsNullOrWhiteSpace(p.Model))
            throw Failure("ppt_edit_policy_missing", "当前 PPT 修改策略缺少匹配的逻辑模型与模型身份，未创建修改任务");
        if (p.PriceCurrency != "USD" || string.IsNullOrWhiteSpace(p.EstimateSource) || string.IsNullOrWhiteSpace(p.SourceUrl)
            || p.PriceObservedAtUtc == default || p.PriceObservedAtUtc > now
            || p.LongContextThresholdTokens <= 0 || p.LongPriceInputMultiplier <= 0 || p.LongPriceOutputMultiplier <= 0)
            throw Failure("ppt_edit_policy_missing", "当前 PPT 修改策略缺少 USD 估算来源、观测时间或长上下文阶梯，未创建修改任务");
        if (p.DocumentedMaxOutputTokens <= 0 || p.MaxOutputTokens <= 0 || p.TailHeldUsd is null or < 0)
            throw Failure("ppt_edit_policy_missing", "当前 PPT 修改策略缺少受信输出上限或尾部预留，未创建修改任务");
        if (currentGateway == null || string.IsNullOrWhiteSpace(selectedModel))
            throw Failure("ppt_edit_policy_missing", "当前模型路由解析服务不可用，未创建修改任务");
        // 只读当前元信息；执行解析会认领恢复租约，不能用于预算预检。
        var route = await currentGateway.ResolveModelMetadataAsync(
            AppCallerRegistry.MdToPptAgent.Generation.Patch, "chat", selectedModel,
            requestPolicy.PinnedPlatformId,
            requestPolicy.PinnedPlatformId == null ? null : requestPolicy.PinnedModelId, ct);
        if (!route.Success || route.LogicalModelPublicId != p.LogicalModelPublicId
            || string.IsNullOrWhiteSpace(route.OfferingId) || string.IsNullOrWhiteSpace(route.ActualPlatformName)
            || route.ActualModel != p.Model)
            throw Failure("ppt_edit_policy_missing", "当前模型路由与 PPT 估算策略不匹配，未创建修改任务");
        var currentPrice = route.PriceCurrency == "USD" && route.InputPricePerMillion is > 0
            && route.OutputPricePerMillion is > 0 && route.PricePerCall == null
            && !string.IsNullOrWhiteSpace(route.PriceSource) && route.PriceObservedAt is { } seen
            && seen <= now;
        if (!currentPrice && (!p.IsEstimate || p.FallbackEstimateProvider != route.ActualPlatformName
            || p.EstimatedInputUsdPerMillion <= 0 || p.EstimatedOutputUsdPerMillion <= 0))
            throw Failure("ppt_edit_policy_missing", "当前线路缺少有效 USD 单价及明确的基准估算，未创建修改任务");
        var modelOutputCap = route.MaxTokens ?? p.DocumentedMaxOutputTokens;
        if (modelOutputCap <= 0)
            throw Failure("ppt_edit_policy_missing", "当前模型输出上限无效，未创建修改任务");
        var outputCap = Math.Min(p.MaxOutputTokens, modelOutputCap);
        var inputRate = currentPrice ? route.InputPricePerMillion!.Value : p.EstimatedInputUsdPerMillion;
        var outputRate = currentPrice ? route.OutputPricePerMillion!.Value : p.EstimatedOutputUsdPerMillion;
        var shell = new GatewayRuntimeBudgetScopeRecord
        {
            TenantId = tenant, UserId = userId, RootOutlineRunId = rootId, SourcePlanHash = sourceHash,
            ExpectedLogicalModelPublicId = route.LogicalModelPublicId!, ExpectedProvider = route.ActualPlatformName!,
            ExpectedModel = route.ActualModel, MaxOutputTokens = outputCap, InputByteTokenMultiplier = 1,
            InputUsdPerMillion = inputRate, OutputUsdPerMillion = outputRate,
            LongContextThresholdTokens = p.LongContextThresholdTokens,
            LongContextInputUsdPerMillion = checked(inputRate * p.LongPriceInputMultiplier),
            LongContextOutputUsdPerMillion = checked(outputRate * p.LongPriceOutputMultiplier),
            PptCompletion = new() { GenerationAndRepairs = p.GenerationAndRepairs, ManualSave = p.ManualSave,
                TailHeldUsd = p.TailHeldUsd.Value },
        };
        var priceSource = currentPrice ? route.PriceSource! : p.EstimateSource;
        var priceSeen = currentPrice ? route.PriceObservedAt!.Value : p.PriceObservedAtUtc;
        var isEstimate = !currentPrice || route.ActualPlatformName == p.FallbackEstimateProvider;
        var basis = currentPrice ? "current-route-estimate" : "official-benchmark-estimate";
        var fingerprint = Hash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        { policy = p, route.OfferingId, shell.ExpectedProvider, shell.ExpectedModel,
            shell.InputUsdPerMillion, shell.OutputUsdPerMillion, outputCap, basis, priceSource, priceSeen })));
        return new(shell, p.PolicyId, p.ValidUntilUtc, TimeSpan.FromHours(p.OperationLifetimeHours),
            fingerprint, basis, priceSource, p.SourceUrl, priceSeen, isEstimate);
    }

    private async Task<MdToPptRun> FindRootAsync(string runId, string userId, CancellationToken ct)
    {
        for (var depth = 0; depth < 16; depth++)
        {
            var item = await db.MdToPptRuns.Find(x => x.Id == runId && x.UserId == userId)
                .FirstOrDefaultAsync(ct) ?? throw Failure("ppt_edit_source_invalid", "演示稿原始来源链不完整");
            if (item.Op == "outline" && item.Status == "done") return item;
            runId = item.ParentOutlineRunId ?? item.ParentRunId ?? string.Empty;
            if (runId.Length == 0) break;
        }
        throw Failure("ppt_edit_source_invalid", "演示稿原始来源链不完整");
    }

    public static HtmlPptResolvedEditContext ResolveSnapshot(
        MdToPptRun source, DesignArtifactRun artifact, HostedSite site,
        HostedSiteRevision origin, HostedSiteRevision current,
        IReadOnlyList<HostedSiteRevision> rollbackChain, string userId)
    {
        if (source.UserId != userId || source.Status != "done" || artifact.UserId != userId
            || artifact.Id != source.Id || artifact.Status != RunStatuses.Done
            || site.OwnerUserId != userId || site.SourceType != "design-agent"
            || origin.CreatedByUserId != userId || current.CreatedByUserId != userId
            || origin.SiteId != site.Id || current.SiteId != site.Id || origin.SourceRunId != source.Id
            || artifact.ProducedArtifactSiteId != site.Id || artifact.ProducedArtifactRevisionId != origin.Id
            || (artifact.ArtifactSiteId != null && artifact.ArtifactSiteId != site.Id)
            || (artifact.ArtifactRevisionId != null && artifact.ArtifactRevisionId != origin.Id)
            || !Hex(artifact.WorkspaceResultSha256, 64) || artifact.PresentationInput == null)
            throw Failure("ppt_edit_source_invalid", "演示稿来源不存在、无权访问或缺少受信产物");
        if (origin.Status == HostedSiteRevisionStatuses.Published
            && (artifact.ArtifactSiteId != site.Id || artifact.ArtifactRevisionId != origin.Id))
            throw Failure("ppt_edit_source_invalid", "已发布演示稿缺少匹配的来源绑定");
        if (current.Status == HostedSiteRevisionStatuses.Draft)
        {
            if (current.Id != origin.Id || current.SourceRunId != source.Id
                || current.BasedOnContentVersion != site.ContentVersion
                || string.IsNullOrWhiteSpace(site.PublishedRevisionId))
                throw Failure("ppt_edit_base_changed", "草稿所基于的线上版本已变化，请重新载入当前版本");
        }
        else
        {
            if (current.Status != HostedSiteRevisionStatuses.Published || current.Id != site.PublishedRevisionId
                || current.PublishedContentVersion != site.ContentVersion)
                throw Failure("ppt_edit_base_changed", "演示稿线上版本已变化，请重新载入当前版本");
            var step = current;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var depth = 0; step.Id != origin.Id; depth++)
            {
                if (depth >= 16 || !seen.Add(step.Id) || step.Source != HostedSiteRevisionSources.Rollback
                    || string.IsNullOrWhiteSpace(step.RollbackTargetRevisionId))
                    throw Failure("ppt_edit_source_invalid", "当前版本与原稿没有可验证的恢复关系");
                step = rollbackChain.SingleOrDefault(x => x.Id == step.RollbackTargetRevisionId)
                    ?? throw Failure("ppt_edit_source_invalid", "演示稿恢复关系不完整");
                if (step.SiteId != site.Id || step.CreatedByUserId != userId || step.Status != HostedSiteRevisionStatuses.Published)
                    throw Failure("ppt_edit_source_invalid", "演示稿恢复来源不属于当前作品");
            }
        }
        string originFingerprint;
        string currentFingerprint;
        try
        {
            originFingerprint = HostedSitePreviewAccessService.ComputePackageFingerprint(origin.VerifiedFiles);
            currentFingerprint = HostedSitePreviewAccessService.ComputePackageFingerprint(current.VerifiedFiles);
        }
        catch (InvalidOperationException)
        {
            throw Failure("ppt_edit_source_invalid", "演示稿文件包未通过完整性校验，原稿仍然保留");
        }
        if (originFingerprint != currentFingerprint)
            throw Failure("ppt_edit_source_invalid", "恢复版本与受信来源文件不一致，原版本仍然保留");
        var entry = current.VerifiedFiles.Single(file => file.Path == "index.html");
        var html = Encoding.UTF8.GetString(entry.Content);
        return new(new HtmlPptEditContext
        {
            SourceRunId = source.Id, SourcePackageHash = artifact.WorkspaceResultSha256!,
            BaseSiteId = site.Id, BaseRevisionId = current.Id,
            BasePublishedRevisionId = site.PublishedRevisionId!, BaseContentVersion = site.ContentVersion,
            BaseHtmlHash = Hash(entry.Content), BaseFilesFingerprint = currentFingerprint,
        }, html);
    }

    public static string OperationRunId(string tenantId, string userId, string idempotencyKey)
        => Hash(Encoding.UTF8.GetBytes($"ppt-modification\n{tenantId}\n{userId}\n{idempotencyKey}"))[..32];

    public static string ContextFingerprint(HtmlPptEditContext value)
        => Hash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)));

    public static string RequestFingerprint(string sourceRunId, HtmlPptEditContext expected,
        string instruction, int? slideIndex, string? theme, string? templateId, string? manualEditHtml,
        bool styleOverride = false)
    {
        var original = Hash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            sourceRunId, expected, instruction, slideIndex, theme, templateId,
            manualHash = manualEditHtml == null ? null : Hash(Encoding.UTF8.GetBytes(manualEditHtml)),
        })));
        return styleOverride ? Hash(JsonSerializer.SerializeToUtf8Bytes(new { original, styleOverride = true })) : original;
    }

    public static GatewayRuntimeBudgetScopeRecord BuildModificationScope(
        HtmlPptCurrentModificationPolicy current, HtmlPptEditContext context,
        string runId, string requestHash, DateTime now, string actualCommit)
    {
        var template = current.Policy;
        if (!Hex(actualCommit, 40) || !Hex(requestHash, 64) || template.PptCompletion == null
            || template.InputUsdPerMillion <= 0 || template.OutputUsdPerMillion <= 0
            || template.LongContextThresholdTokens <= 0 || template.LongContextInputUsdPerMillion <= 0
            || template.LongContextOutputUsdPerMillion <= 0 || template.MaxOutputTokens <= 0
            || string.IsNullOrWhiteSpace(template.ExpectedLogicalModelPublicId)
            || string.IsNullOrWhiteSpace(template.ExpectedProvider) || string.IsNullOrWhiteSpace(template.ExpectedModel))
            throw Failure("ppt_edit_policy_missing", "演示稿修改缺少可核验的路由、费率或发送包络，未创建任务");
        var next = new GatewayRuntimeBudgetScopeRecord
        {
            Id = "pptb_m_" + runId, TenantId = template.TenantId, UserId = template.UserId,
            RootOutlineRunId = template.RootOutlineRunId, SourcePlanHash = template.SourcePlanHash,
            InputUsdPerMillion = template.InputUsdPerMillion, OutputUsdPerMillion = template.OutputUsdPerMillion,
            LongContextThresholdTokens = template.LongContextThresholdTokens,
            LongContextInputUsdPerMillion = template.LongContextInputUsdPerMillion,
            LongContextOutputUsdPerMillion = template.LongContextOutputUsdPerMillion,
            InputByteTokenMultiplier = 1, MaxOutputTokens = template.MaxOutputTokens,
            ExpectedLogicalModelPublicId = template.ExpectedLogicalModelPublicId,
            ExpectedProvider = template.ExpectedProvider, ExpectedModel = template.ExpectedModel,
            Status = "active", ActivatedByUserId = template.UserId,
            PptOperationPurpose = GatewayPptCompletionPurposes.Modification, PptModificationRunId = runId,
            PptModificationRequestHash = requestHash, PptModificationBaseFingerprint = ContextFingerprint(context),
            PptModificationPolicyId = current.PolicyId, PptModificationPolicyFingerprint = current.Fingerprint,
            PptModificationPriceBasis = current.PriceBasis, PptModificationPriceSource = current.PriceSource,
            PptModificationPriceObservedAtUtc = current.PriceObservedAtUtc,
            PptModificationPriceSourceUrl = current.PriceSourceUrl, PptModificationPriceIsEstimate = current.IsEstimate,
            ExpiresAt = current.ValidUntilUtc is { } until && until < now.Add(current.OperationLifetime)
                ? until : now.Add(current.OperationLifetime),
            CreatedAt = now, UpdatedAt = now,
        };
        GatewayPptCompletionStageBudgetRecord Stage(GatewayPptCompletionStageBudgetRecord policy)
        {
            if (policy.MaxPhysicalCalls <= 0 || policy.MaxBodyUtf8Bytes <= 0 || policy.MaxOutputTokens <= 0)
                throw Failure("ppt_edit_policy_missing", "演示稿修改发送包络无效，未创建任务");
            return new()
            {
                MaxPhysicalCalls = policy.MaxPhysicalCalls, MaxBodyUtf8Bytes = policy.MaxBodyUtf8Bytes,
                MaxOutputTokens = Math.Min(policy.MaxOutputTokens, next.MaxOutputTokens),
                PerCallUpperUsd = GatewayPptCompletionBudgetMath.PerCallUpper(next, policy.MaxBodyUtf8Bytes,
                    Math.Min(policy.MaxOutputTokens, next.MaxOutputTokens)),
            };
        }
        var generation = Stage(template.PptCompletion.GenerationAndRepairs);
        var manual = Stage(template.PptCompletion.ManualSave);
        var future = GatewayPptCompletionBudgetMath.FullEnvelope(generation, manual, template.PptCompletion.TailHeldUsd);
        next.AuthorizedLimitUsd = future;
        var canonical = JsonSerializer.Serialize(new { runId, requestHash, context, actualCommit, current.Fingerprint,
            next.ExpectedLogicalModelPublicId, next.ExpectedProvider, next.ExpectedModel,
            next.InputUsdPerMillion, next.OutputUsdPerMillion, next.LongContextThresholdTokens,
            next.LongContextInputUsdPerMillion, next.LongContextOutputUsdPerMillion, generation, manual, next.ExpiresAt });
        var contractHash = Hash(Encoding.UTF8.GetBytes(canonical));
        next.PptCompletion = new()
        {
            Id = "pptc_m_" + contractHash[..32], ContractHash = contractHash,
            CandidateCommit = actualCommit, RootOutlineRunId = next.RootOutlineRunId,
            StableSourceHash = next.SourcePlanHash, GenerationAndRepairs = generation, ManualSave = manual,
            TailHeldUsd = template.PptCompletion.TailHeldUsd, FutureHeldUsd = future, ExpiresAt = next.ExpiresAt,
        };
        return next;
    }

    private static void CheckReplay(GatewayRuntimeBudgetScopeRecord scope, HtmlPptEditContext expected,
        string runId, string requestHash)
    {
        if (scope.PptCompletion == null || scope.PptOperationPurpose != GatewayPptCompletionPurposes.Modification
            || scope.PptModificationRunId != runId
            || scope.PptModificationRequestHash != requestHash
            || scope.PptModificationBaseFingerprint != ContextFingerprint(expected))
            throw Failure("ppt_edit_request_conflict", "同一修改操作不能用于不同内容或版本，原稿未改变");
    }
    private static void CheckManualReplay(GatewayRuntimeBudgetScopeRecord scope, HtmlPptEditContext expected,
        string runId, string requestHash)
    {
        if (scope.PptCompletion == null || scope.PptOperationPurpose != GatewayPptCompletionPurposes.Modification
            || scope.PptPendingManualRunId != runId || scope.PptManualRequestHash != requestHash
            || scope.PptManualBaseFingerprint != ContextFingerprint(expected))
            throw Failure("ppt_edit_request_conflict", "同一人工保存不能用于不同草稿或内容，原稿未改变");
    }
    private static bool Hex(string? value, int length) => value?.Length == length && value.All(Uri.IsHexDigit);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static HtmlPptContinuationException Failure(string code, string message) => new(code, message);
}
