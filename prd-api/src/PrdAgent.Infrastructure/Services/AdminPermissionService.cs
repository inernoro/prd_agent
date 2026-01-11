using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using MongoDB.Driver;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 管理后台权限计算：system role + allow - deny。
/// </summary>
public sealed class AdminPermissionService : IAdminPermissionService
{
    private readonly MongoDbContext _db;

    public AdminPermissionService(MongoDbContext db)
    {
        _db = db;
    }

    private static string InferSystemRoleKey(User user)
    {
        var k = (user.SystemRoleKey ?? string.Empty).Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(k)) return k;
        return user.Role == UserRole.ADMIN ? "admin" : "none";
    }

    private static HashSet<string> NormalizeSet(IEnumerable<string>? items)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        if (items == null) return set;
        foreach (var x in items)
        {
            var t = (x ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(t)) continue;
            set.Add(t);
        }
        return set;
    }

    public async Task<IReadOnlyList<string>> GetEffectivePermissionsAsync(string userId, bool isRoot, CancellationToken ct = default)
    {
        if (isRoot)
        {
            // root：全权限（包含超级兜底）
            return AdminPermissionCatalog.All.Select(x => x.Key).Distinct(StringComparer.Ordinal).ToList();
        }

        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid)) return Array.Empty<string>();

        var user = await _db.Users.Find(x => x.UserId == uid).FirstOrDefaultAsync(ct);
        if (user == null) return Array.Empty<string>();

        var roleKey = InferSystemRoleKey(user);
        var rolePerms = new HashSet<string>(StringComparer.Ordinal);
        if (!string.Equals(roleKey, "none", StringComparison.Ordinal))
        {
            var r = await _db.SystemRoles.Find(x => x.Key == roleKey).FirstOrDefaultAsync(ct);
            if (r?.Permissions != null)
            {
                foreach (var p in r.Permissions)
                {
                    var t = (p ?? string.Empty).Trim();
                    if (!string.IsNullOrWhiteSpace(t)) rolePerms.Add(t);
                }
            }
        }

        // system role + allow - deny
        var allow = NormalizeSet(user.PermAllow);
        var deny = NormalizeSet(user.PermDeny);

        rolePerms.UnionWith(allow);
        rolePerms.ExceptWith(deny);

        return rolePerms.OrderBy(x => x, StringComparer.Ordinal).ToList();
    }

    public async Task<AdminUserAuthzSnapshot?> GetUserAuthzSnapshotAsync(string userId, CancellationToken ct = default)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid)) return null;

        var user = await _db.Users.Find(x => x.UserId == uid).FirstOrDefaultAsync(ct);
        if (user == null) return null;

        return new AdminUserAuthzSnapshot
        {
            UserId = user.UserId,
            Username = user.Username,
            DisplayName = user.DisplayName,
            Role = user.Role,
            SystemRoleKey = user.SystemRoleKey,
            EffectiveSystemRoleKey = InferSystemRoleKey(user),
            PermAllow = NormalizeSet(user.PermAllow).OrderBy(x => x, StringComparer.Ordinal).ToList(),
            PermDeny = NormalizeSet(user.PermDeny).OrderBy(x => x, StringComparer.Ordinal).ToList(),
        };
    }
}

