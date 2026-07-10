using MongoDB.Driver;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// appCaller identity comparison must stay identical across passive registration,
/// governance reads, routing reads, deduplication and the unique index.
/// </summary>
public static class GatewayAppCallerIdentity
{
    public static Collation Collation { get; } =
        new("en", strength: CollationStrength.Secondary);

    public static string NormalizePart(string value)
        => value.Trim();
}
