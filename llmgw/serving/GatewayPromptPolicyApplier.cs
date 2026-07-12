using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.LlmGatewayHost;

public sealed record GatewayPromptPolicyApplication(
    bool Success,
    GatewayRequest Request,
    string? ErrorCode = null,
    string? ErrorMessage = null);

public static partial class GatewayPromptPolicyApplier
{
    private static readonly HashSet<string> SupportedVariables = new(StringComparer.Ordinal)
    {
        "tenantId", "teamId", "appCallerCode", "requestType", "sourceSystem",
    };

    public static async Task<GatewayPromptPolicyApplication> ApplyAsync(
        IServiceProvider services,
        GatewayRequest request,
        CancellationToken ct)
    {
        var requestType = request.ModelType.Trim().ToLowerInvariant();
        if (requestType is not ("chat" or "vision"))
            return new(true, request);

        var tenantId = request.Context?.TenantId?.Trim();
        if (string.IsNullOrWhiteSpace(tenantId))
            return new(false, request, "PROMPT_POLICY_TENANT_UNAVAILABLE", "提示词策略缺少服务端租户上下文");

        var data = services.GetService<LlmGatewayDataContext>();
        if (data is null) return new(true, request);
        var policies = data.Database.GetCollection<BsonDocument>("llmgw_prompt_policies");
        var fb = Builders<BsonDocument>.Filter;
        var filter = fb.And(
            fb.Eq("TenantId", tenantId),
            fb.Eq("AppCallerCode", request.AppCallerCode.Trim().ToLowerInvariant()),
            fb.Eq("RequestType", requestType));
        var candidates = await policies.Find(filter)
            .Sort(Builders<BsonDocument>.Sort.Descending("Version"))
            .Limit(20)
            .ToListAsync(ct);
        var teamId = request.Context?.TeamId?.Trim();
        var policy = candidates
            .OrderByDescending(x => !string.IsNullOrWhiteSpace(teamId)
                                    && string.Equals(x.GetValue("TeamId", BsonNull.Value).IsString ? x["TeamId"].AsString : null, teamId, StringComparison.Ordinal))
            .ThenByDescending(x => x.GetValue("Version", 0).ToInt32())
            .FirstOrDefault(x => !x.TryGetValue("TeamId", out var scopedTeam)
                                 || scopedTeam.IsBsonNull
                                 || string.IsNullOrWhiteSpace(scopedTeam.AsString)
                                 || string.Equals(scopedTeam.AsString, teamId, StringComparison.Ordinal));
        if (policy is null || policy.GetValue("Enabled", false).ToBoolean() == false) return new(true, request);

        var allowed = policy.GetValue("AllowedVariables", new BsonArray()).AsBsonArray
            .Where(x => x.IsString && SupportedVariables.Contains(x.AsString))
            .Select(x => x.AsString)
            .ToHashSet(StringComparer.Ordinal);
        var variables = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["tenantId"] = tenantId,
            ["teamId"] = teamId ?? string.Empty,
            ["appCallerCode"] = request.AppCallerCode,
            ["requestType"] = requestType,
            ["sourceSystem"] = request.Context?.SourceSystem ?? string.Empty,
        };
        var prefix = Render(policy.GetValue("SystemPromptPrefix", string.Empty).AsString, allowed, variables);
        var suffix = Render(policy.GetValue("SystemPromptSuffix", string.Empty).AsString, allowed, variables);
        var policyChars = prefix.Length + suffix.Length;
        var maxChars = Math.Clamp(policy.GetValue("MaxChars", 8000).ToInt32(), 1, 20000);
        if (policyChars > maxChars)
            return new(false, request, "PROMPT_POLICY_TOO_LONG", $"提示词策略渲染后为 {policyChars} 字符，超过上限 {maxChars}");

        var body = request.GetEffectiveRequestBody().DeepClone().AsObject();
        ApplyToStandardMessages(body, prefix, suffix);
        var context = request.Context ?? new GatewayRequestContext();
        context.PromptPolicyId = policy.GetValue("_id", string.Empty).AsString;
        context.PromptPolicyVersion = policy.GetValue("Version", 0).ToInt32();
        context.PromptPolicyHash = policy.GetValue("PolicyHash", string.Empty).AsString;
        context.PromptPolicyChars = policyChars;
        return new(true, CopyWithBody(request, body, context));
    }

    public static void ApplyToStandardMessages(JsonObject body, string prefix, string suffix)
    {
        var messages = body["messages"] as JsonArray ?? new JsonArray();
        var systemParts = new List<string>();
        for (var index = messages.Count - 1; index >= 0; index--)
        {
            if (messages[index] is not JsonObject message
                || !string.Equals(message["role"]?.GetValue<string>(), "system", StringComparison.OrdinalIgnoreCase))
                continue;
            if (message["content"] is JsonValue value && value.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text))
                systemParts.Insert(0, text);
            else if (message["content"] is { } content)
                systemParts.Insert(0, content.ToJsonString());
            messages.RemoveAt(index);
        }
        var merged = string.Join("\n\n", new[] { prefix, string.Join("\n\n", systemParts), suffix }
            .Where(x => !string.IsNullOrWhiteSpace(x)));
        if (!string.IsNullOrWhiteSpace(merged))
            messages.Insert(0, new JsonObject { ["role"] = "system", ["content"] = merged });
        body["messages"] = messages;
    }

    private static string Render(string template, HashSet<string> allowed, IReadOnlyDictionary<string, string> variables)
        => VariablePattern().Replace(template, match =>
        {
            var name = match.Groups[1].Value;
            return allowed.Contains(name) && variables.TryGetValue(name, out var value) ? value : match.Value;
        });

    private static GatewayRequest CopyWithBody(GatewayRequest source, JsonObject body, GatewayRequestContext context) => new()
    {
        AppCallerCode = source.AppCallerCode,
        ModelType = source.ModelType,
        ExpectedModel = source.ExpectedModel,
        PinnedPlatformId = source.PinnedPlatformId,
        PinnedModelId = source.PinnedModelId,
        RequestBody = body,
        Stream = source.Stream,
        EnablePromptCache = source.EnablePromptCache,
        TimeoutSeconds = source.TimeoutSeconds,
        IncludeThinking = source.IncludeThinking,
        Context = context,
    };

    [GeneratedRegex("\\{\\{([A-Za-z][A-Za-z0-9]*)\\}\\}")]
    private static partial Regex VariablePattern();
}
