using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesOpenApiController
{
    // 仓库内 Nginx 请求上限为 30 MiB；预留 1 MiB 给 multipart 边界和元数据。
    // 解包后的资源限制仍由 HostedSiteUploadLimits 约束，不能当作直传容量发布给客户端。
    internal const long MaxDirectUploadFileBytes = 29L * 1024 * 1024;
    private const long MaxUploadRequestSize = MaxDirectUploadFileBytes + 1024 * 1024;

    /// <summary>MCP 取得受限上传凭证；原文件由客户端直接 multipart 上传，不经过模型转写。</summary>
    [HttpGet("upload-info")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> GetUploadInfo([FromQuery] string? siteId = null)
    {
        if (siteId != null)
        {
            var site = await _sites.GetByIdAsync(siteId, GetBoundUserId(), CancellationToken.None);
            if (site == null || !await _sites.CanEditSiteAsync(site, GetBoundUserId(), CancellationToken.None))
                return MissingSite();
            var grantError = await RequireSiteContentExposureGrantAsync(site);
            if (grantError != null) return grantError;
        }
        var apiKey = PrdAgent.Api.Authentication.ApiKeyCredentialHeaders.Read(Request) ?? string.Empty;
        if (!apiKey.StartsWith("sk-ak-", StringComparison.Ordinal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_CREDENTIALS, "请通过已连接的 MAP 智能体密钥获取上传凭证"));
        var protection = HttpContext.RequestServices.GetService<IDataProtectionProvider>();
        if (protection == null)
            return StatusCode(503, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "上传凭证服务暂不可用，请稍后重试"));
        var (token, expiresAt) = McpHostedSiteUploadTicket.Issue(protection, apiKey, siteId);
        Response.Headers.CacheControl = "no-store";
        return Ok(ApiResponse<object>.Ok(new
        {
            uploadUrl = Request.ResolveAbsoluteUrl(siteId == null
                ? "/api/open/web-pages/upload" : $"/api/open/web-pages/pages/{Uri.EscapeDataString(siteId)}/reupload"),
            method = "POST",
            contentType = "multipart/form-data",
            fileField = "file",
            uploadToken = token,
            expiresAt,
            authorization = "Authorization: Bearer <uploadToken>",
            maxPackageBytes = MaxDirectUploadFileBytes,
            maxSingleFileBytes = MaxDirectUploadFileBytes,
            maxExpandedPackageBytes = HostedSiteUploadLimits.MaxPackageBytes,
            maxExtractedFileBytes = HostedSiteUploadLimits.MaxSingleFileBytes,
            supportedExtensions = new[] { ".html", ".htm", ".zip", ".md", ".markdown", ".pdf", ".mp4", ".m4v", ".webm", ".mov", ".ogg", ".ogv" }
                .Concat(WebPagesController.ImageExtensions).OrderBy(x => x, StringComparer.Ordinal).ToList(),
            fields = new[] { "file", "title", "description", "folder", "tags", "uploadId", "clientRequestId" },
            instruction = "将原始文件作为 file 字段上传，直传文件最多 29 MiB；更大的文件请使用网页托管的分片上传。不要把 ZIP 重写成单页，不要把文件转为 base64。凭证仅用于本次指定上传路径，十分钟内有效；原密钥撤销或权限变化后立即失效。上传成功后读回 siteId 和文件清单核验。",
        }));
    }

    [HttpPost("upload")]
    [RequireScope(ScopeWrite)]
    [RequestSizeLimit(MaxUploadRequestSize)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxDirectUploadFileBytes)]
    public Task<IActionResult> UploadFile(IFormFile file, [FromForm] string? title,
        [FromForm] string? description, [FromForm] string? folder, [FromForm] string? tags,
        [FromForm] string? uploadId, [FromForm] string? clientRequestId)
        => StoreUploadedFileAsync(file, null, title, description, folder, tags, uploadId, clientRequestId);

    [HttpPost("pages/{siteId}/reupload")]
    [RequireScope(ScopeWrite)]
    [RequestSizeLimit(MaxUploadRequestSize)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxDirectUploadFileBytes)]
    public Task<IActionResult> ReuploadFile(string siteId, IFormFile file,
        [FromForm] string? uploadId, [FromForm] string? clientRequestId)
        => StoreUploadedFileAsync(file, siteId, null, null, null, null, uploadId, clientRequestId);

    private async Task<IActionResult> StoreUploadedFileAsync(IFormFile? file, string? siteId,
        string? title, string? description, string? folder, string? tags, string? uploadId, string? clientRequestId)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请在 file 字段上传原始文件"));
        var extension = Path.GetExtension(file.FileName).ToLowerInvariant();
        var error = ValidateUploadedFile(file.Length, extension);
        var metadata = new PublishPageRequest { Title = title, Description = description, Folder = folder,
            Tags = tags?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList() };
        error ??= ValidateMetadata(metadata);
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var userId = GetBoundUserId();
        if (siteId != null)
        {
            var target = await _sites.GetByIdAsync(siteId, userId, CancellationToken.None);
            if (target == null || !await _sites.CanEditSiteAsync(target, userId, CancellationToken.None)) return MissingSite();
            var grantError = await RequireSiteContentExposureGrantAsync(target);
            if (grantError != null) return grantError;
        }
        var progressId = ScopedUploadId(uploadId);
        var sourceRef = BuildSourceRef(clientRequestId);
        try
        {
            if (siteId == null && sourceRef != null)
            {
                var previous = await _db.HostedSites.Find(s => s.OwnerUserId == userId && s.SourceRef == sourceRef)
                    .FirstOrDefaultAsync(CancellationToken.None);
                if (previous != null) return Ok(ApiResponse<object>.Ok(SiteDto(previous, deduplicated: true)));
            }
            HostedSite site;
            if (extension == ".zip")
            {
                using var input = file.OpenReadStream();
                site = siteId == null
                    ? await _sites.CreateFromZipAsync(userId, input, title, description, folder, metadata.Tags,
                        ct: CancellationToken.None, uploadId: progressId, sourceRef: sourceRef)
                    : await _sites.ReuploadAsync(siteId, userId, input, file.FileName,
                        ct: CancellationToken.None, uploadId: progressId, reuploadRef: sourceRef);
            }
            else
            {
                using var input = file.OpenReadStream();
                using var bytes = new MemoryStream();
                await input.CopyToAsync(bytes, CancellationToken.None);
                var content = bytes.ToArray();
                var uploadName = file.FileName;
                var wrappedType = WebPagesController.WrappedUploadType(extension);
                if (wrappedType != null)
                {
                    content = WebPagesController.BuildWrapperZip(file.FileName, content, extension, title);
                    uploadName = Path.ChangeExtension(file.FileName, ".zip");
                }
                site = siteId != null
                    ? await _sites.ReuploadAsync(siteId, userId, content, uploadName, wrappedType,
                        ct: CancellationToken.None, uploadId: progressId, reuploadRef: sourceRef)
                    : wrappedType != null
                        ? await _sites.CreateFromZipAsync(userId, content,
                            string.IsNullOrWhiteSpace(title) ? Path.GetFileNameWithoutExtension(file.FileName) : title,
                            description, folder, metadata.Tags, wrappedType,
                            ct: CancellationToken.None, uploadId: progressId, sourceRef: sourceRef)
                        : sourceRef != null
                            ? await _sites.CreateFromHtmlIdempotentAsync(userId, content, file.FileName, title,
                                description, folder, metadata.Tags, "api", sourceRef, CancellationToken.None)
                            : await _sites.CreateFromHtmlAsync(userId, content, file.FileName, title,
                                description, folder, metadata.Tags, CancellationToken.None);
            }
            return Ok(ApiResponse<object>.Ok(SiteDto(site)));
        }
        catch (KeyNotFoundException) { return MissingSite(); }
        catch (UnauthorizedAccessException) { return MissingSite(); }
        catch (InvalidOperationException ex)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
        finally { if (_uploadProgress != null) await _uploadProgress.CompleteAsync(progressId, CancellationToken.None); }
    }

    internal static string? ValidateUploadedFile(long bytes, string extension)
    {
        if (bytes <= 0) return "文件不能为空";
        if (extension is not ".zip" and not ".html" and not ".htm" && !WebPagesController.IsWrappedUploadExtension(extension))
            return "请上传 HTML、ZIP、图片、PDF、Markdown 或支持的视频文件";
        if (bytes > MaxDirectUploadFileBytes)
            return "直传文件不能超过 29 MiB，请使用网页托管的分片上传";
        return WebPagesController.ValidateUploadSize(bytes, extension);
    }

    private string? ScopedUploadId(string? id)
        => string.IsNullOrWhiteSpace(id) ? null : "mcp-upload:" + Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(GetBoundUserId() + ":" + id))).ToLowerInvariant();

    [HttpGet("upload-progress/{uploadId}")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> GetUploadProgress(string uploadId)
        => Ok(ApiResponse<object>.Ok(new { progress = _uploadProgress == null ? null
            : await _uploadProgress.GetAsync(ScopedUploadId(uploadId)!, CancellationToken.None) }));

    [HttpGet("pages/{siteId}")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> GetPage(string siteId, [FromQuery] int offset = 0, [FromQuery] int limit = 200)
    {
        if (offset < 0 || limit is < 1 or > 1000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "offset 不能为负数，limit 必须在 1-1000 之间"));
        var site = await _sites.GetByIdAsync(siteId, GetBoundUserId(), CancellationToken.None);
        return site == null ? MissingSite() : Ok(ApiResponse<object>.Ok(SiteDto(site, offset: offset, limit: limit)));
    }

    [HttpGet("pages/{siteId}/content")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> GetPageContent(string siteId)
    {
        try
        {
            // 源码读取复用编辑入口的权限与 2MB 上限；不新建无界对象下载通道。
            var entry = await _sites.GetEditableEntryHtmlAsync(siteId, GetBoundUserId(), CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { siteId, html = entry.Html, contentVersion = entry.ContentVersion }));
        }
        catch (KeyNotFoundException) { return MissingSite(); }
        catch (InvalidOperationException ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    [HttpPatch("pages/{siteId}")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> UpdatePage(string siteId, [FromBody] PublishPageRequest request)
    {
        var error = ValidateMetadata(request);
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var target = await _sites.GetByIdAsync(siteId, GetBoundUserId(), CancellationToken.None);
        if (target == null || !await _sites.CanEditSiteAsync(target, GetBoundUserId(), CancellationToken.None)) return MissingSite();
        var grantError = await RequireSiteContentExposureGrantAsync(target);
        if (grantError != null) return grantError;
        var site = await _sites.UpdateAsync(siteId, GetBoundUserId(), request.Title, request.Description,
            request.Tags, request.Folder, null, CancellationToken.None);
        return site == null ? MissingSite() : Ok(ApiResponse<object>.Ok(SiteDto(site)));
    }

    public class VisibilityRequest
    {
        public string? Visibility { get; set; }
        public bool ConfirmedExposure { get; set; }
        public string? ConfirmedPrivateSourceFingerprint { get; set; }
    }

    [HttpPatch("pages/{siteId}/visibility")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> SetPageVisibility(string siteId, [FromBody] VisibilityRequest request)
    {
        var visibility = request.Visibility?.Trim().ToLowerInvariant();
        if (visibility is not "private" and not "public")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "visibility 只能是 private 或 public"));
        if (visibility == "public" && !request.ConfirmedExposure)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "公开网页前，请明确确认用户要求公开，再传 confirmedExposure=true"));
        if (visibility == "public")
        {
            var grantError = RequireWebExposureGrant();
            if (grantError != null) return grantError;
        }
        var fingerprintError = ValidatePrivateSourceFingerprint(request.ConfirmedPrivateSourceFingerprint);
        if (fingerprintError != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, fingerprintError));
        var userId = GetBoundUserId();
        var site = await _sites.GetByIdAsync(siteId, userId, CancellationToken.None);
        if (site == null || !_sites.CanSetVisibility(site, userId)) return MissingSite();
        if (visibility == "public" && site.Visibility != "public")
        {
            var refusal = await EnforcePrivateSourcesAsync([site], HostedSitePrivateSourceActions.SitePublic,
                request.ConfirmedPrivateSourceFingerprint);
            if (refusal != null) return refusal;
        }
        var updated = await _sites.SetVisibilityAsync(siteId, userId, visibility, CancellationToken.None);
        return updated == null ? MissingSite() : Ok(ApiResponse<object>.Ok(SiteDto(updated)));
    }

    [HttpGet("pages/{siteId}/private-sources")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> InspectPagePrivateSources(string siteId)
    {
        var userId = GetBoundUserId();
        if (!await _sites.CanCreateShareAsync([siteId], userId, CancellationToken.None)) return MissingSite();
        var site = await _sites.GetByIdAsync(siteId, userId, CancellationToken.None);
        if (site == null) return MissingSite();
        if (_privateSources == null) return PrivateSourceServiceUnavailable();
        var report = await _privateSources.InspectSitesAsync([site], CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(HostedSitePrivateSourceResponses.ToDto(report, report.HasPrivateSources)));
    }

    [HttpGet("shares")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> ListPageShares([FromQuery] string? siteId = null)
    {
        var items = await _sites.ListSharesAsync(GetBoundUserId(), CancellationToken.None, includeRevoked: true, siteId: siteId);
        return Ok(ApiResponse<object>.Ok(new { items = items.Select(ShareDto).ToList() }));
    }

    public sealed class ShareSettingsRequest : VisibilityRequest
    {
        public int? ExpiresInDays { get; set; }
    }

    [HttpPatch("shares/{shareId}")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> UpdatePageShare(string shareId, [FromBody] ShareSettingsRequest request)
    {
        var error = ValidateShareSettings(request.Visibility, request.ExpiresInDays, request.ConfirmedExposure)
            ?? ValidatePrivateSourceFingerprint(request.ConfirmedPrivateSourceFingerprint);
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var userId = GetBoundUserId();
        var share = await _db.WebPageShareLinks.Find(s => s.Id == shareId && s.CreatedBy == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (share == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享不存在或无权操作"));
        var visibility = NormalizeShareVisibility(request.Visibility);
        var external = IsExternallyAccessibleShare(share, visibility);
        if (external)
        {
            var grantError = RequireWebExposureGrant();
            if (grantError != null) return grantError;
        }
        if (external && request.ExpiresInDays != null && !request.ConfirmedExposure)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "修改对外分享有效期前，请确认用户意图并传 confirmedExposure=true"));
        // 放宽范围或延续对外暴露时，均重新核查当前线上内容引用的私有资料。
        if (!share.IsRevoked && external
            && (visibility != null && visibility != share.Visibility || request.ExpiresInDays != null))
        {
            var refusal = await EnforceSharePrivateSourcesAsync(share, request.ConfirmedPrivateSourceFingerprint);
            if (refusal != null) return refusal;
        }
        var result = await _sites.UpdateShareSettingsAsync(shareId, userId, visibility, request.ExpiresInDays, CancellationToken.None);
        return result.Ok ? Ok(ApiResponse<object>.Ok(new { shareId, visibility = result.Visibility, expiresAt = result.ExpiresAt,
            shareUrl = Request.ResolveAbsoluteUrl($"/s/wp/{share.Token}") }))
            : BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Error ?? "分享修改失败，请刷新后重试"));
    }

    public sealed class RenewPageShareRequest
    {
        public int ExtendDays { get; set; }
        public bool ConfirmedExposure { get; set; }
        public string? ConfirmedPrivateSourceFingerprint { get; set; }
    }

    [HttpPost("shares/{shareId}/renew")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> RenewPageShare(string shareId, [FromBody] RenewPageShareRequest request)
    {
        if (request.ExtendDays is < 1 or > 365)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "extendDays 必须在 1 到 365 天之间；设永久请修改分享设置"));
        var fingerprintError = ValidatePrivateSourceFingerprint(request.ConfirmedPrivateSourceFingerprint);
        if (fingerprintError != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, fingerprintError));
        var userId = GetBoundUserId();
        var share = await _db.WebPageShareLinks.Find(s => s.Id == shareId && s.CreatedBy == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (share == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享不存在或无权操作"));
        if (!share.IsRevoked && IsExternallyAccessibleShare(share))
        {
            var grantError = RequireWebExposureGrant();
            if (grantError != null) return grantError;
            if (!request.ConfirmedExposure)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "延长对外分享前，请确认用户意图并传 confirmedExposure=true"));
            var refusal = await EnforceSharePrivateSourcesAsync(share, request.ConfirmedPrivateSourceFingerprint);
            if (refusal != null) return refusal;
        }
        var result = await _sites.RenewShareAsync(shareId, userId, request.ExtendDays, CancellationToken.None);
        return result.Ok ? Ok(ApiResponse<object>.Ok(new { shareId, expiresAt = result.NewExpiresAt }))
            : BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Error ?? "续期失败，请刷新后重试"));
    }

    public sealed class RevokeShareRequest { public string? Reason { get; set; } }

    [HttpPost("shares/{shareId}/revoke")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> RevokePageShare(string shareId, [FromBody] RevokeShareRequest? request)
    {
        var error = McpInputBounds.Text(request?.Reason, McpInputBounds.DescriptionBytes, "reason");
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var revoked = await _sites.RevokeShareAsync(shareId, GetBoundUserId(), request?.Reason, CancellationToken.None);
        return revoked ? Ok(ApiResponse<object>.Ok(new { shareId, revoked = true }))
            : NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在或无权操作"));
    }

    internal static string? NormalizeShareVisibility(string? visibility) => visibility?.Trim().ToLowerInvariant();
    internal static bool IsExternalVisibility(string? visibility) => visibility is "public" or "logged-in";
    internal static string? ValidateShareSettings(string? visibility, int? days, bool confirmedExposure)
    {
        var normalized = NormalizeShareVisibility(visibility);
        if (normalized != null && normalized is not "owner-only" and not "logged-in" and not "public")
            return "visibility 只能是 owner-only、logged-in 或 public";
        if (days is < 0 or > 365) return "expiresInDays 必须在 0（永久）到 365 天之间";
        if (IsExternalVisibility(normalized) && !confirmedExposure)
            return "对外分享前，请明确确认用户要求该范围，再传 confirmedExposure=true";
        return null;
    }

    private async Task<IActionResult?> EnforceSharePrivateSourcesAsync(WebPageShareLink share, string? fingerprint)
    {
        var sites = new List<HostedSite>();
        foreach (var id in share.TargetSiteIds())
        {
            var site = await _sites.GetByIdAsync(id, GetBoundUserId(), CancellationToken.None);
            if (site == null) return MissingSite();
            sites.Add(site);
        }
        return await EnforcePrivateSourcesAsync(sites, HostedSitePrivateSourceActions.ShareWiden, fingerprint);
    }

    internal static string? ValidatePrivateSourceFingerprint(string? fingerprint)
        => fingerprint == null || System.Text.RegularExpressions.Regex.IsMatch(fingerprint, @"\Apsc1:[a-f0-9]{64}\z")
            ? null : "私有资料确认指纹格式无效，请重新核查当前资料后再确认";

    private async Task<IActionResult?> EnforcePrivateSourcesAsync(IReadOnlyList<HostedSite> sites, string action, string? fingerprint)
    {
        if (_privateSources == null) return PrivateSourceServiceUnavailable();
        var decision = await _privateSources.EnforceForSitesAsync(sites, action, GetBoundUserId(), fingerprint, CancellationToken.None);
        if (decision.Allowed) return null;
        var response = ApiResponse<object>.Fail(decision.ErrorCode, decision.Message);
        response.Data = HostedSitePrivateSourceResponses.ToDto(decision.Report, requiresConfirmation: true);
        return Conflict(response);
    }

    private IActionResult PrivateSourceServiceUnavailable() => StatusCode(503,
        ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "私有资料核查暂不可用，请稍后重试公开或分享"));
    private IActionResult MissingSite() => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "网页不存在或无权操作"));

    private object ShareDto(WebPageShareLink share) => new
    {
        shareId = share.Id, siteIds = share.TargetSiteIds(), title = share.Title,
        visibility = share.Visibility, expiresAt = share.ExpiresAt, revoked = share.IsRevoked,
        shareUrl = Request.ResolveAbsoluteUrl($"/s/wp/{share.Token}"),
    };

    private object SiteDto(HostedSite site, bool deduplicated = false, int offset = 0, int limit = 200) => new
    {
        siteId = site.Id, title = site.Title, description = site.Description,
        url = Request.ResolveAbsoluteUrl(site.SiteUrl), visibility = site.Visibility,
        folder = site.Folder, tags = site.Tags, entryFile = site.EntryFile, contentVersion = site.ContentVersion,
        wrappedAssetType = site.WrappedAssetType, fileCount = site.Files.Count, totalSize = site.TotalSize, deduplicated,
        filesOffset = offset, filesHasMore = offset + limit < site.Files.Count,
        files = site.Files.Skip(offset).Take(limit).Select(f => new { path = f.Path, size = f.Size, mimeType = f.MimeType,
            url = f.Url == null ? null : Request.ResolveAbsoluteUrl(f.Url) }).ToList(),
    };
}
