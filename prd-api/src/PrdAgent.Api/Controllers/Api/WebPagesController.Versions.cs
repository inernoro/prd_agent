using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    private readonly IAssetStorage? _reviewStorage;

    [HttpGet("{siteId}/revisions")]
    public async Task<IActionResult> ListReviewVersions(string siteId)
    {
        var site = await _siteService.GetByIdAsync(siteId, GetUserId(), CancellationToken.None);
        return site == null ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"))
            : await ListReviewVersionsCoreAsync(site, await _siteService.CanEditSiteAsync(site, GetUserId(), CancellationToken.None));
    }

    [HttpGet("{siteId}/revisions/{revisionId}/preview")]
    public async Task<IActionResult> PreviewReviewVersion(string siteId, string revisionId)
    {
        var site = await _siteService.GetByIdAsync(siteId, GetUserId(), CancellationToken.None);
        return site == null ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"))
            : await PreviewReviewVersionCoreAsync(site, revisionId, await _siteService.CanEditSiteAsync(site, GetUserId(), CancellationToken.None));
    }

    [AllowAnonymous]
    [HttpGet("shares/view/{token}/revisions")]
    public async Task<IActionResult> ListSharedReviewVersions(string token, [FromQuery] string? password)
    {
        var viewer = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var access = await _siteService.ResolveShareSiteAsync(token, null, password, viewer, CancellationToken.None);
        if (access.Error != null)
            return MapCommentError(access.Error, access.HttpStatus, access.ErrorCode, access.RetryAfterSeconds);
        return access.Site == null ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享内无站点"))
            : await ListReviewVersionsCoreAsync(access.Site, !string.IsNullOrEmpty(viewer) && await _siteService.CanEditSiteAsync(access.Site, viewer, CancellationToken.None));
    }

    [AllowAnonymous]
    [HttpGet("shares/view/{token}/revisions/{revisionId}/preview")]
    public async Task<IActionResult> PreviewSharedReviewVersion(string token, string revisionId, [FromQuery] string? password)
    {
        var viewer = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var access = await _siteService.ResolveShareSiteAsync(token, null, password, viewer, CancellationToken.None);
        if (access.Error != null)
            return MapCommentError(access.Error, access.HttpStatus, access.ErrorCode, access.RetryAfterSeconds);
        return access.Site == null ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享内无站点"))
            : await PreviewReviewVersionCoreAsync(access.Site, revisionId, !string.IsNullOrEmpty(viewer) && await _siteService.CanEditSiteAsync(access.Site, viewer, CancellationToken.None));
    }

    private async Task<IActionResult> ListReviewVersionsCoreAsync(HostedSite site, bool canViewHistory)
    {
        // Reads never create or backfill snapshots; replacement paths capture the current publication.
        var published = Builders<HostedSiteRevision>.Filter.Eq(r => r.SiteId, site.Id)
            & Builders<HostedSiteRevision>.Filter.Eq(r => r.Status, HostedSiteRevisionStatuses.Published)
            & Builders<HostedSiteRevision>.Filter.Ne(r => r.PublishedContentVersion, null);
        var filter = canViewHistory ? published : published & Builders<HostedSiteRevision>.Filter.Eq(
            r => r.PublishedContentVersion, HostedSiteService.EffectiveContentVersion(site));
        var total = await _db.HostedSiteRevisions.CountDocumentsAsync(published, cancellationToken: CancellationToken.None);
        var items = await _db.HostedSiteRevisions.Find(filter)
            .Project<HostedSiteRevision>(Builders<HostedSiteRevision>.Projection.Exclude(r => r.Html).Exclude(r => r.VerifiedFiles).Exclude(r => r.PublishedAssetKeys))
            .SortByDescending(r => r.PublishedContentVersion).ThenByDescending(r => r.Id).Limit(100)
            .ToListAsync(CancellationToken.None);
        var result = items.Select((item, index) => ReviewVersionDto(item, site, total - index) with { HistoryRestricted = !canViewHistory }).ToList();
        if (!items.Any(item => item.PublishedContentVersion == HostedSiteService.EffectiveContentVersion(site)))
        {
            // The live publication has no immutable revision ID until it is captured before replacement.
            var version = HostedSiteService.EffectiveContentVersion(site);
            result.Insert(0, new ReviewVersionSummary("", site.Id, "V" + (total + 1), HostedSiteCommentRules.VersionKey(version),
                version, true, !string.IsNullOrWhiteSpace(site.SiteUrl), site.EntryFile,
                HostedSiteContentShapeRules.Resolve(site), site.SiteUrl, !canViewHistory));
        }
        return Ok(ApiResponse<object>.Ok(result));
    }

    private async Task<IActionResult> PreviewReviewVersionCoreAsync(HostedSite site, string revisionId, bool canViewHistory)
    {
        var item = await _db.HostedSiteRevisions.Find(r => r.Id == revisionId && r.SiteId == site.Id
            && r.Status == HostedSiteRevisionStatuses.Published && r.PublishedContentVersion != null
            && (canViewHistory || r.PublishedContentVersion == HostedSiteService.EffectiveContentVersion(site)))
            .FirstOrDefaultAsync(CancellationToken.None);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在或尚未发布"));
        var number = await _db.HostedSiteRevisions.CountDocumentsAsync(r => r.SiteId == site.Id
            && r.Status == HostedSiteRevisionStatuses.Published && r.PublishedContentVersion != null
            && r.PublishedContentVersion <= item.PublishedContentVersion,
            cancellationToken: CancellationToken.None);
        var dto = ReviewVersionDto(item, site, number);
        if (!dto.CanPreview)
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.HOSTED_SITE_HISTORY_UNAVAILABLE, "这份旧版本未保留完整资源，无法可靠预览"));
        var html = string.IsNullOrWhiteSpace(item.Html) || HostedSiteService.HasDeclarativeOnlyPolicy(item.Html)
            ? item.Html : HostedSiteAnnotationRuntime.Inject(item.Html);
        return Ok(ApiResponse<object>.Ok(new { revision = dto, html, siteUrl = dto.SiteUrl }));
    }

    private ReviewVersionSummary ReviewVersionDto(HostedSiteRevision item, HostedSite site, long number)
    {
        var entryFile = item.PublishedEntryFile ?? "index.html";
        var key = item.PublishedEntryCosKey;
        var current = item.PublishedContentVersion == HostedSiteService.EffectiveContentVersion(site);
        var siteUrl = current && !string.IsNullOrWhiteSpace(site.SiteUrl) ? site.SiteUrl
            : !string.IsNullOrWhiteSpace(key) && _reviewStorage != null
            ? HostedSiteService.AppendBridgeVersion(HostedSiteService.AppendVersion(_reviewStorage.BuildUrlForKey(key), item.PublishedContentVersion!.Value), site.SlideNavCompatVersion)
            : current ? site.SiteUrl : null;
        return new ReviewVersionSummary(item.Id, site.Id, "V" + number,
            HostedSiteCommentRules.VersionKey(item.PublishedContentVersion!.Value), item.PublishedAt, current,
            !string.IsNullOrWhiteSpace(siteUrl) || item.CapturedContentShape == HostedSiteContentShapes.SelfContainedHtml,
            entryFile, item.CapturedContentShape ?? HostedSiteContentShapes.MultiFile, siteUrl);
    }

    private sealed record ReviewVersionSummary(string Id, string SiteId, string VersionLabel, string ContentVersionKey,
        DateTime? PublishedAt, bool IsCurrent, bool CanPreview, string EntryFile, string ContentShape, string? SiteUrl, bool HistoryRestricted = false);
}
