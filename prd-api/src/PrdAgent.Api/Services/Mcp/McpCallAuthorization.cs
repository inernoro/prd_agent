using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
namespace PrdAgent.Api.Services.Mcp;

public static class McpCallAuthorization
{
    public static string? RequiredScope(McpCallLog log, AgentApiKey? key, IReadOnlyList<string> permissions, DateTime now)
    {
        if (log.Status != "denied" || key == null || key.Id != log.KeyId || key.OwnerUserId != log.OwnerUserId
            || key.ScopeMode != AgentApiKeyScopeMode.Manual || !AgentApiKey.IsUsableAt(key, now, out _)) return null;
        var tool = McpBuiltinTools.All.FirstOrDefault(tool => tool.Name == log.ToolName);
        if (tool == null) return null;
        var scope = tool.RequiredScope;
        if (McpCapabilityCatalog.IsIssuancePermissionChecked(scope)
            && !McpCapabilityCatalog.PermissionsAllowScope(permissions, scope)) return null;
        var effective = McpCapabilityCatalog.EffectiveScopesFor(key.ScopeMode, key.Scopes, permissions)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return McpCapabilityCatalog.ScopeSatisfies(effective, scope) ? null : scope;
    }
}
