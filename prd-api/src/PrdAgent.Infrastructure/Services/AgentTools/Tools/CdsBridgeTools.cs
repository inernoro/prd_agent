using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class CdsBridgeSnapshotTool : IAgentTool
{
    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "cds_bridge_snapshot",
        Description = "Read a live CDS preview browser snapshot through the CDS Bridge. Use before browser actions to inspect URL, title, DOM tree, console errors, and network errors.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "branchId": { "type": "string", "description": "CDS branch id, for example prd-agent-main." },
            "description": { "type": "string", "description": "Human-visible reason shown in the bridge operation panel." }
          },
          "required": ["branchId"]
        }
        """
    };

    public Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        var branchId = CdsBridgeToolSupport.GetRequiredString(input, "branchId");
        var description = CdsBridgeToolSupport.GetOptionalString(input, "description")
            ?? "读取当前页面状态";
        return CdsBridgeToolSupport.SendCommandAsync(
            context,
            branchId,
            "snapshot",
            JsonDocument.Parse("{}").RootElement,
            description,
            ct);
    }
}

public sealed class CdsBridgeActionTool : IAgentTool
{
    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "cds_bridge_action",
        Description = "Operate a live CDS preview browser through the CDS Bridge after user approval. Supports click, type, scroll, spa-navigate, navigate, and evaluate actions.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "branchId": { "type": "string", "description": "CDS branch id, for example prd-agent-main." },
            "action": { "type": "string", "enum": ["click", "type", "scroll", "spa-navigate", "navigate", "evaluate"] },
            "params": { "type": "object", "description": "Bridge action params. Examples: {\"index\":6}, {\"index\":0,\"text\":\"hello\",\"clear\":true}, {\"url\":\"/settings\"}." },
            "description": { "type": "string", "description": "Human-visible explanation shown in the bridge operation panel." }
          },
          "required": ["branchId", "action", "description"]
        }
        """
    };

    public Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        var branchId = CdsBridgeToolSupport.GetRequiredString(input, "branchId");
        var action = CdsBridgeToolSupport.GetRequiredString(input, "action");
        var description = CdsBridgeToolSupport.GetRequiredString(input, "description");
        if (string.IsNullOrWhiteSpace(action))
        {
            return Task.FromResult(AgentToolInvokeResult.Fail("bridge_action_required", "action is required"));
        }
        if (string.IsNullOrWhiteSpace(description))
        {
            return Task.FromResult(AgentToolInvokeResult.Fail("description_required", "description is required"));
        }
        if (!CdsBridgeToolSupport.IsAllowedAction(action))
        {
            return Task.FromResult(AgentToolInvokeResult.Fail("bridge_action_not_allowed", $"action not allowed: {action}"));
        }

        var parameters = input.TryGetProperty("params", out var p) && p.ValueKind == JsonValueKind.Object
            ? p
            : JsonDocument.Parse("{}").RootElement;
        return CdsBridgeToolSupport.SendCommandAsync(context, branchId, action, parameters, description, ct);
    }
}

internal static class CdsBridgeToolSupport
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(30)
    };
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    public static async Task<AgentToolInvokeResult> SendCommandAsync(
        AgentToolInvocationContext context,
        string? branchId,
        string action,
        JsonElement parameters,
        string description,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(context.CdsBaseUrl))
            return AgentToolInvokeResult.Fail("cds_connection_missing", "CDS connection context is required");
        if (string.IsNullOrWhiteSpace(context.CdsLongToken))
            return AgentToolInvokeResult.Fail("cds_token_missing", "CDS long token is unavailable");
        if (string.IsNullOrWhiteSpace(branchId))
            return AgentToolInvokeResult.Fail("branch_id_required", "branchId is required");
        if (string.IsNullOrWhiteSpace(description))
            return AgentToolInvokeResult.Fail("description_required", "description is required");

        var endpoint = $"{context.CdsBaseUrl.TrimEnd('/')}/api/bridge/command/{Uri.EscapeDataString(branchId.Trim())}";
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint);
        req.Headers.Add("X-AI-Access-Key", context.CdsLongToken);
        req.Headers.UserAgent.Add(new ProductInfoHeaderValue("prd-agent-cds-bridge-tool", "1.0"));
        req.Content = new StringContent(JsonSerializer.Serialize(new
        {
            action,
            @params = parameters,
            description
        }, JsonOpts), Encoding.UTF8, "application/json");

        using var resp = await Http.SendAsync(req, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            return AgentToolInvokeResult.Fail(
                $"cds_bridge_http_{(int)resp.StatusCode}",
                Truncate(body, 2000));
        }

        return AgentToolInvokeResult.Ok(body);
    }

    public static string? GetOptionalString(JsonElement input, string property)
    {
        return input.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    public static string? GetRequiredString(JsonElement input, string property)
    {
        return GetOptionalString(input, property)?.Trim();
    }

    public static bool IsAllowedAction(string? action)
    {
        return action is "click" or "type" or "scroll" or "spa-navigate" or "navigate" or "evaluate";
    }

    private static string Truncate(string value, int max)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= max) return value;
        return value[..max];
    }
}
