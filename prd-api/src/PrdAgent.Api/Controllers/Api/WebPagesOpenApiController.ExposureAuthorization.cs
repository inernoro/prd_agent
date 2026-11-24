using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesOpenApiController
{
    private bool HasWebExposureGrant => User.HasClaim("scope", McpCapabilityCatalog.ScopeWebPagesPublish);

    private IActionResult? RequireWebExposureGrant()
    {
        if (HasWebExposureGrant) return null;
        var response = ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED,
            "此客户端缺少网页对外发布授权，本次操作未提交。若要委托这台客户端对外发布，请由账号本人在智能体接入台授权。");
        response.Data = new { requiredScope = McpCapabilityCatalog.ScopeWebPagesPublish,
            clientSettingsUrl = Request.ResolveAbsoluteUrl("/mcp-console") };
        return StatusCode(403, response);
    }

    private static bool IsExternallyAccessibleShare(WebPageShareLink share, string? proposedVisibility = null)
        => string.Equals(share.Purpose, "visit", StringComparison.OrdinalIgnoreCase)
            || (proposedVisibility ?? share.Visibility) != "owner-only";

    private async Task<IActionResult?> CheckSiteExposureAsync(HostedSite site, bool confirmedExposure, CancellationToken ct = default)
    {
        if (HasWebExposureGrant && confirmedExposure) return null;
        if (!await IsSiteExternallyAccessibleAsync(site, ct)) return null;
        if (RequireWebExposureGrant() is { } grantError) return grantError;
        var response = ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
            "此网页已有对外访问入口。请先确认用户同意更新对外内容，再传 confirmedExposure=true。");
        response.Data = new { siteId = site.Id, requiresExposureConfirmation = true };
        return BadRequest(response);
    }

    private async Task<bool> IsSiteExternallyAccessibleAsync(HostedSite site, CancellationToken ct)
    {
        if (string.Equals(site.Visibility, "public", StringComparison.OrdinalIgnoreCase)) return true;
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
            new CountOptions { Limit = 1 }, ct);
        return count > 0;
    }
}
