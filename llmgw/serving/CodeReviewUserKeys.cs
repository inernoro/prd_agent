using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.LlmGatewayHost;

// Personal credentials never become a platform, offering, or model-pool member.
[BsonIgnoreExtraElements]
public sealed class CodeReviewUserKey
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Owner { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Provider { get; set; } = "";
    public string Ciphertext { get; set; } = "";
    public string Fingerprint { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
[BsonIgnoreExtraElements]
public sealed class CodeReviewUserKeyTask
{
    public string Id { get; set; } = "";
    public string KeyId { get; set; } = "";
    public string Owner { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Model { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public string TokenCiphertext { get; set; } = "";
    public long TokenLimit { get; set; }
    // Conservative reservations are retained on unknown usage/failure, including process death.
    public long ReservedTokens { get; set; }
    public int Calls { get; set; }
    public DateTime ExpiresAt { get; set; }
    public bool Closed { get; set; }
}
public sealed record CodeReviewKeyBind(string Owner, string ProjectId, string TaskId, string Provider,
    string Model, string ApiKey, long TokenLimit = 200000);

public sealed record CodeReviewUserKeyEndpoint;

public static class CodeReviewUserKeys
{
    public const string AuthorityItem = "llmgw.code-review-user-key.authority";
    public const string PhysicalAdmissionItem = "llmgw.code-review-user-key.physical-admission";
    public const string ResolutionItem = "llmgw.code-review-user-key.resolution";
    public const string Caller = "cds.code-review::chat";
    public static readonly IReadOnlyDictionary<string, (string Url, string Protocol)> Providers =
        new Dictionary<string, (string, string)>(StringComparer.Ordinal)
        {
            ["openai"] = ("https://api.openai.com/v1", "openai"),
            ["anthropic"] = ("https://api.anthropic.com", "claude"),
            ["openrouter"] = ("https://openrouter.ai/api/v1", "openai"),
            ["deepseek"] = ("https://api.deepseek.com/v1", "openai"),
        };
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static bool ManagementAuthorized(HttpContext http, IConfiguration config)
    {
        var expected = config["CodeReview:ServiceKey"];
        var actual = http.Request.Headers["X-Code-Review-Service-Key"].ToString();
        return !string.IsNullOrWhiteSpace(expected) && CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(actual)), SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
    }
    private static string Secret(IConfiguration config)
    {
        var value = config["ApiKeyCrypto:Secret"];
        if (string.IsNullOrWhiteSpace(value) || Encoding.UTF8.GetByteCount(value) < 32)
            throw new InvalidOperationException("Dedicated credential encryption is not configured");
        return value;
    }
    private static string Decrypt(string ciphertext, IConfiguration config)
    {
        var result = ApiKeyCryptoKeyRing.Decrypt(ciphertext, config);
        if (!result.Success || string.IsNullOrEmpty(result.PlainText)) throw new InvalidOperationException("Credential cannot be decrypted");
        return result.PlainText;
    }
    public static void MapCodeReviewUserKeys(this WebApplication app)
    {
        app.MapPost("/internal/code-review/user-keys/bind", async (HttpContext http, IConfiguration config, LlmGatewayDataContext data) =>
        {
            if (!ManagementAuthorized(http, config)) return Results.Unauthorized();
            var input = await http.Request.ReadFromJsonAsync<CodeReviewKeyBind>();
            if (input is null || string.IsNullOrEmpty(input.Provider) || string.IsNullOrEmpty(input.Owner) || string.IsNullOrEmpty(input.ProjectId) || string.IsNullOrEmpty(input.TaskId) || string.IsNullOrEmpty(input.Model) || string.IsNullOrEmpty(input.ApiKey) || !Providers.ContainsKey(input.Provider) || input.Owner.Length is < 1 or > 200
                || input.ProjectId.Length is < 1 or > 100 || input.TaskId.Length is < 1 or > 100
                || input.Model.Length is < 1 or > 200 || input.Model.Any(char.IsControl)
                || input.ApiKey.Length is < 8 or > 4096 || input.ApiKey.Any(char.IsWhiteSpace)
                || input.TokenLimit is < 4096 or > 10000000) return Results.BadRequest(new { error = "invalid_user_key_binding" });
            var keys = data.Database.GetCollection<CodeReviewUserKey>("llmgw_code_review_user_keys");
            var tasks = data.Database.GetCollection<CodeReviewUserKeyTask>("llmgw_code_review_user_key_tasks");
            var scope = config["CodeReview:Issuer"] ?? "cds";
            var taskId = Hash(scope + ":" + input.ProjectId + ":" + input.TaskId);
            // HMAC fingerprint is scoped to owner and project, never a public raw-key hash.
            var fingerprint = Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret(config)),
                Encoding.UTF8.GetBytes(scope + ":" + input.Owner + ":" + input.ProjectId + ":" + input.Provider + ":" + input.ApiKey)));
            var keyId = fingerprint.ToLowerInvariant();
            var old = await tasks.Find(x => x.Id == taskId).FirstOrDefaultAsync();
            if (old is not null && (old.KeyId != keyId || old.Owner != input.Owner || old.Model != input.Model || old.TokenLimit != input.TokenLimit))
                return Results.Conflict(new { error = "immutable_user_key_binding" });
            var key = new CodeReviewUserKey { Id = keyId, Owner = input.Owner, ProjectId = input.ProjectId,
                Provider = input.Provider, Ciphertext = ApiKeyCrypto.Encrypt(input.ApiKey, Secret(config)), Fingerprint = keyId[..12] };
            await keys.UpdateOneAsync(x => x.Id == keyId, Builders<CodeReviewUserKey>.Update
                .SetOnInsert(x => x.Owner, key.Owner).SetOnInsert(x => x.ProjectId, key.ProjectId)
                .SetOnInsert(x => x.Provider, key.Provider).SetOnInsert(x => x.Ciphertext, key.Ciphertext)
                .SetOnInsert(x => x.Fingerprint, key.Fingerprint).SetOnInsert(x => x.CreatedAt, key.CreatedAt), new UpdateOptions { IsUpsert = true });
            var token = "cruk_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var task = old ?? new CodeReviewUserKeyTask { Id = taskId, KeyId = keyId, Owner = input.Owner,
                ProjectId = input.ProjectId, Model = input.Model, TokenLimit = input.TokenLimit,
                TokenHash = Hash(token), TokenCiphertext = ApiKeyCrypto.Encrypt(token, Secret(config)), ExpiresAt = DateTime.UtcNow.AddDays(7) };
            if (old is null)
            {
                try { await tasks.InsertOneAsync(task); }
                catch (MongoWriteException e) when (e.WriteError.Category == ServerErrorCategory.DuplicateKey)
                { return Results.Conflict(new { error = "binding_in_progress" }); }
            }
            return Results.Json(new { bindingId = task.Id, keyId, fingerprint = key.Fingerprint, provider = key.Provider,
                model = task.Model, tokenLimit = task.TokenLimit });
        }).WithMetadata(new CodeReviewUserKeyEndpoint());
        app.MapGet("/internal/code-review/user-keys/{id}", async (string id, HttpContext http, IConfiguration config, LlmGatewayDataContext data) =>
        {
            if (!ManagementAuthorized(http, config)) return Results.Unauthorized();
            var task = await data.Database.GetCollection<CodeReviewUserKeyTask>("llmgw_code_review_user_key_tasks").Find(x => x.Id == id).FirstOrDefaultAsync();
            if (task is null || task.Owner != http.Request.Query["owner"].ToString() || task.ProjectId != http.Request.Query["projectId"].ToString()) return Results.NotFound();
            if (http.Request.Query["binding"] == "1")
            {
                if (task.Closed || task.ExpiresAt <= DateTime.UtcNow) return Results.Conflict(new { error = "user_key_binding_expired" });
                return Results.Json(new { token = Decrypt(task.TokenCiphertext, config), model = task.Model });
            }
            // Same physical request log used by the gateway usage console. Missing usage is never zero.
            var logs = await data.Context.LlmRequestLogs.Find(x => x.ServiceKeyId == "user-key:" + task.KeyId
                && x.RunId == task.Id).ToListAsync();
            var all = await data.Context.LlmRequestLogs.Find(x => x.ServiceKeyId == "user-key:" + task.KeyId).ToListAsync();
            return Results.Json(new { task = Summarize(logs), key = Summarize(all), reservedTokens = task.ReservedTokens,
                tokenLimit = task.TokenLimit, calls = task.Calls, credentialSource = "user", accountBalance = (decimal?)null });
        }).WithMetadata(new CodeReviewUserKeyEndpoint());
        app.MapPost("/internal/code-review/user-keys/{id}/close", async (string id, HttpContext http, IConfiguration config, LlmGatewayDataContext data) =>
        {
            if (!ManagementAuthorized(http, config)) return Results.Unauthorized();
            var owner = http.Request.Query["owner"].ToString(); var project = http.Request.Query["projectId"].ToString();
            await data.Database.GetCollection<CodeReviewUserKeyTask>("llmgw_code_review_user_key_tasks").UpdateOneAsync(
                x => x.Id == id && x.Owner == owner && x.ProjectId == project, Builders<CodeReviewUserKeyTask>.Update.Set(x => x.Closed, true));
            return Results.NoContent();
        }).WithMetadata(new CodeReviewUserKeyEndpoint());
        app.MapPost("/byok/v1/chat/completions", Invoke).WithMetadata(new CodeReviewUserKeyEndpoint());
    }
    private static object Summarize(List<LlmRequestLog> logs) => new {
        requests = logs.Count, inputTokens = logs.Count > 0 && logs.All(x => x.InputTokens.HasValue) ? logs.Sum(x => (long)x.InputTokens!.Value) : (long?)null,
        outputTokens = logs.Count > 0 && logs.All(x => x.OutputTokens.HasValue) ? logs.Sum(x => (long)x.OutputTokens!.Value) : (long?)null,
        providerActualUsd = logs.Count > 0 && logs.All(x => x.ProviderReportedCost.HasValue && x.ProviderCostCurrency == "USD") ? logs.Sum(x => x.ProviderReportedCost!.Value) : (decimal?)null,
        estimatedCostUsd = logs.Count > 0 && logs.All(x => x.EstimatedCostUsd.HasValue) ? logs.Sum(x => x.EstimatedCostUsd!.Value) : (decimal?)null,
        costKind = logs.Count > 0 && logs.All(x => x.EstimatedCostUsd.HasValue) ? "estimated" : "unknown",
        unknownUsageRequests = logs.Count(x => !x.InputTokens.HasValue || !x.OutputTokens.HasValue)
    };
    private static async Task<IResult> Invoke(HttpContext http, IConfiguration config, LlmGatewayDataContext data)
    {
        var raw = http.Request.Headers.Authorization.ToString();
        if (!raw.StartsWith("Bearer cruk_", StringComparison.Ordinal)) return Results.Unauthorized();
        var tasks = data.Database.GetCollection<CodeReviewUserKeyTask>("llmgw_code_review_user_key_tasks");
        var tokenHash = Hash(raw[7..]);
        var task = await tasks.Find(x => x.TokenHash == tokenHash && !x.Closed && x.ExpiresAt > DateTime.UtcNow).FirstOrDefaultAsync(http.RequestAborted);
        if (task is null) return Results.Unauthorized();
        if (http.Request.ContentLength > 1024 * 1024) return Results.StatusCode(413);
        JsonObject? body;
        try { body = await http.Request.ReadFromJsonAsync<JsonObject>(cancellationToken: http.RequestAborted); }
        catch { return Results.BadRequest(new { error = "invalid_request" }); }
        if (body is null || body["messages"] is not JsonArray || body["stream"]?.GetValue<bool>() == true)
            return Results.BadRequest(new { error = "non_streaming_chat_required" });
        var key = await data.Database.GetCollection<CodeReviewUserKey>("llmgw_code_review_user_keys").Find(x => x.Id == task.KeyId).FirstOrDefaultAsync(http.RequestAborted);
        if (key is null || key.Owner != task.Owner || key.ProjectId != task.ProjectId || !Providers.TryGetValue(key.Provider, out var provider)) return Results.Unauthorized();
        body["model"] = task.Model;
        var output = body["max_tokens"] is JsonValue cap && cap.TryGetValue<int>(out var requested) ? Math.Clamp(requested, 1, 4096) : 4096;
        body.Remove("max_completion_tokens"); body["max_tokens"] = output;
        // The existing adapters handle all provider protocols. A request-scoped resolver never reaches the platform pool.
        http.Items[AuthorityItem] = task;
        http.Items[ResolutionItem] = new ModelResolutionResult { Success = true, ResolutionType = "UserKey",
            ActualModel = task.Model, ActualPlatformId = "user-key:" + key.Id, ActualPlatformName = "用户 Key · " + key.Provider,
            ApiUrl = provider.Url, ApiKey = Decrypt(key.Ciphertext, config), PlatformType = provider.Protocol, Protocol = provider.Protocol,
            MaxTokens = 4096, PriceCurrency = "USD", ResolutionReason = "用户自带 Key；无平台回退" };
        var tenant = config["LlmGateway:InternalTenantId"] ?? GatewayTenantDefaults.InternalTenantId;
        var context = new GatewayRequestContext { TenantId = tenant, ServiceKeyId = "user-key:" + key.Id,
            ClientCode = "cds-user-key", SourceSystem = "external", UserId = task.Owner, GroupId = task.ProjectId,
            RunId = task.Id, LogicalRequestId = task.Id, RequestId = Guid.NewGuid().ToString("N") };
        http.Items["llmgw.key.authorization"] = new GatewayKeyAuthorization(true, true, 200, "", "用户 Key",
            KeyId: context.ServiceKeyId, TenantId: tenant, ClientCode: context.ClientCode, AuthenticatedSourceSystem: "external");
        http.Items[GatewayInvocationAuthority.PaidAdmissionKey] = true;
        http.Items[GatewayInvocationAuthority.AdmittedCallerKey] = Caller;
        using var logScope = GatewayHttpEndpoints.OpenContextScope(http.RequestServices.GetRequiredService<ILLMRequestContextAccessor>(), context, "chat", Caller);
        var gateway = http.RequestServices.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.LlmGateway>();
        var response = await gateway.SendWithAdmissionAsync(new GatewayRequest { AppCallerCode = Caller, ModelType = "chat",
            ExpectedModel = task.Model, PinnedPlatformId = "user-key:" + key.Id, PinnedModelId = task.Model,
            RequestBody = body, Context = context, TimeoutSeconds = 120 }, async (physical, ct) => {
            var tokens = checked((long)physical.RequestBodyUtf8Bytes + physical.EffectiveMaxOutputTokens + 1024);
            var admitted = await tasks.FindOneAndUpdateAsync(x => x.Id == task.Id && !x.Closed && x.ExpiresAt > DateTime.UtcNow
                && x.Calls < 256 && x.ReservedTokens <= x.TokenLimit - tokens,
                Builders<CodeReviewUserKeyTask>.Update.Inc(x => x.ReservedTokens, tokens).Inc(x => x.Calls, 1), cancellationToken: ct);
            if (admitted is not null) http.Items[PhysicalAdmissionItem] = true;
            return admitted is null ? GatewayResponse.Fail("USER_KEY_TOKEN_LIMIT", "用户 Key 任务额度已用尽", 429) : null;
        }, http.RequestAborted);
        if (!response.Success) return Results.Json(new { error = new { code = response.ErrorCode, message = "用户 Key 调用失败；未使用平台额度" } }, statusCode: response.StatusCode is >= 400 and <= 599 ? response.StatusCode : 502);
        return Results.Json(new { id = context.RequestId, @object = "chat.completion", model = task.Model,
            choices = new[] { new { index = 0, message = new { role = "assistant", content = response.Content }, finish_reason = "stop" } },
            usage = response.TokenUsage is null ? null : new { prompt_tokens = response.TokenUsage.InputTokens, completion_tokens = response.TokenUsage.OutputTokens, total_tokens = response.TokenUsage.TotalTokens } });
    }
}

// The binding lives only in the current HTTP request. No singleton credentials, global env changes, or fallback.
public sealed class CodeReviewUserKeyResolver(PrdAgent.Infrastructure.LlmGateway.ModelResolver inner, IHttpContextAccessor accessor) : IModelResolver
{
    private ModelResolutionResult? Bound => accessor.HttpContext?.Items[CodeReviewUserKeys.ResolutionItem] as ModelResolutionResult;
    public Task<ModelResolutionResult> ResolveAsync(string caller, string type, string? expected = null, string? platform = null, string? model = null, CancellationToken ct = default)
        => Bound is { } bound ? Task.FromResult(caller == CodeReviewUserKeys.Caller && platform == bound.ActualPlatformId && model == bound.ActualModel
            ? bound : ModelResolutionResult.NotFound(expected, "用户 Key 路由不匹配", GatewayRouteFailure.OfferingUnresolvable)) : inner.ResolveAsync(caller, type, expected, platform, model, ct);
    public Task<ModelResolutionResult> ResolveMetadataAsync(string caller, string type, string? expected = null, string? platform = null, string? model = null, CancellationToken ct = default)
        => Bound is not null ? ResolveAsync(caller, type, expected, platform, model, ct) : inner.ResolveMetadataAsync(caller, type, expected, platform, model, ct);
    public Task<ModelResolutionResult> ResolveOfferingAsync(string caller, string type, string offering, CancellationToken ct = default)
        => Bound is not null ? Task.FromResult(ModelResolutionResult.NotFound(offering, "用户 Key 不支持模型池回退", GatewayRouteFailure.OfferingUnresolvable)) : inner.ResolveOfferingAsync(caller, type, offering, ct);
    public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string caller, string type, CancellationToken ct = default)
        => Bound is not null ? Task.FromResult(new List<AvailableModelPool>()) : inner.GetAvailablePoolsAsync(caller, type, ct);
    public Task RecordSuccessAsync(ModelResolutionResult r, CancellationToken ct = default) => Bound is not null ? Task.CompletedTask : inner.RecordSuccessAsync(r, ct);
    public Task RecordFailureAsync(ModelResolutionResult r, CancellationToken ct = default) => Bound is not null ? Task.CompletedTask : inner.RecordFailureAsync(r, ct);
    public Task RecordUnavailableAsync(ModelResolutionResult r, CancellationToken ct = default) => Bound is not null ? Task.CompletedTask : inner.RecordUnavailableAsync(r, ct);
}
