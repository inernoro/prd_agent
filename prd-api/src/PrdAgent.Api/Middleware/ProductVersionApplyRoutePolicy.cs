using System.Text.RegularExpressions;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 精确限定独立版本申领权限可用的接口。产品管理控制器保留原权限；
/// 仅开放产品管理申领所需的精确接口，绝不替代产品评审智能体原权限。
/// </summary>
public static class ProductVersionApplyRoutePolicy
{
    private static readonly Regex ProductRoutes = new(
        @"\A(?:" +
        @"GET /api/product/version-workflow/products(?:/[^/]+)?|" +
        @"GET /api/product/version-workflow/review-sources|" +
        @"GET /api/product/version-workflow/initiation-defaults|" +
        @"POST /api/product/version-workflow/parse-message|" +
        @"POST /api/product/version-workflow/void|" +
        @"POST /api/product/claim-webhook/notifications/(?:T|V)/[^/]+/debug|" +
        @"GET /api/product/overview/(?:releases|initiations)|" +
        @"GET /api/product/overview/version-workflow/(?:legacy(?:/[^/]+/copy-template)?|snapshots(?:/[^/]+)?)|" +
        @"GET /api/product/(?:initiations|releases)/[^/]+(?:/copy-template)?|" +
        @"(?:GET|POST) /api/product/products/[^/]+/(?:initiations|releases)|" +
        @"GET /api/product/products/[^/]+/releases/(?:inherit-manifest|history-check)|" +
        @"GET /api/product/products/[^/]+/(?:requirements|features|members|defects)|" +
        @"PATCH /api/product/initiations/[^/]+(?:/meeting)?|" +
        @"DELETE /api/product/(?:initiations|releases)/[^/]+|" +
        @"POST /api/product/initiations/[^/]+/(?:review|decision|approve)|" +
        @"PUT /api/product/releases/[^/]+/feature-manifest|" +
        @"POST /api/product/releases/[^/]+/complete" +
        @")\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static bool Allows(string? path, string? method, string requiredPermission)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(method)) return false;
        var request = $"{method.ToUpperInvariant()} {path}";
        return requiredPermission switch
        {
            AdminPermissionCatalog.ProductAgentUse => ProductRoutes.IsMatch(request),
            _ => false,
        };
    }
}
