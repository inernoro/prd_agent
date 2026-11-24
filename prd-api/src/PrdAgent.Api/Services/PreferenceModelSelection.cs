using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>偏好写入只保存当前目录身份，防止旧页面在迁移后重新写回失效选择。</summary>
public static class PreferenceModelSelection
{
    public static bool TryNormalize(IEnumerable<ModelPoolForAppResult> catalog, string? requested, out string? canonical)
    {
        canonical = null;
        if (string.IsNullOrWhiteSpace(requested)) return true;
        var key = requested.Trim();
        var matches = catalog.Where(x => x.ResolutionType == "LogicalModel"
            && (key == x.Id || key == "pool_" + x.Id || x.LegacyPoolIds.Any(id => key == id || key == "pool_" + id)
                || GatewayLogicalModelIdentity.Accepts(key, x.Code, x.Aliases)))
            .GroupBy(x => x.Id, StringComparer.Ordinal).Take(2).ToList();
        if (matches.Count != 1) return false;
        canonical = "pool_" + matches[0].Key;
        return true;
    }
}
