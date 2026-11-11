namespace PrdAgent.Core.LlmGateway;

/// <summary>精确模型身份与显式兼容标识共用的判据；不存在任意模型代选。</summary>
public static class GatewayLogicalModelIdentity
{
    public static bool Accepts(string? requested, string? canonical, IEnumerable<string>? aliases)
    {
        if (string.IsNullOrWhiteSpace(requested) || string.IsNullOrWhiteSpace(canonical)) return false;
        var key = requested.Trim();
        return string.Equals(key, canonical.Trim(), StringComparison.OrdinalIgnoreCase)
            || aliases?.Any(alias => string.Equals(key, alias?.Trim(), StringComparison.OrdinalIgnoreCase)) == true;
    }
}
