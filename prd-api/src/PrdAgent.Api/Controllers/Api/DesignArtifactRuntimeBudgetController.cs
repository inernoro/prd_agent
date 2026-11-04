using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Diagnostics;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/design-artifacts/runtime-budget")]
[Authorize]
public sealed class DesignArtifactRuntimeBudgetController(
    LlmGatewayDataContext gateway,
    IConfiguration configuration,
    ILogger<DesignArtifactRuntimeBudgetController> logger) : ControllerBase
{
    [HttpPost("activate")]
    public async Task<IActionResult> Activate(
        [FromBody] ActivateDesignArtifactRuntimeBudgetRequest request,
        CancellationToken ct)
    {
        if (!IsAiSuper()) return Forbid();
        var ownerId = this.GetRequiredUserId();
        var error = Validate(request);
        if (error is not null) return BadRequest(new { code = "task_budget_policy_invalid", error });
        var actualCommit = ActualRuntimeCommit();
        if (BuildIdentity.Compare(actualCommit, request.PptCompletion!.CandidateCommit) != BuildIdentity.MatchState.Match)
            return Conflict(new
            {
                code = "task_budget_candidate_commit_mismatch",
                error = "额度合同候选版本与当前受信服务二进制不一致，未激活任务",
            });
        var tenantId = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } configured
            ? configured
            : GatewayTenantDefaults.InternalTenantId;
        var sourcePlanHash = request.SourcePlanHash.Trim().ToLowerInvariant();
        var id = ScopeId(tenantId, ownerId, sourcePlanHash);
        var scopes = gateway.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var existing = await scopes.Find(item => item.Id == id).FirstOrDefaultAsync(ct);
        if (existing is not null)
        {
            if (existing.Status == "closed")
                return Conflict(new { code = "task_budget_scope_closed", error = "该任务额度作用域已关闭，已花与未知用量保持冻结" });
            if (!SamePolicy(existing, request))
                return Conflict(new { code = "task_budget_already_bound", error = "此任务已绑定不同预算策略，禁止静默扩大或重置" });
            return Ok(Receipt(existing));
        }

        var now = DateTime.UtcNow;
        var record = new GatewayRuntimeBudgetScopeRecord
        {
            Id = id,
            TenantId = tenantId,
            RootOutlineRunId = string.Empty,
            UserId = ownerId,
            SourcePlanHash = sourcePlanHash,
            ImmutableCarryUsd = request.ImmutableCarryUsd,
            AuthorizedLimitUsd = request.AuthorizedLimitUsd,
            SpentUsd = request.ImmutableCarryUsd,
            InputUsdPerMillion = request.InputUsdPerMillion,
            OutputUsdPerMillion = request.OutputUsdPerMillion,
            LongContextThresholdTokens = request.LongContextThresholdTokens,
            LongContextInputUsdPerMillion = request.LongContextInputUsdPerMillion,
            LongContextOutputUsdPerMillion = request.LongContextOutputUsdPerMillion,
            InputByteTokenMultiplier = 1,
            MaxOutputTokens = request.MaxOutputTokens,
            ExpectedLogicalModelPublicId = request.ExpectedLogicalModelPublicId.Trim(),
            ExpectedProvider = request.ExpectedProvider.Trim(),
            ExpectedModel = request.ExpectedModel.Trim(),
            ActivatedByUserId = ownerId,
            ExpiresAt = request.ExpiresAt.ToUniversalTime(),
            CreatedAt = now,
            UpdatedAt = now,
        };
        record.PptCompletion = BuildCompletion(record, request, now);
        try { await scopes.InsertOneAsync(record, cancellationToken: ct); }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return Conflict(new { code = "task_budget_already_bound", error = "此任务预算已由另一请求绑定，请读取现有回执" });
        }
        return Ok(Receipt(record));
    }

    [HttpGet("{scopeId}")]
    public async Task<IActionResult> Get(string scopeId, CancellationToken ct)
    {
        if (!IsAiSuper()) return Forbid();
        var ownerId = this.GetRequiredUserId();
        var scope = await gateway.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .Find(item => item.Id == scopeId.Trim() && item.UserId == ownerId)
            .FirstOrDefaultAsync(ct);
        return scope is null ? NotFound(new { code = "task_budget_not_found" }) : Ok(Receipt(scope));
    }

    [HttpPost("{scopeId}/close")]
    public async Task<IActionResult> Close(string scopeId, CancellationToken ct)
    {
        if (!IsAiSuper()) return Forbid();
        var ownerId = this.GetRequiredUserId();
        var normalizedScopeId = scopeId.Trim();
        if (normalizedScopeId.Length is < 8 or > 80)
            return BadRequest(new { code = "task_budget_scope_invalid" });
        var scopes = gateway.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var now = DateTime.UtcNow;
        var closed = await CloseScopeAsync(scopes, normalizedScopeId, ownerId, now, ct);
        if (closed is not null)
        {
            logger.LogInformation(
                "Task budget scope closed ScopeId={ScopeId} RootRunId={RootRunId} RequestCount={RequestCount}",
                closed.Id, closed.RootOutlineRunId, closed.Reservations.Count);
            return Ok(Receipt(closed));
        }

        var existing = await scopes.Find(item => item.Id == normalizedScopeId && item.UserId == ownerId)
            .FirstOrDefaultAsync(ct);
        if (existing is null) return NotFound(new { code = "task_budget_not_found" });
        if (existing.Status == "closed") return Ok(Receipt(existing));
        return Conflict(new
        {
            code = "task_budget_scope_busy",
            error = "任务仍有在途额度预占，须先确认所有模型请求终结后再关闭；已花与未知预占不会被清零",
        });
    }

    internal static async Task<GatewayRuntimeBudgetScopeRecord?> CloseScopeAsync(
        IMongoCollection<GatewayRuntimeBudgetScopeRecord> scopes,
        string scopeId,
        string ownerId,
        DateTime now,
        CancellationToken ct)
    {
        var common = Builders<GatewayRuntimeBudgetScopeRecord>.Filter.And(
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Id, scopeId),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.UserId, ownerId),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Status, "active"),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.ReservedUsd, 0m),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Not(
                    Builders<GatewayRuntimeBudgetScopeRecord>.Filter.ElemMatch(
                        item => item.Reservations,
                        reservation => reservation.Status == "reserved")));
        var closed = await scopes.FindOneAndUpdateAsync(
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.And(
                common,
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Ne(item => item.PptCompletion, null)),
            Builders<GatewayRuntimeBudgetScopeRecord>.Update
                .Set(item => item.Status, "closed")
                .Set(item => item.ClosedAt, now)
                .Set(item => item.ClosedByUserId, ownerId)
                .Set("PptCompletion.FutureHeldUsd", 0m)
                .Set("PptCompletion.Status", GatewayPptCompletionStatuses.Closed)
                .Set(item => item.UpdatedAt, now),
            new FindOneAndUpdateOptions<GatewayRuntimeBudgetScopeRecord> { ReturnDocument = ReturnDocument.After },
            ct);
        if (closed is not null) return closed;

        // 历史 scope 没有 Completion 子文档；不能对显式 null 父字段写子路径，否则 Mongo 会报
        // Cannot create field。旧记录只关闭外层 scope，既有已花与未知用量原样保留。
        return await scopes.FindOneAndUpdateAsync(
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.And(
                common,
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.PptCompletion, null)),
            Builders<GatewayRuntimeBudgetScopeRecord>.Update
                .Set(item => item.Status, "closed")
                .Set(item => item.ClosedAt, now)
                .Set(item => item.ClosedByUserId, ownerId)
                .Set(item => item.UpdatedAt, now),
            new FindOneAndUpdateOptions<GatewayRuntimeBudgetScopeRecord> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    private bool IsAiSuper() => string.Equals(
        User.FindFirst(AiAccessKeyAuthenticationHandler.ClaimTypeIsAiSuperAccess)?.Value,
        "1",
        StringComparison.Ordinal);

    internal static string? ActualRuntimeCommit()
    {
        var informationalVersion = typeof(DesignArtifactRuntimeBudgetController).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        return BuildIdentity.ParseBakedCommit(informationalVersion);
    }

    internal static string? Validate(ActivateDesignArtifactRuntimeBudgetRequest request)
    {
        var sourcePlanHash = request.SourcePlanHash?.Trim();
        if (sourcePlanHash?.Length != 64
            || sourcePlanHash.Any(ch => !Uri.IsHexDigit(ch))) return "sourcePlanHash 无效";
        if (request.ImmutableCarryUsd < 0 || request.AuthorizedLimitUsd <= request.ImmutableCarryUsd
            || request.AuthorizedLimitUsd > 500) return "授权金额边界无效";
        if (request.InputUsdPerMillion <= 0 || request.InputUsdPerMillion > 1_000
            || request.OutputUsdPerMillion <= 0 || request.OutputUsdPerMillion > 1_000)
            return "任务估算费率无效";
        if (request.LongContextThresholdTokens != 272_000
            || request.LongContextInputUsdPerMillion <= 0 || request.LongContextInputUsdPerMillion > 1_000
            || request.LongContextOutputUsdPerMillion <= 0 || request.LongContextOutputUsdPerMillion > 1_000)
            return "长上下文估算费率无效";
        if (request.MaxOutputTokens != 8_192) return "输出硬上限必须为 8192";
        if (!BoundedRoute(request.ExpectedLogicalModelPublicId, 128)
            || !BoundedRoute(request.ExpectedProvider, 128)
            || !BoundedRoute(request.ExpectedModel, 128)) return "任务物理路由无效";
        var expiry = request.ExpiresAt.ToUniversalTime();
        if (expiry <= DateTime.UtcNow.AddMinutes(5) || expiry > DateTime.UtcNow.AddDays(7)) return "任务预算有效期无效";
        if (request.PptCompletion is null) return "PPT 完成阶段预算合同不能为空";
        if (!Hex(request.PptCompletion.CandidateCommit, 40)) return "候选提交标识无效";
        if (!ValidStage(request.PptCompletion.GenerationAndRepairs, request.MaxOutputTokens)
            || !ValidStage(request.PptCompletion.ManualSave, request.MaxOutputTokens))
            return "PPT 完成阶段上限无效";
        if (request.PptCompletion.TailHeldUsd < 0
            || request.PptCompletion.TailHeldUsd > request.AuthorizedLimitUsd)
            return "PPT 尾部预留无效";
        try
        {
            var policy = PolicyShell(request);
            var generationUpper = GatewayPptCompletionBudgetMath.PerCallUpper(
                policy,
                request.PptCompletion.GenerationAndRepairs.MaxBodyUtf8Bytes,
                request.PptCompletion.GenerationAndRepairs.MaxOutputTokens);
            var manualUpper = GatewayPptCompletionBudgetMath.PerCallUpper(
                policy,
                request.PptCompletion.ManualSave.MaxBodyUtf8Bytes,
                request.PptCompletion.ManualSave.MaxOutputTokens);
            var envelope = checked(
                request.PptCompletion.GenerationAndRepairs.MaxPhysicalCalls * generationUpper
                + request.PptCompletion.ManualSave.MaxPhysicalCalls * manualUpper
                + request.PptCompletion.TailHeldUsd);
            if (request.ImmutableCarryUsd + envelope > request.AuthorizedLimitUsd)
                return "PPT 完成阶段联合包络超过授权总额";
        }
        catch (OverflowException)
        {
            return "PPT 完成阶段联合包络无效";
        }
        return null;
    }

    private static bool SamePolicy(
        GatewayRuntimeBudgetScopeRecord existing,
        ActivateDesignArtifactRuntimeBudgetRequest request)
        => existing.ImmutableCarryUsd == request.ImmutableCarryUsd
           && existing.AuthorizedLimitUsd == request.AuthorizedLimitUsd
           && existing.InputUsdPerMillion == request.InputUsdPerMillion
           && existing.OutputUsdPerMillion == request.OutputUsdPerMillion
           && existing.LongContextThresholdTokens == request.LongContextThresholdTokens
           && existing.LongContextInputUsdPerMillion == request.LongContextInputUsdPerMillion
           && existing.LongContextOutputUsdPerMillion == request.LongContextOutputUsdPerMillion
           && existing.InputByteTokenMultiplier == 1
           && existing.MaxOutputTokens == request.MaxOutputTokens
           && string.Equals(existing.SourcePlanHash, request.SourcePlanHash.Trim(), StringComparison.OrdinalIgnoreCase)
           && string.Equals(existing.ExpectedLogicalModelPublicId, request.ExpectedLogicalModelPublicId.Trim(), StringComparison.OrdinalIgnoreCase)
           && string.Equals(existing.ExpectedProvider, request.ExpectedProvider.Trim(), StringComparison.OrdinalIgnoreCase)
           && string.Equals(existing.ExpectedModel, request.ExpectedModel.Trim(), StringComparison.OrdinalIgnoreCase)
           && existing.PptCompletion is not null
           && string.Equals(
               existing.PptCompletion.ContractHash,
               BuildCompletion(PolicyShell(request), request, existing.CreatedAt).ContractHash,
               StringComparison.Ordinal);

    private static object Receipt(GatewayRuntimeBudgetScopeRecord scope) => new
    {
        scopeId = scope.Id,
        rootOutlineRunId = scope.RootOutlineRunId,
        sourcePlanFingerprint = scope.SourcePlanHash[..Math.Min(12, scope.SourcePlanHash.Length)],
        status = scope.Status,
        immutableCarryUsd = scope.ImmutableCarryUsd,
        spentUsd = scope.SpentUsd,
        reservedUsd = scope.ReservedUsd,
        futureHeldUsd = scope.PptCompletion?.FutureHeldUsd ?? 0m,
        authorizedLimitUsd = scope.AuthorizedLimitUsd,
        remainingUsd = Math.Max(
            0m,
            scope.AuthorizedLimitUsd - scope.SpentUsd - scope.ReservedUsd - (scope.PptCompletion?.FutureHeldUsd ?? 0m)),
        maxOutputTokens = scope.MaxOutputTokens,
        pricing = new
        {
            unit = "USD_PER_MILLION_TOKENS",
            standardInput = scope.InputUsdPerMillion,
            standardOutput = scope.OutputUsdPerMillion,
            longContextThresholdTokens = scope.LongContextThresholdTokens,
            longContextInput = scope.LongContextInputUsdPerMillion,
            longContextOutput = scope.LongContextOutputUsdPerMillion,
        },
        expectedLogicalModelPublicId = scope.ExpectedLogicalModelPublicId,
        expectedProvider = scope.ExpectedProvider,
        expectedModel = scope.ExpectedModel,
        requestCount = scope.Reservations.Count,
        inFlightCount = scope.Reservations.Count(item => item.Status == "reserved"),
        pptCompletion = scope.PptCompletion is null ? null : new
        {
            completionId = scope.PptCompletion.Id,
            contractHash = scope.PptCompletion.ContractHash,
            candidateCommit = scope.PptCompletion.CandidateCommit,
            rootOutlineRunId = scope.PptCompletion.RootOutlineRunId,
            generationRunId = scope.PptCompletion.GenerationRunId,
            manualRunId = scope.PptCompletion.ManualRunId,
            parentArtifactHash = scope.PptCompletion.ParentArtifactHash,
            parentPackageHash = scope.PptCompletion.ParentPackageHash,
            status = scope.PptCompletion.Status,
            futureHeldUsd = scope.PptCompletion.FutureHeldUsd,
            generationAndRepairs = StageReceipt(scope.PptCompletion.GenerationAndRepairs),
            manualSave = StageReceipt(scope.PptCompletion.ManualSave),
            tailHeldUsd = scope.PptCompletion.TailHeldUsd,
            expiresAt = scope.PptCompletion.ExpiresAt,
        },
        expiresAt = scope.ExpiresAt,
        closedAt = scope.ClosedAt,
    };

    private static string ScopeId(string tenantId, string ownerId, string sourceHash)
        => "pptb_" + Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes($"{tenantId}\n{ownerId}\n{sourceHash}"))).ToLowerInvariant()[..32];

    private static bool BoundedRoute(string? value, int max)
        => !string.IsNullOrWhiteSpace(value) && value.Trim().Length <= max;

    private static bool Hex(string? value, int length)
        => value?.Trim().Length == length && value.Trim().All(Uri.IsHexDigit);

    private static bool ValidStage(ActivatePptCompletionStageBudgetRequest stage, int scopeOutputCap)
        => stage.MaxPhysicalCalls is > 0 and <= 256
           && stage.MaxBodyUtf8Bytes is > 0 and <= 16_777_216
           && stage.MaxOutputTokens is > 0
           && stage.MaxOutputTokens <= scopeOutputCap;

    private static GatewayRuntimeBudgetScopeRecord PolicyShell(ActivateDesignArtifactRuntimeBudgetRequest request)
        => new()
        {
            InputUsdPerMillion = request.InputUsdPerMillion,
            OutputUsdPerMillion = request.OutputUsdPerMillion,
            LongContextThresholdTokens = request.LongContextThresholdTokens,
            LongContextInputUsdPerMillion = request.LongContextInputUsdPerMillion,
            LongContextOutputUsdPerMillion = request.LongContextOutputUsdPerMillion,
            InputByteTokenMultiplier = 1,
        };

    private static GatewayPptCompletionBudgetRecord BuildCompletion(
        GatewayRuntimeBudgetScopeRecord scope,
        ActivateDesignArtifactRuntimeBudgetRequest request,
        DateTime createdAt)
    {
        var input = request.PptCompletion!;
        var generationUpper = GatewayPptCompletionBudgetMath.PerCallUpper(
            scope, input.GenerationAndRepairs.MaxBodyUtf8Bytes, input.GenerationAndRepairs.MaxOutputTokens);
        var manualUpper = GatewayPptCompletionBudgetMath.PerCallUpper(
            scope, input.ManualSave.MaxBodyUtf8Bytes, input.ManualSave.MaxOutputTokens);
        var generation = new GatewayPptCompletionStageBudgetRecord
        {
            MaxPhysicalCalls = input.GenerationAndRepairs.MaxPhysicalCalls,
            MaxBodyUtf8Bytes = input.GenerationAndRepairs.MaxBodyUtf8Bytes,
            MaxOutputTokens = input.GenerationAndRepairs.MaxOutputTokens,
            PerCallUpperUsd = generationUpper,
        };
        var manual = new GatewayPptCompletionStageBudgetRecord
        {
            MaxPhysicalCalls = input.ManualSave.MaxPhysicalCalls,
            MaxBodyUtf8Bytes = input.ManualSave.MaxBodyUtf8Bytes,
            MaxOutputTokens = input.ManualSave.MaxOutputTokens,
            PerCallUpperUsd = manualUpper,
        };
        var future = GatewayPptCompletionBudgetMath.FullEnvelope(generation, manual, input.TailHeldUsd);
        var canonical = string.Join("\n", new[]
        {
            request.SourcePlanHash.Trim().ToLowerInvariant(), input.CandidateCommit.Trim().ToLowerInvariant(),
            request.ExpectedLogicalModelPublicId.Trim().ToLowerInvariant(), request.ExpectedProvider.Trim().ToLowerInvariant(),
            request.ExpectedModel.Trim().ToLowerInvariant(), request.InputUsdPerMillion.ToString(System.Globalization.CultureInfo.InvariantCulture),
            request.OutputUsdPerMillion.ToString(System.Globalization.CultureInfo.InvariantCulture),
            request.LongContextThresholdTokens.ToString(System.Globalization.CultureInfo.InvariantCulture),
            request.LongContextInputUsdPerMillion.ToString(System.Globalization.CultureInfo.InvariantCulture),
            request.LongContextOutputUsdPerMillion.ToString(System.Globalization.CultureInfo.InvariantCulture),
            generation.MaxPhysicalCalls.ToString(), generation.MaxBodyUtf8Bytes.ToString(), generation.MaxOutputTokens.ToString(),
            manual.MaxPhysicalCalls.ToString(), manual.MaxBodyUtf8Bytes.ToString(), manual.MaxOutputTokens.ToString(),
            input.TailHeldUsd.ToString(System.Globalization.CultureInfo.InvariantCulture), request.ExpiresAt.ToUniversalTime().ToString("O"),
        });
        var contractHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        return new GatewayPptCompletionBudgetRecord
        {
            Id = "pptc_" + contractHash[..32],
            ContractHash = contractHash,
            CandidateCommit = input.CandidateCommit.Trim().ToLowerInvariant(),
            StableSourceHash = request.SourcePlanHash.Trim().ToLowerInvariant(),
            Status = GatewayPptCompletionStatuses.Pending,
            FutureHeldUsd = future,
            GenerationAndRepairs = generation,
            ManualSave = manual,
            TailHeldUsd = input.TailHeldUsd,
            ExpiresAt = request.ExpiresAt.ToUniversalTime(),
        };
    }

    private static object StageReceipt(GatewayPptCompletionStageBudgetRecord stage) => new
    {
        maxPhysicalCalls = stage.MaxPhysicalCalls,
        usedPhysicalCalls = stage.UsedPhysicalCalls,
        maxBodyUtf8Bytes = stage.MaxBodyUtf8Bytes,
        maxOutputTokens = stage.MaxOutputTokens,
        perCallUpperUsd = stage.PerCallUpperUsd,
    };
}

public sealed class ActivateDesignArtifactRuntimeBudgetRequest
{
    public string SourcePlanHash { get; set; } = string.Empty;
    public decimal ImmutableCarryUsd { get; set; }
    public decimal AuthorizedLimitUsd { get; set; }
    public decimal InputUsdPerMillion { get; set; }
    public decimal OutputUsdPerMillion { get; set; }
    public long LongContextThresholdTokens { get; set; }
    public decimal LongContextInputUsdPerMillion { get; set; }
    public decimal LongContextOutputUsdPerMillion { get; set; }
    public int MaxOutputTokens { get; set; }
    public string ExpectedLogicalModelPublicId { get; set; } = string.Empty;
    public string ExpectedProvider { get; set; } = string.Empty;
    public string ExpectedModel { get; set; } = string.Empty;
    public DateTime ExpiresAt { get; set; }
    public ActivatePptCompletionBudgetRequest? PptCompletion { get; set; }
}

public sealed class ActivatePptCompletionBudgetRequest
{
    public string CandidateCommit { get; set; } = string.Empty;
    public ActivatePptCompletionStageBudgetRequest GenerationAndRepairs { get; set; } = new();
    public ActivatePptCompletionStageBudgetRequest ManualSave { get; set; } = new();
    public decimal TailHeldUsd { get; set; }
}

public sealed class ActivatePptCompletionStageBudgetRequest
{
    public int MaxPhysicalCalls { get; set; }
    public long MaxBodyUtf8Bytes { get; set; }
    public int MaxOutputTokens { get; set; }
}
