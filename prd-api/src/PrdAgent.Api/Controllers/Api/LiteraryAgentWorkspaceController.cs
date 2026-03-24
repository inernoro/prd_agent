using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
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

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public LiteraryAgentWorkspaceController(MongoDbContext db, IAssetStorage assetStorage, ILogger<LiteraryAgentWorkspaceController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
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

    private static string Sha256Hex(string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string ComputeContentHash(string? canvasHash, string? assetsHash)
    {
        var ch = (canvasHash ?? string.Empty).Trim();
        var ah = (assetsHash ?? string.Empty).Trim();
        return Sha256Hex($"{ch}|{ah}");
    }

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

        var update = Builders<ImageMasterWorkspace>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request?.Title != null) update = update.Set(x => x.Title, request.Title.Trim());
        if (request?.ArticleContent != null) update = update.Set(x => x.ArticleContent, request.ArticleContent);
        if (request?.ScenarioType != null) update = update.Set(x => x.ScenarioType, request.ScenarioType.Trim());
        if (request?.FolderName != null) update = update.Set(x => x.FolderName, request.FolderName.Trim());
        if (request?.MemberUserIds != null) update = update.Set(x => x.MemberUserIds, request.MemberUserIds.Select(x => x.Trim()).Where(x => x != adminId).Distinct().ToList());
        if (request?.CoverAssetId != null) update = update.Set(x => x.CoverAssetId, request.CoverAssetId.Trim());
        if (request?.SelectedPromptId != null)
        {
            var pid = request.SelectedPromptId.Trim();
            update = update.Set(x => x.SelectedPromptId, string.IsNullOrEmpty(pid) ? null : pid);
        }

        await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == ws.Id, update, cancellationToken: ct);
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

        await _db.ImageMasterWorkspaces.DeleteOneAsync(x => x.Id == ws.Id, ct);
        // Clean up related data
        await _db.ImageAssets.DeleteManyAsync(x => x.WorkspaceId == ws.Id, ct);
        await _db.ImageMasterMessages.DeleteManyAsync(x => x.WorkspaceId == ws.Id, ct);
        await _db.ImageMasterCanvases.DeleteManyAsync(x => x.WorkspaceId == ws.Id, ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

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

        // Update lastOpenedAt
        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == ws.Id,
            Builders<ImageMasterWorkspace>.Update.Set(x => x.LastOpenedAt, DateTime.UtcNow),
            cancellationToken: ct);

        var msgLimit = Math.Clamp(messageLimit ?? 100, 1, 500);
        var astLimit = Math.Clamp(assetLimit ?? 200, 1, 1000);

        var messages = await _db.ImageMasterMessages
            .Find(x => x.WorkspaceId == ws.Id)
            .SortByDescending(x => x.CreatedAt)
            .Limit(msgLimit)
            .ToListAsync(ct);

        // 文章配图场景：只返回当前版本的图片，隐藏重新生成的旧版本
        List<ImageAsset> assets;
        var currentAssetIds = ws.ArticleWorkflow?.AssetIdByMarkerIndex?.Values
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Distinct()
            .ToHashSet(StringComparer.Ordinal);

        if (ws.ScenarioType == "article-illustration" && currentAssetIds != null && currentAssetIds.Count > 0)
        {
            assets = await _db.ImageAssets
                .Find(x => x.WorkspaceId == ws.Id && currentAssetIds.Contains(x.Id))
                .SortBy(x => x.ArticleInsertionIndex)
                .ThenBy(x => x.CreatedAt)
                .ToListAsync(ct);
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

        return Ok(ApiResponse<object>.Ok(new
        {
            workspace = ws,
            messages = messages.OrderBy(x => x.CreatedAt).ToList(),
            assets,
            canvas,
            viewport
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
                await _db.ImageMasterWorkspaces.UpdateOneAsync(
                    x => x.Id == ws.Id,
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
                else if (run.Status == ImageGenRunStatus.Running || run.Status == ImageGenRunStatus.Queued)
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
                await _db.ImageMasterWorkspaces.UpdateOneAsync(
                    x => x.Id == ws.Id,
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
            if (ws.ScenarioType != "article-illustration") return;

            var hasMapping = wf.AssetIdByMarkerIndex?.Values.Any(v => !string.IsNullOrWhiteSpace(v)) ?? false;
            if (hasMapping) return;
            if (assets.Count == 0) return;
            if (!wf.Markers.Any(m => string.IsNullOrEmpty(m.Status) || m.Status == "idle")) return;

            // 取最新 N 个 assets（按创建时间倒序已在查询中完成），然后反转为正序
            var markerCount = wf.Markers.Count;
            var candidateAssets = assets
                .OrderByDescending(a => a.CreatedAt)
                .Take(markerCount)
                .OrderBy(a => a.CreatedAt)
                .ToList();

            if (candidateAssets.Count == 0) return;

            wf.AssetIdByMarkerIndex ??= new Dictionary<string, string>(StringComparer.Ordinal);
            var needUpdate = false;

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

                await _db.ImageMasterWorkspaces.UpdateOneAsync(
                    x => x.Id == ws.Id,
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
        if (asset.OriginalMarkerText != null && asset.OriginalMarkerText.Length > 200) asset.OriginalMarkerText = asset.OriginalMarkerText[..200].Trim();
        if (request?.Width is > 0 and < 20000) asset.Width = request.Width!.Value;
        if (request?.Height is > 0 and < 20000) asset.Height = request.Height!.Value;

        // Dedup: remove previous asset at same insertion index
        if (asset.ArticleInsertionIndex.HasValue)
        {
            await _db.ImageAssets.DeleteManyAsync(
                Builders<ImageAsset>.Filter.And(
                    Builders<ImageAsset>.Filter.Eq(x => x.WorkspaceId, ws.Id),
                    Builders<ImageAsset>.Filter.Eq(x => x.ArticleInsertionIndex, asset.ArticleInsertionIndex),
                    Builders<ImageAsset>.Filter.Ne(x => x.Id, asset.Id)
                ), ct);
        }

        await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: ct);

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
