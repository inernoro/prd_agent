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

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public LiteraryAgentWorkspaceController(MongoDbContext db, IAssetStorage assetStorage)
    {
        _db = db;
        _assetStorage = assetStorage;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

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
                folderName = ws.FolderName
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
        await _db.ImageMasterCanvasObjects.DeleteManyAsync(x => x.SessionId == ws.Id, ct);

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

        var assets = await _db.ImageAssets
            .Find(x => x.WorkspaceId == ws.Id)
            .SortByDescending(x => x.CreatedAt)
            .Limit(astLimit)
            .ToListAsync(ct);

        var canvas = await _db.ImageMasterCanvasObjects
            .Find(x => x.SessionId == ws.Id)
            .FirstOrDefaultAsync(ct);

        var viewport = ws.ViewportByUserId != null && ws.ViewportByUserId.TryGetValue(adminId, out var vp)
            ? vp
            : null;

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
