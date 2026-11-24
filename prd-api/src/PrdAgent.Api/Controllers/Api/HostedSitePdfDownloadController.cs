using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/web-pages")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class HostedSitePdfDownloadController : ControllerBase
{
    // 存储读取返回 byte[]；元数据与实际内容共用独立下载预算，不改托管容量。
    public const long MaxPdfDownloadBytes = 320L * 1024 * 1024;
    private readonly IHostedSiteService _sites;
    private readonly IAssetStorage _storage;
    private readonly ILogger<HostedSitePdfDownloadController> _logger;

    public HostedSitePdfDownloadController(IHostedSiteService sites, IAssetStorage storage,
        ILogger<HostedSitePdfDownloadController> logger)
    {
        _sites = sites;
        _storage = storage;
        _logger = logger;
    }

    [HttpGet("{id}/download/pdf")]
    public async Task<IActionResult> DownloadOwnedPdf(string id, [FromQuery] string filePath)
    {
        var userId = this.GetRequiredUserId();
        var site = await _sites.GetByIdAsync(id, userId, HttpContext.RequestAborted);
        if (site == null || !await _sites.CanEditSiteAsync(site, userId, HttpContext.RequestAborted))
            return MissingPdf();
        return await DownloadAsync(site, filePath);
    }

    [HttpGet("{id}/download/zip-homepage")]
    public async Task<IActionResult> DownloadSiteZipHomepage(string id, [FromQuery] string filePath, [FromQuery] long version)
    {
        var site = await _sites.GetByIdAsync(id, this.GetRequiredUserId(), HttpContext.RequestAborted);
        return site == null ? MissingFile(zipHomepage: true) : await DownloadAsync(site, filePath, version);
    }

    [AllowAnonymous]
    [HttpGet("shares/view/{token}/download/pdf")]
    public Task<IActionResult> DownloadSharedPdf(string token, [FromQuery] string siteId,
        [FromQuery] string filePath, [FromQuery] string? password = null)
        => DownloadSharedAsync(token, siteId, filePath, password);

    [AllowAnonymous]
    [HttpGet("shares/view/{token}/download/zip-homepage")]
    public Task<IActionResult> DownloadSharedZipHomepage(string token, [FromQuery] string siteId,
        [FromQuery] string filePath, [FromQuery] long version, [FromQuery] string? password = null)
        => DownloadSharedAsync(token, siteId, filePath, password, version);

    private async Task<IActionResult> DownloadSharedAsync(string token, string siteId, string filePath, string? password, long? zipVersion = null)
    {
        var viewer = User.Identity?.IsAuthenticated == true ? this.GetRequiredUserId() : null;
        var resolved = await _sites.ResolveShareSiteAsync(token, siteId, password, viewer, HttpContext.RequestAborted);
        if (resolved.Error != null)
        {
            if (resolved.RetryAfterSeconds is { } seconds) Response.Headers.RetryAfter = seconds.ToString();
            // 分享密码错误不能触发父站会话登出；与既有离线导出端点采用同一语义。
            var status = resolved.HttpStatus == 401 ? 403 : resolved.HttpStatus;
            var code = resolved.HttpStatus == 401 ? "SHARE_PASSWORD_REQUIRED" : resolved.ErrorCode
                ?? (zipVersion.HasValue ? "ZIP_HOMEPAGE_DOWNLOAD_DENIED" : "PDF_DOWNLOAD_DENIED");
            return StatusCode(status, ApiResponse<object>.Fail(code, resolved.Error));
        }
        return resolved.Site == null ? MissingFile(zipVersion.HasValue) : await DownloadAsync(resolved.Site, filePath, zipVersion);
    }

    private NotFoundObjectResult MissingPdf() => MissingFile(zipHomepage: false);

    private NotFoundObjectResult MissingFile(bool zipHomepage) => NotFound(ApiResponse<object>.Fail(
        ErrorCodes.NOT_FOUND, zipHomepage ? "原文件不存在或网页版本已变化，请刷新后重试。" : "PDF 不存在或当前无法访问，请刷新网页后重试。"));

    private static bool IsSafeZipPath(string path) => HostedSitePdfFiles.IsSafePath(path.Replace('#', '_').Replace('?', '_'));

    private async Task<IActionResult> DownloadAsync(HostedSite site, string filePath, long? zipVersion = null)
    {
        var zipHomepage = zipVersion.HasValue;
        // MongoDB rounds the timestamp to milliseconds. A freshly uploaded URL may retain finer ticks.
        if (zipHomepage && zipVersion / TimeSpan.TicksPerMillisecond
            != HostedSiteService.EffectiveContentVersion(site).Ticks / TimeSpan.TicksPerMillisecond)
            return MissingFile(zipHomepage);
        var file = zipHomepage
            ? site.Files?.FirstOrDefault(file => file.IsZipHomepageAsset && file.Size > 0 && !string.IsNullOrWhiteSpace(file.CosKey) && IsSafeZipPath(file.Path)
                && string.Equals(file.Path, filePath, StringComparison.Ordinal))
            : HostedSitePdfFiles.Find(site, filePath);
        if (file == null) return MissingFile(zipHomepage);
        var label = zipHomepage ? "原文件" : "PDF";
        if (file.Size > MaxPdfDownloadBytes)
            return StatusCode(413, ApiResponse<object>.Fail(zipHomepage ? "ZIP_HOMEPAGE_DOWNLOAD_TOO_LARGE" : "PDF_DOWNLOAD_TOO_LARGE",
                zipHomepage ? $"原文件超过 {MaxPdfDownloadBytes / (1024 * 1024)} MiB 在线下载上限，请联系上传者取得文件。"
                    : $"这份 PDF 超过 {MaxPdfDownloadBytes / (1024 * 1024)} MiB 在线下载上限，请联系分享者提供较小文件。"));
        const string scopeMarker = "__pdf_download_scope__";
        var scope = _storage.BuildSiteKey(site.Id, scopeMarker)[..^scopeMarker.Length];
        if (!file.CosKey.StartsWith(scope, StringComparison.Ordinal)
            || !(zipHomepage ? IsSafeZipPath(file.CosKey[scope.Length..]) : HostedSitePdfFiles.IsSafePath(file.CosKey[scope.Length..])))
            return MissingFile(zipHomepage);
        try
        {
            // 键只能来自本站点清单；请求不含 URL，不经 HTTP 代理，不向客户端暴露物理键。
            var bytes = await _storage.TryDownloadBytesAsync(file.CosKey, HttpContext.RequestAborted);
            if (bytes == null || bytes.LongLength > MaxPdfDownloadBytes || (zipHomepage
                ? bytes.LongLength != file.Size
                : bytes.Length < 5 || !bytes.AsSpan(0, 5).SequenceEqual("%PDF-"u8)))
                return MissingFile(zipHomepage);
            Response.Headers.CacheControl = "private, no-store";
            Response.Headers["X-Content-Type-Options"] = "nosniff";
            Response.Headers["Content-Security-Policy"] = "sandbox";
            return File(bytes, zipHomepage ? "application/octet-stream" : "application/pdf", file.Path.Split('/')[^1]);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "托管文件下载未完成: {SiteId}", site.Id);
            return StatusCode(503, ApiResponse<object>.Fail(zipHomepage ? "ZIP_HOMEPAGE_DOWNLOAD_UNAVAILABLE" : "PDF_DOWNLOAD_UNAVAILABLE",
                $"{label}暂时未能下载，请稍后重新点击下载按钮。"));
        }
    }
}
