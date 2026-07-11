using System.Security.Claims;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Auth;

public sealed record TenantAccessContext(
    string TenantId,
    string TenantName,
    string UserId,
    string Username,
    string MembershipId,
    long MembershipVersion,
    string Role,
    IReadOnlyList<string> TeamIds);

public static class LlmGwPermissions
{
    public const string LogsRead = "logs:read";
    public const string RequestBodyRead = "request-body:read";
    public const string UsageRead = "usage:read";
    public const string AuditRead = "audit:read";
    public const string ConfigWrite = "config:write";
    public const string OrganizationWrite = "organization:write";
    public const string TenantOwner = "tenant:owner";

    public static bool Allows(string role, string permission) => role switch
    {
        LlmGwTenantRoles.Owner => true,
        LlmGwTenantRoles.Admin => permission is LogsRead or RequestBodyRead or UsageRead or AuditRead or ConfigWrite or OrganizationWrite,
        LlmGwTenantRoles.Developer => permission is LogsRead or RequestBodyRead or UsageRead,
        LlmGwTenantRoles.Viewer => permission is LogsRead or RequestBodyRead or UsageRead,
        LlmGwTenantRoles.Billing => permission is UsageRead,
        _ => false,
    };
}

public static class TenantAccess
{
    public const string ItemKey = "llmgw.tenant.access";
    public const string TenantClaim = "tenant_id";
    public const string RoleClaim = "tenant_role";
    public const string MembershipClaim = "membership_id";
    public const string MembershipVersionClaim = "membership_version";

    public static TenantAccessContext GetRequired(HttpContext http)
        => http.Items.TryGetValue(ItemKey, out var value) && value is TenantAccessContext context
            ? context
            : throw new UnauthorizedAccessException("tenant context is not available");

    public static FilterDefinition<BsonDocument> Filter(HttpContext http)
        => Builders<BsonDocument>.Filter.Eq("TenantId", GetRequired(http).TenantId);

    public static FilterDefinition<BsonDocument> Filter(HttpContext http, FilterDefinition<BsonDocument> filter)
        => Builders<BsonDocument>.Filter.And(Filter(http), filter);

    public static FilterDefinition<T> Filter<T>(HttpContext http, FilterDefinition<T> filter)
        => Builders<T>.Filter.And(
            Builders<T>.Filter.Eq("TenantId", GetRequired(http).TenantId),
            filter);

    public static bool HasPermission(ClaimsPrincipal user, string permission)
    {
        var role = user.FindFirst(RoleClaim)?.Value ?? string.Empty;
        return LlmGwPermissions.Allows(role, permission);
    }

    public static async Task<TenantAccessContext?> ResolveAsync(
        HttpContext http,
        IMongoCollection<LlmGwMembership> memberships,
        IMongoCollection<LlmGwTenant> tenants,
        CancellationToken ct)
    {
        var userId = http.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
            ?? http.User.FindFirst("sub")?.Value;
        var username = http.User.FindFirst(ClaimTypes.Name)?.Value;
        var tenantId = http.User.FindFirst(TenantClaim)?.Value;
        var membershipId = http.User.FindFirst(MembershipClaim)?.Value;
        var versionText = http.User.FindFirst(MembershipVersionClaim)?.Value;
        if (string.IsNullOrWhiteSpace(userId)
            || string.IsNullOrWhiteSpace(username)
            || string.IsNullOrWhiteSpace(tenantId)
            || string.IsNullOrWhiteSpace(membershipId)
            || !long.TryParse(versionText, out var membershipVersion))
            return null;

        var membership = await memberships.Find(x =>
                x.Id == membershipId
                && x.TenantId == tenantId
                && x.UserId == userId
                && x.Status == "active")
            .FirstOrDefaultAsync(ct);
        if (membership is null
            || membership.Version != membershipVersion
            || !LlmGwTenantRoles.All.Contains(membership.Role))
            return null;

        var tenant = await tenants.Find(x => x.Id == tenantId && x.Status == "active").FirstOrDefaultAsync(ct);
        if (tenant is null) return null;

        return new TenantAccessContext(
            tenant.Id,
            tenant.Name,
            userId,
            username,
            membership.Id,
            membership.Version,
            membership.Role,
            membership.TeamIds);
    }
}
