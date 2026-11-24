using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Auth;

public sealed record StableSmokeFederationResult(
    bool Success,
    string Code,
    string Message,
    int StatusCode,
    LlmGwUser? User = null,
    LlmGwTenant? Tenant = null,
    LlmGwMembership? Membership = null);

public static class StableSmokeFederation
{
    public const string IdentityProvider = "stable-smoke";
    public const int DefaultSessionMinutes = 30;

    public static string NormalizeRole(string? configured) =>
        (configured ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            LlmGwTenantRoles.Admin => LlmGwTenantRoles.Admin,
            LlmGwTenantRoles.Developer => LlmGwTenantRoles.Developer,
            _ => LlmGwTenantRoles.Viewer,
        };

    public static int NormalizeSessionMinutes(int configured) =>
        Math.Clamp(configured <= 0 ? DefaultSessionMinutes : configured, 5, DefaultSessionMinutes);

    public static IReadOnlySet<string> ReadAllowedUsernames(string? configured) =>
        (configured ?? string.Empty)
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    public static async Task<StableSmokeFederationResult> ProvisionAsync(
        string mapUserId,
        string mapUsername,
        string mapDisplayName,
        string internalTenantId,
        string desiredRole,
        IMongoCollection<LlmGwUser> users,
        IMongoCollection<LlmGwTenant> tenants,
        IMongoCollection<LlmGwMembership> memberships,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(mapUserId) || string.IsNullOrWhiteSpace(mapUsername))
        {
            return Fail("STABLE_SMOKE_IDENTITY_MISSING", "巡检身份不完整，请重新签发入口", 401);
        }

        var tenant = await tenants.Find(x => x.Id == internalTenantId && x.Status == "active")
            .FirstOrDefaultAsync(cancellationToken);
        if (tenant is null)
        {
            return Fail("STABLE_SMOKE_TENANT_UNAVAILABLE", "模型网关巡检租户尚未就绪，请稍后重试", 503);
        }

        var normalizedRole = NormalizeRole(desiredRole);
        var externalSubjectId = $"stable-smoke:{mapUserId.Trim()}";
        var user = await users.Find(x =>
                x.IdentityProvider == IdentityProvider && x.ExternalSubjectId == externalSubjectId)
            .FirstOrDefaultAsync(cancellationToken);
        var now = DateTime.UtcNow;

        if (user is null)
        {
            var usernameHash = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(mapUserId.Trim()))).ToLowerInvariant()[..16];
            var preferredUsername = $"stsmk-{usernameHash}";
            var created = new LlmGwUser
            {
                Id = Guid.NewGuid().ToString("N"),
                Username = preferredUsername,
                DisplayName = string.IsNullOrWhiteSpace(mapDisplayName) ? mapUsername.Trim() : mapDisplayName.Trim(),
                IdentityProvider = IdentityProvider,
                ExternalSubjectId = externalSubjectId,
                ExternalUsername = mapUsername.Trim(),
                PasswordHash = PasswordHasher.Hash(Convert.ToBase64String(RandomNumberGenerator.GetBytes(48))),
                IsActive = true,
                MustChangePassword = false,
                PasswordChangedByUser = false,
                SecurityVersion = 1,
                TenantIds = new List<string> { tenant.Id },
                DefaultTenantId = tenant.Id,
                CreatedAt = now,
                UpdatedAt = now,
                LastLoginAt = now,
            };
            try
            {
                await users.InsertOneAsync(created, cancellationToken: cancellationToken);
                user = created;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                user = await users.Find(x =>
                        x.IdentityProvider == IdentityProvider && x.ExternalSubjectId == externalSubjectId)
                    .FirstOrDefaultAsync(cancellationToken);
                if (user is null)
                {
                    return Fail("STABLE_SMOKE_IDENTITY_CONFLICT", "巡检身份存在冲突，请由管理员检查后重试", 409);
                }
            }
        }

        if (!user.IsActive)
        {
            return Fail("STABLE_SMOKE_ACCOUNT_DISABLED", "巡检账号已被停用，请由管理员确认后恢复", 403);
        }

        var membership = await memberships.Find(x => x.TenantId == tenant.Id && x.UserId == user.Id)
            .FirstOrDefaultAsync(cancellationToken);
        if (membership is null)
        {
            var createdMembership = new LlmGwMembership
            {
                Id = Guid.NewGuid().ToString("N"),
                TenantId = tenant.Id,
                UserId = user.Id,
                Role = normalizedRole,
                Status = "active",
                Version = 1,
                CreatedAt = now,
                UpdatedAt = now,
            };
            try
            {
                await memberships.InsertOneAsync(createdMembership, cancellationToken: cancellationToken);
                membership = createdMembership;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                membership = await memberships.Find(x => x.TenantId == tenant.Id && x.UserId == user.Id)
                    .FirstOrDefaultAsync(cancellationToken);
            }
        }

        if (membership is null)
        {
            return Fail("STABLE_SMOKE_MEMBERSHIP_CONFLICT", "巡检成员关系创建冲突，请稍后重试", 409);
        }
        if (!string.Equals(membership.Status, "active", StringComparison.OrdinalIgnoreCase))
        {
            return Fail("STABLE_SMOKE_MEMBERSHIP_DISABLED", "巡检成员关系已被停用，请由管理员确认后恢复", 403);
        }
        if (!string.Equals(membership.Role, normalizedRole, StringComparison.OrdinalIgnoreCase))
        {
            return Fail("STABLE_SMOKE_ROLE_DRIFT", "巡检角色与环境策略不一致，请由管理员校准后重试", 409);
        }

        user = await users.FindOneAndUpdateAsync(
            Builders<LlmGwUser>.Filter.And(
                Builders<LlmGwUser>.Filter.Eq(x => x.Id, user.Id),
                Builders<LlmGwUser>.Filter.Eq(x => x.IsActive, true)),
            Builders<LlmGwUser>.Update
                .Set(x => x.DisplayName, string.IsNullOrWhiteSpace(mapDisplayName) ? mapUsername.Trim() : mapDisplayName.Trim())
                .Set(x => x.ExternalUsername, mapUsername.Trim())
                .Set(x => x.DefaultTenantId, tenant.Id)
                .AddToSet(x => x.TenantIds, tenant.Id)
                .Set(x => x.LastLoginAt, now)
                .Set(x => x.UpdatedAt, now),
            new FindOneAndUpdateOptions<LlmGwUser, LlmGwUser> { ReturnDocument = ReturnDocument.After },
            cancellationToken);
        if (user is null)
        {
            return Fail("STABLE_SMOKE_ACCOUNT_DISABLED", "巡检账号已被停用，请由管理员确认后恢复", 403);
        }

        return new StableSmokeFederationResult(
            true,
            "OK",
            string.Empty,
            200,
            user,
            tenant,
            membership);
    }

    private static StableSmokeFederationResult Fail(string code, string message, int statusCode) =>
        new(false, code, message, statusCode);
}
