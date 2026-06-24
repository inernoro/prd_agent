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
    private readonly IHttpClientFactory _httpClientFactory;

    public WebPagesController(
        IHostedSiteService siteService,
        PrdAgent.Infrastructure.Database.MongoDbContext db,
        ITeamService teams,
        IHttpClientFactory httpClientFactory)
    {
        _siteService = siteService;
        _db = db;
        _teams = teams;
        _httpClientFactory = httpClientFactory;
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
        [FromForm] IFormFile? file,
        [FromForm] List<IFormFile>? files,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? folder,
        [FromForm] string? tags)
    {
        var uploadFiles = NormalizeUploadFiles(file, files);
        if (uploadFiles.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));

        if (uploadFiles.Sum(f => f.Length) > MaxSingleFileSize)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxSingleFileSize / 1024 / 1024}MB"));

        var userId = GetUserId();
        var tagList = string.IsNullOrWhiteSpace(tags)
            ? new List<string>()
            : tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

        try
        {
            HostedSite site;
            if (uploadFiles.Count > 1)
            {
                var zipBytes = await BuildMultiHtmlZipAsync(uploadFiles);
                var effectiveTitle = string.IsNullOrWhiteSpace(title)
                    ? BuildMultiHtmlDefaultTitle(uploadFiles)
                    : title!.Trim();
                site = await _siteService.CreateFromZipAsync(userId, zipBytes, effectiveTitle, description, folder, tagList);
                return Ok(ApiResponse<object>.Ok(site));
            }

            var single = uploadFiles[0];
            var ext = Path.GetExtension(single.FileName).ToLowerInvariant();

            using var ms = new MemoryStream();
            await single.CopyToAsync(ms);
            var fileBytes = ms.ToArray();

            if (ext == ".zip")
            {
                site = await _siteService.CreateFromZipAsync(userId, fileBytes, title, description, folder, tagList);
            }
            else if (ext is ".html" or ".htm")
            {
                site = await _siteService.CreateFromHtmlAsync(userId, fileBytes, single.FileName, title, description, folder, tagList);
            }
            else if (VideoExtensions.Contains(ext) || MarkdownExtensions.Contains(ext) || ext == ".pdf")
            {
                // 视频 / PDF / Markdown：现场生成 index.html 壳子 + 原文件，打包成 ZIP 走现有路径
                // 标题留空时用文件名（去扩展名）兜底，避免 ZIP 路径把视频/PDF 全落成"未命名站点"
                // （前端 UploadEditDialog 仅对 .md 自动预填标题；其它媒体类型靠后端兜底）
                var effectiveTitle = string.IsNullOrWhiteSpace(title)
                    ? Path.GetFileNameWithoutExtension(single.FileName)
                    : title!.Trim();
                var zipBytes = BuildWrapperZip(single.FileName, fileBytes, ext, effectiveTitle);
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
            loadScript(CDN + "pdf.min.js").then(function(){
              var lib = window.pdfjsLib || window["pdfjs-dist/build/pdf"];
              if(!lib){ throw new Error("pdfjs not loaded"); }
              lib.GlobalWorkerOptions.workerSrc = CDN + "pdf.worker.min.js";
              return lib.getDocument({ url: PDF_URL }).promise;
            }).then(function(pdf){
              if(statusEl){ statusEl.style.display = "none"; }
              var dpr = Math.min(window.devicePixelRatio || 1, 2);
              var renderOne = function(num){
                return pdf.getPage(num).then(function(page){
                  var base = page.getViewport({ scale: 1 });
                  var cssWidth = Math.min((pagesEl.clientWidth || window.innerWidth) - 16, 1100);
                  var cssScale = cssWidth / base.width;
                  var vp = page.getViewport({ scale: cssScale * dpr });
                  var canvas = document.createElement("canvas");
                  var ctx = canvas.getContext("2d");
                  canvas.width = Math.floor(vp.width);
                  canvas.height = Math.floor(vp.height);
                  canvas.style.width = cssWidth + "px";
                  canvas.style.height = Math.floor(cssWidth * base.height / base.width) + "px";
                  pagesEl.appendChild(canvas);
                  return page.render({ canvasContext: ctx, viewport: vp }).promise;
                });
              };
              var chain = Promise.resolve();
              for(var i = 1; i <= pdf.numPages; i++){
                (function(n){ chain = chain.then(function(){ return renderOne(n); }); })(i);
              }
              return chain;
            }).catch(function(){
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
                return Ok(ApiResponse<object>.Ok(new { items, total, owners, myWebHostingRole }));
            }
            return Ok(ApiResponse<object>.Ok(new { items, total, owners }));
        }

        return Ok(ApiResponse<object>.Ok(new { items, total }));
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
        if (!string.IsNullOrEmpty(site.WrappedAssetType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该站点是 PDF/视频/Markdown 包装站，不支持以 HTML 导入"));
        if (string.IsNullOrWhiteSpace(site.SiteUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点没有可读取的入口文件"));

        const long maxBytes = 2L * 1024 * 1024; // 知识库正文按文本存储，2MB 足够覆盖单文件 HTML
        try
        {
            var version = site.ContentVersion == default ? site.CreatedAt : site.ContentVersion;
            var url = $"{site.SiteUrl}{(site.SiteUrl.Contains('?') ? "&" : "?")}v={version.Ticks}";
            var http = _httpClientFactory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(20);
            using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            if (!resp.IsSuccessStatusCode)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"站点内容读取失败（HTTP {(int)resp.StatusCode}）"));
            if (resp.Content.Headers.ContentLength is > maxBytes)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点入口文件超过 2MB，不支持导入"));
            var html = await resp.Content.ReadAsStringAsync();
            if (html.Length > maxBytes)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点入口文件超过 2MB，不支持导入"));
            return Ok(ApiResponse<object>.Ok(new { siteId = site.Id, title = site.Title, contentType = "text/html", html }));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
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
    public async Task<IActionResult> Reupload(string id, [FromForm] IFormFile? file, [FromForm] List<IFormFile>? files)
    {
        var uploadFiles = NormalizeUploadFiles(file, files);
        if (uploadFiles.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));
        if (uploadFiles.Sum(f => f.Length) > MaxSingleFileSize)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxSingleFileSize / 1024 / 1024}MB"));

        byte[] fileBytes;
        string uploadName;
        string? wrappedAssetType = null;

        if (uploadFiles.Count > 1)
        {
            fileBytes = await BuildMultiHtmlZipAsync(uploadFiles);
            uploadName = "multi-html.zip";
        }
        else
        {
            var single = uploadFiles[0];
            using var ms = new MemoryStream();
            await single.CopyToAsync(ms);
            fileBytes = ms.ToArray();
            var ext = Path.GetExtension(single.FileName).ToLowerInvariant();
            uploadName = single.FileName;

            // 视频 / PDF / Markdown：包装成 ZIP（保持与 Upload 一致的行为）
            if (VideoExtensions.Contains(ext) || MarkdownExtensions.Contains(ext) || ext == ".pdf")
            {
                fileBytes = BuildWrapperZip(single.FileName, fileBytes, ext, title: null);
                uploadName = Path.ChangeExtension(single.FileName, ".zip");
                wrappedAssetType = ext == ".pdf" ? "pdf"
                    : VideoExtensions.Contains(ext) ? "video"
                    : MarkdownExtensions.Contains(ext) ? "markdown"
                    : null;
            }
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

    private static List<IFormFile> NormalizeUploadFiles(IFormFile? file, List<IFormFile>? files)
    {
        var result = new List<IFormFile>();
        if (files is { Count: > 0 })
            result.AddRange(files.Where(f => f is { Length: > 0 }));
        if (result.Count == 0 && file is { Length: > 0 })
            result.Add(file);
        return result;
    }

    private static async Task<byte[]> BuildMultiHtmlZipAsync(IReadOnlyList<IFormFile> files)
    {
        if (files.Count < 2)
            throw new InvalidOperationException("多文件上传至少需要选择 2 个 HTML 文件");

        var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var file in files)
            {
                var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
                if (ext is not (".html" or ".htm"))
                    throw new InvalidOperationException("多文件上传仅支持 .html / .htm 文件；其他资源请上传 ZIP");

                var safeName = SanitizeFileName(file.FileName);
                if (!usedNames.Add(safeName))
                    throw new InvalidOperationException($"存在同名文件：{safeName}");

                var entry = zip.CreateEntry(safeName, CompressionLevel.Optimal);
                await using var target = entry.Open();
                await file.CopyToAsync(target);
            }
        }
        return ms.ToArray();
    }

    private static string BuildMultiHtmlDefaultTitle(IReadOnlyList<IFormFile> files)
    {
        var entry = files.FirstOrDefault(f =>
                string.Equals(Path.GetFileName(f.FileName), "index.html", StringComparison.OrdinalIgnoreCase)
                || string.Equals(Path.GetFileName(f.FileName), "index.htm", StringComparison.OrdinalIgnoreCase))
            ?? files[0];
        return Path.GetFileNameWithoutExtension(entry.FileName);
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
                allocateShortLink: req.AllocateShortLink ?? false);

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
