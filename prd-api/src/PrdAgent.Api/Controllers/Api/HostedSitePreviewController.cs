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

/// <summary>
/// 预览 iframe 的可嵌入来源（Codex P1，2026-09-15）。默认只有同源；admin 与 API 拆分部署时
/// （前端 <c>VITE_API_BASE_URL</c> 指向另一个源，预览 iframe 由 API 源提供、父页面在 admin 源），
/// <c>frame-ancestors 'self'</c> 会把这块**必看**的发布前核对面板整片挡成空白。
/// 这里复用**已经声明过**的信任来源 <c>Cors:AllowedOrigins</c>——拆分部署本来就得把 admin 源写进去，
/// 否则带凭据的 API 调用一条都过不了——不新开一个配置项，也就不会出现两份各自漂移的名单
/// （判据与接线纪律 形状 3）。
/// </summary>
public sealed class HostedSitePreviewEmbedOptions
{
    /// <summary>没有任何额外来源：只许同源嵌入（单源部署的默认形态）。</summary>
    public static readonly HostedSitePreviewEmbedOptions SelfOnly = new(Array.Empty<string>());

    /// <summary>可写进 CSP frame-ancestors 的额外来源，已规范化成 scheme://host[:port]。</summary>
    public IReadOnlyList<string> FrameAncestors { get; }

    public HostedSitePreviewEmbedOptions(IEnumerable<string> origins)
    {
        var normalized = new List<string>();
        foreach (var raw in origins)
        {
            // CSP source-list 不能塞任意文本：只收能解析成 http/https 绝对地址的项，
            // 输出统一成 scheme://host[:port]，顺手挡掉换行注入与路径/查询残留。
            if (string.IsNullOrWhiteSpace(raw)) continue;
            if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri)) continue;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) continue;
            var origin = uri.IsDefaultPort
                ? $"{uri.Scheme}://{uri.Host}"
                : $"{uri.Scheme}://{uri.Host}:{uri.Port}";
            if (!normalized.Contains(origin, StringComparer.Ordinal)) normalized.Add(origin);
        }
        FrameAncestors = normalized;
    }

    public static HostedSitePreviewEmbedOptions FromConfiguration(IConfiguration configuration)
    {
        var section = configuration.GetSection("Cors:AllowedOrigins");
        if (!section.Exists()) return SelfOnly;
        return new HostedSitePreviewEmbedOptions(
            section.GetChildren().Select(child => child.Value ?? string.Empty));
    }
}

[ApiController]
[Route(HostedSitePreviewFilesController.RoutePrefix)]
public sealed class HostedSitePreviewFilesController : ControllerBase
{
    public const string CookieNamePrefix = "MapVerifiedPreview_";
    private const string PolicyWithoutFrameAncestors =
        "sandbox allow-scripts allow-forms allow-modals allow-downloads; " +
        HostedSiteRevisionRules.VerifiedPackageArtifactCsp;

    /// <summary>路由前缀与 cookie 的 Path 必须同源：写死两遍就是两份会各自漂移的判据。</summary>
    internal const string RoutePrefix = "api/hosted-site-preview-files";

    private readonly IHostedSiteRevisionService _revisions;
    private readonly HostedSitePreviewAccessService _access;
    private readonly HostedSitePreviewEmbedOptions _embed;

    public HostedSitePreviewFilesController(
        IHostedSiteRevisionService revisions,
        HostedSitePreviewAccessService access,
        HostedSitePreviewEmbedOptions? embed = null)
    {
        _revisions = revisions;
        _access = access;
        _embed = embed ?? HostedSitePreviewEmbedOptions.SelfOnly;
    }

    /// <summary>同源永远允许；配置里声明过的来源额外放行。</summary>
    internal static string BuildContentSecurityPolicy(HostedSitePreviewEmbedOptions embed)
    {
        var ancestors = embed.FrameAncestors.Count == 0
            ? "'self'"
            : "'self' " + string.Join(' ', embed.FrameAncestors);
        return $"{PolicyWithoutFrameAncestors}; frame-ancestors {ancestors}";
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
            // 同源嵌入保持 Strict。拆分部署时 iframe 处在跨站上下文，Strict / Lax 的 cookie
            // 浏览器一律不带，预览会在 CSP 放行之后照样空白——所以只在浏览器明确告知
            // Sec-Fetch-Site: cross-site 时降到 None。票据本身 HttpOnly + Secure + 短时效 +
            // 绑定单个版本，降的是嵌入范围不是校验强度；拿不到这个头就维持 Strict，不猜。
            SameSite = IsCrossSiteEmbed() ? SameSiteMode.None : SameSiteMode.Strict,
            IsEssential = true,
            Expires = payload.ExpiresAt,
            // 只跟着自己这条预览的资源请求走。Path="/" 时，15 分钟寿命内签发过的**每一张**
            // 票据都会附在打到本域名的所有请求上——用户连着翻几十个版本就能把 cookie 与
            // 请求头堆到上限，打坏的是与预览无关的普通接口，而且要等 cookie 过期才恢复
            //（Codex P2，2026-09-16）。accessId 是 32 位十六进制，可直接进路径。
            Path = $"/{RoutePrefix}/{payload.AccessId}",
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
            Response.Headers.ContentSecurityPolicy = BuildContentSecurityPolicy(_embed);
            Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
        }
    }

    private void ApplyNoStoreHeaders()
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        Response.Headers.Pragma = "no-cache";
        Response.Headers["Referrer-Policy"] = "no-referrer";
    }

    private bool IsCrossSiteEmbed()
    {
        if (_embed.FrameAncestors.Count == 0) return false;
        return string.Equals(Request.Headers["Sec-Fetch-Site"], "cross-site", StringComparison.Ordinal);
    }

    private NotFoundObjectResult Missing() => NotFound(ApiResponse<object>.Fail(
        ErrorCodes.NOT_FOUND,
        "预览已失效，请返回作品页面重新打开"));

    private static string CookieNameFor(string accessId) => CookieNamePrefix + accessId;
}
