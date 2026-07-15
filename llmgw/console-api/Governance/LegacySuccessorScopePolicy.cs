namespace PrdAgent.LlmGw.Governance;

public static class LegacySuccessorScopePolicy
{
    public static IReadOnlyList<string> RequiredRuntimeScopes { get; } =
    [
        "invoke",
        "stream:invoke",
        "raw:invoke",
        "route:read",
        "readiness:read",
        "request:cancel",
        "request:read",
    ];

    public static IReadOnlyList<string> FindMissing(
        IEnumerable<string>? configuredValues,
        IEnumerable<string>? requiredValues)
    {
        var configured = Normalize(configuredValues);
        if (configured.Contains("*"))
            return [];

        return Normalize(requiredValues)
            .Where(required => !configured.Contains(required))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToList();
    }

    private static HashSet<string> Normalize(IEnumerable<string>? values)
        => values?
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value.Trim().ToLowerInvariant())
            .ToHashSet(StringComparer.Ordinal)
           ?? new HashSet<string>(StringComparer.Ordinal);
}
