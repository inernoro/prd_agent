using System.Security.Cryptography;
using System.Text;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Auth;

public sealed record AuthFailureIncident(
    string Reason,
    string Scope,
    int Attempts,
    int AffectedIdentities,
    string? IdentityFingerprint,
    DateTime FirstSeenAt,
    DateTime LastSeenAt);

public sealed record AuthRecoveryObservation(
    string Reason,
    int Attempts,
    string IdentityFingerprint,
    DateTime RecoveredAt);

public static class AuthFailureHealthPolicy
{
    public const int DefaultThreshold = 3;

    public static IReadOnlyList<AuthFailureIncident> Evaluate(
        IReadOnlyList<LlmGwLoginAudit> samples,
        int threshold = DefaultThreshold)
    {
        var effectiveThreshold = Math.Clamp(threshold, 2, 20);
        var ordered = samples.OrderBy(item => item.CreatedAt).ToList();
        var openFailures = ordered
            .Where(item => !item.Success && !string.IsNullOrWhiteSpace(item.Reason))
            .Where(item => !ordered.Any(success =>
                success.Success
                && string.Equals(success.Username, item.Username, StringComparison.OrdinalIgnoreCase)
                && success.CreatedAt > item.CreatedAt))
            .ToList();

        var incidents = new List<AuthFailureIncident>();
        foreach (var identityGroup in openFailures.GroupBy(
                     item => new { Username = item.Username.ToLowerInvariant(), Reason = item.Reason! }))
        {
            var entries = identityGroup.ToList();
            if (entries.Count < effectiveThreshold) continue;
            incidents.Add(new AuthFailureIncident(
                identityGroup.Key.Reason,
                "identity",
                entries.Count,
                1,
                Fingerprint(identityGroup.Key.Username),
                entries[0].CreatedAt,
                entries[^1].CreatedAt));
        }

        foreach (var reasonGroup in openFailures.GroupBy(item => item.Reason!))
        {
            var entries = reasonGroup.ToList();
            var identities = entries.Select(item => item.Username).Distinct(StringComparer.OrdinalIgnoreCase).Count();
            if (identities < effectiveThreshold) continue;
            incidents.Add(new AuthFailureIncident(
                reasonGroup.Key,
                "platform",
                entries.Count,
                identities,
                null,
                entries[0].CreatedAt,
                entries[^1].CreatedAt));
        }

        return incidents
            .OrderByDescending(item => item.Scope == "platform")
            .ThenByDescending(item => item.LastSeenAt)
            .ToList();
    }

    public static IReadOnlyList<AuthRecoveryObservation> FindRecoveries(
        IReadOnlyList<LlmGwLoginAudit> samples)
    {
        return samples
            .GroupBy(item => item.Username, StringComparer.OrdinalIgnoreCase)
            .Select(group =>
            {
                var ordered = group.OrderBy(item => item.CreatedAt).ToList();
                var failures = ordered.Where(item => !item.Success && !string.IsNullOrWhiteSpace(item.Reason)).ToList();
                if (failures.Count == 0) return null;
                var lastFailure = failures[^1];
                var recovered = ordered.FirstOrDefault(item => item.Success && item.CreatedAt > lastFailure.CreatedAt);
                return recovered is null
                    ? null
                    : new AuthRecoveryObservation(
                        lastFailure.Reason!,
                        failures.Count,
                        Fingerprint(group.Key.ToLowerInvariant()),
                        recovered.CreatedAt);
            })
            .Where(item => item is not null)
            .Cast<AuthRecoveryObservation>()
            .OrderByDescending(item => item.RecoveredAt)
            .ToList();
    }

    private static string Fingerprint(string username) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(username)))
            .ToLowerInvariant()[..12];
}
