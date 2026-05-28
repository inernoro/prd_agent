using System.IO.Compression;
using System.Security.Claims;
using System.Text;
using Markdig;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
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

    private readonly PrdAgent.Infrastructure.Database.MongoDbContext _db;
    private readonly ITeamService _teams;

    public WebPagesController(
        IHostedSiteService siteService,
        PrdAgent.Infrastructure.Database.MongoDbContext db,
        ITeamService teams)
    {
        _siteService = siteService;
        _db = db;
        _teams = teams;
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
                site = await _siteService.CreateFromZipAsync(userId, zipBytes, effectiveTitle, description, folder, tagList, assetType);
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

        // 团队作用域：附带创建者头像/昵称（卡片左下角展示）+ 我在该团队的网页托管有效角色
        //（owner/editor/viewer），前端据此隐藏 viewer 的编辑/删除/分享入口。即使列表为空也返回角色。
        if (string.Equals(scope, "team", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(teamId))
        {
            var myRoles = await _teams.GetMyWebHostingTeamRolesAsync(userId);
            var myWebHostingRole = myRoles.GetValueOrDefault(teamId);
            var owners = items.Count > 0
                ? await BuildUserCardsAsync(items.Select(s => s.OwnerUserId))
                : new Dictionary<string, object>();
            return Ok(ApiResponse<object>.Ok(new { items, total, owners, myWebHostingRole }));
        }

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>设置站点分享到的团队（仅 owner 可调）</summary>
    [HttpPatch("{id}/teams")]
    public async Task<IActionResult> SetTeams(string id, [FromBody] SetSiteTeamsRequest req)
    {
        var updated = await _siteService.SetSharedTeamsAsync(id, GetUserId(), req.TeamIds ?? new List<string>());
        if (updated == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或无权限"));
        return Ok(ApiResponse<object>.Ok(updated));
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
            var updated = await _siteService.ReuploadAsync(id, GetUserId(), fileBytes, uploadName, wrappedAssetType);
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
                GetUserId(), GetDisplayName(),
                req.SiteId, req.SiteIds, req.ShareType ?? "single",
                req.Title, req.Description,
                req.Password, req.ExpiresInDays,
                purpose: isVisit ? "visit" : "share",
                forceNew: forceNew,
                visibility: visibility);

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

    /// <summary>获取当前用户的分享链接列表（含未过期 + 过期 ≤ 7 天宽限期）</summary>
    [HttpGet("shares")]
    public async Task<IActionResult> ListShares()
    {
        var items = await _siteService.ListSharesAsync(GetUserId());
        var now = DateTime.UtcNow;
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
            isExpired = x.ExpiresAt.HasValue && x.ExpiresAt.Value < now,
            inGracePeriod = x.ExpiresAt.HasValue && x.ExpiresAt.Value < now && x.ExpiresAt.Value > now.AddDays(-7),
            renewalCount = x.RenewalHistory?.Count ?? 0,
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

    /// <summary>用户分享统计聚合（参考 Cloudflare 简化版）</summary>
    [HttpGet("shares/analytics")]
    public async Task<IActionResult> GetShareAnalytics([FromQuery] int rangeDays = 7)
    {
        var result = await _siteService.GetShareAnalyticsAsync(GetUserId(), rangeDays);
        return Ok(ApiResponse<object>.Ok(result));
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
}

public class RenewShareRequest
{
    /// <summary>续期天数（1-365）</summary>
    public int ExtendDays { get; set; } = 30;
}
