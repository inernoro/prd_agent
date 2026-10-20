using System.Text.RegularExpressions;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 精确限定独立版本申领权限可用的接口。产品管理和评审控制器仍保留原权限；
/// 这里只给交互所需的读取、申领与本人评审链路开口，不对整段路由放权。
/// </summary>
public static class ProductVersionApplyRoutePolicy
{
    private static readonly Regex ProductRoutes = new(
        @"\A(?:" +
        @"GET /api/product/version-workflow/products(?:/[^/]+)?|" +
        @"GET /api/product/version-workflow/review-sources|" +
        @"POST /api/product/version-workflow/parse-message|" +
        @"GET /api/product/overview/(?:releases|initiations)|" +
        @"GET /api/product/overview/version-workflow/(?:legacy(?:/[^/]+/copy-template)?|snapshots(?:/[^/]+)?)|" +
        @"GET /api/product/(?:initiations|releases)/[^/]+(?:/copy-template)?|" +
        @"(?:GET|POST) /api/product/products/[^/]+/(?:initiations|releases)|" +
        @"GET /api/product/products/[^/]+/releases/(?:inherit-manifest|history-check)|" +
        @"GET /api/product/products/[^/]+/(?:requirements|features|members|defects)|" +
        @"PATCH /api/product/initiations/[^/]+(?:/meeting)?|" +
        @"POST /api/product/initiations/[^/]+/(?:review|decision|approve)|" +
        @"PUT /api/product/releases/[^/]+/feature-manifest|" +
        @"POST /api/product/releases/[^/]+/complete" +
        @")\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex ReviewRoutes = new(
        @"\A(?:" +
        @"GET /api/review-agent/dimensions|" +
        @"POST /api/review-agent/submissions|" +
        @"GET /api/review-agent/submissions/[0-9a-f]{32}|" +
        @"GET /api/review-agent/submissions/[0-9a-f]{32}/result/stream" +
        @")\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static bool Allows(string? path, string? method, string requiredPermission)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(method)) return false;
        var request = $"{method.ToUpperInvariant()} {path}";
        return requiredPermission switch
        {
            AdminPermissionCatalog.ProductAgentUse => ProductRoutes.IsMatch(request),
            AdminPermissionCatalog.ReviewAgentUse => ReviewRoutes.IsMatch(request),
            _ => false,
        };
    }
}
