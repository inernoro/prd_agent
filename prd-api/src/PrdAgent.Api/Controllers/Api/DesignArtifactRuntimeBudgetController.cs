using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Extensions;
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
        var closed = await scopes.FindOneAndUpdateAsync(
            Builders<GatewayRuntimeBudgetScopeRecord>.Filter.And(
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Id, scopeId),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.UserId, ownerId),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.Status, "active"),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Eq(item => item.ReservedUsd, 0m),
                Builders<GatewayRuntimeBudgetScopeRecord>.Filter.Not(
                    Builders<GatewayRuntimeBudgetScopeRecord>.Filter.ElemMatch(
                        item => item.Reservations,
                        reservation => reservation.Status == "reserved"))),
            Builders<GatewayRuntimeBudgetScopeRecord>.Update
                .Set(item => item.Status, "closed")
                .Set(item => item.ClosedAt, now)
                .Set(item => item.ClosedByUserId, ownerId)
                .Set(item => item.UpdatedAt, now),
            new FindOneAndUpdateOptions<GatewayRuntimeBudgetScopeRecord> { ReturnDocument = ReturnDocument.After },
            ct);
        return closed;
    }

    private bool IsAiSuper() => string.Equals(
        User.FindFirst(AiAccessKeyAuthenticationHandler.ClaimTypeIsAiSuperAccess)?.Value,
        "1",
        StringComparison.Ordinal);

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
           && string.Equals(existing.ExpectedModel, request.ExpectedModel.Trim(), StringComparison.OrdinalIgnoreCase);

    private static object Receipt(GatewayRuntimeBudgetScopeRecord scope) => new
    {
        scopeId = scope.Id,
        rootOutlineRunId = scope.RootOutlineRunId,
        sourcePlanFingerprint = scope.SourcePlanHash[..Math.Min(12, scope.SourcePlanHash.Length)],
        status = scope.Status,
        immutableCarryUsd = scope.ImmutableCarryUsd,
        spentUsd = scope.SpentUsd,
        reservedUsd = scope.ReservedUsd,
        authorizedLimitUsd = scope.AuthorizedLimitUsd,
        remainingUsd = Math.Max(0m, scope.AuthorizedLimitUsd - scope.SpentUsd - scope.ReservedUsd),
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
        expiresAt = scope.ExpiresAt,
        closedAt = scope.ClosedAt,
    };

    private static string ScopeId(string tenantId, string ownerId, string sourceHash)
        => "pptb_" + Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes($"{tenantId}\n{ownerId}\n{sourceHash}"))).ToLowerInvariant()[..32];

    private static bool BoundedRoute(string? value, int max)
        => !string.IsNullOrWhiteSpace(value) && value.Trim().Length <= max;
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
}
