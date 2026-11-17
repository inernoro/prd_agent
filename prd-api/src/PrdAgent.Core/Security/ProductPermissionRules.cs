using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

public static class ProductPermissionRules
{
    public const string OpenAccess = "product-agent.open-access";
    public const string MapAdmin = "product-agent.map-admin";

    public static bool IsMapAdministrator(User user) =>
        user.Role == UserRole.ADMIN && IsActiveHuman(user);

    public static bool IsActiveHuman(User user) =>
        user.Status == UserStatus.Active && user.UserType == UserType.Human;

    public static IReadOnlyList<string> Apply(User user, IEnumerable<string> original)
    {
        var result = new HashSet<string>(original, StringComparer.Ordinal);
        result.Remove(OpenAccess);
        result.Remove(MapAdmin);
        if (IsActiveHuman(user))
            result.Add(OpenAccess);
        if (IsMapAdministrator(user))
        {
            result.Add(MapAdmin);
            result.Add(AdminPermissionCatalog.ProductAgentUse);
            result.Add(AdminPermissionCatalog.ProductAgentManage);
            result.Add(AdminPermissionCatalog.ProductAgentAdmin);
            result.Add(AdminPermissionCatalog.ProductAgentVersionApply);
            result.Add(AdminPermissionCatalog.ProductAgentVersionClaimTest);
        }
        return result.OrderBy(x => x, StringComparer.Ordinal).ToArray();
    }
}
