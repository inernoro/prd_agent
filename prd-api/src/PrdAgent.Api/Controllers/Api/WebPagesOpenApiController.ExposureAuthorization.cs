using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesOpenApiController
{
    private static bool IsExternallyAccessibleShare(WebPageShareLink share, string? proposedVisibility = null)
        => string.Equals(share.Purpose, "visit", StringComparison.OrdinalIgnoreCase)
            || (proposedVisibility ?? share.Visibility) != "owner-only";

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
