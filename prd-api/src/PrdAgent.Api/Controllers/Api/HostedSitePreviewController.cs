using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

public sealed record HostedSitePreviewAccessRequest(string? SiteId, string? RevisionId);

[ApiController]
[Route("api/hosted-site-preview-access")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesRead)]
public sealed class HostedSitePreviewAccessController : ControllerBase
{
    private readonly IHostedSiteRevisionService _revisions;
    private readonly HostedSitePreviewAccessService _access;

    public HostedSitePreviewAccessController(
        IHostedSiteRevisionService revisions,
        HostedSitePreviewAccessService access)
    {
        _revisions = revisions;
        _access = access;
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] HostedSitePreviewAccessRequest request)
    {
        var siteId = request.SiteId?.Trim() ?? string.Empty;
        var revisionId = request.RevisionId?.Trim() ?? string.Empty;
        if (siteId.Length == 0 || revisionId.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少要预览的网页版本"));
        try
        {
            var revision = await _revisions.GetAsync(
                siteId,
                revisionId,
                this.GetRequiredUserId(),
                CancellationToken.None);
            if (revision == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在"));
            if (revision.VerifiedFiles.Count == 0)
                return Ok(ApiResponse<object>.Ok(new { available = false }));
            var issued = _access.Issue(revision, this.GetRequiredUserId());
            return Ok(ApiResponse<object>.Ok(new
            {
                available = true,
                previewUrl = $"/api/hosted-site-preview-files/bootstrap/{Uri.EscapeDataString(issued.Ticket)}",
                expiresAt = issued.ExpiresAt,
            }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException)
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.HOSTED_SITE_HISTORY_UNAVAILABLE,
                "版本资源暂时无法预览，请重新生成该版本"));
        }
    }
}

[ApiController]
[Route("api/hosted-site-preview-files")]
public sealed class HostedSitePreviewFilesController : ControllerBase
{
    public const string CookieNamePrefix = "MapVerifiedPreview_";
    public const string ContentSecurityPolicy =
        "sandbox allow-scripts allow-forms allow-modals allow-downloads; " +
        HostedSiteRevisionRules.VerifiedPackageArtifactCsp + "; frame-ancestors 'self'";

    private readonly IHostedSiteRevisionService _revisions;
    private readonly HostedSitePreviewAccessService _access;

    public HostedSitePreviewFilesController(
        IHostedSiteRevisionService revisions,
        HostedSitePreviewAccessService access)
    {
        _revisions = revisions;
        _access = access;
    }

    [AllowAnonymous]
    [HttpGet("bootstrap/{ticket}")]
    public IActionResult Bootstrap(string ticket)
    {
        if (!_access.TryRead(ticket, out var payload)) return Missing();
        ApplyNoStoreHeaders();
        Response.Cookies.Append(CookieNameFor(payload.AccessId), ticket, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            IsEssential = true,
            Expires = payload.ExpiresAt,
            Path = "/",
        });
        return Redirect($"../{payload.AccessId}/index.html");
    }

    [AllowAnonymous]
    [HttpGet("{accessId}/{**path}")]
    public async Task<IActionResult> Read(string accessId, string? path)
    {
        if (!Request.Cookies.TryGetValue(CookieNameFor(accessId), out var ticket)
            || !_access.TryRead(ticket, out var payload)
            || !string.Equals(payload.AccessId, accessId, StringComparison.Ordinal)
            || !DesignArtifactPublicPath.TryNormalize(path, out var normalizedPath)
            || !DesignArtifactPublicPath.IsWebPageWorkspaceOutput(normalizedPath, includeInternalManifest: false))
            return Missing();
        try
        {
            var file = await _revisions.GetVerifiedFileAsync(
                payload.SiteId,
                payload.RevisionId,
                normalizedPath,
                payload.UserId,
                CancellationToken.None);
            if (file == null || !HostedSitePreviewAccessService.HasValidContentHash(file)) return Missing();
            ApplyResponseHeaders(file.MimeType);
            return File(file.Content, file.MimeType, enableRangeProcessing: false);
        }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException)
        {
            return Missing();
        }
    }

    private void ApplyResponseHeaders(string mimeType)
    {
        ApplyNoStoreHeaders();
        Response.Headers.XContentTypeOptions = "nosniff";
        Response.Headers["Cross-Origin-Resource-Policy"] = "cross-origin";
        Response.Headers.AccessControlAllowOrigin = "*";
        if (mimeType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase))
        {
            Response.Headers.ContentSecurityPolicy = ContentSecurityPolicy;
            Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
        }
    }

    private void ApplyNoStoreHeaders()
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        Response.Headers.Pragma = "no-cache";
        Response.Headers["Referrer-Policy"] = "no-referrer";
    }

    private NotFoundObjectResult Missing() => NotFound(ApiResponse<object>.Fail(
        ErrorCodes.NOT_FOUND,
        "预览已失效，请返回作品页面重新打开"));

    private static string CookieNameFor(string accessId) => CookieNamePrefix + accessId;
}
