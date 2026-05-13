using System.IO.Compression;
using System.Security.Claims;
using System.Text;
using Markdig;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
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

    // 500MB —— 视频 / PDF 等媒体文件比 HTML 大几个量级
    private const long MaxSingleFileSize = 500L * 1024 * 1024;

    // 视频扩展名（浏览器原生 <video> 支持）
    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".webm", ".mov", ".m4v", ".ogg", ".ogv",
    };

    private static readonly HashSet<string> MarkdownExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".md", ".markdown",
    };

    public WebPagesController(IHostedSiteService siteService)
    {
        _siteService = siteService;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private string GetDisplayName()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst("display_name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value
           ?? "用户";

    // ─────────────────────────────────────────────
    // 上传 / 创建
    // ─────────────────────────────────────────────

    /// <summary>上传 HTML/ZIP/Markdown/PDF/视频文件，解压或包装后托管</summary>
    [HttpPost("upload")]
    [RequestSizeLimit(MaxSingleFileSize)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxSingleFileSize)]
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
            else if (VideoExtensions.Contains(ext) || MarkdownExtensions.Contains(ext) || ext == ".pdf")
            {
                // 视频 / PDF / Markdown：现场生成 index.html 壳子 + 原文件，打包成 ZIP 走现有路径
                var zipBytes = BuildWrapperZip(file.FileName, fileBytes, ext, title);
                site = await _siteService.CreateFromZipAsync(userId, zipBytes, title, description, folder, tagList);
            }
            else
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.INVALID_FORMAT,
                    "支持的文件类型：.html / .htm / .zip / .md / .pdf / .mp4 / .webm / .mov"));
            }

            return Ok(ApiResponse<object>.Ok(site));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    // ─────────────────────────────────────────────
    // 媒体文件 → 网页壳子
    // ─────────────────────────────────────────────

    /// <summary>把媒体文件（视频/PDF/Markdown）包装成可托管的 ZIP（含 index.html 壳子 + 原文件）</summary>
    private static byte[] BuildWrapperZip(string originalFileName, byte[] fileBytes, string ext, string? title)
    {
        // 资产文件名做安全清洗，避免路径穿越
        var safeAssetName = SanitizeFileName(originalFileName);
        var displayTitle = string.IsNullOrWhiteSpace(title)
            ? Path.GetFileNameWithoutExtension(originalFileName)
            : title!.Trim();
        var indexHtml = ext switch
        {
            ".pdf" => BuildPdfWrapper(safeAssetName, displayTitle),
            _ when VideoExtensions.Contains(ext) => BuildVideoWrapper(safeAssetName, displayTitle, ext),
            _ when MarkdownExtensions.Contains(ext) => BuildMarkdownWrapper(fileBytes, displayTitle),
            _ => throw new InvalidOperationException($"未识别的包装类型: {ext}"),
        };

        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            // index.html 入口
            var indexEntry = zip.CreateEntry("index.html", CompressionLevel.Optimal);
            using (var s = indexEntry.Open())
            {
                var bytes = Encoding.UTF8.GetBytes(indexHtml);
                s.Write(bytes, 0, bytes.Length);
            }
            // Markdown 不需要保留原文件（已渲染入 HTML）；视频 / PDF 必须保留
            if (!MarkdownExtensions.Contains(ext))
            {
                var assetEntry = zip.CreateEntry(safeAssetName, CompressionLevel.NoCompression);
                using var s = assetEntry.Open();
                s.Write(fileBytes, 0, fileBytes.Length);
            }
        }
        return ms.ToArray();
    }

    private static string SanitizeFileName(string raw)
    {
        var name = Path.GetFileName(raw);
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return string.IsNullOrWhiteSpace(cleaned) ? "asset" : cleaned;
    }

    private static string HtmlEscape(string s)
        => System.Net.WebUtility.HtmlEncode(s ?? string.Empty);

    // 资产文件名作 URL 用时必须 percent-encode，否则 `demo#1.pdf` 里的 `#` 会被浏览器
    // 当成 fragment、`?` 当成 query，导致 <iframe src> / <a href> / <source src>
    // 实际请求的是被截断后的路径。EscapeDataString 输出只含 unreserved 字符 (A-Za-z0-9-._~)
    // 或 %XX，本身就是 HTML 属性安全的，不需要再 HtmlEscape。
    private static string UrlEncodeFilename(string s)
        => Uri.EscapeDataString(s ?? string.Empty);

    private static string BuildVideoWrapper(string assetName, string title, string ext)
    {
        var mime = ext switch
        {
            ".mp4" or ".m4v" => "video/mp4",
            ".webm" => "video/webm",
            ".mov" => "video/quicktime",
            ".ogg" or ".ogv" => "video/ogg",
            _ => "application/octet-stream",
        };
        var safeTitle = HtmlEscape(title);
        var urlAsset = UrlEncodeFilename(assetName);
        var sb = new StringBuilder();
        sb.AppendLine("<!DOCTYPE html>");
        sb.AppendLine("<html lang=\"zh-CN\">");
        sb.AppendLine("<head>");
        sb.AppendLine("  <meta charset=\"UTF-8\" />");
        sb.AppendLine("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />");
        sb.Append("  <title>").Append(safeTitle).AppendLine("</title>");
        sb.AppendLine("  <style>");
        sb.AppendLine("    html,body{margin:0;padding:0;height:100%;background:#0b0b10;color:#e8e8ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}");
        sb.AppendLine("    .wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box;}");
        sb.AppendLine("    video{max-width:100%;max-height:90vh;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,0.5);}");
        sb.AppendLine("  </style>");
        sb.AppendLine("</head>");
        sb.AppendLine("<body>");
        sb.AppendLine("  <div class=\"wrap\">");
        sb.AppendLine("    <video controls preload=\"metadata\" playsinline>");
        sb.Append("      <source src=\"").Append(urlAsset).Append("\" type=\"").Append(mime).AppendLine("\" />");
        sb.Append("      您的浏览器不支持视频播放，<a href=\"").Append(urlAsset).AppendLine("\" style=\"color:#7dd3fc;\">点此下载</a>");
        sb.AppendLine("    </video>");
        sb.AppendLine("  </div>");
        sb.AppendLine("</body>");
        sb.AppendLine("</html>");
        return sb.ToString();
    }

    private static string BuildPdfWrapper(string assetName, string title)
    {
        var safeTitle = HtmlEscape(title);
        var urlAsset = UrlEncodeFilename(assetName);
        var sb = new StringBuilder();
        sb.AppendLine("<!DOCTYPE html>");
        sb.AppendLine("<html lang=\"zh-CN\">");
        sb.AppendLine("<head>");
        sb.AppendLine("  <meta charset=\"UTF-8\" />");
        sb.AppendLine("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />");
        sb.Append("  <title>").Append(safeTitle).AppendLine("</title>");
        sb.AppendLine("  <style>");
        sb.AppendLine("    html,body{margin:0;padding:0;height:100%;background:#1a1a1f;}");
        sb.AppendLine("    iframe{display:block;width:100%;height:100vh;border:0;}");
        sb.AppendLine("    .fallback{padding:24px;color:#e8e8ec;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}");
        sb.AppendLine("  </style>");
        sb.AppendLine("</head>");
        sb.AppendLine("<body>");
        sb.Append("  <iframe src=\"").Append(urlAsset).Append("\" title=\"").Append(safeTitle).AppendLine("\"></iframe>");
        sb.AppendLine("  <noscript>");
        sb.AppendLine("    <div class=\"fallback\">");
        sb.Append("      浏览器不支持内嵌 PDF，<a href=\"").Append(urlAsset).AppendLine("\">点此下载</a>。");
        sb.AppendLine("    </div>");
        sb.AppendLine("  </noscript>");
        sb.AppendLine("</body>");
        sb.AppendLine("</html>");
        return sb.ToString();
    }

    private static string BuildMarkdownWrapper(byte[] mdBytes, string title)
    {
        var text = Encoding.UTF8.GetString(mdBytes);
        var pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .UseSoftlineBreakAsHardlineBreak()
            .Build();
        var bodyHtml = Markdown.ToHtml(text, pipeline);
        var safeTitle = HtmlEscape(title);
        var sb = new StringBuilder();
        sb.AppendLine("<!DOCTYPE html>");
        sb.AppendLine("<html lang=\"zh-CN\">");
        sb.AppendLine("<head>");
        sb.AppendLine("  <meta charset=\"UTF-8\" />");
        sb.AppendLine("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />");
        sb.Append("  <title>").Append(safeTitle).AppendLine("</title>");
        sb.AppendLine("  <style>");
        sb.AppendLine("    :root{color-scheme:light dark;}");
        sb.AppendLine("    body{margin:0;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2328;background:#fff;}");
        sb.AppendLine("    .markdown-body{max-width:780px;margin:0 auto;}");
        sb.AppendLine("    .markdown-body h1,.markdown-body h2,.markdown-body h3{border-bottom:1px solid #eaecef;padding-bottom:0.3em;margin-top:1.8em;}");
        sb.AppendLine("    .markdown-body pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto;}");
        sb.AppendLine("    .markdown-body code{background:rgba(175,184,193,0.2);padding:.2em .4em;border-radius:6px;font-size:85%;}");
        sb.AppendLine("    .markdown-body pre code{background:transparent;padding:0;}");
        sb.AppendLine("    .markdown-body img{max-width:100%;}");
        sb.AppendLine("    .markdown-body blockquote{border-left:4px solid #d0d7de;padding:0 1em;color:#57606a;margin:0;}");
        sb.AppendLine("    .markdown-body table{border-collapse:collapse;}");
        sb.AppendLine("    .markdown-body th,.markdown-body td{border:1px solid #d0d7de;padding:6px 13px;}");
        sb.AppendLine("    @media (prefers-color-scheme: dark){");
        sb.AppendLine("      body{background:#0d1117;color:#e6edf3;}");
        sb.AppendLine("      .markdown-body h1,.markdown-body h2,.markdown-body h3{border-bottom-color:#30363d;}");
        sb.AppendLine("      .markdown-body pre{background:#161b22;}");
        sb.AppendLine("      .markdown-body code{background:rgba(110,118,129,0.4);}");
        sb.AppendLine("      .markdown-body blockquote{border-left-color:#30363d;color:#8b949e;}");
        sb.AppendLine("      .markdown-body th,.markdown-body td{border-color:#30363d;}");
        sb.AppendLine("    }");
        sb.AppendLine("  </style>");
        sb.AppendLine("</head>");
        sb.AppendLine("<body>");
        sb.AppendLine("  <article class=\"markdown-body\">");
        sb.AppendLine(bodyHtml);
        sb.AppendLine("  </article>");
        sb.AppendLine("</body>");
        sb.AppendLine("</html>");
        return sb.ToString();
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
    [RequestFormLimits(MultipartBodyLengthLimit = MaxSingleFileSize)]
    public async Task<IActionResult> Reupload(string id, IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var fileBytes = ms.ToArray();
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        var uploadName = file.FileName;

        // 视频 / PDF / Markdown：包装成 ZIP（保持与 Upload 一致的行为）
        if (VideoExtensions.Contains(ext) || MarkdownExtensions.Contains(ext) || ext == ".pdf")
        {
            fileBytes = BuildWrapperZip(file.FileName, fileBytes, ext, title: null);
            uploadName = Path.ChangeExtension(file.FileName, ".zip");
        }

        try
        {
            var updated = await _siteService.ReuploadAsync(id, GetUserId(), fileBytes, uploadName);
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

    /// <summary>切换站点可见性（public = 出现在 /u/:username 公开页 | private = 仅自己可见）</summary>
    [HttpPatch("{id}/visibility")]
    public async Task<IActionResult> SetVisibility(string id, [FromBody] SetVisibilityRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Visibility))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "visibility 不能为空"));

        try
        {
            var updated = await _siteService.SetVisibilityAsync(id, GetUserId(), req.Visibility);
            if (updated == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
            return Ok(ApiResponse<object>.Ok(updated));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
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

public class SetVisibilityRequest
{
    /// <summary>public | private</summary>
    public string Visibility { get; set; } = "private";
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
