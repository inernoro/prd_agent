using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    public sealed record CdsShareRequest(string? Grant, string? CdsOrigin, bool Confirmed = false, string? Password = null,
        string? ConfirmedPrivateSourceFingerprint = null);

    [HttpPost("shares/cds/inspect")]
    public Task<IActionResult> InspectCdsShare(CdsShareRequest request, [FromServices] IConfiguration configuration) =>
        ProcessCdsShareAsync(request, configuration, approve: false);

    [HttpPost("shares/cds/approve")]
    public Task<IActionResult> ApproveCdsShare(CdsShareRequest request, [FromServices] IConfiguration configuration) =>
        ProcessCdsShareAsync(request, configuration, approve: true);

    private async Task<IActionResult> ProcessCdsShareAsync(CdsShareRequest request, IConfiguration configuration, bool approve)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        if (!FederatedConsoleSessionPolicy.IsEligibleBrowserSession(User))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail("CDS_SHARE_HUMAN_REQUIRED", "请使用有权限的 MAP 真人会话"));

        var userId = GetUserId();
        var grant = CdsDesignShareHandoff.Read(request.Grant, userId, configuration, DateTimeOffset.UtcNow);
        var ct = HttpContext.RequestAborted;
        if (grant == null || grant.Issuer != request.CdsOrigin || !await _siteService.CanCreateShareAsync([grant.SiteId], userId, ct))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail("CDS_SHARE_NOT_ALLOWED", "确认人、授权或目标站点已失效"));
        if (_privateSources == null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, ApiResponse<object>.Fail("CDS_SHARE_UNAVAILABLE", "当前无法核对稿件的私有引用"));

        var site = await _siteService.GetByIdAsync(grant.SiteId, userId, ct);
        var revision = await _db.HostedSiteRevisions.Find(row => row.Id == grant.RevisionId && row.SiteId == grant.SiteId
            && row.Status == HostedSiteRevisionStatuses.Published).FirstOrDefaultAsync(ct);
        if (site == null || revision?.VerifiedFiles is not [{ Path: "index.html" } entry]
            || !entry.MimeType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(entry.Sha256, grant.PrototypeSha256, StringComparison.OrdinalIgnoreCase)
            || !HostedSitePreviewAccessService.HasValidContentHash(entry))
            return Conflict(ApiResponse<object>.Fail("CDS_SHARE_VERSION_MISMATCH", "已绑定的托管版本和定稿原型不一致"));

        if (!approve)
        {
            var sources = await _privateSources.InspectRevisionAsync(site, revision, ct);
            var existing = await _db.WebPageShareLinks.Find(row => row.Id == grant.ApprovalId && row.CreatedBy == userId
                && row.SiteId == grant.SiteId).FirstOrDefaultAsync(ct);
            if (existing?.FixedRevision?.CdsApproval is not { } recorded || recorded.PackageSha256 != grant.PackageSha256
                || recorded.SourceCommit != grant.SourceCommit || existing.FixedRevision.RevisionId != grant.RevisionId)
                existing = null;
            var state = existing == null ? "awaiting_human_confirmation" : existing.IsRevoked ? "revoked"
                : existing.ExpiresAt is not { } expiry || expiry <= DateTime.UtcNow ? "expired" : "approved";
            return Ok(ApiResponse<object>.Ok(new {
                site.Title, grant.PreparationId, grant.Version, grant.SourceCommit, grant.Access, grant.ExpiresInHours,
                privateSources = sources.Items.Select(item => new { item.Title, item.Scope }), sources.Fingerprint,
                state, shareId = existing?.Id, expiresAt = existing?.ExpiresAt,
                shareUrl = state == "approved" && existing != null ? FixedCdsShareUrl(existing, revision.Id) : null,
            }));
        }

        var password = request.Password?.Trim();
        if (!request.Confirmed || (grant.Access == "password" && (password == null || password.Length is < 1 or > 128))
            || (grant.Access == "public" && !string.IsNullOrEmpty(password)))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请确认固定版本和受众；需要密码时请设定密码"));

        var decision = await _privateSources.EnforceForRevisionShareAsync(site, revision, userId, request.ConfirmedPrivateSourceFingerprint, ct);
        if (!decision.Allowed) return Conflict(ApiResponse<object>.Fail(decision.ErrorCode, decision.Message));
        var pinned = new HostedSiteFixedRevision(revision.Id, HostedSitePreviewAccessService.ComputePackageFingerprint(revision.VerifiedFiles),
            new(StringComparer.Ordinal) { [entry.Path] = entry.Sha256 })
        {
            CdsApproval = new(grant.ApprovalId, grant.Issuer, grant.ProjectId, grant.DesignId, grant.PreparationId,
                grant.Version, grant.SourceCommit, grant.PackageSha256, grant.ExpiresInHours),
        };
        try
        {
            var share = await _siteService.CreateFixedRevisionShareAsync(userId, await ResolveDisplayNameAsync(userId), site.Id,
                pinned, site.Title, null, password, TimeSpan.FromHours(grant.ExpiresInHours), "public", ct);
            return Ok(ApiResponse<object>.Ok(new {
                share.Id, grant.PreparationId, share.ExpiresAt,
                shareUrl = FixedCdsShareUrl(share, revision.Id),
            }));
        }
        catch (UnauthorizedAccessException)
        {
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail("CDS_SHARE_NOT_ALLOWED", "托管分享权限已变化"));
        }
        catch (InvalidOperationException)
        {
            return Conflict(ApiResponse<object>.Fail("CDS_SHARE_CONFLICT", "这条 CDS 确认已变更或链接已失效"));
        }
    }

    private static string FixedCdsShareUrl(WebPageShareLink share, string revisionId) =>
        $"/s/wp/{share.Token}?revision={Uri.EscapeDataString(revisionId)}";
}
