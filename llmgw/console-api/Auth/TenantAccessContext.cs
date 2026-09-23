using System.Security.Claims;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Provisioning;

namespace PrdAgent.LlmGw.Auth;

public sealed record TenantAccessContext(
    string TenantId,
    string TenantName,
    bool IsInternalTenant,
    string UserId,
    string Username,
    string MembershipId,
    long MembershipVersion,
    string Role,
    IReadOnlyList<string> TeamIds,
    string? ExternalUserId = null);

public static class LlmGwPermissions
{
    public const string LogsRead = "logs:read";
    public const string RequestBodyRead = "request-body:read";
    public const string UsageRead = "usage:read";
    public const string AuditRead = "audit:read";
    public const string ConfigWrite = "config:write";
    public const string AppCallerWrite = "app-caller:write";
    public const string ServiceKeyWrite = "service-key:write";
    public const string OrganizationWrite = "organization:write";
    public const string TenantOwner = "tenant:owner";

    public static bool Allows(string role, string permission) => role switch
    {
        LlmGwTenantRoles.Owner => true,
        LlmGwTenantRoles.Admin => permission is LogsRead or RequestBodyRead or UsageRead or AuditRead or ConfigWrite or AppCallerWrite or ServiceKeyWrite or OrganizationWrite,
        LlmGwTenantRoles.Developer => permission is LogsRead or RequestBodyRead or UsageRead or AppCallerWrite or ServiceKeyWrite,
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
    public const string UserSecurityVersionClaim = "user_security_version";

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

    public static FilterDefinition<BsonDocument> FilterTeamScope(
        HttpContext http,
        FilterDefinition<BsonDocument> filter)
    {
        var access = GetRequired(http);
        var tenantFilter = Builders<BsonDocument>.Filter.Eq("TenantId", access.TenantId);
        if (access.Role is LlmGwTenantRoles.Owner or LlmGwTenantRoles.Admin or LlmGwTenantRoles.Billing)
            return Builders<BsonDocument>.Filter.And(tenantFilter, filter);

        // 低权限账号除了团队数据，还必须能读取自己的调用记录。MAP 联邦账号在网关里有独立的
        // user id，而调用日志沿用 MAP user id；只按 TeamId 会让没有团队的 viewer 永远查不到
        // 自己刚产生的日志，真实调用成功后仍无法完成审计闭环。
        var scopes = new List<FilterDefinition<BsonDocument>>();
        if (access.TeamIds.Count > 0)
            scopes.Add(Builders<BsonDocument>.Filter.In("TeamId", access.TeamIds));

        var ownUserIds = new[] { access.UserId, access.ExternalUserId }
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (ownUserIds.Length > 0)
            scopes.Add(Builders<BsonDocument>.Filter.In("UserId", ownUserIds));

        var scopeFilter = scopes.Count == 1
            ? scopes[0]
            : Builders<BsonDocument>.Filter.Or(scopes);
        return Builders<BsonDocument>.Filter.And(tenantFilter, scopeFilter, filter);
    }

    public static bool HasPermission(ClaimsPrincipal user, string permission)
    {
        var role = user.FindFirst(RoleClaim)?.Value ?? string.Empty;
        return LlmGwPermissions.Allows(role, permission);
    }

    public static async Task<TenantAccessContext?> ResolveAsync(
        HttpContext http,
        IMongoCollection<LlmGwUser> users,
        IMongoCollection<LlmGwMembership> memberships,
        IMongoCollection<LlmGwTenant> tenants,
        IMongoCollection<LlmGwTeam> teams,
        CancellationToken ct)
    {
        var userId = http.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
            ?? http.User.FindFirst("sub")?.Value;
        var username = http.User.FindFirst(ClaimTypes.Name)?.Value;
        var tenantId = http.User.FindFirst(TenantClaim)?.Value;
        var membershipId = http.User.FindFirst(MembershipClaim)?.Value;
        var versionText = http.User.FindFirst(MembershipVersionClaim)?.Value;
        var securityVersionText = http.User.FindFirst(UserSecurityVersionClaim)?.Value;
        if (string.IsNullOrWhiteSpace(userId)
            || string.IsNullOrWhiteSpace(username)
            || string.IsNullOrWhiteSpace(tenantId)
            || string.IsNullOrWhiteSpace(membershipId)
            || !long.TryParse(versionText, out var membershipVersion)
            || !long.TryParse(securityVersionText, out var securityVersion))
            return null;


        var user = await users.Find(x => x.Id == userId && x.IsActive).FirstOrDefaultAsync(ct);
        if (user is null || user.SecurityVersion != securityVersion)
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
        if (tenant is null || !TenantOwnerAuthority.IsEffectiveOwner(tenant, membership)) return null;

        var activeTeamIds = membership.TeamIds.Count == 0
            ? new List<string>()
            : await teams.Find(x => x.TenantId == tenantId
                    && membership.TeamIds.Contains(x.Id)
                    && x.Status == "active")
                .Project(x => x.Id)
                .ToListAsync(ct);

        return new TenantAccessContext(
            tenant.Id,
            tenant.Name,
            tenant.IsInternal,
            userId,
            username,
            membership.Id,
            membership.Version,
            membership.Role,
            activeTeamIds,
            ResolveExternalUserId(user));
    }

    private static string? ResolveExternalUserId(LlmGwUser user)
    {
        if (user.IdentityProvider is not ("map" or StableSmokeFederation.IdentityProvider)
            || string.IsNullOrWhiteSpace(user.ExternalSubjectId))
            return null;

        var separator = user.ExternalSubjectId.IndexOf(':');
        if (separator <= 0 || separator == user.ExternalSubjectId.Length - 1)
            return null;
        return user.ExternalSubjectId[(separator + 1)..].Trim() is { Length: > 0 } value ? value : null;
    }
}
