using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 文学创作 Agent - 工作区管理
/// 为文学创作提供独立的工作区 CRUD 端点，避免跨权限调用 visual-agent 端点。
/// 底层与 visual-agent 共享同一 DB 集合（image_master_workspaces），通过 Controller 层隔离身份。
/// </summary>
[ApiController]
[Route("api/literary-agent/workspaces")]
[Authorize]
[AdminController("literary-agent", AdminPermissionCatalog.LiteraryAgentUse)]
public class LiteraryAgentWorkspaceController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<LiteraryAgentWorkspaceController> _logger;
    private readonly Services.ImageMasterWorkspaceDeletionService _workspaceDeletion;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public LiteraryAgentWorkspaceController(MongoDbContext db, IAssetStorage assetStorage, ILogger<LiteraryAgentWorkspaceController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
        _workspaceDeletion = new Services.ImageMasterWorkspaceDeletionService(db, assetStorage, logger);
    }

    private string GetAdminId()
    {
        var id = User.FindFirst("sub")?.Value
            ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrWhiteSpace(id))
            throw new UnauthorizedAccessException("Missing user identity claims");
        return id;
    }

    private async Task<ImageMasterWorkspace?> GetWorkspaceIfAllowedAsync(string workspaceId, string adminId, CancellationToken ct)
    {
        var wid = (workspaceId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return null;
        var ws = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
        if (ws == null) return null;
        if (ws.OwnerUserId == adminId) return ws;
        if (ws.MemberUserIds != null && ws.MemberUserIds.Contains(adminId)) return ws;
        return new ImageMasterWorkspace { Id = ws.Id, OwnerUserId = "__FORBIDDEN__" };
    }

    // 指纹计算搬到 Services.LiteraryWorkspaceHash：开放接口那边建工作区要用同一份判据
    private static string Sha256Hex(string s) => Services.LiteraryWorkspaceHash.Sha256Hex(s);

    private static string ComputeContentHash(string? canvasHash, string? assetsHash)
        => Services.LiteraryWorkspaceHash.ComputeContentHash(canvasHash, assetsHash);

    /// <summary>
    /// 列出当前用户的工作区（文学创作场景）
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> ListWorkspaces([FromQuery] int limit = 50, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        limit = Math.Clamp(limit, 1, 100);
        var filter = Builders<ImageMasterWorkspace>.Filter.Or(
            Builders<ImageMasterWorkspace>.Filter.Eq(x => x.OwnerUserId, adminId),
            Builders<ImageMasterWorkspace>.Filter.AnyEq(x => x.MemberUserIds, adminId)
        );
        var items = await _db.ImageMasterWorkspaces
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        // Hydrate cover assets
        var coverIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ws in items)
        {
            var single = (ws.CoverAssetId ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(single)) coverIds.Add(single);
            if (ws.CoverAssetIds != null)
                foreach (var cid in ws.CoverAssetIds)
                {
                    var s = (cid ?? string.Empty).Trim();
                    if (!string.IsNullOrWhiteSpace(s)) coverIds.Add(s);
                }
        }

        var coverMap = new Dictionary<string, ImageAsset>(StringComparer.Ordinal);
        if (coverIds.Count > 0)
        {
            var covers = await _db.ImageAssets.Find(x => x.WorkspaceId != null && coverIds.Contains(x.Id)).ToListAsync(ct);
            foreach (var a in covers)
                if (!string.IsNullOrWhiteSpace(a.Id)) coverMap[a.Id] = a;
        }

        // Batch query: latest illustration per workspace (for card covers)
        var wsIds = items.Select(w => w.Id).ToList();
        var latestIllustrationMap = new Dictionary<string, ImageAsset>(StringComparer.Ordinal);
        if (wsIds.Count > 0)
        {
            var allAssets = await _db.ImageAssets
                .Find(x => x.WorkspaceId != null && wsIds.Contains(x.WorkspaceId))
                .SortByDescending(x => x.CreatedAt)
                .ToListAsync(ct);
            foreach (var a in allAssets)
            {
                if (a.WorkspaceId != null && !latestIllustrationMap.ContainsKey(a.WorkspaceId))
                    latestIllustrationMap[a.WorkspaceId] = a;
            }
        }

        var dto = items.Select(ws =>
        {
            var coverAssets = new List<object>();
            var coverIdsOrdered = (ws.CoverAssetIds ?? new List<string>())
                .Select(x => (x ?? string.Empty).Trim())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Take(6)
                .ToList();
            if (coverIdsOrdered.Count == 0)
            {
                var single = (ws.CoverAssetId ?? string.Empty).Trim();
                if (!string.IsNullOrWhiteSpace(single)) coverIdsOrdered.Add(single);
            }

            foreach (var cid in coverIdsOrdered)
                if (coverMap.TryGetValue(cid, out var a))
                    coverAssets.Add(new { id = a.Id, url = a.Url, width = a.Width, height = a.Height });

            var contentHash = (ws.ContentHash ?? string.Empty).Trim();
            var coverHash = (ws.CoverHash ?? string.Empty).Trim();
            var coverStale = !string.IsNullOrWhiteSpace(contentHash) && !string.Equals(contentHash, coverHash, StringComparison.Ordinal);

            // Latest illustration URL for card cover (newest generated image)
            var latestUrl = latestIllustrationMap.TryGetValue(ws.Id, out var latestAsset) ? latestAsset.Url : null;

            return new
            {
                id = ws.Id, ownerUserId = ws.OwnerUserId, title = ws.Title,
                scenarioType = ws.ScenarioType,
                memberUserIds = ws.MemberUserIds ?? new List<string>(),
                coverAssetId = ws.CoverAssetId,
                coverAssetIds = ws.CoverAssetIds ?? new List<string>(),
                coverAssets, canvasHash = ws.CanvasHash, assetsHash = ws.AssetsHash,
                contentHash = ws.ContentHash, coverHash = ws.CoverHash, coverStale,
                coverUpdatedAt = ws.CoverUpdatedAt,
                createdAt = ws.CreatedAt, updatedAt = ws.UpdatedAt, lastOpenedAt = ws.LastOpenedAt,
                articleContent = ws.ArticleContent,
                articleContentWithMarkers = ws.ArticleContentWithMarkers,
                articleWorkflow = ws.ArticleWorkflow,
                folderName = ws.FolderName,
                latestIllustrationUrl = latestUrl
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items = dto }));
    }

    /// <summary>
    /// 创建文学创作工作区
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateWorkspace([FromBody] CreateWorkspaceRequest? request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var title = (request?.Title ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(title)) title = "未命名";
        if (title.Length > 40) title = title[..40].Trim();

        var scenarioType = (request?.ScenarioType ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(scenarioType)) scenarioType = "article-illustration";

        var now = DateTime.UtcNow;
        var assetsHash = Guid.NewGuid().ToString("N");
        var canvasHash = string.Empty;
        var contentHash = ComputeContentHash(canvasHash, assetsHash);
        var ws = new ImageMasterWorkspace
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            Title = title,
            ScenarioType = scenarioType,
            MemberUserIds = new List<string>(),
            AssetsHash = assetsHash,
            CanvasHash = canvasHash,
            ContentHash = contentHash,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ImageMasterWorkspaces.InsertOneAsync(ws, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { workspace = ws }));
    }

    /// <summary>
    /// 更新工作区（标题、文章内容等）
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateWorkspace(string id, [FromBody] UpdateWorkspaceRequest? request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var ws = await GetWorkspaceIfAllowedAsync(id, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var now = DateTime.UtcNow;
        var update = Builders<ImageMasterWorkspace>.Update.Set(x => x.UpdatedAt, now);
        if (request?.Title != null) update = update.Set(x => x.Title, request.Title.Trim());
        if (request?.ScenarioType != null) update = update.Set(x => x.ScenarioType, request.ScenarioType.Trim());
        if (request?.FolderName != null) update = update.Set(x => x.FolderName, request.FolderName.Trim());
        if (request?.MemberUserIds != null) update = update.Set(x => x.MemberUserIds, request.MemberUserIds.Select(x => x.Trim()).Where(x => x != adminId).Distinct().ToList());
        if (request?.CoverAssetId != null) update = update.Set(x => x.CoverAssetId, request.CoverAssetId.Trim());
        if (request?.SelectedPromptId != null)
        {
            var pid = request.SelectedPromptId.Trim();
            update = update.Set(x => x.SelectedPromptId, string.IsNullOrEmpty(pid) ? null : pid);
        }

        // 正文真的换了 = 提交型修改：配图方案升一版、旧标记失效（旧图保留进历史）。
        // 页面一直按这个语义调用它（上传文章处的注释写着「会触发 version++，清空后续阶段」），
        // 但这个入口此前只改了正文——旧标记与带标记正文原样挂在新正文上。
        if (LiteraryIllustrationArchive.IsContentChange(ws, request?.ArticleContent))
        {
            var outcome = await LiteraryIllustrationArchive.WriteContentResetAsync(
                _db, ws, request!.ArticleContent!, update, LiteraryArchiveReason.WebContent, ct);
            if (outcome == LiteraryIllustrationArchive.ContentResetOutcome.WorkspaceGone)
                return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 在保存过程中被删除了"));
            if (outcome == LiteraryIllustrationArchive.ContentResetOutcome.KeptChanging)
                return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED", "这篇文章正被别处连续修改，正文没有保存，请刷新后再试。"));
        }
        else
        {
            if (request?.ArticleContent != null) update = update.Set(x => x.ArticleContent, request.ArticleContent);
            await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == ws.Id, update, cancellationToken: CancellationToken.None);
        }
        var updated = await _db.ImageMasterWorkspaces.Find(x => x.Id == ws.Id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { workspace = updated }));
    }

    /// <summary>
    /// 删除工作区
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteWorkspace(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var ws = await GetWorkspaceIfAllowedAsync(id, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        // Only owner can delete
        if (ws.OwnerUserId != adminId) return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有创建者可以删除"));

        var deletion = await _workspaceDeletion.DeleteAsync(ws.Id, CancellationToken.None);
        if (deletion.HasActiveGeneration)
        {
            return Conflict(ApiResponse<object>.Fail(
                ErrorCodes.WORKSPACE_GENERATION_ACTIVE,
                "该项目仍有图片正在生成，请先取消任务并等待状态结束后再删除"));
        }

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    public class IllustrationPrefsRequest
    {
        /// <summary>风格（参考图配置）ID 或名称；none = 不用参考图；null = 不改这一项。</summary>
        public string? Style { get; set; }
        /// <summary>水印配置 ID 或名称；none = 不打水印；null = 不改这一项。</summary>
        public string? Watermark { get; set; }
        /// <summary>true = 清除这篇文章的设定，之后跟随账号默认。</summary>
        public bool Clear { get; set; }
    }

    /// <summary>
    /// 设置 / 清除这篇文章记住的配图风格与水印。网页编辑页顶栏改选时调它：
    /// 有设定的文章改的是这篇文章，不再去动账号级的「当前启用」，智能体与网页读写同一份。
    /// </summary>
    [HttpPut("{id}/illustration-prefs")]
    public async Task<IActionResult> SetIllustrationPrefs(string id, [FromBody] IllustrationPrefsRequest? request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var ws = await GetWorkspaceIfAllowedAsync(id, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        if (ws.ScenarioType != "article-illustration")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只有文学创作的文章能设置配图风格与水印"));
        // 文章记住的是作者账号里的风格 / 水印 ID，协作者选的是自己账号里的，存进来作者那边查不到
        if (ws.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED,
                "这篇文章的配图风格与水印由作者设定；协作者生图按自己账号的风格与水印。"));

        // 不动 UpdatedAt：它是正文的版本令牌，改配图设定不该让智能体手里的令牌失效
        if (request?.Clear == true)
        {
            await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == ws.Id,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.IllustrationPrefs, (LiteraryIllustrationPrefs?)null), cancellationToken: CancellationToken.None);
        }
        else
        {
            string? styleId = null, watermarkId = null;
            if (!string.IsNullOrWhiteSpace(request?.Style))
            {
                var (style, error) = await LiteraryIllustrationChoices.ResolveStyleAsync(_db, adminId, request.Style, ct);
                if (error != null) return BadRequest(ApiResponse<object>.Fail("STYLE_NOT_FOUND", error));
                styleId = style!.StyleId;
            }
            if (!string.IsNullOrWhiteSpace(request?.Watermark))
            {
                var (watermark, error) = await LiteraryIllustrationChoices.ResolveWatermarkAsync(_db, adminId, request.Watermark, ct);
                if (error != null) return BadRequest(ApiResponse<object>.Fail("WATERMARK_NOT_FOUND", error));
                watermarkId = watermark!.WatermarkId;
            }
            // 只写这次改的那一项：两个标签页一个改风格、一个改水印，整份写回会让后到的把先到的那项改回去
            await LiteraryIllustrationChoices.RememberExplicitAsync(_db, ws.Id, ws.OwnerUserId, styleId, watermarkId, null);
        }
        var prefs = await _db.ImageMasterWorkspaces.Find(x => x.Id == ws.Id).Project(x => x.IllustrationPrefs).FirstOrDefaultAsync(CancellationToken.None);
        var effective = await LiteraryIllustrationChoices.ResolveForArticleAsync(_db, adminId, prefs, ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            illustrationPrefs = prefs,
            effective = ArticleChoiceView(prefs, effective),
        }));
    }

    /// <summary>
    /// 页面顶栏读的「本文风格 / 水印」。missing = 这篇记住过、但那套已被删除，本次按账号默认出图：
    /// 页面据此提示用户，而不是照旧写「本文自己的设定」让人带着回退的那套去花额度。
    /// 判据是状态（记住过 + 结果来源是账号默认），不去匹配 notes 里的文案。
    /// </summary>
    private static object ArticleChoiceView(
        LiteraryIllustrationPrefs? prefs,
        (LiteraryIllustrationChoices.StyleChoice style, string styleSource, LiteraryIllustrationChoices.WatermarkChoice watermark, string watermarkSource, List<string> notes) effective)
    {
        var styleMissing = !string.IsNullOrWhiteSpace(prefs?.StyleId) && effective.styleSource == "account-default";
        var watermarkMissing = !string.IsNullOrWhiteSpace(prefs?.WatermarkId) && effective.watermarkSource == "account-default";
        return new
        {
            style = new { styleId = effective.style.StyleId, name = effective.style.Label, source = effective.styleSource, missing = styleMissing },
            watermark = new { watermarkId = effective.watermark.WatermarkId, name = effective.watermark.Label, source = effective.watermarkSource, missing = watermarkMissing },
            notes = effective.notes,
        };
    }

    /// <summary>
    /// 这篇文章生成过的全部配图，按配图方案版本分组（当前版本在前）。
    ///
    /// 改稿、重新规划标记、同一位置重新生成都不会删除旧图——它们只是不再挂在正文上。
    /// 用户要回看「这篇文章所有的图」时就读这里；智能体（MCP）生成的图同样在内。
    /// </summary>
    [HttpGet("{id}/illustration-history")]
    public async Task<IActionResult> GetIllustrationHistory(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var ws = await GetWorkspaceIfAllowedAsync(id, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var assets = await LiteraryIllustrationHistory.LoadAssetsAsync(_db, ws.Id, ct);
        var history = LiteraryIllustrationHistory.Build(ws, assets);
        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            currentVersion = history.CurrentVersion,
            total = history.Total,
            currentCount = history.CurrentCount,
            // 当前有哪些标记位置可以把旧图放回去
            markerIndexes = ws.ArticleWorkflow?.Markers.Select(m => m.Index).OrderBy(i => i).ToList() ?? new List<int>(),
            groups = history.Groups,
            previousSets = history.PreviousSets,
        }));
    }

    public sealed class RestoreIllustrationRequest
    {
        /// <summary>放到哪个标记上；不填 = 这张图当初所在的位置</summary>
        public int? MarkerIndex { get; set; }
        /// <summary>页面打开历史配图时看到的配图方案版本（历史接口回的 currentVersion），必填</summary>
        public int? WorkflowVersion { get; set; }
    }

    /// <summary>
    /// 把历史里的一张旧图放回正文的某个配图位置（默认它当初的位置）。被换下的那张同样留在历史里。
    /// </summary>
    [HttpPost("{id}/illustration-history/{assetId}/restore")]
    public async Task<IActionResult> RestoreIllustration(string id, string assetId, [FromBody] RestoreIllustrationRequest? request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var ws = await GetWorkspaceIfAllowedAsync(id, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        // 版本取页面所见的那一版，不取此刻库里的：页面停留期间文章被改稿或重新规划过，
        // 同一个序号已经是另一段描述，按新版本放回就会把旧图挂到不相干的标记上。
        if (request?.WorkflowVersion is not { } seenVersion)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少页面所见的配图方案版本，请刷新历史配图后再放回。"));
        var asset = await _db.ImageAssets.Find(x => x.Id == assetId && x.WorkspaceId == ws.Id).FirstOrDefaultAsync(ct);
        var markerIndex = request.MarkerIndex ?? asset?.ArticleInsertionIndex ?? -1;
        var result = await LiteraryIllustrationHistory.RestoreAsync(_db, ws, assetId, markerIndex, seenVersion, ct);
        return RestoreResponse(result);
    }

    internal IActionResult RestoreResponse(LiteraryIllustrationHistory.RestoreResult result) => result.Failure switch
    {
        LiteraryIllustrationHistory.RestoreFailure.None => Ok(ApiResponse<object>.Ok(new
        {
            markerIndex = result.MarkerIndex, url = result.Url, description = result.Description, note = result.Message,
        })),
        LiteraryIllustrationHistory.RestoreFailure.AssetNotFound => NotFound(ApiResponse<object>.Fail("IMAGE_NOT_FOUND", result.Message!)),
        LiteraryIllustrationHistory.RestoreFailure.VersionChanged => Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED", result.Message!)),
        _ => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Message!)),
    };

    /// <summary>
    /// 获取工作区详情（包含消息、资源、画布等）
    /// </summary>
    [HttpGet("{id}/detail")]
    public async Task<IActionResult> GetWorkspaceDetail(
        string id,
        [FromQuery] int? messageLimit = null,
        [FromQuery] int? assetLimit = null,
        CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        var ws = await GetWorkspaceIfAllowedAsync(id, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        await Services.LiteraryWorkspacePublicationPolicy.ResolveSuppressAutoSubmitAsync(_db, ws, ct);

        // Update lastOpenedAt + 每用户「最近打开」台账（首页继续上次）
        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == ws.Id,
            Builders<ImageMasterWorkspace>.Update.Set(x => x.LastOpenedAt, DateTime.UtcNow),
            cancellationToken: ct);
        await RecentOpenTracker.TouchAsync(_db, adminId, "literary-agent", ws.Id);

        var msgLimit = Math.Clamp(messageLimit ?? 100, 1, 500);
        var astLimit = Math.Clamp(assetLimit ?? 200, 1, 1000);

        var messages = await _db.ImageMasterMessages
            .Find(x => x.WorkspaceId == ws.Id)
            .SortByDescending(x => x.CreatedAt)
            .Limit(msgLimit)
            .ToListAsync(ct);

        // 文章配图场景：只返回当前版本的图片，隐藏重新生成的旧版本
        List<ImageAsset> assets;
        if (LiteraryIllustrationHistory.ShowsCurrentOnly(ws))
        {
            assets = await LiteraryIllustrationHistory.LoadCurrentForDetailAsync(_db, ws, ct);
        }
        else
        {
            assets = await _db.ImageAssets
                .Find(x => x.WorkspaceId == ws.Id)
                .SortByDescending(x => x.CreatedAt)
                .Limit(astLimit)
                .ToListAsync(ct);
        }

        var canvas = await _db.ImageMasterCanvases
            .Find(x => x.WorkspaceId == ws.Id)
            .FirstOrDefaultAsync(ct);

        var viewport = ws.ViewportByUserId != null && ws.ViewportByUserId.TryGetValue(adminId, out var vp)
            ? vp
            : null;

        // 唤醒逻辑：自动修正卡住的 marker 状态（与 ImageMasterController 对齐）
        await TrySyncRunningMarkersAsync(ws, ct);

        // 兜底：旧数据中 markers 存在但 assetIdByMarkerIndex 为空，通过 prompt 文本匹配修复关联
        await TryBackfillMarkerAssetsAsync(ws, assets, ct);

        // 这篇文章自己的配图设定（智能体或网页为它指定过时才有）：页面顶栏据此显示「本文」的风格与水印
        object? illustrationChoice = null;
        // 只给作者本人：协作者生图不套文章设定（见 SetIllustrationPrefs），页面照旧显示并修改他自己账号的设定
        if (ws.IllustrationPrefs != null && ws.OwnerUserId == adminId)
        {
            var effective = await LiteraryIllustrationChoices.ResolveForArticleAsync(_db, adminId, ws.IllustrationPrefs, ct);
            illustrationChoice = ArticleChoiceView(ws.IllustrationPrefs, effective);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            workspace = ws,
            messages = messages.OrderBy(x => x.CreatedAt).ToList(),
            assets,
            canvas,
            viewport,
            illustrationChoice,
        }));
    }

    /// <summary>
    /// 唤醒逻辑：检测卡住的 marker 状态，自动修正。
    /// 后端是状态的唯一来源，当检测到不一致时自动修正。
    /// 场景：前端刷新时丢失 SSE 事件，或后端重启导致状态未同步。
    /// </summary>
    private async Task TrySyncRunningMarkersAsync(ImageMasterWorkspace ws, CancellationToken ct)
    {
        try
        {
            var wf = ws.ArticleWorkflow;
            if (wf?.Markers == null || wf.Markers.Count == 0) return;
            var snapshotAt = wf.UpdatedAt;

            var now = DateTime.UtcNow;
            var needUpdate = false;

            // 1. 检测 parsing 状态超时（超过 5 分钟认为卡住）
            foreach (var marker in wf.Markers.Where(m => m.Status == "parsing"))
            {
                var markerTime = marker.UpdatedAt ?? wf.UpdatedAt;
                if (now - markerTime > TimeSpan.FromMinutes(5))
                {
                    marker.Status = "error";
                    marker.ErrorMessage = "意图解析超时，请重试";
                    marker.UpdatedAt = now;
                    needUpdate = true;
                    _logger.LogInformation(
                        "Auto-corrected stuck parsing marker: workspace={WorkspaceId}, index={Index}",
                        ws.Id, marker.Index);
                }
            }

            // 2. 检测 running 状态的 marker，同步 run 的真实状态
            var runningMarkers = wf.Markers
                .Where(m => m.Status == "running" && !string.IsNullOrEmpty(m.RunId))
                .ToList();

            if (runningMarkers.Count == 0 && !needUpdate) return;

            if (runningMarkers.Count == 0)
            {
                wf.UpdatedAt = now;
                await _db.ImageMasterWorkspaces.UpdateOneAsync(
                    x => x.Id == ws.Id && x.ArticleWorkflow!.Version == wf.Version
                        && x.ArticleWorkflow.UpdatedAt == snapshotAt,
                    Builders<ImageMasterWorkspace>.Update
                        .Set(x => x.ArticleWorkflow, wf)
                        .Set(x => x.UpdatedAt, now),
                    cancellationToken: ct);
                return;
            }

            // 批量查询这些 run 的状态
            var runIds = runningMarkers.Select(m => m.RunId!).Distinct().ToList();
            var runs = await _db.ImageGenRuns
                .Find(r => runIds.Contains(r.Id))
                .ToListAsync(ct);
            var runById = runs.ToDictionary(r => r.Id);

            foreach (var marker in runningMarkers)
            {
                if (!runById.TryGetValue(marker.RunId!, out var run)) continue;

                if (run.Status == ImageGenRunStatus.Completed)
                {
                    var item = await _db.ImageGenRunItems
                        .Find(i => i.RunId == run.Id && i.Status == ImageGenRunItemStatus.Done)
                        .FirstOrDefaultAsync(ct);

                    marker.Status = "done";
                    marker.Url = item?.Url ?? marker.Url;
                    marker.ErrorMessage = null;
                    marker.UpdatedAt = now;
                    needUpdate = true;
                }
                else if (run.Status == ImageGenRunStatus.Failed || run.Status == ImageGenRunStatus.Cancelled)
                {
                    var item = await _db.ImageGenRunItems
                        .Find(i => i.RunId == run.Id)
                        .FirstOrDefaultAsync(ct);

                    marker.Status = "error";
                    marker.ErrorMessage = item?.ErrorMessage ?? (run.Status == ImageGenRunStatus.Cancelled ? "任务已取消" : "生图失败");
                    marker.UpdatedAt = now;
                    needUpdate = true;
                }
                else if (run.Status == ImageGenRunStatus.Running
                         || run.Status == ImageGenRunStatus.Queued
                         || run.Status == ImageGenRunStatus.ScopedQueued)
                {
                    if (now - run.CreatedAt > TimeSpan.FromMinutes(10))
                    {
                        marker.Status = "error";
                        marker.ErrorMessage = "生图任务超时，请重试";
                        marker.UpdatedAt = now;
                        needUpdate = true;
                    }
                }
            }

            if (needUpdate)
            {
                wf.UpdatedAt = now;
                await _db.ImageMasterWorkspaces.UpdateOneAsync(
                    x => x.Id == ws.Id && x.ArticleWorkflow!.Version == wf.Version
                        && x.ArticleWorkflow.UpdatedAt == snapshotAt,
                    Builders<ImageMasterWorkspace>.Update
                        .Set(x => x.ArticleWorkflow, wf)
                        .Set(x => x.UpdatedAt, now),
                    cancellationToken: ct);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "TrySyncRunningMarkersAsync failed for workspace {WorkspaceId}", ws.Id);
        }
    }

    /// <summary>
    /// 兜底回填：旧数据中 markers 已存在但 assetIdByMarkerIndex 为空时，
    /// 取最新 N 个 assets（N=marker 数量）按创建时间正序与 markers 按 index 顺序匹配。
    /// 旧版本生图后 prompt 经 LLM 重写，与 marker text 无直接文本关系，故只能按时间顺序。
    /// 仅 article-illustration 场景 + assetIdByMarkerIndex 完全为空时触发（一次性回填）。
    /// </summary>
    private async Task TryBackfillMarkerAssetsAsync(ImageMasterWorkspace ws, List<ImageAsset> assets, CancellationToken ct)
    {
        try
        {
            var wf = ws.ArticleWorkflow;
            if (wf?.Markers == null || wf.Markers.Count == 0) return;
            var snapshotAt = wf.UpdatedAt;
            if (ws.ScenarioType != "article-illustration") return;

            var recovered = PrdAgent.Core.Services.LiteraryMcpWorkflow.RecoverVersionedAssets(ws, assets);
            var hasMapping = wf.AssetIdByMarkerIndex?.Values.Any(v => !string.IsNullOrWhiteSpace(v)) ?? false;
            if (hasMapping && !recovered) return;
            if (assets.Count == 0) return;
            if (!recovered && !wf.Markers.Any(m => string.IsNullOrEmpty(m.Status) || m.Status == "idle")) return;

            // 取最新 N 个 assets（按创建时间倒序已在查询中完成），然后反转为正序
            var markerCount = wf.Markers.Count;
            var candidateAssets = assets
                .Where(a => !hasMapping && !a.ArticleWorkflowVersion.HasValue)
                .OrderByDescending(a => a.CreatedAt)
                .Take(markerCount)
                .OrderBy(a => a.CreatedAt)
                .ToList();

            if (candidateAssets.Count == 0 && !recovered) return;

            wf.AssetIdByMarkerIndex ??= new Dictionary<string, string>(StringComparer.Ordinal);
            var needUpdate = recovered;

            for (var i = 0; i < Math.Min(wf.Markers.Count, candidateAssets.Count); i++)
            {
                var marker = wf.Markers[i];
                var asset = candidateAssets[i];

                wf.AssetIdByMarkerIndex[marker.Index.ToString()] = asset.Id;
                marker.Status = "done";
                marker.AssetId = asset.Id;
                marker.Url = asset.Url;
                marker.ErrorMessage = null;
                marker.UpdatedAt = DateTime.UtcNow;
                needUpdate = true;
            }

            if (needUpdate)
            {
                wf.DoneImageCount = wf.AssetIdByMarkerIndex.Values
                    .Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count();
                wf.UpdatedAt = DateTime.UtcNow;

                await _db.ImageMasterWorkspaces.UpdateOneAsync(
                    x => x.Id == ws.Id && x.ArticleWorkflow!.Version == wf.Version
                        && x.ArticleWorkflow.UpdatedAt == snapshotAt,
                    Builders<ImageMasterWorkspace>.Update
                        .Set(x => x.ArticleWorkflow, wf)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);

                _logger.LogInformation(
                    "Backfilled {Count} marker-asset associations for workspace {WorkspaceId}",
                    wf.AssetIdByMarkerIndex.Count, ws.Id);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "TryBackfillMarkerAssetsAsync failed for workspace {WorkspaceId}", ws.Id);
        }
    }

    /// <summary>
    /// 上传工作区资源（JSON base64 格式，兼容 visual-agent 上传接口）
    /// </summary>
    [HttpPost("{id}/assets")]
    [RequestSizeLimit(16 * 1024 * 1024)]
    public async Task<IActionResult> UploadWorkspaceAsset(string id, [FromBody] UploadAssetRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var ws = await GetWorkspaceIfAllowedAsync(id, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var raw = (request?.Data ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "data 不能为空"));

        // 解码 data URL 或纯 base64
        byte[] bytes;
        string mime;
        if (raw.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var semiIdx = raw.IndexOf(';');
            var commaIdx = raw.IndexOf(',');
            if (semiIdx < 0 || commaIdx < 0 || commaIdx <= semiIdx)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "data URL 格式无效"));
            mime = raw[5..semiIdx];
            bytes = Convert.FromBase64String(raw[(commaIdx + 1)..]);
        }
        else
        {
            mime = "image/png";
            bytes = Convert.FromBase64String(raw);
        }

        if (bytes.LongLength > 15 * 1024 * 1024)
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "图片过大（上限 15MB）"));
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片"));

        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: "literary-agent", type: "img");

        var asset = new ImageAsset
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            WorkspaceId = ws.Id,
            Sha256 = stored.Sha256,
            Mime = stored.Mime,
            SizeBytes = stored.SizeBytes,
            Url = stored.Url,
            Prompt = (request?.Prompt ?? string.Empty).Trim(),
            CreatedAt = DateTime.UtcNow,
            ArticleInsertionIndex = request?.ArticleInsertionIndex,
            OriginalMarkerText = string.IsNullOrWhiteSpace(request?.OriginalMarkerText) ? null : request!.OriginalMarkerText!.Trim(),
        };
        if (asset.Prompt != null && asset.Prompt.Length > 300) asset.Prompt = asset.Prompt[..300].Trim();
        asset.OriginalMarkerText = PrdAgent.Core.Services.LiteraryMcpWorkflow.ClampOriginalMarkerText(asset.OriginalMarkerText);
        if (request?.Width is > 0 and < 20000) asset.Width = request.Width!.Value;
        if (request?.Height is > 0 and < 20000) asset.Height = request.Height!.Value;

        // 同一位置的旧图不再删除（用户要能在「历史配图」里找回）；新图盖当前版本号并挂上指针，
        // 「当前挂哪张」由指针 + 版本判定，不再靠「同位置只留一张」来保证。
        if (asset.ArticleInsertionIndex.HasValue && ws.ArticleWorkflow != null)
        {
            await LiteraryIllustrationArchive.StampUnversionedAsync(_db, ws.Id, ws.ArticleWorkflow.Version);
            asset.ArticleWorkflowVersion = ws.ArticleWorkflow.Version;
        }

        await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: ct);
        // 挂不上 = 存图期间配图方案换了版本（改稿或重新规划）。图已作为上一版的图留在历史里，
        // 但不能报成功：页面会把新方案里同序号的标记当成已完成，而那里其实没有挂任何图。
        if (asset.ArticleInsertionIndex.HasValue && ws.ArticleWorkflow != null
            && !await LiteraryMarkerWrites.PointMarkerAsync(_db, ws.Id, ws.ArticleWorkflow.Version, asset.ArticleInsertionIndex.Value, asset.Id))
            return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED",
                "保存图片期间这篇文章的配图方案已更新，这张图没有挂到正文上（已留在历史配图里）。请刷新后重试。"));

        // Update assetsHash
        var newAssetsHash = Guid.NewGuid().ToString("N");
        var newContentHash = ComputeContentHash(ws.CanvasHash, newAssetsHash);
        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == ws.Id,
            Builders<ImageMasterWorkspace>.Update
                .Set(x => x.AssetsHash, newAssetsHash)
                .Set(x => x.ContentHash, newContentHash)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { asset }));
    }
}
