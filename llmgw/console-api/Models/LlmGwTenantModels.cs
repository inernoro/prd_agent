using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.LlmGw.Models;

public static class LlmGwTenantRoles
{
    public const string Owner = "owner";
    public const string Admin = "admin";
    public const string Developer = "developer";
    public const string Viewer = "viewer";
    public const string Billing = "billing";

    public static readonly HashSet<string> All = new(StringComparer.OrdinalIgnoreCase)
    {
        Owner,
        Admin,
        Developer,
        Viewer,
        Billing,
    };
}

[BsonIgnoreExtraElements]
public sealed class LlmGwTenant
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string NormalizedName { get; set; } = string.Empty;
    public string Slug { get; set; } = string.Empty;
    public string NormalizedSlug { get; set; } = string.Empty;
    public string Status { get; set; } = "active";
    public bool IsInternal { get; set; }
    [BsonRepresentation(BsonType.Decimal128)]
    public decimal? MonthlyBudgetUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)]
    public decimal? BudgetReservationUsd { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public bool OwnerAuthorityInitialized { get; set; }
    public List<string> ActiveOwnerMembershipIds { get; set; } = new();
    public long OwnerFenceGeneration { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class LlmGwTeam
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string NormalizedName { get; set; } = string.Empty;
    public string Status { get; set; } = "active";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class LlmGwMembership
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string Role { get; set; } = LlmGwTenantRoles.Viewer;
    public List<string> TeamIds { get; set; } = new();
    public string Status { get; set; } = "active";
    public long Version { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
