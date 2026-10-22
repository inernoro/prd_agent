using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/web-pages")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class HostedSitePdfDownloadController : ControllerBase
{
    // 现有存储读取接口返回 byte[]；为低内存实例设置独立下载预算，不改托管容量。
    public const long MaxPdfDownloadBytes = 32L * 1024 * 1024;
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

    [AllowAnonymous]
    [HttpGet("shares/view/{token}/download/pdf")]
    public async Task<IActionResult> DownloadSharedPdf(string token, [FromQuery] string siteId,
        [FromQuery] string filePath, [FromQuery] string? password = null)
    {
        var viewer = User.Identity?.IsAuthenticated == true ? this.GetRequiredUserId() : null;
        var resolved = await _sites.ResolveShareSiteAsync(token, siteId, password, viewer, HttpContext.RequestAborted);
        if (resolved.Error != null)
        {
            if (resolved.RetryAfterSeconds is { } seconds) Response.Headers.RetryAfter = seconds.ToString();
            // 分享密码错误不能触发父站会话登出；与既有离线导出端点采用同一语义。
            var status = resolved.HttpStatus == 401 ? 403 : resolved.HttpStatus;
            var code = resolved.HttpStatus == 401 ? "SHARE_PASSWORD_REQUIRED" : resolved.ErrorCode ?? "PDF_DOWNLOAD_DENIED";
            return StatusCode(status, ApiResponse<object>.Fail(code, resolved.Error));
        }
        return resolved.Site == null ? MissingPdf() : await DownloadAsync(resolved.Site, filePath);
    }

    private NotFoundObjectResult MissingPdf() => NotFound(ApiResponse<object>.Fail(
        ErrorCodes.NOT_FOUND, "PDF 不存在或当前无法访问，请刷新网页后重试。"));

    private async Task<IActionResult> DownloadAsync(HostedSite site, string filePath)
    {
        var file = HostedSitePdfFiles.Find(site, filePath);
        if (file == null) return MissingPdf();
        if (file.Size > MaxPdfDownloadBytes)
            return StatusCode(413, ApiResponse<object>.Fail("PDF_DOWNLOAD_TOO_LARGE",
                "这份 PDF 超过 32 MB 在线下载上限，请联系分享者提供文件。"));
        const string scopeMarker = "__pdf_download_scope__";
        var scope = _storage.BuildSiteKey(site.Id, scopeMarker)[..^scopeMarker.Length];
        if (!file.CosKey.StartsWith(scope, StringComparison.Ordinal)
            || !HostedSitePdfFiles.IsSafePath(file.CosKey[scope.Length..]))
            return MissingPdf();
        try
        {
            // 键只能来自本站点清单；请求不含 URL，不经 HTTP 代理，不向客户端暴露物理键。
            var bytes = await _storage.TryDownloadBytesAsync(file.CosKey, HttpContext.RequestAborted);
            if (bytes == null || bytes.LongLength > MaxPdfDownloadBytes
                || bytes.Length < 5 || !bytes.AsSpan(0, 5).SequenceEqual("%PDF-"u8))
                return MissingPdf();
            Response.Headers.CacheControl = "private, no-store";
            Response.Headers["X-Content-Type-Options"] = "nosniff";
            Response.Headers["Content-Security-Policy"] = "sandbox";
            return File(bytes, "application/pdf", file.Path.Split('/')[^1]);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "托管 PDF 下载未完成: {SiteId}", site.Id);
            return StatusCode(503, ApiResponse<object>.Fail("PDF_DOWNLOAD_UNAVAILABLE",
                "PDF 暂时未能下载，请稍后重新点击下载按钮。"));
        }
    }
}
