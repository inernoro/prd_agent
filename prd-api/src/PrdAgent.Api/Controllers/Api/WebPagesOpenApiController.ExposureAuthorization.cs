using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesOpenApiController
{
    private bool HasWebExposureGrant => User.HasClaim("scope", McpCapabilityCatalog.ScopeWebPagesPublish);

    private IActionResult? RequireWebExposureGrant() => HasWebExposureGrant ? null
        : StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED,
            "此客户端尚未获准对外发布网页。请登录 MAP，在智能体接入台的客户端设置中开启对外发布授权；确认参数不能代替此授权。"));

    private static bool IsExternallyAccessibleShare(WebPageShareLink share, string? proposedVisibility = null)
        => string.Equals(share.Purpose, "visit", StringComparison.OrdinalIgnoreCase)
            || (proposedVisibility ?? share.Visibility) != "owner-only";

    private async Task<IActionResult?> RequireSiteContentExposureGrantAsync(HostedSite site)
    {
        if (HasWebExposureGrant) return null;
        if (string.Equals(site.Visibility, "public", StringComparison.OrdinalIgnoreCase))
            return RequireWebExposureGrant();

        // 分享可以由其他有权用户创建；不能只查当前用户名下最近的100条，否则会漏掉正在对外的站点。
        var f = Builders<WebPageShareLink>.Filter;
        // 与读取路径一致：只有 owner-only 是内部分享；空/缺失的旧可见性仍可公开访问。
        // visit 链会在读取时被治愈为公开永久，不能把其旧到期时间或旧可见性当作安全边界。
        var visit = f.Regex(s => s.Purpose, new BsonRegularExpression("^visit$", "i"));
        var activeExternal = f.Ne(s => s.IsRevoked, true)
            & (visit | ((f.Eq(s => s.ExpiresAt, null) | f.Gte(s => s.ExpiresAt, DateTime.UtcNow))
                & f.Ne(s => s.Visibility, "owner-only")))
            & (f.Eq(s => s.SiteId, site.Id) | f.AnyEq(s => s.SiteIds, site.Id));
        var count = await _db.WebPageShareLinks.CountDocumentsAsync(activeExternal,
            new CountOptions { Limit = 1 }, CancellationToken.None);
        return count > 0 ? RequireWebExposureGrant() : null;
    }
}
