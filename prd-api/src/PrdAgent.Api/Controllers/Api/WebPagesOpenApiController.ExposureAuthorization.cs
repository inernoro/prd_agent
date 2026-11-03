using Microsoft.AspNetCore.Mvc;
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

    private async Task<IActionResult?> RequireSiteContentExposureGrantAsync(HostedSite site)
    {
        if (HasWebExposureGrant) return null;
        if (string.Equals(site.Visibility, "public", StringComparison.OrdinalIgnoreCase))
            return RequireWebExposureGrant();

        // 分享可以由其他有权用户创建；不能只查当前用户名下最近的100条，否则会漏掉正在对外的站点。
        var f = Builders<WebPageShareLink>.Filter;
        var activeExternal = f.Eq(s => s.IsRevoked, false)
            & (f.Eq(s => s.ExpiresAt, null) | f.Gt(s => s.ExpiresAt, DateTime.UtcNow))
            & f.In(s => s.Visibility, new[] { "public", "logged-in" })
            & (f.Eq(s => s.SiteId, site.Id) | f.AnyEq(s => s.SiteIds, site.Id));
        var count = await _db.WebPageShareLinks.CountDocumentsAsync(activeExternal,
            new CountOptions { Limit = 1 }, CancellationToken.None);
        return count > 0 ? RequireWebExposureGrant() : null;
    }
}
