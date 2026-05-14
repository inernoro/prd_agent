using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 统一短链管理（Admin 后台）— 跨用户列出所有 /s/{seq}，支持强制吊销 + counter 修复。
/// 系统设置 → 分享短链页面的后端入口。
/// </summary>
[ApiController]
[Route("api/admin/short-links")]
[Authorize]
[AdminController("short-links", AdminPermissionCatalog.ShortLinksManage,
    WritePermission = AdminPermissionCatalog.ShortLinksManage)]
public class AdminShortLinksController : ControllerBase
{
    private readonly IShortLinkService _shortLinks;
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminShortLinksController> _logger;

    public AdminShortLinksController(IShortLinkService shortLinks, MongoDbContext db,
        ILogger<AdminShortLinksController> logger)
    {
        _shortLinks = shortLinks;
        _db = db;
        _logger = logger;
    }

    /// <summary>列出所有短链（跨用户、支持按 targetType 和 token/seq 搜索）。</summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? targetType,
        [FromQuery] string? search,
        [FromQuery] int skip = 0,
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
    {
        var (items, total) = await _shortLinks.ListAsync(targetType, search, skip, limit, ct);

        // 仅 web_page 拉取关联 share 元信息（其他系统接入后在此扩展）
        var webPageTokens = items
            .Where(x => x.TargetType == ShortLinkTargetTypes.WebPage)
            .Select(x => x.TargetId)
            .ToList();

        var webPageShares = webPageTokens.Count == 0
            ? new List<WebPageShareLink>()
            : await _db.WebPageShareLinks
                .Find(Builders<WebPageShareLink>.Filter.In(x => x.Token, webPageTokens))
                .ToListAsync(ct);
        var shareByToken = webPageShares.ToDictionary(s => s.Token, s => s);

        var enriched = items.Select(x =>
        {
            object? meta = null;
            if (x.TargetType == ShortLinkTargetTypes.WebPage && shareByToken.TryGetValue(x.TargetId, out var s))
            {
                meta = new
                {
                    title = s.Title,
                    shareType = s.ShareType,
                    accessLevel = s.AccessLevel,
                    viewCount = s.ViewCount,
                    isRevoked = s.IsRevoked,
                    expiresAt = s.ExpiresAt,
                    createdBy = s.CreatedBy,
                    createdByName = s.CreatedByName,
                    sharedAt = s.CreatedAt,
                };
            }
            return new
            {
                seq = x.Seq,
                targetType = x.TargetType,
                token = x.TargetId,
                createdAt = x.CreatedAt,
                share = meta,
            };
        });

        return Ok(ApiResponse<object>.Ok(new { items = enriched, total }));
    }

    /// <summary>
    /// 强制吊销一条短链：把底层分享标记为 IsRevoked=true，让 /s/{seq} 和 /s/wp/{token} 两条 URL 同步失效。
    /// </summary>
    [HttpPost("{seq:long}/revoke")]
    public async Task<IActionResult> Revoke(long seq, CancellationToken ct)
    {
        var link = await _shortLinks.ResolveAsync(seq, ct);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "短链不存在"));

        if (link.TargetType == ShortLinkTargetTypes.WebPage)
        {
            var result = await _db.WebPageShareLinks.UpdateOneAsync(
                Builders<WebPageShareLink>.Filter.Eq(x => x.Token, link.TargetId),
                Builders<WebPageShareLink>.Update.Set(x => x.IsRevoked, true),
                cancellationToken: ct);

            if (result.MatchedCount == 0)
            {
                // ShortLink 映射还在但底层 share 已被物理删除（罕见，数据不一致）。
                // 不能报"已吊销"误导运维，明确返回 NOT_FOUND + 上下文。
                _logger.LogWarning("Admin 吊销短链 seq={Seq}：ShortLink 存在但 WebPageShareLink token={Token} 已不在 DB",
                    seq, link.TargetId);
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND,
                    $"短链 #{seq} 的底层分享记录已不存在（token={link.TargetId}），无需吊销"));
            }
            _logger.LogWarning("Admin 吊销短链 seq={Seq} target={Type}/{Token} matched={Matched}",
                seq, link.TargetType, link.TargetId, result.MatchedCount);
            return Ok(ApiResponse<object>.Ok(new { revoked = true, seq, targetType = link.TargetType }));
        }

        return StatusCode(501, ApiResponse<object>.Fail("NOT_IMPLEMENTED",
            $"暂不支持吊销 targetType={link.TargetType} 的短链"));
    }

    /// <summary>把全局 counter 同步到 max(seq) — 运维误删/误改 counter 后的修复入口。</summary>
    [HttpPost("repair-counter")]
    public async Task<IActionResult> RepairCounter(CancellationToken ct)
    {
        var maxSeq = await _shortLinks.RepairCounterAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { repaired = true, counterSet = maxSeq }));
    }
}
