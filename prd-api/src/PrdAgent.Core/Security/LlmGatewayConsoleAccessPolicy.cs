using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

/// <summary>
/// LLM Gateway 控制台准入判据。
///
/// <see cref="User.Role"/> 是 PM/DEV/QA/ADMIN 的业务角色，不能再作为控制台授权依据。
/// 网关准入只认 system role + allow - deny 计算出的有效权限，使管理员默认拥有，
/// 也允许给非管理员单独授权或显式撤销。
/// </summary>
public static class LlmGatewayConsoleAccessPolicy
{
    public static bool CanEnter(User? user, IEnumerable<string>? effectivePermissions)
    {
        if (user is null || user.Status != UserStatus.Active || user.UserType != UserType.Human)
        {
            return false;
        }

        return effectivePermissions?.Any(permission =>
            string.Equals(permission, AdminPermissionCatalog.LlmGatewayAccess, StringComparison.Ordinal) ||
            string.Equals(permission, AdminPermissionCatalog.Super, StringComparison.Ordinal)) == true;
    }
}
