namespace PrdAgent.Api.Services;

/// <summary>拒绝客户端尝试覆盖由 MAP 统一掌控的运行时权威字段。</summary>
public static class DesignArtifactRequestAuthorityGuard
{
    public const string ErrorCode = "RUNTIME_AUTHORITY_OVERRIDE_REJECTED";

    private static readonly HashSet<string> ProtectedFields = new(StringComparer.OrdinalIgnoreCase)
    {
        "model",
        "modelBaseUrl",
        "baseUrl",
        "apiKey",
        "modelApiKey",
        "modelPoolId",
        "modelPolicy",
        "auditOwner",
        "appCallerCode",
        "sourceSystem",
        "authority",
    };

    public static IReadOnlyList<string> FindProtectedOverrides(IEnumerable<string>? propertyNames)
        => propertyNames?
            .Where(ProtectedFields.Contains)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ToArray()
           ?? Array.Empty<string>();
}
