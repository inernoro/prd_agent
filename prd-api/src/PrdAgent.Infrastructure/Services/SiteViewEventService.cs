using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 托管站点访客痕迹服务实现。
/// RecordAsync 全程 try/catch 兜底（埋点不得污染主流程）；ListViewersAsync 做授权判定。
/// </summary>
public class SiteViewEventService : ISiteViewEventService
{
    /// <summary>去重窗口：30 分钟内同一 (站点, 访客) 视为同一次访问，不重复写</summary>
    private const int ViewDedupWindowMinutes = 30;

    private readonly MongoDbContext _db;
    private readonly ITeamService _teams;
    private readonly ILogger<SiteViewEventService> _logger;

    public SiteViewEventService(MongoDbContext db, ITeamService teams, ILogger<SiteViewEventService> logger)
    {
        _db = db;
        _teams = teams;
        _logger = logger;
    }

    public async Task RecordAsync(string siteId, string viewerUserId, string? ip, string? userAgent, CancellationToken ct = default)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(siteId) || string.IsNullOrWhiteSpace(viewerUserId)) return;

            var site = await _db.HostedSites.Find(s => s.Id == siteId).FirstOrDefaultAsync(ct);
            if (site == null) return; // 站点不存在则静默忽略

            // 解析访客展示信息快照（昵称优先 DisplayName，缺则回退 Username）
            var viewer = await _db.Users.Find(u => u.UserId == viewerUserId).FirstOrDefaultAsync(ct);
            var viewerName = viewer != null
                ? (!string.IsNullOrWhiteSpace(viewer.DisplayName) ? viewer.DisplayName : viewer.Username)
                : null;
            var viewerAvatar = viewer?.AvatarFileName;

            // 去重：同一 (站点, 访客) 在去重窗口内已有记录则跳过插入
            var dedupSince = DateTime.UtcNow - TimeSpan.FromMinutes(ViewDedupWindowMinutes);
            var vf = Builders<SiteViewEvent>.Filter;
            var recent = await _db.SiteViewEvents
                .Find(vf.And(
                    vf.Eq(e => e.SiteId, siteId),
                    vf.Eq(e => e.ViewerUserId, viewerUserId),
                    vf.Gte(e => e.ViewedAt, dedupSince)))
                .AnyAsync(ct);
            if (recent) return;

            var evt = new SiteViewEvent
            {
                SiteId = siteId,
                SiteOwnerUserId = site.OwnerUserId,
                SiteTitle = site.Title,
                ViewerUserId = viewerUserId,
                ViewerName = viewerName,
                ViewerAvatarFileName = viewerAvatar,
                ViewedAt = DateTime.UtcNow,
                IpAddress = string.IsNullOrWhiteSpace(ip) ? null : ip,
                UserAgent = string.IsNullOrWhiteSpace(userAgent) ? null : userAgent,
            };
            await _db.SiteViewEvents.InsertOneAsync(evt, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            // 埋点失败绝不抛给调用方，仅告警
            _logger.LogWarning(ex, "[site-view] 记录站点访问失败 siteId={SiteId} viewer={ViewerId}", siteId, viewerUserId);
        }
    }

    public async Task<SiteViewersResult> ListViewersAsync(string siteId, string requesterUserId, int skip, int limit, CancellationToken ct = default)
    {
        var empty = new SiteViewersResult();
        if (string.IsNullOrWhiteSpace(siteId) || string.IsNullOrWhiteSpace(requesterUserId)) return empty;

        var site = await _db.HostedSites.Find(s => s.Id == siteId).FirstOrDefaultAsync(ct);
        if (site == null) return empty;

        // 授权：站点 owner，或站点共享团队之一的成员
        var authorized = site.OwnerUserId == requesterUserId;
        if (!authorized && site.SharedTeamIds is { Count: > 0 })
        {
            var myTeamIds = await _teams.GetMyTeamIdsAsync(requesterUserId, ct);
            authorized = myTeamIds.Any(tid => site.SharedTeamIds.Contains(tid));
        }
        if (!authorized) return empty;

        skip = Math.Max(0, skip);
        limit = Math.Clamp(limit <= 0 ? 100 : limit, 1, 500);

        var f = Builders<SiteViewEvent>.Filter.Eq(e => e.SiteId, siteId);

        var total = await _db.SiteViewEvents.CountDocumentsAsync(f, cancellationToken: ct);

        var distinct = await _db.SiteViewEvents
            .Distinct(e => e.ViewerUserId, f, cancellationToken: ct)
            .ToListAsync(ct);
        var uniqueViewers = distinct.Count(id => !string.IsNullOrEmpty(id));

        var events = await _db.SiteViewEvents
            .Find(f)
            .Sort(Builders<SiteViewEvent>.Sort.Descending(e => e.ViewedAt))
            .Skip(skip)
            .Limit(limit)
            .ToListAsync(ct);

        return new SiteViewersResult
        {
            Items = events.Select(e => new SiteViewerItem
            {
                ViewerUserId = e.ViewerUserId ?? string.Empty,
                ViewerName = e.ViewerName,
                ViewerAvatarFileName = e.ViewerAvatarFileName,
                ViewedAt = e.ViewedAt,
            }).ToList(),
            Total = total,
            UniqueViewers = uniqueViewers,
        };
    }
}
