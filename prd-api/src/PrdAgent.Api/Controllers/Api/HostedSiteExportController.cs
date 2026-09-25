using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页托管：下载单文件离线 HTML（站内资源全部内嵌，外部绝对地址原样保留）。
///
/// 两个入口、两道门，**门都不是这里新写的**：
/// - 站内（工作台）：与编辑站点同一道门——GetByIdAsync 只放行 owner / 共享团队成员，
///   再叠 CanEditSiteAsync（viewer 读得到站点但不能导出整份源码）。
/// - 分享链接：完全复用 ResolveShareSiteAsync（撤销 / 过期 / 可见性 / 密码 + 限流），
///   与分享页取正文是同一条判定源。另要求登录，与分享页「下载源文件」按钮的门槛一致。
/// </summary>
[ApiController]
[Route("api/web-pages")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class HostedSiteExportController : ControllerBase
{
    public const string MissingCountHeader = "X-Offline-Export-Missing-Count";
    public const string MissingHeader = "X-Offline-Export-Missing";
    public const string InlinedCountHeader = "X-Offline-Export-Inlined-Count";
    private const int MaxMissingInHeader = 20;

    private readonly IHostedSiteService _sites;
    private readonly IHostedSiteOfflineExportService _exporter;

    public HostedSiteExportController(IHostedSiteService sites, IHostedSiteOfflineExportService exporter)
    {
        _sites = sites;
        _exporter = exporter;
    }

    /// <summary>站内下载离线 HTML（owner / 团队编辑者）。</summary>
    [HttpGet("{id}/export/offline-html")]
    public async Task<IActionResult> ExportOwnedSite(string id)
    {
        var userId = this.GetRequiredUserId();
        var site = await _sites.GetByIdAsync(id, userId, CancellationToken.None);
        // 不存在与无权说同一句话：不借错误文案告诉外人「这个 id 的站点存在」。
        if (site == null || !await _sites.CanEditSiteAsync(site, userId, CancellationToken.None))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "网页不存在，或你没有编辑这个网页的权限，请返回列表刷新后重试。"));
        return await ExportAsync(site);
    }

    /// <summary>经分享链接下载离线 HTML（需登录；分享门禁与分享页正文完全同源）。</summary>
    [HttpGet("shares/view/{token}/export/offline-html")]
    public async Task<IActionResult> ExportSharedSite(string token, [FromQuery] string? siteId, [FromQuery] string? password)
    {
        var userId = this.GetRequiredUserId();
        var resolved = await _sites.ResolveShareSiteAsync(token, siteId, password, userId, CancellationToken.None);
        if (resolved.Error != null)
            return MapShareGateError(resolved);
        if (resolved.Site == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享里的网页已经不存在了，请联系分享者重新分享。"));
        return await ExportAsync(resolved.Site);
    }

    private async Task<IActionResult> ExportAsync(HostedSite site)
    {
        // 打包与客户端连接解耦：用户中途关页不该让一次已经读了一半存储的打包半途而废（server-authority）。
        var result = await _exporter.ExportAsync(site, CancellationToken.None);
        if (!result.Succeeded)
        {
            var failure = result.Failure!.Value;
            var body = ApiResponse<object>.Fail(FailureCode(failure), result.Message ?? "离线打包没有完成，请稍后重试。");
            return failure switch
            {
                HostedSiteOfflineExportFailure.TooLarge => StatusCode(StatusCodes.Status413PayloadTooLarge, body),
                HostedSiteOfflineExportFailure.EntryMissing => NotFound(body),
                HostedSiteOfflineExportFailure.EntryUnreadable => StatusCode(StatusCodes.Status503ServiceUnavailable, body),
                _ => BadRequest(body),
            };
        }

        Response.Headers[MissingCountHeader] = result.Missing.Count.ToString();
        Response.Headers[InlinedCountHeader] = result.InlinedCount.ToString();
        if (result.Missing.Count > 0)
        {
            // 头只能装 ASCII：路径逐条百分号编码，「原因:路径」用逗号连起来，只带前 20 条。
            Response.Headers[MissingHeader] = string.Join(",", result.Missing
                .Take(MaxMissingInHeader)
                .Select(m => m.Reason + ":" + Uri.EscapeDataString(m.Reference)));
        }
        // 这是用户上传的任意 HTML，从 API 源下发：强制附件 + 沙箱 + 不嗅探，绝不在主站源上渲染。
        Response.Headers["Content-Security-Policy"] = "sandbox";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers["Cache-Control"] = "no-store";
        return File(result.Html, "text/html; charset=utf-8", result.FileName);
    }

    /// <summary>失败枚举 → 对外错误码的唯一映射。前端按码出文案，不去猜句子。</summary>
    public static string FailureCode(HostedSiteOfflineExportFailure failure) => failure switch
    {
        HostedSiteOfflineExportFailure.WrappedAsset => "OFFLINE_EXPORT_WRAPPED_ASSET",
        HostedSiteOfflineExportFailure.EntryNotHtml => "OFFLINE_EXPORT_ENTRY_NOT_HTML",
        HostedSiteOfflineExportFailure.EntryMissing => "OFFLINE_EXPORT_ENTRY_MISSING",
        HostedSiteOfflineExportFailure.EntryUnreadable => "OFFLINE_EXPORT_ENTRY_UNREADABLE",
        HostedSiteOfflineExportFailure.TooLarge => "OFFLINE_EXPORT_TOO_LARGE",
        _ => "OFFLINE_EXPORT_FAILED",
    };

    /// <summary>
    /// 分享门禁错误 → HTTP。与 WebPagesController.MapCommentError 的唯一差别是 401：
    /// 这里的 401 是「分享密码不对」，不是登录失效。原样回 401 会被前端下载器当成会话过期，
    /// 刷新令牌、再失败就直接把用户登出——所以改成 403 + SHARE_PASSWORD_REQUIRED。
    /// </summary>
    private IActionResult MapShareGateError(ShareSiteResolveResult resolved)
    {
        var message = resolved.Error ?? "分享链接不可用";
        switch (resolved.HttpStatus)
        {
            case 429:
                if (resolved.RetryAfterSeconds is { } ra && ra > 0)
                    Response.Headers["Retry-After"] = ra.ToString();
                return StatusCode(429, ApiResponse<object>.Fail("RATE_LIMITED", message));
            case 401:
                return StatusCode(403, ApiResponse<object>.Fail("SHARE_PASSWORD_REQUIRED", message));
            case 403:
                return StatusCode(403, ApiResponse<object>.Fail(resolved.ErrorCode ?? "VISIBILITY_DENIED", message));
            case 400:
                return BadRequest(ApiResponse<object>.Fail("SHARE_EXPIRED", message));
            default:
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, message));
        }
    }
}
