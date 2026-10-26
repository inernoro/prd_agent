using PrdAgent.Core.Security;

namespace PrdAgent.Api.Middleware;

/// <summary>只约束产品管理请求；未知产品接口对覆盖模式用户默认关闭。</summary>
public static class ProductMenuRoutePolicy
{
    private static readonly IReadOnlyDictionary<string, string> ResourceMenus = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["product"] = "products", ["products"] = "products", ["requirement"] = "requirements", ["requirements"] = "requirements",
        ["feature"] = "features", ["features"] = "features", ["defect"] = "defects", ["defects"] = "defects",
        ["version"] = "versions", ["versions"] = "versions", ["initiation"] = "versions", ["initiations"] = "versions",
        ["release"] = "versions", ["releases"] = "versions", ["upgrade-requests"] = "versions",
        ["customers"] = "customers", ["customer"] = "customers", ["knowledge"] = "knowledge", ["graph"] = "graph",
        ["structure"] = "products", ["rules"] = "products", ["terms"] = "products", ["analytics"] = "dashboard",
        ["rtm"] = "features", ["my-todos"] = "dashboard", ["assistant"] = "products",
        ["trace-defect"] = "defects", ["untrace-defect"] = "defects",
        ["settings"] = "settings", ["feature-versions"] = "features", ["follow-ups"] = "customers",
    };

    public static bool Allows(IReadOnlyCollection<string> permissions, string path, string method, string? entityType = null)
    {
        if (permissions.Contains(ProductPermissionRules.MapAdmin) || !permissions.Contains(ProductPermissionRules.Scoped)) return true;
        var menus = ProductPermissionRules.Menus.Where(x => permissions.Contains(ProductPermissionRules.MenuPrefix + x.Key)).Select(x => x.Key).ToHashSet(StringComparer.Ordinal);
        if (menus.Count == 0) return false;
        if (!path.StartsWith("/api/product/", StringComparison.OrdinalIgnoreCase)) return false;
        var p = path[13..].TrimEnd('/').Split('/');
        if (p.Length == 0 || p[0].Length == 0) return false;
        var read = string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase);
        if (p[0] == "review") return menus.Contains(p.Length > 1 && p[1] == "assessments" ? "requirements" : "review");
        if (p[0] == "overview")
        {
            if (p.Length < 2) return false;
            if (p[1] == "stats") return menus.Contains("dashboard");
            if (p[1] == "version-workflow") return menus.Contains("versions");
            return ResourceMenus.TryGetValue(p[1], out var overviewMenu) && menus.Contains(overviewMenu);
        }
        if (p[0] == "version-workflow") return menus.Contains("versions");
        if (p[0] is "transition" || (p[0] == "items" && p.Length > 1 && p[1] == "batch"))
            return entityType != null && ResourceMenus.TryGetValue(entityType, out var target) && menus.Contains(target);
        if (p[0] == "items") return p.Length > 1 && ResourceMenus.TryGetValue(p[1], out var itemMenu) && menus.Contains(itemMenu);
        if (p[0] is "form-templates" or "workflow-definitions" or "grade-options" or "desc-templates" or "categories" or "requirement-types")
            return read || menus.Contains("settings");
        if (p[0] == "preferences") return read || menus.Contains("dashboard");
        if (p[0] == "products")
        {
            if (p.Length < 3) return read || menus.Contains("products"); // 授权业务表单的产品选择与所属产品说明。
            if (read && p[2] == "members") return true; // 处理人/项目成员选择器。
            if (read && p[2] == "features" && menus.Contains("versions")) return true; // V号功能清单。
            if (p[2] == "version-workflow") return menus.Contains("versions");
            return ResourceMenus.TryGetValue(p[2], out var childMenu) && menus.Contains(childMenu);
        }
        if (p[0] == "features" && read && menus.Contains("versions")) return true;
        if (p[0] == "consult") return menus.Contains("knowledge");
        return ResourceMenus.TryGetValue(p[0], out var menu) && menus.Contains(menu);
    }
}
