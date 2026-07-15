using System.Text.RegularExpressions;

namespace PrdAgent.LlmGw.Organization;

public static class MembershipPolicy
{
    private const int MaxCanonicalUsernameLength = 128;
    private const string DeveloperRole = "developer";
    private const string OwnerRole = "owner";
    private static readonly Regex AccountNamePattern = new(
        "^[a-z0-9][a-z0-9._-]{2,47}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static bool TryCanonicalizeUsername(string tenantSlug, string requested, out string username)
    {
        var prefix = $"{tenantSlug.Trim().ToLowerInvariant()}.";
        var accountName = requested.Trim().ToLowerInvariant();
        if (accountName.StartsWith(prefix, StringComparison.Ordinal))
            accountName = accountName[prefix.Length..];
        username = prefix + accountName;
        return AccountNamePattern.IsMatch(accountName) && username.Length <= MaxCanonicalUsernameLength;
    }

    public static bool AllowsIdempotentReplay(string? auditState, bool auditSuccess)
        => auditSuccess && string.Equals(auditState, "completed", StringComparison.Ordinal);

    public static bool HasUsableDeveloperScope(
        string role,
        IReadOnlyCollection<string> teamIds,
        IReadOnlySet<string> activeTeamIds)
        => role != DeveloperRole
           || teamIds.Count > 0 && teamIds.All(activeTeamIds.Contains);

    public static bool RemovesActiveOwner(
        string currentRole,
        string currentStatus,
        string? requestedRole,
        string? requestedStatus)
        => currentRole == OwnerRole
           && currentStatus == "active"
           && (requestedRole is not null && requestedRole != OwnerRole
               || requestedStatus == "disabled");
}
