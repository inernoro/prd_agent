using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.BackgroundTasks;

/// <summary>消费已由控制台授权并预留预算的候选验收；一个队列身份最多发送一次。</summary>
public sealed class ModelUpgradeCanaryWorker(IServiceScopeFactory scopes, IConfiguration config,
    ILogger<ModelUpgradeCanaryWorker> logger) : BackgroundService
{
    internal const string Queue = "llmgw_model_upgrade_validation_runs";
    internal const string Policies = "llmgw_model_upgrade_policies";
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (Enabled(config)) await PollAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { logger.LogWarning("候选验收队列暂时不可用，将稍后检查；未自动重发付费请求。"); }
            try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    internal static bool Enabled(IConfiguration c)
    {
        if (!c.GetValue<bool>("LlmGateway:ModelUpgrades:CanaryEnabled")
            || string.IsNullOrWhiteSpace(c["LlmGateway:ModelUpgrades:CanaryDeployment"])) return false;
        if (!string.IsNullOrWhiteSpace(c["CDS_PROJECT_ID"]))
        {
            // 预览共享库不代表它获准消费 main 的模型验收队列。
            if (c["VITE_GIT_BRANCH"]?.Trim() != "main") return false;
        }
        else if (string.IsNullOrWhiteSpace(c[DeploymentAuthority.DeploymentIdentityKey])) return false;
        return c["LlmGateway:ModelUpgrades:CanaryDeployment"] == TaskPermitDeployment.Resolve(c);
    }

    private async Task PollAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var data = scope.ServiceProvider.GetRequiredService<LlmGatewayDataContext>();
        var queue = data.Database.GetCollection<BsonDocument>(Queue);
        var tenant = config["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } id ? id : GatewayTenantDefaults.InternalTenantId;
        // 崩溃后的任务不重新夺取执行：供应商可能已经收费，仅允许日志核账。
        await queue.UpdateManyAsync(new BsonDocument { { "TenantId", tenant }, { "Status", "running" },
            { "ExecutionDeadline", new BsonDocument("$lt", DateTime.UtcNow) } },
            new BsonDocument("$set", new BsonDocument { { "Status", "unknown" }, { "Message", "执行中断，等待既有日志核账；不会重发。" }, { "UpdatedAt", DateTime.UtcNow } }), cancellationToken: ct);
        var filter = new BsonDocument { { "TenantId", tenant }, { "Status", "pending" } };
        if (!config.GetValue<bool>("LlmGateway:ModelUpgrades:ScheduledCanaryEnabled")) filter.Add("ExecutionRequestedBy", "manual");
        var job = await queue.FindOneAndUpdateAsync(filter, new BsonDocument("$set", new BsonDocument {
            { "Status", "running" }, { "ExecutionDeadline", DateTime.UtcNow.AddMinutes(12) }, { "UpdatedAt", DateTime.UtcNow },
            { "ConsumerDeployment", TaskPermitDeployment.Resolve(config) } }),
            new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After }, ct);
        if (job is null) return;
        var status = "failed"; var message = "候选配置或授权已变化，未发起验收；请检查后重新登记。";
        var dispatchEntered = false;
        try
        {
            var validation = await ValidateAsync(data, scope.ServiceProvider.GetRequiredService<MongoDbContext>(), job, tenant, ct);
            if (validation is null) return;
            var (budget, type) = validation.Value;
            using var automatic = AutomaticTaskExecutionContext.Enter(TaskPermitDeployment.Resolve(config) + "/ModelUpgradeCanaryWorker/" + S(job, "_id"));
            var admission = scope.ServiceProvider.GetRequiredService<TaskAdmissionService>();
            var identity = await admission.AdmitModelUpgradeCanaryAsync(S(job, "_id"),
                TaskExecutionCoordinator.Fingerprint(job.ToJson()), S(job, "ActorUserId"), S(job, "AppCallerCode"),
                budget, S(job, "ExecutionRequestedBy") == "scheduled", ct);
            var executions = scope.ServiceProvider.GetRequiredService<ITaskExecutionCoordinator>();
            await using var lease = await executions.AcquireAsync(identity.PermitId, null, ct);
            using var execution = TaskExecutionContext.Enter(lease.Identity);
            var caller = S(job, "AppCallerCode");
            var client = scope.ServiceProvider.GetRequiredService<HttpLlmGatewayClient>();
            var resolved = await client.ResolveOfferingAsync(caller, type, S(job, "CandidateOfferingId"), ct);
            if (!MatchesResolution(job, resolved)) return;
            var context = new GatewayRequestContext { RequestId = S(job, "_id"), RunId = S(job, "_id"),
                TenantId = tenant, UserId = S(job, "ActorUserId"), SourceSystem = "map",
                SourceTask = "ModelUpgradeCanaryWorker:" + S(job, "_id") };
            var accessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();
            using var requestScope = accessor.BeginScope(new LlmRequestContext(S(job, "_id"), null, null,
                S(job, "ActorUserId"), null, null, null, null, AppCallerCode: caller,
                RunId: S(job, "_id"), TenantId: tenant, SourceSystem: "map"));
            dispatchEntered = true;
            if (type == ModelTypes.ImageGen)
            {
                var response = await client.GenerateImageAsync(new GatewayRawRequest { AppCallerCode = caller, ModelType = type,
                    RequiredLogicalModelPublicId = S(job, "CandidateLogicalModelPublicId"), RequiredOfferingId = S(job, "CandidateOfferingId"),
                    Context = context, TimeoutSeconds = 600,
                    CanonicalImageRequest = new() { Prompt = "A small blue circle on a plain white background.", Count = 1,
                        Size = "1024x1024", Quality = "low", ResponseFormat = "b64_json" } }, ct);
                status = response.Success && response.StatusCode is >= 200 and < 300 && HasImageOutput(response.Content) ? "succeeded" : "unknown";
            }
            else
            {
                var response = await client.SendAsync(new GatewayRequest { AppCallerCode = caller, ModelType = type,
                    ExpectedModel = S(job, "CandidateLogicalModelPublicId"), Context = context,
                    RequestBody = new JsonObject { ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "Reply OK." }), ["max_tokens"] = 16 },
                    TimeoutSeconds = 120 }, ct);
                status = response.Success && !string.IsNullOrWhiteSpace(response.Content) ? "succeeded" : "unknown";
            }
            message = status == "succeeded" ? "受限验收已完成，等待权威日志核验真实输出。" : "验收未获确定成功结果，仅核查既有日志，不会重发。";
        }
        catch (TaskExecutionAdmissionException) { status = dispatchEntered ? "unknown" : "failed"; }
        catch (Exception) { status = dispatchEntered ? "unknown" : "failed"; }
        finally
        {
            await queue.UpdateOneAsync(new BsonDocument { { "_id", job["_id"] }, { "Status", "running" } },
                new BsonDocument("$set", new BsonDocument { { "Status", status }, { "Message", message }, { "UpdatedAt", DateTime.UtcNow } }), cancellationToken: CancellationToken.None);
        }
    }

    private static async Task<(TaskBudgetContractPolicy Budget, string Type)?> ValidateAsync(LlmGatewayDataContext data,
        MongoDbContext map, BsonDocument job, string tenant, CancellationToken ct)
    {
        if (S(job, "TenantId") != tenant || !job.TryGetValue("ExpiresAt", out var expiry) || expiry.ToUniversalTime() <= DateTime.UtcNow) return null;
        var state = await Find(data, Policies, new BsonDocument { { "_id", S(job, "PolicyId") }, { "TenantId", tenant } }, ct);
        if (state is null || !MatchesPolicy(job, state)) return null;
        var actor = await map.Users.Find(x => x.UserId == S(job, "ActorUserId") && x.Status == UserStatus.Active).FirstOrDefaultAsync(ct);
        if (actor is null) return null;
        var consoleUser = await Find(data, "llmgw_console_users", new BsonDocument { { "_id", S(job, "ActorConsoleUserId") },
            { "IsActive", true }, { "IdentityProvider", "map" }, { "ExternalSubjectId", "map:" + actor.UserId } }, ct);
        var member = await Find(data, "llmgw_memberships", new BsonDocument { { "TenantId", tenant },
            { "UserId", S(job, "ActorConsoleUserId") }, { "Status", "active" }, { "Role", new BsonDocument("$in", new BsonArray { "owner", "admin" }) } }, ct);
        if (consoleUser is null || member is null) return null;
        var stable = await Find(data, "llmgw_logical_models", Scoped(tenant, S(job, "LogicalModelId")), ct);
        var provider = await Find(data, "llmgw_platforms", Scoped(tenant, S(job, "ProviderId")), ct);
        var model = await Find(data, "llmgw_models", Scoped(tenant, S(job, "ModelId")), ct);
        var offering = await Find(data, "llmgw_model_offerings", Scoped(tenant, S(job, "CandidateOfferingId")), ct);
        if (stable is null || provider is null || model is null || offering is null) return null;
        var fixedLogical = await Find(data, "llmgw_logical_models", Scoped(tenant, S(offering, "LogicalModelId")), ct);
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(new BsonArray(new[] { stable, provider, model }.Select(d =>
            new BsonDocument { { "id", d["_id"] }, { "updatedAt", d.GetValue("UpdatedAt", BsonNull.Value) } })).ToJson()))).ToLowerInvariant();
        if (fingerprint != S(job, "CandidateFingerprint") || !B(stable, "Enabled") || S(stable, "IdentityKind") != "stable"
            || fixedLogical is null || !B(fixedLogical, "Enabled")
            || S(fixedLogical, "PublicId") != S(job, "CandidateLogicalModelPublicId")
            || S(fixedLogical, "IdentityKind") == "stable" || !B(offering, "Enabled")
            || S(offering, "TargetKind") != "model" || S(offering, "TargetId") != S(job, "ModelId")
            || S(model, "PlatformId") != S(job, "ProviderId") || S(model, "ModelName") != S(job, "UpstreamModelId")
            || !B(provider, "Enabled") || !B(model, "Enabled")
            || S(provider, "Name") != S(job, "Provider") || S(model, "PriceCurrency") != "USD"
            || model.GetValue("UpdatedAt", BsonNull.Value).ToUniversalTime().ToString("O") != S(job, "PriceVersion")
            || !model.TryGetValue("PriceObservedAt", out var observed) || observed.IsBsonNull || observed.ToUniversalTime() < DateTime.UtcNow.AddDays(-30)) return null;
        var type = S(job, "ModelType");
        var upper = D(job, "UnitCostUpperBoundUsd");
        var perCall = S(job, "PricingBasis") == "per-call";
        if (type is not (ModelTypes.ImageGen or ModelTypes.Chat) || upper is <= 0 or > 10
            || perCall && (D(model, "PricePerCall") <= 0 || D(model, "PricePerCall") > upper)
            || !perCall && (D(model, "InputPricePerMillion") <= 0 || D(model, "OutputPricePerMillion") <= 0)
            || GatewayProtocolAliases.NormalizeAdapterKey(S(job, "Protocol")) != "openai"
            || type == ModelTypes.ImageGen && (perCall || !HasSufficientKnownImageEnvelope(S(model, "ModelName"), upper,
                D(model, "InputPricePerMillion"), D(model, "OutputPricePerMillion")))) return null;
        return (new TaskBudgetContractPolicy { AuthorizedLimitUsd = upper,
            CanaryUnitCostUpperBoundUsd = type == ModelTypes.ImageGen ? upper : null,
            ExpectedOfferingId = S(job, "CandidateOfferingId"), MaxOutputTokens = type == ModelTypes.ImageGen ? 1 : 16,
            LogicalModelPublicId = S(job, "CandidateLogicalModelPublicId"), Provider = S(job, "Provider"), Model = S(job, "UpstreamModelId"),
            Protocol = S(job, "Protocol"), PriceVersion = S(job, "PriceVersion"), InputUsdPerMillion = D(model, "InputPricePerMillion"),
            OutputUsdPerMillion = D(model, "OutputPricePerMillion"), CachedInputUsdPerMillion = Math.Max(D(model, "CachedInputPricePerMillion"), D(model, "InputPricePerMillion")), CacheWriteUsdPerMillion = Math.Max(D(model, "CacheWritePricePerMillion"), D(model, "InputPricePerMillion")) }, type);
    }

    internal static bool HasSufficientKnownImageEnvelope(string model, decimal upper, decimal inputRate, decimal outputRate)
    {
        // 官方 2.6 low/1024 方图输出估算 823 tokens；文本按最宽 200 字符及信封余量保守冻结。
        // 未登记的后继规格不能仅凭相似名称自动付费。此值是最低预占校验，不宣称供应商硬费用上限。
        if (model is not ("gpt-image-2.6" or "gpt-image-2.6-sunburst" or "gpt-image-2.6-flare")) return false;
        var minimum = 1056m * Math.Max(inputRate, 5m) / 1_000_000m
            + 823m * Math.Max(outputRate, 30m) / 1_000_000m;
        return upper >= minimum;
    }

    internal static bool MatchesPolicy(BsonDocument job, BsonDocument state)
    {
        var candidate = state.GetValue("Candidate", new BsonDocument()) as BsonDocument;
        var policy = state.GetValue("Policy", new BsonDocument()) as BsonDocument;
        if (candidate is null || policy is null) return false;
        return S(state, "TenantId") == S(job, "TenantId") && S(state, "LogicalModelId") == S(job, "LogicalModelId")
            && state.GetValue("Version", 0).ToInt64() >= job.GetValue("PolicyVersion", long.MaxValue).ToInt64()
            && S(candidate, "ValidationRequestId") == S(job, "_id") && S(candidate, "Fingerprint") == S(job, "CandidateFingerprint")
            && S(candidate, "ModelId") == S(job, "ModelId") && S(candidate, "ProviderId") == S(job, "ProviderId")
            && S(candidate, "UpstreamModelId") == S(job, "UpstreamModelId")
            && new[] { "ActorUserId", "ActorConsoleUserId", "ActorUsername" }.All(k => S(state, k).Length > 0 && S(state, k) == S(job, k))
            && S(job, "ExecutionRequestedBy") is "manual" or "scheduled"
            && (S(job, "ExecutionRequestedBy") == "manual" || B(policy, "Enabled") && B(policy, "AutoValidate"))
            && S(policy, "ValidationAppCallerCode") == S(job, "AppCallerCode")
            && D(policy, "MaxValidationCostUsd") == D(job, "MaxCostUsd") && D(policy, "MaxDailyCostUsd") == D(job, "MaxDailyCostUsd")
            && D(policy, "CanaryUnitCostUpperBoundUsd") == D(job, "UnitCostUpperBoundUsd")
            && D(job, "EstimatedCostUsd") == D(job, "UnitCostUpperBoundUsd")
            && D(job, "UnitCostUpperBoundUsd") > 0 && D(job, "UnitCostUpperBoundUsd") <= D(job, "MaxCostUsd")
            && D(state, "ReservedCostUsd") >= D(job, "UnitCostUpperBoundUsd") && D(state, "ReservedCostUsd") <= D(job, "MaxDailyCostUsd")
            && S(state, "BudgetDate") == DateTime.UtcNow.ToString("yyyy-MM-dd");
    }
    internal static bool MatchesResolution(BsonDocument job, GatewayModelResolution r) => r.Success
        && r.ActualPlatformId == S(job, "ProviderId") && r.ActualModel == S(job, "UpstreamModelId")
        && r.ActualPlatformName == S(job, "Provider") && r.OfferingId == S(job, "CandidateOfferingId")
        && r.LogicalModelPublicId == S(job, "CandidateLogicalModelPublicId")
        && GatewayProtocolAliases.NormalizeAdapterKey(r.Protocol ?? r.PlatformType) == GatewayProtocolAliases.NormalizeAdapterKey(S(job, "Protocol"));
    internal static bool HasImageOutput(string? content)
    {
        try { return JsonNode.Parse(content ?? "")?["data"] is JsonArray images && images.OfType<JsonObject>()
            .Any(i => !string.IsNullOrWhiteSpace(i["b64_json"]?.ToString()) || !string.IsNullOrWhiteSpace(i["url"]?.ToString())); }
        catch { return false; }
    }
    private static Task<BsonDocument?> Find(LlmGatewayDataContext d, string collection, BsonDocument filter, CancellationToken ct)
        => d.Database.GetCollection<BsonDocument>(collection).Find(filter).FirstOrDefaultAsync(ct)!;
    private static BsonDocument Scoped(string tenant, string id) => new() { { "TenantId", tenant }, { "_id", id } };
    private static string S(BsonDocument d, string k) => d.TryGetValue(k, out var v) && v.IsString ? v.AsString : "";
    private static bool B(BsonDocument d, string k) => d.TryGetValue(k, out var v) && v.IsBoolean && v.AsBoolean;
    private static decimal D(BsonDocument d, string k) => d.TryGetValue(k, out var v) && v.IsNumeric ? v.ToDecimal() : 0;
}
