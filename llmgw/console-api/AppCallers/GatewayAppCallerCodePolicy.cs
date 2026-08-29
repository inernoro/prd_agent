using PrdAgent.LlmGw.ModelPools;

namespace PrdAgent.LlmGw.AppCallers;

public static class GatewayAppCallerCodePolicy
{
    public static bool IsValidSelfService(string? appCallerCode, string? requestType)
    {
        var code = appCallerCode?.Trim() ?? string.Empty;
        var type = requestType?.Trim().ToLowerInvariant() ?? string.Empty;
        if (code.Length is 0 or > 200 || GatewayModelPoolTypeRegistry.Find(type) is null)
            return false;

        var separator = code.IndexOf("::", StringComparison.Ordinal);
        if (separator <= 0 || separator != code.LastIndexOf("::", StringComparison.Ordinal))
            return false;

        var declaredType = code[(separator + 2)..];
        if (!string.Equals(declaredType, type, StringComparison.Ordinal))
            return false;

        var segments = code[..separator].Split('.', StringSplitOptions.None);
        return segments.Length >= 2
               && segments.All(IsKebabCaseSegment)
               && IsKebabCaseSegment(declaredType);
    }

    private static bool IsKebabCaseSegment(string value)
        => value.Length > 0
           && value[0] is >= 'a' and <= 'z'
           && value.All(ch => ch is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');
}
