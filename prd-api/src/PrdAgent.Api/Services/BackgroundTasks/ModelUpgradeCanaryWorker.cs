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
        var filter = PendingClaimFilter(tenant, DateTime.UtcNow, config.GetValue<bool>("LlmGateway:ModelUpgrades:ScheduledCanaryEnabled"), TaskPermitDeployment.Resolve(config));
        var job = await queue.FindOneAndUpdateAsync(filter, new BsonDocument("$set", new BsonDocument {
            { "Status", "running" }, { "ExecutionDeadline", DateTime.UtcNow.AddMinutes(12) }, { "UpdatedAt", DateTime.UtcNow },
            { "ConsumerDeployment", TaskPermitDeployment.Resolve(config) } }),
            new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After }, ct);
        if (job is null) return;
        var status = "failed"; var message = "候选配置或授权已变化，未发起验收；请检查后重新登记。";
        var dispatchEntered = false;
        var probeFields = new BsonDocument();
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
            await using var lease = await AcquireCanaryLeaseAsync(executions, identity, S(job, "_id"), ct);
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
            if (type == ModelTypes.ImageGen)
            {
                var imageRequest = new GatewayRawRequest { AppCallerCode = caller, ModelType = type,
                    RequiredLogicalModelPublicId = S(job, "CandidateLogicalModelPublicId"), RequiredOfferingId = S(job, "CandidateOfferingId"),
                    Context = context, TimeoutSeconds = 600,
                    CanonicalImageRequest = new() { Prompt = "A small blue circle on a plain white background.", Count = 1,
                        Size = "1024x1024", Quality = "low", ResponseFormat = "b64_json" } };
                dispatchEntered = true;
                var response = await client.GenerateImageAsync(imageRequest, ct);
                probeFields["HttpStatus"] = response.StatusCode;
                probeFields["FailureKind"] = ClassifyProbeFailure(response.StatusCode, string.IsNullOrWhiteSpace(response.Content) ? response.ErrorMessage : response.Content);
                status = response.Success && response.StatusCode is >= 200 and < 300 && HasImageOutput(response.Content) ? "succeeded" : "unknown";
                if (S(job, "Operation") == "binding-test" && response.Success && response.StatusCode is >= 200 and < 300)
                {
                    if (!TryDecodeProbeImage(response.Content, out var bytes))
                    { status = "failed"; probeFields["FailureKind"] = "invalid_output"; }
                    else
                    {
                        status = "succeeded";
                        try
                        {
                            var mime = SixLabors.ImageSharp.Image.DetectFormat(bytes).DefaultMimeType;
                            var asset = await scope.ServiceProvider.GetRequiredService<PrdAgent.Infrastructure.Services.AssetStorage.IAssetStorage>().SaveAsync(bytes, mime, ct);
                            probeFields["OutputUrl"] = asset.Url;
                        }
                        catch { logger.LogWarning("线路测试已收到真实图片，但预览存储未完成；不会重发测试请求。"); }
                    }
                }
            }
            else
            {
                var chatRequest = CreateChatCanaryRequest(job, context);
                dispatchEntered = true;
                var response = await client.SendRawWithResolutionAsync(chatRequest, resolved, ct);
                probeFields["HttpStatus"] = response.StatusCode;
                probeFields["FailureKind"] = ClassifyProbeFailure(response.StatusCode, string.IsNullOrWhiteSpace(response.Content) ? response.ErrorMessage : response.Content);
                status = response.Success && response.StatusCode is >= 200 and < 300 && (HasChatOutput(response.Content) || S(job, "Operation") == "binding-test" && HasClaudeProbeOutput(response.Content, S(job, "Protocol"))) ? "succeeded" : "unknown";
            }
            if (S(job, "Operation") == "binding-test" && probeFields.TryGetValue("HttpStatus", out var http) && http.ToInt32() >= 400)
            {
                status = "failed";

            }
            message = status == "succeeded" ? "受限验收已完成，等待权威日志核验真实输出。" : "验收未获确定成功结果，仅核查既有日志，不会重发。";
            if (S(job, "Operation") == "binding-test") message = status == "succeeded" ? "所选线路已返回真实产物，服务测试通过。" : S(probeFields, "FailureKind") switch {
                "quota_exhausted" => "余额或额度不足，请补充对应上游账户额度后再发起新测试。",
                "rate_limited" => "请求受到限流，请稍后发起新测试。",
                "rejected" => "请求被上游拒绝，请核对所选线路的密钥和模型权限。",
                "upstream_error" => "上游服务未完成请求，请检查线路诊断后再测试。",
                _ => "未获得确定可用产物，请核对本次请求日志；不会自动重发。" };
        }
        catch (TaskExecutionAdmissionException) { status = dispatchEntered ? "unknown" : "failed"; }
        catch (Exception) { status = dispatchEntered ? "unknown" : "failed"; }
        finally
        {
            var completion = CompletionFields(status, message, dispatchEntered, DateTime.UtcNow);
            completion.Merge(probeFields);
            await queue.UpdateOneAsync(new BsonDocument { { "_id", job["_id"] }, { "Status", "running" } },
                new BsonDocument("$set", completion), cancellationToken: CancellationToken.None);
        }
    }

    internal static async Task<(TaskBudgetContractPolicy Budget, string Type)?> ValidateAsync(LlmGatewayDataContext data,
        MongoDbContext map, BsonDocument job, string tenant, CancellationToken ct)
    {
        if (S(job, "TenantId") != tenant || !job.TryGetValue("ExpiresAt", out var expiry) || expiry.ToUniversalTime() <= DateTime.UtcNow) return null;
        var bindingTest = S(job, "Operation") == "binding-test";
        var state = bindingTest ? null : await Find(data, Policies, new BsonDocument { { "_id", S(job, "PolicyId") }, { "TenantId", tenant } }, ct);
        if (!bindingTest && (state is null || !MatchesPolicy(job, state))) return null;
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
        var effectiveProtocol = !string.IsNullOrWhiteSpace(S(offering, "Protocol")) ? S(offering, "Protocol")
            : !string.IsNullOrWhiteSpace(S(model, "Protocol")) ? S(model, "Protocol") : S(provider, "PlatformType");
        if (!MatchesOfferingSnapshot(job, offering, effectiveProtocol)) return null;
        var fixedLogical = await Find(data, "llmgw_logical_models", Scoped(tenant, S(offering, "LogicalModelId")), ct);
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(new BsonArray(new[] { stable, provider, model }.Select(d =>
            new BsonDocument { { "id", d["_id"] }, { "updatedAt", d.GetValue("UpdatedAt", BsonNull.Value) } })).ToJson()))).ToLowerInvariant();
        if (fingerprint != S(job, "CandidateFingerprint") || !B(stable, "Enabled") || (!bindingTest && S(stable, "IdentityKind") != "stable")
            || fixedLogical is null || !B(fixedLogical, "Enabled")
            || S(fixedLogical, "PublicId") != S(job, "CandidateLogicalModelPublicId")
            || (!bindingTest && S(fixedLogical, "IdentityKind") == "stable") || !B(offering, "Enabled")
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
            || bindingTest && (upper > 1 || S(job, "ExecutionRequestedBy") != "manual" || S(job, "LogicalModelId") != S(offering, "LogicalModelId") || string.IsNullOrWhiteSpace(S(job, "ProbeRequestFingerprint")))
            || perCall && (D(model, "PricePerCall") <= 0 || D(model, "PricePerCall") > upper)
            || !perCall && (D(model, "InputPricePerMillion") <= 0 || D(model, "OutputPricePerMillion") <= 0)
            || GatewayProtocolAliases.NormalizeAdapterKey(S(job, "Protocol")) != "openai" && !(bindingTest && type == ModelTypes.Chat && GatewayProtocolAliases.IsClaudeProtocol(S(job, "Protocol")))
            || type == ModelTypes.ImageGen && (perCall || !HasSufficientKnownImageEnvelope(S(model, "ModelName"), upper,
                D(model, "InputPricePerMillion"), D(model, "OutputPricePerMillion")))) return null;
        return (new TaskBudgetContractPolicy { AuthorizedLimitUsd = upper,
            CanaryUnitCostUpperBoundUsd = type == ModelTypes.ImageGen ? upper : null,
            ExpectedOfferingId = S(job, "CandidateOfferingId"), MaxOutputTokens = type == ModelTypes.ImageGen ? 1 : bindingTest ? 256 : 16,
            LogicalModelPublicId = S(job, "CandidateLogicalModelPublicId"), Provider = S(job, "Provider"), Model = S(job, "UpstreamModelId"),
            Protocol = S(job, "Protocol"), PriceVersion = S(job, "PriceVersion"), InputUsdPerMillion = D(model, "InputPricePerMillion"),
            OutputUsdPerMillion = D(model, "OutputPricePerMillion"), CachedInputUsdPerMillion = Math.Max(D(model, "CachedInputPricePerMillion"), D(model, "InputPricePerMillion")), CacheWriteUsdPerMillion = Math.Max(D(model, "CacheWritePricePerMillion"), D(model, "InputPricePerMillion")) }, type);
    }

    internal static Task<TaskExecutionLease> AcquireCanaryLeaseAsync(ITaskExecutionCoordinator executions,
        TaskExecutionIdentity admission, string requestId, CancellationToken ct)
        => executions.AcquireAsync(admission.PermitId, requestId, ct);

    internal static BsonDocument PendingClaimFilter(string tenant, DateTime now, bool allowScheduled, string? deployment = null)
    {
        var filter = new BsonDocument { { "TenantId", tenant }, { "Status", "pending" }, { "ExpiresAt", new BsonDocument("$gt", now) } };
        filter.Add("$or", new BsonArray { new BsonDocument("Operation", new BsonDocument("$ne", "binding-test")),
            new BsonDocument { { "Operation", "binding-test" }, { "TargetDeployment", deployment ?? "" } } });
        if (!allowScheduled) filter.Add("ExecutionRequestedBy", "manual");
        return filter;
    }

    internal static BsonDocument CompletionFields(string status, string message, bool dispatchEntered, DateTime now)
        => new() { { "Status", status }, { "Message", message }, { "UpdatedAt", now }, { "UnsentConfirmed", !dispatchEntered } };

    internal static bool MatchesOfferingSnapshot(BsonDocument job, BsonDocument offering, string effectiveProtocol)
        => S(job, "OfferingVersion").Length > 0
           && OfferingWireVersion(offering) == S(job, "OfferingVersion")
           && job.Contains("EndpointPath") && S(job, "EndpointPath") == S(offering, "EndpointPath")
           && GatewayProtocolAliases.NormalizeAdapterKey(S(job, "Protocol")) == GatewayProtocolAliases.NormalizeAdapterKey(effectiveProtocol);

    internal static string OfferingWireVersion(BsonDocument offering)
    {
        // 与控制台队列合同同序；健康、权重和 UpdatedAt 不是请求 wire 身份。
        var wire = new BsonArray { offering.GetValue("_id", ""), offering.GetValue("LogicalModelId", ""),
            offering.GetValue("TargetKind", "model"), offering.GetValue("TargetId", ""),
            offering.GetValue("UpstreamModelId", BsonNull.Value), offering.GetValue("Protocol", BsonNull.Value),
            offering.GetValue("EndpointPath", BsonNull.Value), offering.GetValue("Enabled", false) };
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(wire.ToJson()))).ToLowerInvariant();
    }

    internal static GatewayRawRequest CreateChatCanaryRequest(BsonDocument job, GatewayRequestContext context)
        => new() { AppCallerCode = S(job, "AppCallerCode"), ModelType = ModelTypes.Chat,
            RequiredLogicalModelPublicId = S(job, "CandidateLogicalModelPublicId"), RequiredOfferingId = S(job, "CandidateOfferingId"),
            ExpectedModel = S(job, "CandidateLogicalModelPublicId"), Context = context,
            EndpointPath = S(job, "EndpointPath") is { Length: > 0 } endpoint ? endpoint : GatewayProtocolAliases.IsClaudeProtocol(S(job, "Protocol")) ? "messages" : "chat/completions",
            RequestBody = new JsonObject { ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "Reply OK." }),
                ["max_tokens"] = S(job, "Operation") == "binding-test" ? 256 : 16, ["stream"] = false }, TimeoutSeconds = 120 };

    internal static bool HasChatOutput(string? content)
    {
        try
        {
            if (JsonNode.Parse(content ?? "")?["choices"] is not JsonArray choices) return false;
            return choices.OfType<JsonObject>().Any(choice => choice["message"]?["content"] switch {
                JsonValue value => value.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text),
                JsonArray parts => parts.OfType<JsonObject>().Any(part => part["text"] is JsonValue textValue
                    && textValue.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)),
                _ => false });
        }
        catch { return false; }
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
        && (r.OfferingEndpointPath ?? "") == S(job, "EndpointPath")
        && GatewayProtocolAliases.NormalizeAdapterKey(r.Protocol ?? r.PlatformType) == GatewayProtocolAliases.NormalizeAdapterKey(S(job, "Protocol"));
    internal static bool TryDecodeProbeImage(string? content, out byte[] bytes)
    {
        bytes = [];
        try
        {
            if (content is null || content.Length > 15_000_000) return false;
            var encoded = (JsonNode.Parse(content)?["data"] as JsonArray)?.OfType<JsonObject>().Select(image => image["b64_json"]?.ToString()).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
            if (encoded is not { Length: > 0 and < 14_000_000 }) return false;
            var candidate = Convert.FromBase64String(encoded);
            var info = SixLabors.ImageSharp.Image.Identify(candidate);
            if (info is null || info.Width <= 0 || info.Height <= 0 || info.Width > 2048 || info.Height > 2048) return false;
            using var decoded = SixLabors.ImageSharp.Image.Load(new SixLabors.ImageSharp.Formats.DecoderOptions { MaxFrames = 1, SkipMetadata = true }, candidate);
            bytes = candidate; return decoded.Width > 0;
        }
        catch { return false; }
    }
    internal static bool HasClaudeProbeOutput(string? content, string protocol)
    {
        if (!GatewayProtocolAliases.IsClaudeProtocol(protocol)) return false;
        try { return JsonNode.Parse(content ?? "")?["content"] is JsonArray parts && parts.OfType<JsonObject>().Any(part => part["type"]?.ToString() == "text" && !string.IsNullOrWhiteSpace(part["text"]?.ToString())); }
        catch { return false; }
    }
    internal static string ClassifyProbeFailure(int status, string? diagnostic)
        => status < 400 ? "" : PrdAgent.GatewayTransport.UpstreamQuotaPolicy.IsExceeded(status, diagnostic) ? "quota_exhausted"
            : status == 429 ? "rate_limited" : status is 401 or 403 ? "rejected"
            : status >= 400 ? "upstream_error" : "";
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
