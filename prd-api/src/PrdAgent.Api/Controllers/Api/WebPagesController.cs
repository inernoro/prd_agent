using System.IO.Compression;
using System.Security.Claims;
using System.Text;
using Markdig;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
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
    private readonly IHostedSiteOptimizationService _optimizationService;
    private readonly IUploadProgressService _uploadProgress;

    // 500MB —— 视频 / PDF 等媒体文件比 HTML 大几个量级
    private const long MaxSingleFileSize = 500L * 1024 * 1024;
    private const long MaxOptimizationChunkRequestSize = 3L * 1024 * 1024;

    // 视频扩展名（浏览器原生 <video> 支持）
    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".webm", ".mov", ".m4v", ".ogg", ".ogv",
    };

    private static readonly HashSet<string> MarkdownExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".md", ".markdown",
    };

    private readonly PrdAgent.Infrastructure.Database.MongoDbContext _db;
    private readonly ITeamService _teams;
    private readonly IHttpClientFactory _httpClientFactory;

    public WebPagesController(
        IHostedSiteService siteService,
        IHostedSiteOptimizationService optimizationService,
        IUploadProgressService uploadProgress,
        PrdAgent.Infrastructure.Database.MongoDbContext db,
        ITeamService teams,
        IHttpClientFactory httpClientFactory)
    {
        _siteService = siteService;
        _optimizationService = optimizationService;
        _uploadProgress = uploadProgress;
        _db = db;
        _teams = teams;
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>
    /// 上传 ZIP 并先做确定性检查。只有命中可安全剪枝的冗余内容时才返回优化建议；
    /// 否则直接按原文件保存，避免让每次上传都多一次确认。
    /// </summary>
    [HttpPost("upload-reviewed")]
    [RequestSizeLimit(MaxSingleFileSize)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxSingleFileSize)]
    public async Task<IActionResult> UploadReviewed(
        IFormFile file,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? folder,
        [FromForm] string? tags,
        [FromForm] string? uploadId,
        [FromForm] string? targetSiteId)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传 ZIP 文件"));
        if (file.Length > MaxSingleFileSize)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxSingleFileSize / 1024 / 1024}MB"));
        if (!string.Equals(Path.GetExtension(file.FileName), ".zip", StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "智能优化目前只支持 ZIP 文件"));

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var fileBytes = ms.ToArray();
        var tagList = string.IsNullOrWhiteSpace(tags)
            ? new List<string>()
            : tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        var userId = GetUserId();

        try
        {
            var analysis = _optimizationService.Analyze(fileBytes);
            if (analysis.Blocked)
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.INVALID_FORMAT,
                    analysis.Error ?? "ZIP 文件无法通过安全检查，请重新导出后再试"));

            if (analysis.Recommended)
            {
                var session = await _optimizationService.CreateSessionAsync(
                    userId,
                    fileBytes,
                    file.FileName,
                    targetSiteId,
                    title,
                    description,
                    folder,
                    tagList,
                    analysis,
                    HttpContext.RequestAborted);
                return Ok(ApiResponse<object>.Ok(new HostedSiteOptimizationReviewResult
                {
                    Outcome = "optimization-recommended",
                    SessionId = session.Id,
                    ExpiresAt = session.ExpiresAt,
                    Analysis = session.Analysis,
                }));
            }

            HostedSite saved;
            if (string.IsNullOrWhiteSpace(targetSiteId))
            {
                saved = await _siteService.CreateFromZipAsync(
                    userId, fileBytes, title, description, folder, tagList, uploadId: uploadId);
            }
            else
            {
                saved = await _siteService.ReuploadAsync(
                    targetSiteId, userId, fileBytes, file.FileName, uploadId: uploadId);
                var metadata = await _siteService.UpdateAsync(
                    saved.Id, userId, title, description, tagList, folder, coverImageUrl: null);
                if (metadata != null) saved = metadata;
            }

            return Ok(ApiResponse<object>.Ok(new HostedSiteOptimizationReviewResult
            {
                Outcome = "saved",
                Site = saved,
                Analysis = analysis,
            }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        finally
        {
            await _uploadProgress.CompleteAsync(uploadId);
        }
    }

    /// <summary>创建 ZIP 分片上传任务。只登记元数据，不创建或覆盖站点。</summary>
    [HttpPost("optimization/uploads")]
    public async Task<IActionResult> CreateOptimizationUpload(
        [FromBody] CreateHostedSiteOptimizationUploadRequest request)
    {
        try
        {
            var session = await _optimizationService.CreateUploadAsync(
                GetUserId(), request, HttpContext.RequestAborted);
            return Ok(ApiResponse<object>.Ok(new HostedSiteOptimizationUploadCreatedResult
            {
                SessionId = session.Id,
                ChunkSize = session.ChunkSize,
                TotalChunks = session.TotalChunks,
                ExpiresAt = session.ExpiresAt,
            }));
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

    /// <summary>上传一个固定大小的 ZIP 分片。重复提交同一序号会安全覆盖。</summary>
    [HttpPost("optimization/uploads/{sessionId}/chunks/{chunkIndex:int}")]
    [RequestSizeLimit(MaxOptimizationChunkRequestSize)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxOptimizationChunkRequestSize)]
    public async Task<IActionResult> UploadOptimizationChunk(
        string sessionId,
        int chunkIndex,
        IFormFile chunk)
    {
        if (chunk == null || chunk.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "上传分片为空，请重试"));
        if (chunk.Length > MaxOptimizationChunkRequestSize)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "上传分片过大，请重新开始上传"));

        try
        {
            using var output = new MemoryStream(checked((int)chunk.Length));
            await chunk.CopyToAsync(output, HttpContext.RequestAborted);
            await _optimizationService.UploadChunkAsync(
                sessionId, GetUserId(), chunkIndex, output.ToArray(), HttpContext.RequestAborted);
            return Ok(ApiResponse<object>.Ok(new { uploaded = true, chunkIndex }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上传任务不存在或已经过期"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>确认所有分片已经送达，并把安全检查交给后台任务。</summary>
    [HttpPost("optimization/uploads/{sessionId}/complete")]
    public async Task<IActionResult> CompleteOptimizationUpload(string sessionId)
    {
        try
        {
            await _optimizationService.QueueUploadAsync(
                sessionId, GetUserId(), HttpContext.RequestAborted);
            return Accepted(ApiResponse<object>.Ok(new { queued = true, sessionId }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上传任务不存在或已经过期"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>查询分片上传和后台检查状态。</summary>
    [HttpGet("optimization/uploads/{sessionId}")]
    public async Task<IActionResult> GetOptimizationUploadStatus(string sessionId)
    {
        try
        {
            var result = await _optimizationService.GetUploadStatusAsync(
                sessionId, GetUserId(), HttpContext.RequestAborted);
            return Ok(ApiResponse<object>.Ok(result));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "上传任务不存在或已经过期"));
        }
    }

    /// <summary>生成私有临时优化版本，供用户确认效果。</summary>
    [HttpPost("optimization/{sessionId}/preview")]
    public async Task<IActionResult> PrepareOptimizationPreview(string sessionId)
    {
        try
        {
            var result = await _optimizationService.PreparePreviewAsync(
                sessionId, GetUserId(), HttpContext.RequestAborted);
            return Ok(ApiResponse<object>.Ok(result));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "优化任务不存在或已经过期"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>用短期随机令牌读取优化预览文件，不暴露底层对象地址。</summary>
    [AllowAnonymous]
    [HttpGet("optimization/{sessionId}/preview-content/{accessToken}/{**filePath}")]
    public async Task<IActionResult> GetOptimizationPreviewFile(
        string sessionId,
        string accessToken,
        string filePath)
    {
        var result = await _optimizationService.GetPreviewFileAsync(
            sessionId, accessToken, filePath, HttpContext.RequestAborted);
        if (result == null) return NotFound();
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        Response.Headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms; base-uri 'none'; object-src 'none'";
        return File(result.Bytes, result.MimeType);
    }

    /// <summary>用户确认后才保存原文件或已预览的优化版本。</summary>
    [HttpPost("optimization/{sessionId}/confirm")]
    public async Task<IActionResult> ConfirmOptimization(
        string sessionId,
        [FromBody] ConfirmHostedSiteOptimizationRequest request)
    {
        try
        {
            var site = await _optimizationService.ConfirmAsync(
                sessionId, GetUserId(), request.Variant, HttpContext.RequestAborted);
            return Ok(ApiResponse<object>.Ok(site));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "优化任务不存在或已经过期"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>放弃优化任务并清理私有临时文件。</summary>
    [HttpDelete("optimization/{sessionId}")]
    public async Task<IActionResult> CancelOptimization(string sessionId)
    {
        try
        {
            await _optimizationService.CancelAsync(sessionId, GetUserId(), HttpContext.RequestAborted);
            return Ok(ApiResponse<object>.Ok(new { cancelled = true }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    private string GetUserId() => this.GetRequiredUserId();

    // JwtService 写入的 display name claim 名为 "displayName"（MapInboundClaims=false，保持原样）。
    // 历史 bug：这里读 "name"/"display_name"/ClaimTypes.Name 都不匹配，恒兜底成 "用户"。
    private string GetDisplayNameFromClaims()
        => User.FindFirst("displayName")?.Value
           ?? User.FindFirst("unique_name")?.Value  // JwtRegisteredClaimNames.UniqueName = username
           ?? User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value
           ?? string.Empty;

    // claim 缺失/为空时回查 DB，最后才退化成 "用户"
    private async Task<string> ResolveDisplayNameAsync(string userId)
    {
        var fromClaim = GetDisplayNameFromClaims();
        if (!string.IsNullOrWhiteSpace(fromClaim)) return fromClaim;
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var name = string.IsNullOrWhiteSpace(user?.DisplayName) ? user?.Username : user!.DisplayName;
        return string.IsNullOrWhiteSpace(name) ? "用户" : name;
    }

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
        [FromForm] string? tags,
        [FromForm] string? uploadId)
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
                site = await _siteService.CreateFromZipAsync(userId, fileBytes, title, description, folder, tagList, uploadId: uploadId);
            }
            else if (ext is ".html" or ".htm")
            {
                site = await _siteService.CreateFromHtmlAsync(userId, fileBytes, file.FileName, title, description, folder, tagList);
            }
            else if (VideoExtensions.Contains(ext) || MarkdownExtensions.Contains(ext) || ext == ".pdf")
            {
                // 视频 / PDF / Markdown：现场生成 index.html 壳子 + 原文件，打包成 ZIP 走现有路径
                // 标题留空时用文件名（去扩展名）兜底，避免 ZIP 路径把视频/PDF 全落成"未命名站点"
                // （前端 UploadEditDialog 仅对 .md 自动预填标题；其它媒体类型靠后端兜底）
                var effectiveTitle = string.IsNullOrWhiteSpace(title)
                    ? Path.GetFileNameWithoutExtension(file.FileName)
                    : title!.Trim();
                var zipBytes = BuildWrapperZip(file.FileName, fileBytes, ext, effectiveTitle);
                // 写 marker，下游靠它判定包装站，避免"用户上传的 index.html + report.pdf"被误判
                var assetType = ext == ".pdf" ? "pdf"
                    : VideoExtensions.Contains(ext) ? "video"
                    : MarkdownExtensions.Contains(ext) ? "markdown"
                    : null;
                site = await _siteService.CreateFromZipAsync(userId, zipBytes, effectiveTitle, description, folder, tagList, assetType, uploadId: uploadId);
            }
            else
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.INVALID_FORMAT,
                    "支持的文件类型：.html / .htm / .zip / .md / .markdown / .pdf / .mp4 / .m4v / .webm / .mov / .ogg / .ogv"));
            }

            return Ok(ApiResponse<object>.Ok(site));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        finally
        {
            // 成功和失败都要收尾：不收的话前端那一路轮询会一直转到 TTL 到期，
            // 用户看到的是「解包中」永远不结束——比没有进度还糟
            await _uploadProgress.CompleteAsync(uploadId);
        }
    }

    /// <summary>
    /// 查一次上传解包进度。
    ///
    /// 为什么不是 SSE：上传本身是一次同步 POST，前端在等那个响应，这条只是旁路查询，
    /// 秒级粒度足够，轮询比再拉一条长连接简单得多。
    /// uploadId 由前端生成，跟着上传表单一起发过来；查不到就是还没开始或者已过期。
    /// </summary>
    [HttpGet("upload-progress/{uploadId}")]
    public async Task<IActionResult> GetUploadProgress(string uploadId)
    {
        var snap = await _uploadProgress.GetAsync(uploadId);
        if (snap == null)
            return Ok(ApiResponse<object>.Ok(new { pending = true }));

        return Ok(ApiResponse<object>.Ok(new
        {
            snap.DoneFiles,
            snap.TotalFiles,
            snap.EntryFile,
            snap.CurrentPath,
            snap.CurrentSize,
            snap.Finished,
        }));
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
        // 用 PDF.js 把 PDF 渲染成 <canvas>，而不是 <iframe src="*.pdf"> 内嵌浏览器原生 PDF 阅读器。
        // 移动端 Safari / 微信内置 WebView（iOS WKWebView、Android X5）都不支持在 iframe 里显示 PDF，
        // 导致转发出去的链接在手机 / 微信里打开一片空白——这正是本次要修的问题。canvas 渲染全平台通用。
        // 加载失败时降级为「点此下载 / 在浏览器打开」直链，绝不留白（呼应 CLAUDE.md §6 禁止空白等待）。
        return $$$"""
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
          <title>{{{safeTitle}}}</title>
          <style>
            html,body{margin:0;padding:0;background:#1a1a1f;color:#e8e8ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}
            #bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:rgba(20,20,26,0.95);border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;}
            #bar .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;}
            #bar a{color:#7dd3fc;text-decoration:none;white-space:nowrap;flex-shrink:0;}
            #status{padding:48px 24px;text-align:center;color:#9ca3af;font-size:14px;line-height:1.8;}
            #pages{display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px 8px 56px;}
            #pages canvas{max-width:100%;height:auto;background:#fff;border-radius:4px;box-shadow:0 4px 24px rgba(0,0,0,0.5);}
            .spin{display:inline-block;width:22px;height:22px;border:3px solid rgba(255,255,255,0.18);border-top-color:#7dd3fc;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px;}
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          </style>
        </head>
        <body>
          <div id="bar">
            <span class="t">{{{safeTitle}}}</span>
            <a href="{{{urlAsset}}}" target="_blank" rel="noopener">下载 / 在浏览器打开</a>
          </div>
          <div id="status"><span class="spin"></span>正在加载 PDF…</div>
          <div id="pages"></div>
          <noscript><div id="status">浏览器未启用 JavaScript，<a href="{{{urlAsset}}}" style="color:#7dd3fc;">点此下载 PDF</a>。</div></noscript>
          <script>
          (function(){
            var PDF_URL = "{{{urlAsset}}}";
            var CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/";
            var statusEl = document.getElementById("status");
            var pagesEl = document.getElementById("pages");
            function fail(msg){
              if(!statusEl){ return; }
              statusEl.style.display = "block";
              statusEl.innerHTML = msg + ' <a href="' + PDF_URL + '" target="_blank" rel="noopener" style="color:#7dd3fc;">点此下载或在浏览器打开</a>。';
            }
            function loadScript(src){
              return new Promise(function(resolve, reject){
                var s = document.createElement("script");
                s.src = src; s.onload = resolve; s.onerror = reject;
                document.head.appendChild(s);
              });
            }
            // 闹钟必须罩住**整条初始化链**，不能只罩第一个 script。
            // 只罩第一个的话：pdf.min.js 命中缓存秒回、闹钟被清掉，接着 pdf.worker.min.js 挂起，
            // getDocument 的 promise 就永远悬着，既不 resolve 也不 reject，catch 走不到，
            // 页面照旧永久停在「正在加载 PDF…」——承诺的兜底等于没有。
            // CDN 域名在部分网络里是挂起而不是快速失败，所以 onerror 一个信号靠不住。
            var deadline = new Promise(function(_, reject){
              setTimeout(function(){ reject(new Error("timeout")); }, 20000);
            });
            var ready = loadScript(CDN + "pdf.min.js").then(function(){
              var lib = window.pdfjsLib || window["pdfjs-dist/build/pdf"];
              if(!lib){ throw new Error("pdfjs not loaded"); }
              lib.GlobalWorkerOptions.workerSrc = CDN + "pdf.worker.min.js";
              return lib.getDocument({ url: PDF_URL }).promise;
            });
            // 闹钟只罩到「文档就绪」为止，**不罩逐页渲染**。罩住渲染的话，大 PDF 慢慢画超过
            // 20s 就会在已经画出来的页面上盖一条「加载失败」——那正是 #1356 本来要修的那种谎报。
            Promise.race([ready, deadline]).catch(function(){ fail("PDF 在线预览加载失败。"); });
            ready.then(function(pdf){
              if(statusEl){ statusEl.style.display = "none"; }
              var maxBitmapPixels = 16777216;
              var dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
              var renderOne = function(num){
                return pdf.getPage(num).then(function(page){
                  var base = page.getViewport({ scale: 1 });
                  var availableWidth = Math.max((pagesEl.clientWidth || window.innerWidth || 360) - 16, 320);
                  var cssWidth = Math.floor(Math.min(availableWidth, 1100));
                  var cssScale = cssWidth / base.width;
                  var cssHeight = Math.floor(cssWidth * base.height / base.width);
                  var renderScale = cssScale * dpr;
                  var estimatedPixels = (base.width * renderScale) * (base.height * renderScale);
                  if(estimatedPixels > maxBitmapPixels){
                    renderScale = renderScale * Math.sqrt(maxBitmapPixels / estimatedPixels);
                  }
                  var vp = page.getViewport({ scale: renderScale });
                  var canvas = document.createElement("canvas");
                  var ctx = canvas.getContext("2d", { alpha: false });
                  canvas.width = Math.floor(vp.width);
                  canvas.height = Math.floor(vp.height);
                  canvas.style.width = cssWidth + "px";
                  canvas.style.height = cssHeight + "px";
                  pagesEl.appendChild(canvas);
                  if(ctx){ ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
                  return page.render({ canvasContext: ctx, viewport: vp }).promise;
                });
              };
              var chain = Promise.resolve();
              for(var i = 1; i <= pdf.numPages; i++){
                (function(n){ chain = chain.then(function(){ return renderOne(n); }); })(i);
              }
              return chain;
            }).catch(function(){
              // 渲染阶段自己出错仍要如实告知（此时 race 那条可能早已 resolve）
              fail("PDF 在线预览加载失败。");
            });
          })();
          </script>
        </body>
        </html>
        """;
    }

    private static string BuildMarkdownWrapper(byte[] mdBytes, string title)
    {
        var text = Encoding.UTF8.GetString(mdBytes);
        // .DisableHtml(): Markdig 默认透传原始 HTML 块，用户上传含 <script>alert()</script>
        // 的 .md 会变成网页托管的可执行 XSS。Markdown 被普遍认为是"安全文本"，用户上传
        // 不可信 .md 时不会意识到嵌入脚本能跑。关闭原始 HTML 透传等价于 GitHub README
        // 的渲染策略（白名单/转义）。（Cursor Bugbot PR #598 抓到）
        var pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .UseSoftlineBreakAsHardlineBreak()
            .DisableHtml()
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


    /// <summary>
    /// 每个站点的独立访客数（卡片上的「N 访客」）。
    ///
    /// 去重键：登录访客用 ViewerUserId，匿名访客退回 IP —— 与访客抽屉同一口径。
    /// 一次聚合把整页站点数完，不按站点逐个查（列表一页最多 200 个站点）。
    /// 站点没有任何访问记录时不出现在返回里，前端据此显示 0 而不是编一个数。
    /// </summary>
    /// <summary>
    /// 每个站点的独立访客数。
    ///
    /// 必须并两个来源：站内访问记在 SiteViewEvents（登录用户直接打开或团队内访问），
    /// 而公开分享链接的访问记在 ShareViewLogs、按分享而不是按站点存。只数前者的话，
    /// 一个只通过分享链接传播的站点在卡片上永远是「0 访客」——那不是「没人看」，
    /// 是我们没去数。两边的身份口径一样（登录用 ViewerUserId，匿名退回 IP），
    /// 所以可以先各自取出「站点 → 访客键集合」再求并，避免同一个人被数两次。
    /// </summary>
    private async Task<Dictionary<string, long>> BuildVisitorCountsAsync(IEnumerable<string> siteIds)
    {
        var ids = siteIds.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        if (ids.Count == 0) return new Dictionary<string, long>();

        // 登录用户按用户去重，匿名退回 IP；两端用同一把尺子，否则并集会把同一个人算两次
        var visitorKey = new BsonDocument("$ifNull", new BsonArray
        {
            "$ViewerUserId",
            new BsonDocument("$ifNull", new BsonArray { "$IpAddress", "anonymous" }),
        });

        var buckets = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        void Add(string siteId, string visitor)
        {
            if (!buckets.TryGetValue(siteId, out var set))
                buckets[siteId] = set = new HashSet<string>(StringComparer.Ordinal);
            set.Add(visitor);
        }

        // 来源一：站内访问，本来就带 SiteId
        var sitePipeline = new[]
        {
            new BsonDocument("$match", new BsonDocument("SiteId", new BsonDocument("$in", new BsonArray(ids)))),
            new BsonDocument("$group", new BsonDocument("_id", new BsonDocument
            {
                { "site", "$SiteId" },
                { "visitor", visitorKey },
            })),
        };
        foreach (var row in await _db.SiteViewEvents.Aggregate<BsonDocument>(sitePipeline).ToListAsync())
        {
            var key = row["_id"].AsBsonDocument;
            if (key["site"].IsBsonNull) continue;
            Add(key["site"].AsString, key["visitor"].IsBsonNull ? "anonymous" : key["visitor"].AsString);
        }

        // 来源二：分享访问。ShareViewLog 只认分享，得先把分享映回它包含的站点。
        // 一条分享可以带多个站点，访客算给这条分享里的每个站点——这是这份日志能支持的最细粒度，
        // 比整列显示 0 诚实得多；真要做到「他到底点开了哪一个」得在分享阅读页按站点埋点，另记一笔账。
        // 两个字段都要认：合集分享写 SiteIds，存量单站点分享只写 SiteId。只查 SiteIds 的话，
        // 单站点分享整条被漏掉，而那正是「纯靠分享访问的站点显示 0 访客」最常见的形态——
        // 修了一半等于没修。字段口径走 WebPageShareLink.TargetSiteIds() 这一个来源。
        var fb = Builders<WebPageShareLink>.Filter;
        var shares = await _db.WebPageShareLinks
            .Find(fb.Or(fb.AnyIn(x => x.SiteIds, ids), fb.In(x => x.SiteId, ids)))
            .Project<WebPageShareLink>(Builders<WebPageShareLink>.Projection
                .Include(x => x.Id).Include(x => x.SiteId).Include(x => x.SiteIds))
            .ToListAsync();
        var shareToSites = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var share in shares)
        {
            if (string.IsNullOrEmpty(share.Id)) continue;
            var hit = share.TargetSiteIds().Where(ids.Contains).ToList();
            if (hit.Count > 0) shareToSites[share.Id] = hit;
        }

        if (shareToSites.Count > 0)
        {
            var sharePipeline = new[]
            {
                new BsonDocument("$match", new BsonDocument("ShareId",
                    new BsonDocument("$in", new BsonArray(shareToSites.Keys)))),
                new BsonDocument("$group", new BsonDocument("_id", new BsonDocument
                {
                    { "share", "$ShareId" },
                    { "visitor", visitorKey },
                })),
            };
            foreach (var row in await _db.ShareViewLogs.Aggregate<BsonDocument>(sharePipeline).ToListAsync())
            {
                var key = row["_id"].AsBsonDocument;
                if (key["share"].IsBsonNull) continue;
                if (!shareToSites.TryGetValue(key["share"].AsString, out var sites)) continue;
                var visitor = key["visitor"].IsBsonNull ? "anonymous" : key["visitor"].AsString;
                foreach (var siteId in sites) Add(siteId, visitor);
            }
        }

        return buckets.ToDictionary(kv => kv.Key, kv => (long)kv.Value.Count);
    }

    /// <summary>获取站点列表。scope=team + teamId 时返回该团队共享的站点（含创建者头像昵称），默认返回我的</summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? keyword,
        [FromQuery] string? folder,
        [FromQuery] string? tag,
        [FromQuery] string? sourceType,
        [FromQuery] string sort = "newest",
        [FromQuery] int skip = 0,
        [FromQuery] int limit = 50,
        [FromQuery] string? scope = null,
        [FromQuery] string? teamId = null)
    {
        var userId = GetUserId();
        var (items, total) = await _siteService.ListAsync(
            userId, keyword, folder, tag, sourceType, sort, skip, limit, scope, teamId);

        // 卡片要展示「N 访客」（设计稿屏 2 中卡与大卡都有这一格），浏览数是累计次数、访客是去重人数，
        // 两个数不是一回事，所以必须单独算，不能拿 ViewCount 冒充。
        var visitors = await BuildVisitorCountsAsync(items.Select(s => s.Id));

        // 团队作用域：附带创建者头像/昵称（卡片左下角展示）+ 我在该团队的网页托管有效角色
        //（owner/editor/viewer），前端据此隐藏 viewer 的编辑/删除/分享入口。即使列表为空也返回角色。
        // teamId 为空 = 跨团队聚合视图（知识库团队空间消费），无单团队角色概念，仅附带 owners。
        if (string.Equals(scope, "team", StringComparison.OrdinalIgnoreCase))
        {
            var owners = items.Count > 0
                ? await BuildUserCardsAsync(items.Select(s => s.OwnerUserId))
                : new Dictionary<string, object>();
            if (!string.IsNullOrWhiteSpace(teamId))
            {
                var myRoles = await _teams.GetMyWebHostingTeamRolesAsync(userId);
                var myWebHostingRole = myRoles.GetValueOrDefault(teamId);
                return Ok(ApiResponse<object>.Ok(new { items, total, owners, myWebHostingRole, visitors }));
            }
            return Ok(ApiResponse<object>.Ok(new { items, total, owners, visitors }));
        }

        return Ok(ApiResponse<object>.Ok(new { items, total, visitors }));
    }

    /// <summary>设置站点分享到的团队（仅 owner 可调）</summary>
    [HttpPatch("{id}/teams")]
    public async Task<IActionResult> SetTeams(string id, [FromBody] SetSiteTeamsRequest req)
    {
        try
        {
            var updated = await _siteService.SetSharedTeamsAsync(id, GetUserId(), req.TeamIds ?? new List<string>());
            if (updated == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或无权限"));
            return Ok(ApiResponse<object>.Ok(updated));
        }
        catch (UnauthorizedAccessException ex)
        {
            // 请求包含我无编辑权的团队：返回 403，前端据此提示而非误报成功（默认走 ExceptionMiddleware 会变 401）
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, ex.Message));
        }
    }

    // ─────────────────────────────────────────────
    // 团队空间分组（专题 / 日常分类）
    // ─────────────────────────────────────────────

    /// <summary>我在该团队是否具备网页托管编辑权（owner/editor）</summary>
    private async Task<bool> CanEditInTeamAsync(string userId, string teamId)
    {
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId);
        return roles.TryGetValue(teamId, out var r)
               && (r == WebHostingRoles.Owner || r == WebHostingRoles.Editor);
    }

    /// <summary>我在该团队的空间级网页托管角色（null = 非成员）</summary>
    private async Task<string?> GetMySpaceRoleAsync(string userId, string teamId)
    {
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId);
        return roles.TryGetValue(teamId, out var r) ? r : null;
    }

    /// <summary>我在该团队的角色标签（非成员 = 空列表）</summary>
    private async Task<List<string>> GetMyLabelsAsync(string userId, string teamId)
    {
        var member = await _db.TeamMembers.Find(m => m.TeamId == teamId && m.UserId == userId).FirstOrDefaultAsync();
        return member?.Labels ?? new List<string>();
    }

    /// <summary>解析我对某分组的有效角色（受限分组按授权规则裁剪；null = 不可见）</summary>
    private async Task<string?> ResolveMyGroupRoleAsync(string userId, WebPageGroup group)
    {
        var spaceRole = await GetMySpaceRoleAsync(userId, group.TeamId);
        if (spaceRole == null) return null;
        if (!WebPageGroupAccess.IsRestricted(group)) return spaceRole;
        var labels = await GetMyLabelsAsync(userId, group.TeamId);
        return WebPageGroupAccess.ResolveGroupRole(spaceRole, group, userId, labels);
    }

    /// <summary>列出团队空间的分组（专题 + 日常分类；受限分组仅对授权成员与空间 owner 可见）</summary>
    [HttpGet("groups")]
    public async Task<IActionResult> ListGroups([FromQuery] string teamId)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(teamId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "teamId 不能为空"));
        var spaceRole = await GetMySpaceRoleAsync(userId, teamId);
        if (spaceRole == null)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你不是该团队成员"));

        var groups = await _db.WebPageGroups.Find(g => g.TeamId == teamId)
            .Sort(Builders<WebPageGroup>.Sort.Ascending(g => g.SortOrder).Ascending(g => g.CreatedAt))
            .ToListAsync();

        var labels = await GetMyLabelsAsync(userId, teamId);
        var visible = new List<object>();
        foreach (var g in groups)
        {
            var myGroupRole = WebPageGroupAccess.ResolveGroupRole(spaceRole, g, userId, labels);
            if (myGroupRole == null) continue; // 受限分组未授权：完全不可见
            visible.Add(new
            {
                g.Id,
                g.TeamId,
                g.Kind,
                g.Name,
                g.SortOrder,
                g.CreatedBy,
                g.Visibility,
                // 授权规则仅回给能管理分组权限的空间 owner（避免向普通成员泄露授权名单）
                AccessRules = spaceRole == WebHostingRoles.Owner ? g.AccessRules : null,
                g.CreatedAt,
                g.UpdatedAt,
                MyGroupRole = myGroupRole,
            });
        }
        return Ok(ApiResponse<object>.Ok(new { groups = visible }));
    }

    /// <summary>
    /// 设置分组的可见性与授权规则（仅空间 owner 可调）。
    /// visibility=inherit 时规则被清空；restricted 时按 rules 授权（user 按成员、label 按角色标签）。
    /// </summary>
    [HttpPut("groups/{groupId}/access")]
    public async Task<IActionResult> UpdateGroupAccess(string groupId, [FromBody] UpdateGroupAccessRequest req)
    {
        var userId = GetUserId();
        var group = await _db.WebPageGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync();
        if (group == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分组不存在"));
        var spaceRole = await GetMySpaceRoleAsync(userId, group.TeamId);
        if (spaceRole != WebHostingRoles.Owner)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅空间所有者可设置分组权限"));

        var visibility = req.Visibility?.Trim().ToLowerInvariant();
        if (visibility != WebPageGroupVisibility.Inherit && visibility != WebPageGroupVisibility.Restricted)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "visibility 必须是 inherit 或 restricted"));

        var rules = new List<WebPageGroupAccessRule>();
        if (visibility == WebPageGroupVisibility.Restricted)
        {
            foreach (var r in req.Rules ?? new List<GroupAccessRuleInput>())
            {
                var subjectType = r.SubjectType?.Trim().ToLowerInvariant();
                var subjectId = r.SubjectId?.Trim();
                var role = r.Role?.Trim().ToLowerInvariant();
                if (subjectType != WebPageGroupSubjectType.User && subjectType != WebPageGroupSubjectType.Label)
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "subjectType 必须是 user 或 label"));
                if (string.IsNullOrWhiteSpace(subjectId))
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "subjectId 不能为空"));
                if (role != WebHostingRoles.Viewer && role != WebHostingRoles.Editor)
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分组角色只能是 viewer 或 editor"));
                rules.Add(new WebPageGroupAccessRule { SubjectType = subjectType!, SubjectId = subjectId!, Role = role! });
            }
            if (rules.Count > 100)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "授权规则最多 100 条"));
        }

        await _db.WebPageGroups.UpdateOneAsync(
            g => g.Id == groupId,
            Builders<WebPageGroup>.Update
                .Set(g => g.Visibility, visibility!)
                .Set(g => g.AccessRules, rules)
                .Set(g => g.UpdatedAt, DateTime.UtcNow));
        var updated = await _db.WebPageGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>创建团队空间分组（可先建空分组再加内容；需团队内网页托管编辑权）</summary>
    [HttpPost("groups")]
    public async Task<IActionResult> CreateGroup([FromBody] CreateWebPageGroupRequest req)
    {
        var userId = GetUserId();
        var name = req.Name?.Trim();
        if (string.IsNullOrWhiteSpace(req.TeamId) || string.IsNullOrWhiteSpace(name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "teamId 和 name 不能为空"));
        var kind = req.Kind?.Trim().ToLowerInvariant();
        if (kind != WebPageGroupKind.Topic && kind != WebPageGroupKind.Daily)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "kind 必须是 topic 或 daily"));
        if (!await CanEditInTeamAsync(userId, req.TeamId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你在该团队是只读或非成员角色，无法创建分组"));

        var dup = await _db.WebPageGroups.Find(g => g.TeamId == req.TeamId && g.Kind == kind && g.Name == name)
            .FirstOrDefaultAsync();
        if (dup != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "同类型下已存在同名分组"));

        var group = new WebPageGroup
        {
            TeamId = req.TeamId,
            Kind = kind,
            Name = name,
            SortOrder = req.SortOrder ?? 0,
            CreatedBy = userId,
        };
        await _db.WebPageGroups.InsertOneAsync(group);
        return Ok(ApiResponse<object>.Ok(group));
    }

    /// <summary>重命名/调序团队空间分组（需团队内网页托管编辑权）</summary>
    [HttpPut("groups/{groupId}")]
    public async Task<IActionResult> UpdateGroup(string groupId, [FromBody] UpdateWebPageGroupRequest req)
    {
        var userId = GetUserId();
        var group = await _db.WebPageGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync();
        if (group == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分组不存在"));
        if (!await CanEditInTeamAsync(userId, group.TeamId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你在该团队是只读或非成员角色，无法修改分组"));

        // 受限分组：还需分组级编辑权（空间 editor 未被授权时同样不可改）
        if (WebPageGroupAccess.IsRestricted(group))
        {
            var myGroupRole = await ResolveMyGroupRoleAsync(userId, group);
            if (myGroupRole != WebHostingRoles.Owner && myGroupRole != WebHostingRoles.Editor)
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你在该受限分组没有编辑权"));
        }

        var update = Builders<WebPageGroup>.Update.Set(g => g.UpdatedAt, DateTime.UtcNow);
        var name = req.Name?.Trim();
        if (!string.IsNullOrWhiteSpace(name)) update = update.Set(g => g.Name, name);
        if (req.SortOrder.HasValue) update = update.Set(g => g.SortOrder, req.SortOrder.Value);
        await _db.WebPageGroups.UpdateOneAsync(g => g.Id == groupId, update);
        var updated = await _db.WebPageGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除团队空间分组（组内站点的 GroupId 清空回到「未分组」，站点本身不动）</summary>
    [HttpDelete("groups/{groupId}")]
    public async Task<IActionResult> DeleteGroup(string groupId)
    {
        var userId = GetUserId();
        var group = await _db.WebPageGroups.Find(g => g.Id == groupId).FirstOrDefaultAsync();
        if (group == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分组不存在"));
        if (!await CanEditInTeamAsync(userId, group.TeamId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你在该团队是只读或非成员角色，无法删除分组"));
        // 受限分组：还需分组级编辑权
        if (WebPageGroupAccess.IsRestricted(group))
        {
            var myGroupRole = await ResolveMyGroupRoleAsync(userId, group);
            if (myGroupRole != WebHostingRoles.Owner && myGroupRole != WebHostingRoles.Editor)
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你在该受限分组没有编辑权"));
        }

        await _db.HostedSites.UpdateManyAsync(
            s => s.GroupId == groupId,
            Builders<HostedSite>.Update.Set(s => s.GroupId, null));
        await _db.WebPageGroups.DeleteOneAsync(g => g.Id == groupId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>设置站点的团队分组归属（groupId 为空 = 移出分组；需站点创建者或团队编辑权）</summary>
    [HttpPatch("{id}/group")]
    public async Task<IActionResult> SetSiteGroup(string id, [FromBody] SetSiteGroupRequest req)
    {
        var userId = GetUserId();
        var site = await _db.HostedSites.Find(s => s.Id == id).FirstOrDefaultAsync();
        if (site == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));

        string? targetGroupId = null;
        if (!string.IsNullOrWhiteSpace(req.GroupId))
        {
            var group = await _db.WebPageGroups.Find(g => g.Id == req.GroupId).FirstOrDefaultAsync();
            if (group == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分组不存在"));
            // 分组必须属于站点已共享到的团队，防止跨团队挂靠
            if (!(site.SharedTeamIds ?? new List<string>()).Contains(group.TeamId))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点未共享到该分组所属团队"));
            if (site.OwnerUserId != userId && !await CanEditInTeamAsync(userId, group.TeamId))
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你在该团队是只读角色，无法调整分组"));
            // 受限分组：任何人（含站点创建者）往里放内容都需分组级编辑权
            if (WebPageGroupAccess.IsRestricted(group))
            {
                var myGroupRole = await ResolveMyGroupRoleAsync(userId, group);
                if (myGroupRole != WebHostingRoles.Owner && myGroupRole != WebHostingRoles.Editor)
                    return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你在该受限分组没有编辑权，无法将网页移入"));
            }
            targetGroupId = group.Id;
        }
        else
        {
            // 移出分组：站点创建者，或站点所在任一团队的编辑权
            var allowed = site.OwnerUserId == userId;
            if (!allowed)
            {
                foreach (var tid in site.SharedTeamIds ?? new List<string>())
                {
                    if (await CanEditInTeamAsync(userId, tid)) { allowed = true; break; }
                }
            }
            if (!allowed)
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权调整该站点的分组"));
        }

        await _db.HostedSites.UpdateOneAsync(
            s => s.Id == id,
            Builders<HostedSite>.Update.Set(s => s.GroupId, targetGroupId).Set(s => s.UpdatedAt, DateTime.UtcNow));
        site.GroupId = targetGroupId;
        return Ok(ApiResponse<object>.Ok(site));
    }

    /// <summary>把自己的网页物理复制一份进团队空间（副本独立，原件规则不受影响）</summary>
    [HttpPost("{id}/copy-to-team")]
    public async Task<IActionResult> CopyToTeam(string id, [FromBody] CopySiteToTeamRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.TeamId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "teamId 不能为空"));
        try
        {
            var copy = await _siteService.CopyToTeamAsync(id, GetUserId(), req.TeamId, req.GroupId);
            return Ok(ApiResponse<object>.Ok(copy));
        }
        catch (KeyNotFoundException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
        catch (UnauthorizedAccessException ex)
        {
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>批量加载用户展示卡（userId → 昵称 + 头像文件名），前端据此渲染头像</summary>
    private async Task<Dictionary<string, object>> BuildUserCardsAsync(IEnumerable<string> userIds)
    {
        var ids = userIds.Where(u => !string.IsNullOrWhiteSpace(u)).Distinct().ToList();
        var map = new Dictionary<string, object>();
        if (ids.Count == 0) return map;

        var users = await _db.Users.Find(u => ids.Contains(u.UserId)).ToListAsync();
        foreach (var u in users)
        {
            map[u.UserId] = new
            {
                userId = u.UserId,
                displayName = !string.IsNullOrWhiteSpace(u.DisplayName) ? u.DisplayName : u.Username,
                avatarFileName = u.AvatarFileName,
            };
        }
        return map;
    }

    /// <summary>获取站点详情</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var site = await _siteService.GetByIdAsync(id, GetUserId());
        if (site == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        return Ok(ApiResponse<object>.Ok(site));
    }

    /// <summary>读取站点入口 HTML 原文（owner / 共享团队成员可读）。
    /// 服务端代理取回，绕开浏览器跨域限制；供「知识库从网页托管导入」等场景使用。
    /// 仅适用 HTML 入口的站点；包装资产站（pdf/video/markdown）与超大文件拒绝。</summary>
    [HttpGet("{id}/content")]
    public async Task<IActionResult> GetSiteContent(string id)
    {
        var site = await _siteService.GetByIdAsync(id, GetUserId());
        if (site == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或无权访问"));
        return await FetchSiteHtmlResultAsync(site);
    }

    /// <summary>
    /// 经分享链接读取站点入口 HTML 原文（匿名可访问，走分享门禁）。
    ///
    /// 为什么必须有这条：托管内容在独立域名（与主站刻意跨域隔离，防止用户上传的 HTML 触达主站登录态），
    /// 该域名不返回 Access-Control-Allow-Origin，浏览器侧 fetch 一律被 CORS 拦掉。预览页要拿原文注入
    /// srcDoc 渲染，只能走服务端同源代理——与 GetSiteContent 同一个取回实现，不另开一套。
    /// </summary>
    [HttpGet("shares/view/{token}/content")]
    [AllowAnonymous]
    public async Task<IActionResult> GetShareSiteContent(string token, [FromQuery] string? siteId, [FromQuery] string? password)
    {
        var viewerUserId = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var resolved = await _siteService.ResolveShareSiteAsync(token, siteId, password, viewerUserId);
        if (resolved.Error != null)
            return MapCommentError(resolved.Error, resolved.HttpStatus, resolved.ErrorCode, resolved.RetryAfterSeconds);
        if (resolved.Site == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        return await FetchSiteHtmlResultAsync(resolved.Site);
    }

    /// <summary>
    /// 服务端代理取回站点入口 HTML，绕开浏览器跨域限制。站内路径与分享路径共用，
    /// 保证「什么算可读、多大算超限、失败怎么报」只有一份判定（判据分裂会随时间漂移）。
    /// 仅适用 HTML 入口的站点；包装资产站（pdf/video/markdown）与超大文件拒绝。
    /// </summary>
    /// <summary>
    /// 壳子本身就是完整正文、可以直接当 HTML 读回去的包装类型。
    /// 默认拒绝、这里显式放行：将来新增包装形态时保持今天的行为，
    /// 确认它自包含之后才加进来（default-deny，不靠「忘了排除」来放行）。
    /// </summary>
    private static readonly HashSet<string> SrcDocReadableWrappers =
        new(StringComparer.OrdinalIgnoreCase) { "markdown" };

    private async Task<IActionResult> FetchSiteHtmlResultAsync(HostedSite site)
    {
        // 只拒「壳子里没有正文」的那几类：PDF / 视频壳本身只是一个指向同目录资产的容器，
        // 取回它的 HTML 没有意义，而且它必须以托管域名为文档源才能加载那份资产。
        // Markdown 包装站不同 —— 它的壳子**就是**正文：服务端把 .md 渲染成完整 HTML、
        // 样式内联、没有任何外部引用，恰恰是最适合 srcDoc 的那种页面。
        // 此前一刀切拒绝，导致 MD 站在分享页拿不到原文、只能退回直链 iframe，
        // 而直链正是那条「Chrome 只绘制空白」的路径 —— 用户看到的就是标题栏下面一片白。
        if (!string.IsNullOrEmpty(site.WrappedAssetType) && !SrcDocReadableWrappers.Contains(site.WrappedAssetType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该站点是 PDF/视频包装站，不支持以 HTML 读取"));
        if (string.IsNullOrWhiteSpace(site.SiteUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点没有可读取的入口文件"));

        const long maxBytes = 2L * 1024 * 1024; // 知识库正文按文本存储，2MB 足够覆盖单文件 HTML
        try
        {
            var version = site.ContentVersion == default ? site.CreatedAt : site.ContentVersion;
            var url = $"{site.SiteUrl}{(site.SiteUrl.Contains('?') ? "&" : "?")}v={version.Ticks}";
            var http = _httpClientFactory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(20);

            // 整个取回过程（含读 body）都必须有截止时间。
            // HttpClient.Timeout 配 ResponseHeadersRead 只覆盖到「响应头到手」，之后读 body
            // 是不设防的——对方慢慢滴数据就能把这个请求永久挂住。
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

            using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if (!resp.IsSuccessStatusCode)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"站点内容读取失败（HTTP {(int)resp.StatusCode}）"));
            if (resp.Content.Headers.ContentLength is > maxBytes)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点入口文件超过 2MB，不支持读取"));

            // 边读边卡上限，**不能**先 ReadAsStringAsync 再判长度。
            //
            // Content-Length 只是「对方自愿声明的」：缺头、chunked、或者声明一个压缩后的小尺寸，
            // 上面那道判断就形同虚设，而托管上传允许到 500MB。这条路由是匿名可达的
            // （拿着公开分享 token 就能打），先缓冲后判断等于把「一次请求分配几百 MB」
            // 的开关交给外部——读满上限就立刻断，多一个字节都不收。
            var over = false;
            byte[] bytes;
            await using (var stream = await resp.Content.ReadAsStreamAsync(cts.Token))
            using (var buffered = new MemoryStream())
            {
                var chunk = new byte[8192];
                while (true)
                {
                    var read = await stream.ReadAsync(chunk, cts.Token);
                    if (read <= 0) break;
                    if (buffered.Length + read > maxBytes) { over = true; break; }
                    buffered.Write(chunk, 0, read);
                }
                bytes = buffered.ToArray();
            }
            if (over)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点入口文件超过 2MB，不支持读取"));

            // 去掉 UTF-8 BOM，否则首字符是 \ufeff，注进 srcDoc 会在页面顶部留一个空白字符
            var html = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF
                ? Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3)
                : Encoding.UTF8.GetString(bytes);
            return Ok(ApiResponse<object>.Ok(new
            {
                siteId = site.Id,
                title = site.Title,
                contentType = "text/html",
                siteUrl = site.SiteUrl,
                html,
            }));
        }
        // OperationCanceledException 而不是 TaskCanceledException：显式 CancellationToken 触发时
        // 抛的是前者，只写后者会漏掉「读 body 超时」这条新路径（TaskCanceled 是它的子类，写父类才全）。
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点内容读取超时或失败，请稍后重试"));
        }
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
    public async Task<IActionResult> Reupload(string id, IFormFile file, [FromForm] string? uploadId = null)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var fileBytes = ms.ToArray();
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        var uploadName = file.FileName;

        // 视频 / PDF / Markdown：包装成 ZIP（保持与 Upload 一致的行为）
        string? wrappedAssetType = null;
        if (VideoExtensions.Contains(ext) || MarkdownExtensions.Contains(ext) || ext == ".pdf")
        {
            fileBytes = BuildWrapperZip(file.FileName, fileBytes, ext, title: null);
            uploadName = Path.ChangeExtension(file.FileName, ".zip");
            wrappedAssetType = ext == ".pdf" ? "pdf"
                : VideoExtensions.Contains(ext) ? "video"
                : MarkdownExtensions.Contains(ext) ? "markdown"
                : null;
        }

        try
        {
            // 显式传 wrappedAssetType，普通 HTML/ZIP 传 null 会清空旧 marker（避免站点
            // 从 PDF 包装改成 HTML 后前端还在渲染 PDF 占位，Codex P2 #612 抓到）
            // uploadId 要一路传到解包那层，否则前端轮询的那个键下面永远没有进度：
            // 换 ZIP 时解包面板会一直停在「等待中」，而服务层其实早就支持这个参数了，
            // 断的只是控制器这一跳（线只建了一半）。
            var updated = await _siteService.ReuploadAsync(
                id, GetUserId(), fileBytes, uploadName, wrappedAssetType, uploadId: uploadId);
            await _uploadProgress.CompleteAsync(uploadId);
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
            // visit 便捷链恒走 force=false（保留服务端去重 + 复用）；
            // 用户主动 share 默认走 forceNew=true（PR 2026-05-28：分享面板每次显式新建），
            // 除非 client 显式传 forceNew=false（少数兼容场景，保留逃生口）
            var isVisit = req.Purpose == "visit";
            var forceNew = !isVisit && (req.ForceNew ?? true);
            var visibility = isVisit ? "public" : (req.Visibility ?? "owner-only");

            var share = await _siteService.CreateShareAsync(
                GetUserId(), await ResolveDisplayNameAsync(GetUserId()),
                req.SiteId, req.SiteIds, req.ShareType ?? "single",
                req.Title, req.Description,
                req.Password, req.ExpiresInDays,
                purpose: isVisit ? "visit" : "share",
                forceNew: forceNew,
                visibility: visibility,
                // 数字短链按需分配：仅当用户在分享面板主动选「数字短链」时 client 传 true。
                // 默认 false → 只发不可枚举的 /s/wp/{token} 长链，不污染 short_links。
                allocateShortLink: req.AllocateShortLink ?? false,
                // 原样透传（含 null），三态判定归 AskOpeningQuestions.Resolve 一处
                askSuggestedQuestions: req.AskSuggestedQuestions);

            // P1 调整（2026-05-21 用户反馈）：默认 URL 保留分类前缀 /s/wp/{token}
            //   - 分类前缀有语义、利于在分享总管理面板里按类型分类
            //   - 用户只在主动选「超短链」时才用纯数字 /s/{seq}
            //   - 字母统一长链 /s/{token} 仍然可用（ShortLink 全局索引支持），但不主推
            return Ok(ApiResponse<object>.Ok(new
            {
                share.Id,
                share.Token,
                share.ShareType,
                share.AccessLevel,
                share.Password,
                share.ExpiresAt,
                share.ShortSeq,
                share.Visibility,
                shareUrl = $"/s/wp/{share.Token}",
                // /s/{seq} 与 /s/{token} 都依赖 ShortLink 记录；ShortSeq=0（未注册）时两者都
                // resolve missing，故都置 null，只暴露有效的带前缀长链 shareUrl。
                shortShareUrl = share.ShortSeq > 0 ? $"/s/{share.ShortSeq}" : null,
                unifiedShareUrl = share.ShortSeq > 0 ? $"/s/{share.Token}" : null,
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

    /// <summary>
    /// 事后为某条已存在的分享生成数字短链 /s/{seq}（用户在分享面板点「生成数字短链」）。
    /// 幂等：已有短链则原样返回。仅创建者可调用。
    /// </summary>
    [HttpPost("shares/{shareId}/short-link")]
    public async Task<IActionResult> EnsureShareShortLink(string shareId)
    {
        try
        {
            var seq = await _siteService.EnsureShortLinkAsync(GetUserId(), shareId);
            return Ok(ApiResponse<object>.Ok(new
            {
                shortSeq = seq,
                shortShareUrl = seq > 0 ? $"/s/{seq}" : null,
                unifiedShareUrl = (string?)null, // 由 client 用已知 token 自行拼 /s/{token}
            }));
        }
        catch (KeyNotFoundException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
        catch (UnauthorizedAccessException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 获取当前用户的分享链接列表（含未过期 + 过期 ≤ 7 天宽限期）。
    ///
    /// includeRevoked=true 时把已撤销的一并返回，供分享管理面板的「已撤销」一层展示。
    /// 默认 false，既有调用方行为不变。
    /// </summary>
    [HttpGet("shares")]
    public async Task<IActionResult> ListShares(
        [FromQuery] bool includeRevoked = false, [FromQuery] string? siteId = null)
    {
        // siteId 是给「这个站点到底有没有活着的链接」这种问法准备的：不带它时列表按时间
        // 取最近 100 条，某个站点的链接落在窗口外就会被判成「没有」，然后再建一条重复的。
        var items = await _siteService.ListSharesAsync(GetUserId(), default, includeRevoked, siteId);
        var now = DateTime.UtcNow;

        // 「指向的站点」这一列要的是标题，而链接上只有 siteId。一次批量查完，
        // 不在 Select 里逐条查（100 条链接就是 100 次往返）。
        var siteIds = items
            .SelectMany(x => x.TargetSiteIds())
            .Distinct()
            .ToList();
        var titleById = await _siteService.GetTitlesByIdsAsync(siteIds);

        var enriched = items.Select(x => new
        {
            x.Id,
            x.Token,
            x.ShortSeq,
            x.SiteId,
            x.SiteIds,
            x.ShareType,
            x.Title,
            x.Description,
            x.AccessLevel,
            x.Password,
            x.ExpiresAt,
            x.Visibility,
            x.CreatedAt,
            x.CreatedByName,
            x.ViewCount,
            x.UniqueIpCount,
            x.LastViewedAt,
            x.IsRevoked,
            x.RevokedAt,
            x.RevokedReason,
            isExpired = x.ExpiresAt.HasValue && x.ExpiresAt.Value < now,
            inGracePeriod = x.ExpiresAt.HasValue && x.ExpiresAt.Value < now && x.ExpiresAt.Value > ShareRenewPolicy.GraceCutoff(now),
            // 只数真的续期。RenewalHistory 是「过期时间为什么变了」的审计账，里面还躺着
            // created / reused / reset —— 全量 Count 会让一条从没续过期的链接显示「续期历史 1 次」
            // （创建那条也算进去了），列表上那句话就是假的。
            renewalCount = x.RenewalHistory?.Count(e => e.Action == "renewed") ?? 0,
            // 指向的站点标题；站点已删时该 id 查不到，跳过而不是塞一个占位符
            siteTitles = (x.SiteIds.Count > 0 ? x.SiteIds : (x.SiteId != null ? new List<string> { x.SiteId } : new List<string>()))
                .Where(titleById.ContainsKey)
                .Select(id => titleById[id])
                .ToList(),
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = enriched }));
    }

    /// <summary>列出某个站点的分享访问日志（仅站点 owner 可查）</summary>
    [HttpGet("{siteId}/share-logs")]
    public async Task<IActionResult> ListShareLogsForSite(string siteId, [FromQuery] int limit = 50)
    {
        var logs = await _siteService.ListShareViewLogsForSiteAsync(siteId, GetUserId(), limit);
        return Ok(ApiResponse<object>.Ok(new { items = logs }));
    }

    /// <summary>续期分享链接</summary>
    [HttpPost("shares/{shareId}/renew")]
    public async Task<IActionResult> RenewShare(string shareId, [FromBody] RenewShareRequest req)
    {
        var result = await _siteService.RenewShareAsync(shareId, GetUserId(), req.ExtendDays);
        if (!result.Ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Error ?? "续期失败"));
        return Ok(ApiResponse<object>.Ok(new { newExpiresAt = result.NewExpiresAt }));
    }

    /// <summary>
    /// 就地改一条分享链接的设置（分享下拉面板的「谁能打开 / 有效期」两行）。
    ///
    /// 与续期分开：续期是在现有到期日上累加，这里是从现在起重设。面板上选「7 天」
    /// 期待的是「还剩 7 天」，走续期会得到「原来剩的 + 7 天」，两者不能共用一个端点。
    /// </summary>
    [HttpPatch("shares/{shareId}")]
    public async Task<IActionResult> UpdateShareSettings(string shareId, [FromBody] UpdateShareSettingsRequest req)
    {
        var result = await _siteService.UpdateShareSettingsAsync(
            shareId, GetUserId(), req.Visibility, req.ExpiresInDays);
        if (!result.Ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Error ?? "修改失败"));
        return Ok(ApiResponse<object>.Ok(new { visibility = result.Visibility, expiresAt = result.ExpiresAt }));
    }

    /// <summary>
    /// 用户分享统计聚合（参考 Cloudflare 简化版）。
    /// 可选 ?siteId=xxx 把统计范围收窄到单个站点（用于站点卡上的「本站点统计」按钮）。
    /// </summary>
    [HttpGet("shares/analytics")]
    public async Task<IActionResult> GetShareAnalytics([FromQuery] int rangeDays = 7, [FromQuery] string? siteId = null)
    {
        var result = await _siteService.GetShareAnalyticsAsync(GetUserId(), rangeDays, siteId);
        return Ok(ApiResponse<object>.Ok(result));
    }

    /// <summary>
    /// 撤销分享链接。
    ///
    /// reason 可选：撤销不可逆，几周后回头看列表时这句话是唯一能想起当初为什么撤的线索。
    /// 不传就没有，列表那一行只显示撤销时间。
    /// </summary>
    [HttpDelete("shares/{shareId}")]
    public async Task<IActionResult> RevokeShare(string shareId, [FromQuery] string? reason = null)
    {
        var ok = await _siteService.RevokeShareAsync(shareId, GetUserId(), reason);
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
        var viewerName = viewerUserId != null ? await ResolveDisplayNameAsync(viewerUserId) : null;
        var ip = HttpContext.GetRealClientIp();
        var ua = Request.Headers.UserAgent.ToString();

        var result = await _siteService.ViewShareAsync(token, password,
            viewerUserId, viewerName, ip, ua);
        if (result == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));

        if (result.Error != null)
        {
            if (result.HttpStatus == 429)
            {
                if (result.RetryAfterSeconds is { } ra && ra > 0)
                    Response.Headers["Retry-After"] = ra.ToString();
                return StatusCode(429, ApiResponse<object>.Fail("RATE_LIMITED", result.Error));
            }
            return result.HttpStatus switch
            {
                401 => Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, result.Error)),
                403 => StatusCode(403, ApiResponse<object>.Fail(result.ErrorCode ?? "VISIBILITY_DENIED", result.Error)),
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
            result.Ask,
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
            if (result.HttpStatus == 429)
            {
                if (result.RetryAfterSeconds is { } ra && ra > 0)
                    Response.Headers["Retry-After"] = ra.ToString();
                return StatusCode(429, ApiResponse<object>.Fail("RATE_LIMITED", result.Error));
            }
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

    // ─────────────────────────────────────────────
    // 评论
    // ─────────────────────────────────────────────

    /// <summary>切换站点是否允许评论（仅 owner / editor 可调）</summary>
    [HttpPatch("{id}/comments-enabled")]
    public async Task<IActionResult> SetCommentsEnabled(string id, [FromBody] SetCommentsEnabledRequest req)
    {
        var updated = await _siteService.SetCommentsEnabledAsync(id, GetUserId(), req.Enabled);
        if (updated == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或无权限"));
        return Ok(ApiResponse<object>.Ok(new { id = updated.Id, commentsEnabled = updated.CommentsEnabled }));
    }

    /// <summary>列出某站点的评论（owner / 团队成员视角，需登录）</summary>
    [HttpGet("{siteId}/comments")]
    public async Task<IActionResult> ListSiteComments(string siteId)
    {
        var result = await _siteService.ListCommentsBySiteAsync(siteId, GetUserId());
        if (result == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或无权访问"));
        return Ok(ApiResponse<object>.Ok(result));
    }

    /// <summary>在某站点发表评论（owner / 团队成员视角，需登录）</summary>
    [HttpPost("{siteId}/comments")]
    public async Task<IActionResult> AddSiteComment(string siteId, [FromBody] AddSiteCommentRequest req)
    {
        var result = await _siteService.AddCommentBySiteAsync(
            siteId, GetUserId(), await ResolveDisplayNameAsync(GetUserId()), await GetAvatarFileNameAsync(GetUserId()), req.Content ?? string.Empty);
        return MapAddCommentResult(result);
    }

    /// <summary>经分享链接列出评论（公开访问，无需登录即可读）</summary>
    [HttpGet("shares/view/{token}/comments")]
    [AllowAnonymous]
    public async Task<IActionResult> ListShareComments(string token, [FromQuery] string? password)
    {
        var viewerUserId = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var result = await _siteService.ListCommentsByShareAsync(token, password, viewerUserId);
        if (result.Error != null)
            return MapCommentError(result.Error, result.HttpStatus, result.ErrorCode, result.RetryAfterSeconds);
        return Ok(ApiResponse<object>.Ok(result));
    }

    /// <summary>经分享链接发表评论（需登录）</summary>
    [HttpPost("shares/view/{token}/comments")]
    public async Task<IActionResult> AddShareComment(string token, [FromQuery] string? password, [FromBody] AddSiteCommentRequest req)
    {
        var userId = GetUserId();
        var ip = HttpContext.GetRealClientIp();
        var result = await _siteService.AddCommentByShareAsync(
            token, password, userId, await ResolveDisplayNameAsync(userId), await GetAvatarFileNameAsync(userId), req.Content ?? string.Empty, ip);
        return MapAddCommentResult(result);
    }

    /// <summary>删除评论（作者本人或站点 owner）</summary>
    [HttpDelete("comments/{commentId}")]
    public async Task<IActionResult> DeleteComment(string commentId)
    {
        var ok = await _siteService.DeleteCommentAsync(commentId, GetUserId());
        if (!ok)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "评论不存在或无权删除"));
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    private async Task<string?> GetAvatarFileNameAsync(string userId)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        return user?.AvatarFileName;
    }

    private IActionResult MapAddCommentResult(AddCommentResult result)
    {
        if (result.Error != null)
            return MapCommentError(result.Error, result.HttpStatus, result.ErrorCode, result.RetryAfterSeconds);
        return Ok(ApiResponse<object>.Ok(result.Comment));
    }

    private IActionResult MapCommentError(string error, int httpStatus, string? errorCode, int? retryAfterSeconds = null)
    {
        // 429 限流：与 ViewShare 一致，回 Retry-After 头 + RATE_LIMITED，让客户端倒计时重试，
        // 不能 fall through 成 404 把"临时限流的受密码保护分享"误报成"不存在"（Codex P2）。
        if (httpStatus == 429)
        {
            if (retryAfterSeconds is { } ra && ra > 0)
                Response.Headers["Retry-After"] = ra.ToString();
            return StatusCode(429, ApiResponse<object>.Fail("RATE_LIMITED", error));
        }
        return httpStatus switch
        {
            401 => Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, error)),
            403 => StatusCode(403, ApiResponse<object>.Fail(errorCode ?? "FORBIDDEN", error)),
            400 => BadRequest(ApiResponse<object>.Fail(errorCode ?? ErrorCodes.INVALID_FORMAT, error)),
            _ => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, error)),
        };
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

public class SetSiteTeamsRequest
{
    /// <summary>站点要分享到的团队 ID 列表（空表示取消所有团队分享）</summary>
    public List<string>? TeamIds { get; set; }
}

public class CreateWebPageGroupRequest
{
    public string? TeamId { get; set; }

    /// <summary>topic = 专题 | daily = 日常分类</summary>
    public string? Kind { get; set; }

    public string? Name { get; set; }
    public int? SortOrder { get; set; }
}

public class UpdateWebPageGroupRequest
{
    public string? Name { get; set; }
    public int? SortOrder { get; set; }
}

public class UpdateGroupAccessRequest
{
    /// <summary>inherit | restricted</summary>
    public string? Visibility { get; set; }

    /// <summary>visibility=restricted 时的授权规则；inherit 时忽略</summary>
    public List<GroupAccessRuleInput>? Rules { get; set; }
}

public class GroupAccessRuleInput
{
    /// <summary>user | label</summary>
    public string? SubjectType { get; set; }

    /// <summary>user 时为成员 UserId；label 时为角色标签文本</summary>
    public string? SubjectId { get; set; }

    /// <summary>viewer | editor</summary>
    public string? Role { get; set; }
}

public class SetSiteGroupRequest
{
    /// <summary>目标分组 ID（空 = 移出分组）</summary>
    public string? GroupId { get; set; }
}

public class CopySiteToTeamRequest
{
    public string? TeamId { get; set; }

    /// <summary>副本直接归入的分组 ID（可选）</summary>
    public string? GroupId { get; set; }
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
    /// <summary>用途：visit = 站点访问便捷链（公开永久、独立池）；其余/缺省 = 用户分享</summary>
    public string? Purpose { get; set; }

    /// <summary>
    /// 是否强制新建（绕过服务端复用）。默认 true（分享面板每次显式新建）；
    /// 调用方明确传 false 才走旧版复用逻辑。
    /// </summary>
    public bool? ForceNew { get; set; }

    /// <summary>访问可见性：owner-only（默认） / logged-in / public</summary>
    public string? Visibility { get; set; }

    /// <summary>
    /// 本条分享链接自选的开场问题（分享面板里从站点题库勾选 / 手写）。
    ///
    /// 三态必须原样传达到服务层，**不要**在这里把 null 兜成空数组：
    ///   不传（null）= 沿用站点题库；传 []= 这条链接不显示开场问题；传非空 = 只显示这几条。
    /// </summary>
    public List<string>? AskSuggestedQuestions { get; set; }

    /// <summary>
    /// 是否分配数字短链 /s/{seq}。默认 false：用户意图里没有短链就不强制生成，
    /// 只发不可枚举的 /s/wp/{token} 长链。仅当用户在分享面板主动选「数字短链」时传 true。
    /// </summary>
    public bool? AllocateShortLink { get; set; }
}

public class RenewShareRequest
{
    /// <summary>续期天数（1-365）</summary>
    public int ExtendDays { get; set; } = 30;
}

public class UpdateShareSettingsRequest
{
    /// <summary>可见性：owner-only / logged-in / public。null = 不改这一项</summary>
    public string? Visibility { get; set; }

    /// <summary>
    /// 从现在起的有效天数（0 = 永久，上限 365）。null = 不改这一项。
    /// 注意 0 与 null 是两回事：0 是「改成永久」，null 是「别动它」——用不可空 int 接
    /// 就会把「没传」读成「改成永久」，一次误传把限期链接变永久。
    /// </summary>
    public int? ExpiresInDays { get; set; }
}

public class SetCommentsEnabledRequest
{
    /// <summary>true = 允许评论 | false = 关闭评论</summary>
    public bool Enabled { get; set; }
}

public class AddSiteCommentRequest
{
    /// <summary>评论正文（1-2000 字）</summary>
    public string? Content { get; set; }
}
