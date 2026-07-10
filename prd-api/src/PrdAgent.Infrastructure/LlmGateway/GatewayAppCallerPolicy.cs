namespace PrdAgent.Infrastructure.LlmGateway;

public static class GatewayAppCallerPolicy
{
    private static readonly HashSet<string> AllowedStatuses = new(StringComparer.Ordinal)
    {
        "discovered",
        "configured",
        "active",
    };

    public static string NormalizeStatus(string? status)
        => string.IsNullOrWhiteSpace(status) ? "discovered" : status.Trim().ToLowerInvariant();

    public static bool AllowsTraffic(string? status)
        => AllowedStatuses.Contains(NormalizeStatus(status));
}
