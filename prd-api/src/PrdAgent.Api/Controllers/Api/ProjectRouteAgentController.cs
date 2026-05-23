using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.ProjectRouteAgent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 项目路由智能体（appKey: project-route-agent）
///
/// 业务流程：
///   1) 管理员维护「公共站点说明 md + 仓库登记表」（仅一份 Active）
///   2) 普通用户上传方案 .md（走 attachments → ExtractedText 已含 markdown 文本）
///   3) 调用 /plans/{id}/analyze/stream 触发 SSE：
///        a. LLM 第一步：从方案抽取「应用 + 业务模块」清单（流式 phase）
///        b. 按公共站点说明克隆每个仓库（--depth=1）+ 读取 routemap/ 目录快照
///        c. LLM 第二步：把抽取结果 + 各仓库 routemap 快照喂给 LLM，输出项目路径匹配
///        d. 持久化结果，推送 done 事件
/// </summary>
[ApiController]
[Route("api/project-route-agent")]
[Authorize]
[AdminController("project-route-agent", AdminPermissionCatalog.ProjectRouteAgentUse)]
public class ProjectRouteAgentController : ControllerBase
{
    private const string AppKey = "project-route-agent";

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly GitRepoCacheService _gitCache;
    private readonly ILogger<ProjectRouteAgentController> _logger;

    public ProjectRouteAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        GitRepoCacheService gitCache,
        ILogger<ProjectRouteAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _gitCache = gitCache;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private string? GetDisplayName()
        => User.FindFirst("displayName")?.Value
           ?? User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasManagePermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.ProjectRouteAgentManage)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    // ──────────────────────────────────────────────────────────────
    // 公共站点说明（管理员维护，全员可读用于展示来源）
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// 获取当前激活的公共站点说明。普通用户能看到（用于在分析结果页展示来源）。
    /// </summary>
    [HttpGet("site-spec")]
    public async Task<IActionResult> GetActiveSiteSpec(CancellationToken ct)
    {
        var spec = await _db.ProjectRouteSiteSpecs
            .Find(x => x.IsActive)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { siteSpec = spec }));
    }

    public class UpsertSiteSpecRequest
    {
        public string? Title { get; set; }
        public string? MarkdownContent { get; set; }
        public List<ProjectRouteRepoEntry>? Repos { get; set; }
    }

    /// <summary>
    /// 创建或更新公共站点说明（管理员）。同时间只保留 1 条 IsActive=true，其他自动置为 false。
    /// </summary>
    [HttpPost("site-spec")]
    public async Task<IActionResult> UpsertSiteSpec([FromBody] UpsertSiteSpecRequest req, CancellationToken ct)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限维护公共站点说明"));

        if (req == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求体为空"));
        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));
        if (string.IsNullOrWhiteSpace(req.MarkdownContent))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "公共站点说明 Markdown 不能为空"));

        var repos = (req.Repos ?? new List<ProjectRouteRepoEntry>())
            .Where(r => !string.IsNullOrWhiteSpace(r.RepoUrl) && !string.IsNullOrWhiteSpace(r.AppName))
            .Select(r => new ProjectRouteRepoEntry
            {
                AppName = r.AppName.Trim(),
                Aliases = (r.Aliases ?? new List<string>()).Select(a => a.Trim()).Where(a => a.Length > 0).Distinct().ToList(),
                RepoUrl = r.RepoUrl.Trim(),
                Branch = string.IsNullOrWhiteSpace(r.Branch) ? "main" : r.Branch.Trim(),
                RoutemapPath = string.IsNullOrWhiteSpace(r.RoutemapPath) ? "routemap" : r.RoutemapPath.Trim(),
                Notes = string.IsNullOrWhiteSpace(r.Notes) ? null : r.Notes.Trim(),
            })
            .ToList();

        if (repos.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少登记 1 个仓库（AppName + RepoUrl）"));

        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var existing = await _db.ProjectRouteSiteSpecs.Find(x => x.IsActive).FirstOrDefaultAsync(ct);

        if (existing != null)
        {
            existing.Title = req.Title.Trim();
            existing.MarkdownContent = req.MarkdownContent;
            existing.Repos = repos;
            existing.UpdatedAt = now;
            existing.UpdatedBy = userId;
            await _db.ProjectRouteSiteSpecs.ReplaceOneAsync(x => x.Id == existing.Id, existing, cancellationToken: CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { siteSpec = existing, mode = "updated" }));
        }
        else
        {
            var spec = new ProjectRouteSiteSpec
            {
                Title = req.Title.Trim(),
                MarkdownContent = req.MarkdownContent,
                Repos = repos,
                IsActive = true,
                CreatedBy = userId,
                UpdatedBy = userId,
                CreatedAt = now,
                UpdatedAt = now,
            };
            await _db.ProjectRouteSiteSpecs.InsertOneAsync(spec, cancellationToken: CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { siteSpec = spec, mode = "created" }));
        }
    }

    // ──────────────────────────────────────────────────────────────
    // 方案 plans CRUD
    // ──────────────────────────────────────────────────────────────

    public class CreatePlanRequest
    {
        public string? Title { get; set; }
        public string? AttachmentId { get; set; }
    }

    /// <summary>
    /// 创建一条方案分析任务（上传方案 md 之后调用）
    /// </summary>
    [HttpPost("plans")]
    public async Task<IActionResult> CreatePlan([FromBody] CreatePlanRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方案标题不能为空"));
        if (string.IsNullOrWhiteSpace(req.AttachmentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "attachmentId 不能为空"));

        var attachment = await _db.Attachments.Find(x => x.AttachmentId == req.AttachmentId).FirstOrDefaultAsync(ct);
        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "附件不存在"));
        if (string.IsNullOrWhiteSpace(attachment.ExtractedText))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法从文件中提取文本内容，请确认上传的是有效的 Markdown 文件"));

        var userId = GetUserId();
        var displayName = GetDisplayName() ?? userId;

        var plan = new ProjectRoutePlan
        {
            SubmitterId = userId,
            SubmitterName = displayName,
            Title = req.Title.Trim(),
            AttachmentId = req.AttachmentId,
            FileName = attachment.FileName,
            ExtractedContent = attachment.ExtractedText,
            Status = ProjectRoutePlanStatuses.Queued,
        };
        await _db.ProjectRoutePlans.InsertOneAsync(plan, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>我的方案列表</summary>
    [HttpGet("plans")]
    public async Task<IActionResult> ListMyPlans([FromQuery] int page = 1, [FromQuery] int pageSize = 50, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var dbFilter = Builders<ProjectRoutePlan>.Filter.Eq(x => x.SubmitterId, userId);
        var total = await _db.ProjectRoutePlans.CountDocumentsAsync(dbFilter, cancellationToken: ct);
        var items = await _db.ProjectRoutePlans.Find(dbFilter)
            .SortByDescending(x => x.SubmittedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>单条方案详情</summary>
    [HttpGet("plans/{id}")]
    public async Task<IActionResult> GetPlan(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var plan = await _db.ProjectRoutePlans.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "方案不存在"));
        if (plan.SubmitterId != userId && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权访问"));
        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>删除自己的方案</summary>
    [HttpDelete("plans/{id}")]
    public async Task<IActionResult> DeletePlan(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var plan = await _db.ProjectRoutePlans.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "方案不存在"));
        if (plan.SubmitterId != userId && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权删除"));

        await _db.ProjectRoutePlans.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ──────────────────────────────────────────────────────────────
    // 分析（SSE 流式 — 内联模式）
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// 触发分析。SSE 事件类型：
    ///   phase  { code, label }          — 阶段提示（loading/extracting/cloning/scanning/matching/saving）
    ///   model  { model, platform }      — AI 模型可见性（规则 #6）
    ///   apps   { apps[], modules[] }    — 第一步抽取结果
    ///   repo   { appName, repoUrl, status, message?, files? } — 每仓库 clone + routemap 扫描结果
    ///   result { resolutions[] }        — 路径匹配结果
    ///   done   { planId, model, platform } — 收尾
    ///   error  { message }
    /// </summary>
    [HttpGet("plans/{id}/analyze/stream")]
    [Produces("text/event-stream")]
    public async Task AnalyzePlanStream(string id)
    {
        var userId = GetUserId();
        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        async Task WriteEvent(string evt, object data)
        {
            try
            {
                var json = JsonSerializer.Serialize(data, JsonOpts);
                var bytes = Encoding.UTF8.GetBytes($"event: {evt}\ndata: {json}\n\n");
                await Response.Body.WriteAsync(bytes, CancellationToken.None);
                await Response.Body.FlushAsync(CancellationToken.None);
            }
            catch (OperationCanceledException) { /* 客户端断开 */ }
            catch (ObjectDisposedException) { /* response 已关闭 */ }
        }

        var plan = await _db.ProjectRoutePlans.Find(x => x.Id == id).FirstOrDefaultAsync(CancellationToken.None);
        if (plan == null)
        {
            await WriteEvent("error", new { message = "方案不存在" });
            return;
        }
        if (plan.SubmitterId != userId && !HasManagePermission())
        {
            await WriteEvent("error", new { message = "无权分析此方案" });
            return;
        }
        if (string.IsNullOrWhiteSpace(plan.ExtractedContent))
        {
            await WriteEvent("error", new { message = "方案内容为空" });
            return;
        }

        var siteSpec = await _db.ProjectRouteSiteSpecs
            .Find(x => x.IsActive)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (siteSpec == null || siteSpec.Repos.Count == 0)
        {
            await WriteEvent("error", new { message = "公共站点说明尚未配置，请联系管理员先维护公共站点说明 + 仓库登记表" });
            return;
        }

        plan.Status = ProjectRoutePlanStatuses.Running;
        plan.StartedAt = DateTime.UtcNow;
        plan.SiteSpecId = siteSpec.Id;
        plan.ErrorMessage = null;
        await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);

        await WriteEvent("phase", new { code = "loading", label = "加载方案和公共站点说明", message = "加载方案和公共站点说明" });

        try
        {
            // ===== 阶段 1：LLM 抽取应用 + 业务模块 =====
            await WriteEvent("phase", new { code = "extracting", label = "AI 抽取方案涉及的应用 / 业务模块", message = "AI 抽取方案涉及的应用 / 业务模块" });

            var (apps, modules, extractModel, extractPlatform) = await ExtractAppsAsync(plan, userId);
            plan.ExtractedApps = apps;
            plan.ExtractedModules = modules;
            plan.Model = extractModel;
            plan.ModelPlatform = extractPlatform;
            await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);

            if (!string.IsNullOrEmpty(extractModel))
                await WriteEvent("model", new { model = extractModel, platform = extractPlatform });
            await WriteEvent("apps", new { apps, modules });

            // ===== 阶段 2：克隆仓库 + 读 routemap 快照 =====
            var __cloningLabel = $"克隆 {siteSpec.Repos.Count} 个仓库到本地缓存"; await WriteEvent("phase", new { code = "cloning", label = __cloningLabel, message = __cloningLabel });

            var repoSnapshots = new List<(ProjectRouteRepoEntry Entry, RoutemapSnapshot? Snap, string? ErrorMessage)>();
            foreach (var entry in siteSpec.Repos)
            {
                await WriteEvent("repo", new
                {
                    appName = entry.AppName,
                    repoUrl = entry.RepoUrl,
                    branch = entry.Branch,
                    status = "cloning",
                    message = "git clone --depth=1",
                });
                try
                {
                    var dir = await _gitCache.EnsureClonedAsync(entry.RepoUrl, entry.Branch, CancellationToken.None);
                    var snap = _gitCache.ReadRoutemap(dir, entry.RoutemapPath);
                    repoSnapshots.Add((entry, snap, null));
                    await WriteEvent("repo", new
                    {
                        appName = entry.AppName,
                        repoUrl = entry.RepoUrl,
                        branch = entry.Branch,
                        status = snap.Missing == null ? "ok" : "missing",
                        message = snap.Missing,
                        files = snap.Entries.Take(50).Select(e => e.Path).ToList(),
                        fileCount = snap.Entries.Count,
                    });
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[ProjectRouteAgent] clone failed: {Repo}@{Branch}", entry.RepoUrl, entry.Branch);
                    repoSnapshots.Add((entry, null, ex.Message));
                    await WriteEvent("repo", new
                    {
                        appName = entry.AppName,
                        repoUrl = entry.RepoUrl,
                        branch = entry.Branch,
                        status = "error",
                        message = ex.Message,
                    });
                }
            }

            // ===== 阶段 3：LLM 匹配 routemap 项目路径 =====
            await WriteEvent("phase", new { code = "matching", label = "AI 把应用/模块映射到 routemap 项目路径", message = "AI 把应用/模块映射到 routemap 项目路径" });

            var (resolutions, matchModel, matchPlatform) = await ResolveRoutemapAsync(plan, repoSnapshots, userId);

            if (!string.IsNullOrEmpty(matchModel) && string.IsNullOrEmpty(plan.Model))
            {
                plan.Model = matchModel;
                plan.ModelPlatform = matchPlatform;
            }
            if (!string.IsNullOrEmpty(matchModel))
                await WriteEvent("model", new { model = matchModel, platform = matchPlatform });

            plan.Resolutions = resolutions;
            plan.Status = ProjectRoutePlanStatuses.Done;
            plan.CompletedAt = DateTime.UtcNow;

            await WriteEvent("phase", new { code = "saving", label = "保存解析结果", message = "保存解析结果" });
            await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);

            await WriteEvent("result", new { resolutions });
            await WriteEvent("done", new { planId = plan.Id, model = plan.Model, platform = plan.ModelPlatform });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ProjectRouteAgent] analyze failed: {PlanId}", plan.Id);
            plan.Status = ProjectRoutePlanStatuses.Error;
            plan.ErrorMessage = ex.Message;
            plan.CompletedAt = DateTime.UtcNow;
            await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);
            await WriteEvent("error", new { message = ex.Message });
        }
    }

    // ──────────────────────────────────────────────────────────────
    // LLM 内部逻辑
    // ──────────────────────────────────────────────────────────────

    private async Task<(List<string> apps, List<string> modules, string? model, string? platform)>
        ExtractAppsAsync(ProjectRoutePlan plan, string userId)
    {
        const int maxPlanChars = 12_000;
        var planContent = plan.ExtractedContent ?? string.Empty;
        if (planContent.Length > maxPlanChars)
            planContent = planContent[..maxPlanChars] + "\n…(已截断)";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: planContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: "project-route-agent.extract.apps",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.ProjectRouteAgent.Extract.Apps));

        var systemPrompt =
            "你是「项目路由智能体」的方案分析助手。给你一份产品/技术方案的 Markdown 全文。\n" +
            "请你提炼方案中明确提到或强烈暗示的：\n" +
            "1. 应用（app / 系统 / 智能体 / 产品线 / 子系统），如「PRD 智能体」「视觉创作」「视频生成」\n" +
            "2. 业务模块（feature / page / module），如「方案上传」「缺陷申诉」「周报海报」\n\n" +
            "严格只输出 **一个** JSON 对象，UTF-8，禁止 markdown 代码围栏，禁止解释：\n" +
            "{\n" +
            "  \"apps\": [\"...\"],       // 涉及的应用名（去重，3~10 项内）\n" +
            "  \"modules\": [\"...\"]     // 涉及的业务模块名（去重，3~15 项内）\n" +
            "}";

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = $"方案标题：{plan.Title}\n\n方案正文：\n{planContent}" },
            },
            ["temperature"] = 0.2,
            ["max_tokens"] = 800,
        };

        var resp = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectRouteAgent.Extract.Apps,
            ModelType = "chat",
            RequestBody = body,
            TimeoutSeconds = 120,
        }, CancellationToken.None);

        var model = string.IsNullOrEmpty(resp.Resolution?.ActualModel) ? null : resp.Resolution!.ActualModel;
        var platform = resp.Resolution?.ActualPlatformName;

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
            throw new InvalidOperationException($"应用/模块抽取失败：{resp.ErrorMessage ?? "模型未返回内容"}");

        var apps = new List<string>();
        var modules = new List<string>();
        try
        {
            var parsed = JsonNode.Parse(StripCodeFence(resp.Content!));
            if (parsed is JsonObject obj)
            {
                if (obj.TryGetPropertyValue("apps", out var aNode) && aNode is JsonArray arrA)
                    apps = arrA.Where(n => n != null).Select(n => n!.ToString().Trim()).Where(s => s.Length > 0).Distinct().ToList();
                if (obj.TryGetPropertyValue("modules", out var mNode) && mNode is JsonArray arrM)
                    modules = arrM.Where(n => n != null).Select(n => n!.ToString().Trim()).Where(s => s.Length > 0).Distinct().ToList();
            }
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"LLM 抽取结果不是合法 JSON：{ex.Message}");
        }

        if (apps.Count == 0 && modules.Count == 0)
            throw new InvalidOperationException("AI 未能从方案中识别出任何应用或业务模块");

        return (apps, modules, model, platform);
    }

    private async Task<(List<ProjectRouteResolution> resolutions, string? model, string? platform)>
        ResolveRoutemapAsync(
            ProjectRoutePlan plan,
            IReadOnlyList<(ProjectRouteRepoEntry Entry, RoutemapSnapshot? Snap, string? ErrorMessage)> snapshots,
            string userId)
    {
        var repoBlocks = new StringBuilder();
        foreach (var (entry, snap, err) in snapshots)
        {
            repoBlocks.AppendLine("---");
            repoBlocks.AppendLine($"AppName: {entry.AppName}");
            repoBlocks.AppendLine($"Aliases: {string.Join(", ", entry.Aliases)}");
            repoBlocks.AppendLine($"RepoUrl: {entry.RepoUrl}");
            repoBlocks.AppendLine($"Branch: {entry.Branch}");
            repoBlocks.AppendLine($"RoutemapPath: {entry.RoutemapPath}");
            if (!string.IsNullOrEmpty(entry.Notes))
                repoBlocks.AppendLine($"Notes: {entry.Notes}");
            if (err != null)
            {
                repoBlocks.AppendLine($"[ERROR] {err}");
                continue;
            }
            if (snap == null || !string.IsNullOrEmpty(snap.Missing))
            {
                repoBlocks.AppendLine($"[NO ROUTEMAP] {snap?.Missing}");
                continue;
            }
            repoBlocks.AppendLine($"RoutemapFiles ({snap.Entries.Count}):");
            foreach (var e in snap.Entries.Take(120))
            {
                repoBlocks.AppendLine($"  - {e.Path} ({e.SizeBytes} bytes)");
                if (!string.IsNullOrWhiteSpace(e.ContentPreview))
                {
                    var preview = e.ContentPreview.Length > 600 ? e.ContentPreview[..600] + "…" : e.ContentPreview;
                    foreach (var line in preview.Split('\n').Take(20))
                        repoBlocks.AppendLine("      | " + line.TrimEnd());
                }
            }
        }

        var systemPrompt =
            "你是「项目路由智能体」的路径匹配助手。任务：把方案涉及的应用 / 业务模块映射到具体的 routemap 项目路径。\n" +
            "你将收到：\n" +
            " - 方案涉及的 apps[] 和 modules[]（已由上一步 AI 抽取）\n" +
            " - 公共站点说明 markdown（全局背景）\n" +
            " - 每个已登记仓库 + 其 routemap/ 目录下的文件清单（可能含部分内容预览）\n\n" +
            "请输出严格 JSON（**一个对象**，UTF-8，禁止 markdown 代码围栏，禁止解释）：\n" +
            "{\n" +
            "  \"resolutions\": [\n" +
            "    {\n" +
            "      \"appOrModule\": \"用户方案里的某个应用/模块原话\",\n" +
            "      \"repoUrl\": \"命中的仓库 url（来自上面登记表，找不到为空字符串）\",\n" +
            "      \"repoAppName\": \"命中的仓库 AppName\",\n" +
            "      \"projectPaths\": [\"routemap 下的相对路径，最多 5 个\"],\n" +
            "      \"reasoning\": \"中文简述命中依据（≤80 字）\",\n" +
            "      \"status\": \"Hit | NotFound | Ambiguous\"\n" +
            "    }\n" +
            "  ]\n" +
            "}\n\n" +
            "规则：\n" +
            "- 给方案里每个 app 和 module 都生成一条 resolution（去重后）\n" +
            "- projectPaths 只能引用上面给出的 RoutemapFiles 里真实存在的相对路径\n" +
            "- 找不到就 status=NotFound、projectPaths=[]、reasoning 说明原因\n" +
            "- 多个候选无法确定唯一时 status=Ambiguous，projectPaths 列出全部候选\n" +
            "- 不要瞎编路径，不要返回登记表外的 repoUrl";

        var userBlock = new StringBuilder();
        userBlock.AppendLine($"方案标题：{plan.Title}");
        userBlock.AppendLine();
        userBlock.AppendLine("方案抽取出的应用：");
        foreach (var a in plan.ExtractedApps) userBlock.AppendLine("- " + a);
        userBlock.AppendLine();
        userBlock.AppendLine("方案抽取出的业务模块：");
        foreach (var m in plan.ExtractedModules) userBlock.AppendLine("- " + m);

        userBlock.AppendLine();
        userBlock.AppendLine("===== 公共站点说明（节选）=====");
        // 截断到 4000 字符
        // 此处不引用未配置的快照字段
        ProjectRouteSiteSpec? activeSiteSpec = null;
        if (!string.IsNullOrEmpty(plan.SiteSpecId))
        {
            activeSiteSpec = await _db.ProjectRouteSiteSpecs.Find(x => x.Id == plan.SiteSpecId).FirstOrDefaultAsync(CancellationToken.None);
        }
        var siteMd = activeSiteSpec?.MarkdownContent ?? string.Empty;
        if (siteMd.Length > 4000) siteMd = siteMd[..4000] + "\n…(已截断)";
        userBlock.AppendLine(siteMd);

        userBlock.AppendLine();
        userBlock.AppendLine("===== 仓库登记 + routemap 文件清单 =====");
        userBlock.Append(repoBlocks);

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userBlock.Length,
            DocumentHash: null,
            SystemPromptRedacted: "project-route-agent.resolve.routemap",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.ProjectRouteAgent.Resolve.RoutemapMatch));

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userBlock.ToString() },
            },
            ["temperature"] = 0.15,
            ["max_tokens"] = 4000,
        };

        var resp = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectRouteAgent.Resolve.RoutemapMatch,
            ModelType = "chat",
            RequestBody = body,
            TimeoutSeconds = 180,
        }, CancellationToken.None);

        var model = string.IsNullOrEmpty(resp.Resolution?.ActualModel) ? null : resp.Resolution!.ActualModel;
        var platform = resp.Resolution?.ActualPlatformName;

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
            throw new InvalidOperationException($"routemap 匹配失败：{resp.ErrorMessage ?? "模型未返回内容"}");

        var resolutions = ParseResolutions(resp.Content!, snapshots);
        return (resolutions, model, platform);
    }

    private static List<ProjectRouteResolution> ParseResolutions(
        string content,
        IReadOnlyList<(ProjectRouteRepoEntry Entry, RoutemapSnapshot? Snap, string? ErrorMessage)> snapshots)
    {
        var list = new List<ProjectRouteResolution>();
        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(StripCodeFence(content));
        }
        catch
        {
            return list;
        }
        if (parsed is not JsonObject obj) return list;
        if (!obj.TryGetPropertyValue("resolutions", out var arrNode) || arrNode is not JsonArray arr) return list;

        var entryByUrl = snapshots.ToDictionary(s => s.Entry.RepoUrl, s => s.Entry, StringComparer.OrdinalIgnoreCase);

        foreach (var node in arr)
        {
            if (node is not JsonObject o) continue;
            var item = new ProjectRouteResolution
            {
                AppOrModule = o["appOrModule"]?.GetValue<string>()?.Trim() ?? string.Empty,
                RepoUrl = o["repoUrl"]?.GetValue<string>()?.Trim(),
                RepoAppName = o["repoAppName"]?.GetValue<string>()?.Trim(),
                Reasoning = o["reasoning"]?.GetValue<string>()?.Trim(),
                Status = NormalizeStatus(o["status"]?.GetValue<string>()),
            };
            if (o["projectPaths"] is JsonArray pp)
            {
                item.ProjectPaths = pp.Where(p => p != null)
                    .Select(p => p!.ToString().Trim())
                    .Where(p => p.Length > 0)
                    .Distinct()
                    .ToList();
            }
            // 反查 AppName 兜底
            if (!string.IsNullOrEmpty(item.RepoUrl)
                && string.IsNullOrEmpty(item.RepoAppName)
                && entryByUrl.TryGetValue(item.RepoUrl, out var entry))
            {
                item.RepoAppName = entry.AppName;
            }
            if (string.IsNullOrEmpty(item.AppOrModule)) continue;
            list.Add(item);
        }
        return list;
    }

    private static string NormalizeStatus(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return ProjectRouteResolutionStatuses.Hit;
        return raw.Trim().ToLowerInvariant() switch
        {
            "notfound" or "not-found" or "not_found" or "miss" or "missing" => ProjectRouteResolutionStatuses.NotFound,
            "ambiguous" or "multi" or "multiple" => ProjectRouteResolutionStatuses.Ambiguous,
            _ => ProjectRouteResolutionStatuses.Hit,
        };
    }

    private static string StripCodeFence(string s)
    {
        var t = s.Trim();
        if (t.StartsWith("```"))
        {
            var firstNl = t.IndexOf('\n');
            if (firstNl > 0) t = t[(firstNl + 1)..];
            if (t.EndsWith("```")) t = t[..^3];
        }
        return t.Trim();
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };
}
