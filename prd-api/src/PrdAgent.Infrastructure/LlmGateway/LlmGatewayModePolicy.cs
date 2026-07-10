namespace PrdAgent.Infrastructure.LlmGateway;

public static class LlmGatewayModePolicy
{
    private static readonly HashSet<string> AllowedModes = new(StringComparer.OrdinalIgnoreCase)
    {
        "http",
        "shadow",
        "inproc",
    };

    public static string Resolve(string? configuredMode, bool isProduction)
    {
        var normalized = configuredMode?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            if (isProduction)
            {
                throw new InvalidOperationException(
                    "LlmGateway:Mode 未配置；生产必须显式设置 http、shadow 或破玻璃回滚用 inproc。");
            }

            return "inproc";
        }

        if (!AllowedModes.Contains(normalized))
        {
            throw new InvalidOperationException(
                $"LlmGateway:Mode={configuredMode} 非法；允许值为 http、shadow、inproc。");
        }

        return normalized;
    }
}
