using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页托管与分享 — 用户上传 HTML/ZIP 并托管运行
/// </summary>
[ApiController]
[Route("api/web-pages")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public class WebPagesController : ControllerBase
{
    private readonly IHostedSiteService _siteService;

    private const long MaxSingleFileSize = 50 * 1024 * 1024; // 50MB

    public WebPagesController(IHostedSiteService siteService)
    {
        _siteService = siteService;
    }

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private string GetDisplayName()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst("display_name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value
           ?? "用户";

    // ─────────────────────────────────────────────
    // 上传 / 创建
    // ─────────────────────────────────────────────

    /// <summary>上传 HTML 文件或 ZIP 压缩包，解压并托管</summary>
    [HttpPost("upload")]
    [RequestSizeLimit(MaxSingleFileSize)]
    public async Task<IActionResult> Upload(
        IFormFile file,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? folder,
        [FromForm] string? tags)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));

        if (file.Length > MaxSingleFileSize)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxSingleFileSize / 1024 / 1024}MB"));

        var userId = GetUserId();
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var fileBytes = ms.ToArray();

        var tagList = string.IsNullOrWhiteSpace(tags)
            ? new List<string>()
            : tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

        try
        {
            HostedSite site;
            if (ext == ".zip")
            {
                site = await _siteService.CreateFromZipAsync(userId, fileBytes, title, description, folder, tagList);
            }
            else if (ext is ".html" or ".htm")
            {
                site = await _siteService.CreateFromHtmlAsync(userId, fileBytes, file.FileName, title, description, folder, tagList);
            }
            else
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持 .html/.htm/.zip 文件"));
            }

            return Ok(ApiResponse<object>.Ok(site));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>从 HTML 内容直接创建站点（供工作流/API 调用）</summary>
    [HttpPost("from-content")]
    public async Task<IActionResult> CreateFromContent([FromBody] CreateFromContentRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.HtmlContent))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "htmlContent 不能为空"));

        var site = await _siteService.CreateFromContentAsync(
            GetUserId(), req.HtmlContent,
            req.Title, req.Description,
            req.SourceType ?? "api", req.SourceRef,
            req.Tags, req.Folder);

        return Ok(ApiResponse<object>.Ok(site));
    }

    // ─────────────────────────────────────────────
    // CRUD
    // ─────────────────────────────────────────────

    /// <summary>获取当前用户的站点列表</summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? keyword,
        [FromQuery] string? folder,
        [FromQuery] string? tag,
        [FromQuery] string? sourceType,
        [FromQuery] string sort = "newest",
        [FromQuery] int skip = 0,
        [FromQuery] int limit = 50)
    {
        var (items, total) = await _siteService.ListAsync(
            GetUserId(), keyword, folder, tag, sourceType, sort, skip, limit);
        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>获取站点详情</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var site = await _siteService.GetByIdAsync(id, GetUserId());
        if (site == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        return Ok(ApiResponse<object>.Ok(site));
    }

    /// <summary>更新站点元信息</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateHostedSiteRequest req)
    {
        if (req.Title == null && req.Description == null && req.Tags == null && req.Folder == null && req.CoverImageUrl == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有需要更新的字段"));

        var updated = await _siteService.UpdateAsync(
            id, GetUserId(), req.Title, req.Description, req.Tags, req.Folder, req.CoverImageUrl);

        if (updated == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));

        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>重新上传站点内容（覆盖原有文件）</summary>
    [HttpPost("{id}/reupload")]
    [RequestSizeLimit(MaxSingleFileSize)]
    public async Task<IActionResult> Reupload(string id, IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);

        try
        {
            var updated = await _siteService.ReuploadAsync(id, GetUserId(), ms.ToArray(), file.FileName);
            return Ok(ApiResponse<object>.Ok(updated));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>删除站点（含 COS 文件清理）</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        var ok = await _siteService.DeleteAsync(id, GetUserId());
        if (!ok) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>批量删除站点</summary>
    [HttpPost("batch-delete")]
    public async Task<IActionResult> BatchDelete([FromBody] BatchDeleteRequest req)
    {
        if (req.Ids == null || req.Ids.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请提供要删除的 ID 列表"));

        var deletedCount = await _siteService.BatchDeleteAsync(req.Ids, GetUserId());
        return Ok(ApiResponse<object>.Ok(new { deletedCount }));
    }

    /// <summary>获取用户所有文件夹列表</summary>
    [HttpGet("folders")]
    public async Task<IActionResult> ListFolders()
    {
        var folders = await _siteService.ListFoldersAsync(GetUserId());
        return Ok(ApiResponse<object>.Ok(new { folders }));
    }

    /// <summary>获取用户所有标签列表（含计数）</summary>
    [HttpGet("tags")]
    public async Task<IActionResult> ListTags()
    {
        var tags = await _siteService.ListTagsAsync(GetUserId());
        return Ok(ApiResponse<object>.Ok(new { tags }));
    }

    // ─────────────────────────────────────────────
    // 分享功能
    // ─────────────────────────────────────────────

    /// <summary>创建分享链接</summary>
    [HttpPost("share")]
    public async Task<IActionResult> CreateShare([FromBody] CreateWebPageShareRequest req)
    {
        try
        {
            var share = await _siteService.CreateShareAsync(
                GetUserId(), GetDisplayName(),
                req.SiteId, req.SiteIds, req.ShareType ?? "single",
                req.Title, req.Description,
                req.Password, req.ExpiresInDays);

            return Ok(ApiResponse<object>.Ok(new
            {
                share.Id,
                share.Token,
                share.ShareType,
                share.AccessLevel,
                share.ExpiresAt,
                shareUrl = $"/s/wp/{share.Token}",
            }));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (UnauthorizedAccessException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, ex.Message));
        }
    }

    /// <summary>获取当前用户的分享链接列表</summary>
    [HttpGet("shares")]
    public async Task<IActionResult> ListShares()
    {
        var items = await _siteService.ListSharesAsync(GetUserId());
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>撤销分享链接</summary>
    [HttpDelete("shares/{shareId}")]
    public async Task<IActionResult> RevokeShare(string shareId)
    {
        var ok = await _siteService.RevokeShareAsync(shareId, GetUserId());
        if (!ok) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));
        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    /// <summary>公开访问分享链接（无需登录）</summary>
    [HttpGet("shares/view/{token}")]
    [AllowAnonymous]
    public async Task<IActionResult> ViewShare(string token, [FromQuery] string? password)
    {
        // 尝试获取登录用户信息（AllowAnonymous 但可能带 token）
        var viewerUserId = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var viewerName = User.Identity?.IsAuthenticated == true ? GetDisplayName() : null;
        var ip = HttpContext.Connection.RemoteIpAddress?.ToString();
        var ua = Request.Headers.UserAgent.ToString();

        var result = await _siteService.ViewShareAsync(token, password,
            viewerUserId, viewerName, ip, ua);
        if (result == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));

        if (result.Error != null)
        {
            return result.HttpStatus switch
            {
                401 => Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, result.Error)),
                400 => BadRequest(ApiResponse<object>.Fail("EXPIRED", result.Error)),
                _ => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, result.Error)),
            };
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            result.Title,
            result.Description,
            result.ShareType,
            result.CreatedAt,
            result.CreatedBy,
            result.CreatedByName,
            result.Sites,
        }));
    }

    /// <summary>获取分享的观看记录（仅分享所有者可查看）</summary>
    [HttpGet("shares/view-logs")]
    public async Task<IActionResult> ListShareViewLogs([FromQuery] string? shareToken, [FromQuery] int limit = 100)
    {
        var logs = await _siteService.ListShareViewLogsAsync(GetUserId(), shareToken, limit);
        return Ok(ApiResponse<object>.Ok(new { items = logs }));
    }

    /// <summary>保存分享的站点到自己的托管（需登录，去重）</summary>
    [HttpPost("shares/{token}/save")]
    public async Task<IActionResult> SaveSharedSite(string token, [FromQuery] string? password)
    {
        var result = await _siteService.SaveSharedSiteAsync(token, password, GetUserId());

        if (result.Error != null)
        {
            return result.HttpStatus switch
            {
                401 => Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, result.Error)),
                400 => BadRequest(ApiResponse<object>.Fail("EXPIRED", result.Error)),
                _ => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, result.Error)),
            };
        }

        if (result.AlreadySaved)
            return Ok(ApiResponse<object>.Ok(new { alreadySaved = true }));

        return Ok(ApiResponse<object>.Ok(new { saved = true, siteCount = result.Sites.Count }));
    }
}

// ─────────────────────────────────────────────
// Request DTOs
// ─────────────────────────────────────────────

public class CreateFromContentRequest
{
    public string HtmlContent { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? SourceType { get; set; }
    public string? SourceRef { get; set; }
    public List<string>? Tags { get; set; }
    public string? Folder { get; set; }
}

public class UpdateHostedSiteRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }
    public string? Folder { get; set; }
    public string? CoverImageUrl { get; set; }
}

public class BatchDeleteRequest
{
    public List<string> Ids { get; set; } = new();
}

public class CreateWebPageShareRequest
{
    public string? SiteId { get; set; }
    public List<string>? SiteIds { get; set; }
    public string? ShareType { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Password { get; set; }
    public int ExpiresInDays { get; set; }
}
