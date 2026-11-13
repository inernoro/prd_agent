using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>外发不能绕过站内管理员通知的当前用户权限；订阅本身不授予管理权限。</summary>
public interface IAdminNotificationAudience
{
    Task<bool> CanReceiveAdminAsync(string userId, CancellationToken ct);
}

public sealed class AdminNotificationAudience(MongoDbContext db, IAdminPermissionService permissions) : IAdminNotificationAudience
{
    public async Task<bool> CanReceiveAdminAsync(string userId, CancellationToken ct)
    {
        var user = await db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        if (user is null || user.Status != UserStatus.Active || user.UserType != UserType.Human || user.Role != UserRole.ADMIN)
            return false;
        var effective = await permissions.GetEffectivePermissionsAsync(userId, false, ct);
        return HasPermission(effective);
    }

    internal static bool HasPermission(IEnumerable<string> permissions)
    {
        var effective = permissions.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return effective.Contains(AdminPermissionCatalog.Super) || effective.Contains(AdminPermissionCatalog.SettingsWrite)
            || effective.Contains(AdminPermissionCatalog.OpenPlatformManage) || effective.Contains(AdminPermissionCatalog.AutomationsManage)
            || effective.Contains(AdminPermissionCatalog.DefectAgentManage);
    }
}
