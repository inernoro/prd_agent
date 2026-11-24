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
    Task<bool> CanReceiveGatewayAsync(string userId, CancellationToken ct) => Task.FromResult(false);
}

public sealed class AdminNotificationAudience(MongoDbContext db, IAdminPermissionService permissions) : IAdminNotificationAudience
{
    public async Task<bool> CanReceiveAdminAsync(string userId, CancellationToken ct)
        => HasPermission(await PermissionsForActiveAdminAsync(userId, ct));

    public async Task<bool> CanReceiveGatewayAsync(string userId, CancellationToken ct)
    {
        var effective = await PermissionsForActiveAdminAsync(userId, ct);
        return effective.Contains(AdminPermissionCatalog.Super) || effective.Contains(AdminPermissionCatalog.LlmGatewayAccess);
    }

    private async Task<IReadOnlyList<string>> PermissionsForActiveAdminAsync(string userId, CancellationToken ct)
    {
        // Root 是认证层保留身份，不写入 users；沿用现有 Root 权限计算，不能当作缺失用户丢弃。
        if (string.Equals(userId, AdminPermissionCatalog.RootUserId, StringComparison.Ordinal))
            return await permissions.GetEffectivePermissionsAsync(userId, true, ct);
        var user = await db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        if (user is null || user.Status != UserStatus.Active || user.UserType != UserType.Human || user.Role != UserRole.ADMIN)
            return Array.Empty<string>();
        return await permissions.GetEffectivePermissionsAsync(userId, false, ct);
    }

    internal static bool RequiresGatewayObjectPermission(AdminNotification notification)
        => notification.Source is "gateway-alert" or "llm-gateway-quota"
            || notification.Source == "model-pool-probe"
               && AdminNotificationSourceCatalog.ResolveSection(notification.Source, notification.Section, notification.TargetUserId) == AdminNotificationSections.Admin;

    internal static bool HasPermission(IEnumerable<string> permissions)
    {
        var effective = permissions.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return effective.Contains(AdminPermissionCatalog.Super) || effective.Contains(AdminPermissionCatalog.SettingsWrite)
            || effective.Contains(AdminPermissionCatalog.OpenPlatformManage) || effective.Contains(AdminPermissionCatalog.AutomationsManage)
            || effective.Contains(AdminPermissionCatalog.DefectAgentManage);
    }
}
