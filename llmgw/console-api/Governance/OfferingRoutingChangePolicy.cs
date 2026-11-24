namespace PrdAgent.LlmGw.Governance;

public static class OfferingRoutingChangePolicy
{
    public static bool HasChanged(
        string? currentUpstreamModelId,
        string? currentProtocol,
        string? currentEndpointPath,
        string? requestedUpstreamModelId,
        string? requestedProtocol,
        string? requestedEndpointPath)
        => requestedUpstreamModelId is not null
           && !string.Equals(Normalize(currentUpstreamModelId), Normalize(requestedUpstreamModelId), StringComparison.Ordinal)
           || requestedProtocol is not null
           && !string.Equals(NormalizeProtocol(currentProtocol), NormalizeProtocol(requestedProtocol), StringComparison.Ordinal)
           || requestedEndpointPath is not null
           && !string.Equals(Normalize(currentEndpointPath), Normalize(requestedEndpointPath), StringComparison.Ordinal);

    private static string? Normalize(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? NormalizeProtocol(string? value)
        => Normalize(value)?.ToLowerInvariant();
}
