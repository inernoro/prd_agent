using System.Net;
using System.Security.Cryptography;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using MongoDB.Driver.Core.Servers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Services.VisualAgent;
using PrdAgent.Api.Models.Requests;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/visual-agent/image-master")]
[Authorize]
[AdminController("visual-agent", AdminPermissionCatalog.VisualAgentUse)]
public class ImageMasterController : ControllerBase
{
    /// <summary>
    /// 视觉创作 Agent 的应用标识（用于水印等功能的隔离）
    /// </summary>
    private const string AppKey = "visual-agent";

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ICacheManager _cache;
    private readonly ILogger<ImageMasterController> _logger;
    private readonly IModelDomainService _modelDomain;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IImageDescriptionService _imageDescriptionService;

    private static readonly TimeSpan IdemExpiry = TimeSpan.FromMinutes(30);
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

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

    public ImageMasterController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        IHttpClientFactory httpClientFactory,
        ICacheManager cache,
        ILogger<ImageMasterController> logger,
        IModelDomainService modelDomain,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IImageDescriptionService imageDescriptionService)
    {
        _db = db;
        _assetStorage = assetStorage;
        _httpClientFactory = httpClientFactory;
        _cache = cache;
        _logger = logger;
        _modelDomain = modelDomain;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _imageDescriptionService = imageDescriptionService;
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

    private static List<string> NormalizeMemberIds(IEnumerable<string>? raw, string ownerId)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        if (raw != null)
        {
            foreach (var x in raw)
            {
                var s = (x ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(s)) continue;
                if (s == ownerId) continue;
                set.Add(s);
            }
        }
        return set.ToList();
    }

    private async Task<(bool ok, string? message)> ValidateAdminUsersAsync(IEnumerable<string> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        if (ids.Count == 0) return (true, null);
        var users = await _db.Users.Find(x => ids.Contains(x.UserId)).ToListAsync(ct);
        var found = users.Select(x => x.UserId).ToHashSet();
        var missing = ids.Where(x => !found.Contains(x)).ToList();
        if (missing.Count > 0) return (false, $"成员不存在：{string.Join(",", missing.Take(5))}");
        var nonAdmin = users.Where(x => x.Role != UserRole.ADMIN).Select(x => x.UserId).ToList();
        if (nonAdmin.Count > 0) return (false, $"成员不是 ADMIN：{string.Join(",", nonAdmin.Take(5))}");
        return (true, null);
    }

    [HttpPost("sessions")]
    public async Task<IActionResult> CreateSession([FromBody] CreateSessionRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:sessions:create:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        var title = (request?.Title ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(title)) title = "高级视觉创作";
        if (title.Length > 40) title = title[..40].Trim();

        var now = DateTime.UtcNow;
        var s = new ImageMasterSession
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            Title = title,
            CreatedAt = now,
            UpdatedAt = now
        };
        await _db.ImageMasterSessions.InsertOneAsync(s, cancellationToken: ct);

        var payload = new { session = s };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:sessions:create:{adminId}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }

    // ---------------------------
    // Workspace（视觉创作 Agent）
    // ---------------------------

    [HttpGet("workspaces")]
    public async Task<IActionResult> ListWorkspaces([FromQuery] int limit = 20, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        limit = Math.Clamp(limit, 1, 50);
        var filter = Builders<ImageMasterWorkspace>.Filter.Or(
            Builders<ImageMasterWorkspace>.Filter.Eq(x => x.OwnerUserId, adminId),
            Builders<ImageMasterWorkspace>.Filter.AnyEq(x => x.MemberUserIds, adminId)
        );
        var items = await _db.ImageMasterWorkspaces
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        // Hydrate cover assets (avoid N+1 on client)
        var coverIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ws in items)
        {
            var single = (ws.CoverAssetId ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(single)) coverIds.Add(single);
            if (ws.CoverAssetIds != null)
            {
                foreach (var cid in ws.CoverAssetIds)
                {
                    var s = (cid ?? string.Empty).Trim();
                    if (!string.IsNullOrWhiteSpace(s)) coverIds.Add(s);
                }
            }
        }

        Dictionary<string, ImageAsset> coverMap = new(StringComparer.Ordinal);
        if (coverIds.Count > 0)
        {
            var covers = await _db.ImageAssets.Find(x => x.WorkspaceId != null && coverIds.Contains(x.Id)).ToListAsync(ct);
            foreach (var a in covers)
            {
                if (!string.IsNullOrWhiteSpace(a.Id)) coverMap[a.Id] = a;
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
            {
                if (coverMap.TryGetValue(cid, out var a))
                {
                    coverAssets.Add(new { id = a.Id, url = a.Url, width = a.Width, height = a.Height });
                }
            }

            var contentHash = (ws.ContentHash ?? string.Empty).Trim();
            var coverHash = (ws.CoverHash ?? string.Empty).Trim();
            var coverStale = !string.IsNullOrWhiteSpace(contentHash) && !string.Equals(contentHash, coverHash, StringComparison.Ordinal);

            return new
            {
                id = ws.Id,
                ownerUserId = ws.OwnerUserId,
                title = ws.Title,
                scenarioType = ws.ScenarioType,
                memberUserIds = ws.MemberUserIds ?? new List<string>(),
                coverAssetId = ws.CoverAssetId,
                coverAssetIds = ws.CoverAssetIds ?? new List<string>(),
                coverAssets,
                canvasHash = ws.CanvasHash,
                assetsHash = ws.AssetsHash,
                contentHash = ws.ContentHash,
                coverHash = ws.CoverHash,
                coverStale,
                coverUpdatedAt = ws.CoverUpdatedAt,
                createdAt = ws.CreatedAt,
                updatedAt = ws.UpdatedAt,
                lastOpenedAt = ws.LastOpenedAt,
                articleContent = ws.ArticleContent,
                articleContentWithMarkers = ws.ArticleContentWithMarkers,
                articleWorkflow = ws.ArticleWorkflow,
                folderName = ws.FolderName
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items = dto }));
    }

    [HttpPost("workspaces")]
    public async Task<IActionResult> CreateWorkspace([FromBody] CreateWorkspaceRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:create:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        var title = (request?.Title ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(title)) title = "未命名";
        if (title.Length > 40) title = title[..40].Trim();

        var scenarioType = (request?.ScenarioType ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(scenarioType)) scenarioType = "image-gen";

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
            LastOpenedAt = now
        };
        await _db.ImageMasterWorkspaces.InsertOneAsync(ws, cancellationToken: ct);
        var payload = new { workspace = ws };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:create:{adminId}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }
        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpPut("workspaces/{id}")]
    public async Task<IActionResult> UpdateWorkspace(string id, [FromBody] UpdateWorkspaceRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId != adminId) return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:update:{adminId}:{wid}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        var title = (request?.Title ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(title) && title.Length > 40) title = title[..40].Trim();
        var memberIds = request?.MemberUserIds != null ? NormalizeMemberIds(request.MemberUserIds, ws.OwnerUserId) : ws.MemberUserIds ?? new List<string>();
        if (request?.MemberUserIds != null)
        {
            var chk = await ValidateAdminUsersAsync(memberIds, ct);
            if (!chk.ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, chk.message ?? "成员无效"));
        }
        var coverAssetId = (request?.CoverAssetId ?? string.Empty).Trim();
        if (coverAssetId.Length > 0 && coverAssetId.Length > 64) coverAssetId = coverAssetId[..64];

        var now = DateTime.UtcNow;
        var update = Builders<ImageMasterWorkspace>.Update
            .Set(x => x.UpdatedAt, now)
            .Set(x => x.MemberUserIds, memberIds);
        if (!string.IsNullOrWhiteSpace(title)) update = update.Set(x => x.Title, title);
        if (request?.CoverAssetId != null) update = update.Set(x => x.CoverAssetId, string.IsNullOrWhiteSpace(coverAssetId) ? null : coverAssetId);
        if (!string.IsNullOrWhiteSpace(request?.ScenarioType)) update = update.Set(x => x.ScenarioType, request.ScenarioType);
        if (request?.FolderName != null) update = update.Set(x => x.FolderName, string.IsNullOrWhiteSpace(request.FolderName) ? null : request.FolderName.Trim());

        // 文章配图场景：若更新了 articleContent，触发"提交型修改"逻辑（version++、清后续、清旧配图）
        var articleContentChanged = !string.IsNullOrWhiteSpace(request?.ArticleContent) 
            && !string.Equals(request.ArticleContent, ws.ArticleContent ?? string.Empty, StringComparison.Ordinal);
        if (articleContentChanged)
        {
            update = update.Set(x => x.ArticleContent, request!.ArticleContent);
            // 快照当前 workflow 到历史（debug-only，最多保留 10 条）
            var history = ws.ArticleWorkflowHistory ?? new List<ArticleIllustrationWorkflow>();
            if (ws.ArticleWorkflow != null)
            {
                history.Insert(0, ws.ArticleWorkflow);
                if (history.Count > 10) history = history.Take(10).ToList();
            }
            // 清空后续阶段：清 markers/images/articleContentWithMarkers
            var newWorkflow = new ArticleIllustrationWorkflow
            {
                Version = (ws.ArticleWorkflow?.Version ?? 0) + 1,
                Phase = 1, // Editing
                Markers = new List<ArticleIllustrationMarker>(),
                ExpectedImageCount = null,
                DoneImageCount = 0,
                AssetIdByMarkerIndex = new Dictionary<string, string>(),
                UpdatedAt = now
            };
            update = update
                .Set(x => x.ArticleWorkflow, newWorkflow)
                .Set(x => x.ArticleWorkflowHistory, history)
                .Set(x => x.ArticleContentWithMarkers, null);

            // 删除旧的文章配图资产（ArticleInsertionIndex != null）
            var oldAssets = await _db.ImageAssets.Find(x => x.WorkspaceId == wid && x.ArticleInsertionIndex != null).ToListAsync(ct);
            if (oldAssets.Count > 0)
            {
                await _db.ImageAssets.DeleteManyAsync(x => x.WorkspaceId == wid && x.ArticleInsertionIndex != null, ct);
                // best-effort 删除底层文件（按 sha 引用计数）
                foreach (var a in oldAssets)
                {
                    try
                    {
                        var remain = await _db.ImageAssets.CountDocumentsAsync(x => x.Sha256 == a.Sha256, cancellationToken: ct);
                        if (remain <= 0)
                        {
                            await _assetStorage.DeleteByShaAsync(a.Sha256, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                        }
                    }
                    catch
                    {
                        // ignore
                    }
                }
            }
        }

        await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == wid, update, cancellationToken: ct);
        var next = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
        var payload = new { workspace = next };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:update:{adminId}:{wid}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }
        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpPost("workspaces/{id}/generate-title")]
    public async Task<IActionResult> GenerateWorkspaceTitle(string id, [FromBody] GenerateWorkspaceTitleRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var prompt = (request?.Prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(prompt)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "prompt 不能为空"));

        var ws = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId != adminId) return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        try
        {
            var title = await _modelDomain.SuggestWorkspaceTitleAsync(prompt, ct);
            if (!string.IsNullOrWhiteSpace(title))
            {
                if (title.Length > 20) title = title[..20];
                var update = Builders<ImageMasterWorkspace>.Update
                    .Set(x => x.Title, title)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow);
                await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == wid, update, cancellationToken: ct);
            }
            return Ok(ApiResponse<object>.Ok(new { title }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to generate workspace title for {WorkspaceId}", wid);
            return Ok(ApiResponse<object>.Ok(new { title = ws.Title }));
        }
    }

    [HttpDelete("workspaces/{id}")]
    public async Task<IActionResult> DeleteWorkspace(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await _db.ImageMasterWorkspaces.Find(x => x.Id == wid).FirstOrDefaultAsync(ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId != adminId) return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:delete:{adminId}:{wid}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        // 1) 删除画布
        await _db.ImageMasterCanvases.DeleteManyAsync(x => x.WorkspaceId == wid, ct);
        // 2) 删除消息（workspace 维度）
        await _db.ImageMasterMessages.DeleteManyAsync(x => x.WorkspaceId == wid, ct);
        // 3) 删除资产记录（workspace 维度），底层文件按 sha 全库引用计数决定是否删除
        var assets = await _db.ImageAssets.Find(x => x.WorkspaceId == wid).ToListAsync(ct);
        await _db.ImageAssets.DeleteManyAsync(x => x.WorkspaceId == wid, ct);
        foreach (var a in assets)
        {
            try
            {
                var remain = await _db.ImageAssets.CountDocumentsAsync(x => x.Sha256 == a.Sha256, cancellationToken: ct);
                if (remain <= 0)
                {
                    await _assetStorage.DeleteByShaAsync(a.Sha256, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                }
            }
            catch
            {
                // ignore: best-effort
            }
        }

        // 4) 删除 workspace
        await _db.ImageMasterWorkspaces.DeleteOneAsync(x => x.Id == wid, ct);

        var payload = new { deleted = true };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:delete:{adminId}:{wid}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }
        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpGet("sessions")]
    public async Task<IActionResult> ListSessions([FromQuery] int limit = 20, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        limit = Math.Clamp(limit, 1, 50);
        var items = await _db.ImageMasterSessions
            .Find(x => x.OwnerUserId == adminId)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpGet("sessions/{id}")]
    public async Task<IActionResult> GetSession(string id, [FromQuery] int messageLimit = 200, [FromQuery] int assetLimit = 80, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        var sid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var session = await _db.ImageMasterSessions.Find(x => x.Id == sid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
        if (session == null) return NotFound(ApiResponse<object>.Fail("SESSION_NOT_FOUND", "会话不存在"));

        messageLimit = Math.Clamp(messageLimit, 1, 500);
        assetLimit = Math.Clamp(assetLimit, 1, 200);

        var messages = await _db.ImageMasterMessages
            .Find(x => x.SessionId == sid && x.OwnerUserId == adminId)
            .SortBy(x => x.CreatedAt)
            .Limit(messageLimit)
            .ToListAsync(ct);

        var assets = await _db.ImageAssets
            .Find(x => x.OwnerUserId == adminId)
            .SortByDescending(x => x.CreatedAt)
            .Limit(assetLimit)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { session, messages, assets }));
    }

    [HttpPost("sessions/{id}/messages")]
    public async Task<IActionResult> AddMessage(string id, [FromBody] AddMessageRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var sid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "sessionId 不能为空"));

        var role = (request?.Role ?? "User").Trim();
        if (role != "User" && role != "Assistant") role = "User";
        var content = (request?.Content ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(content)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "content 不能为空"));
        if (content.Length > 64 * 1024) content = content[..(64 * 1024)];

        var session = await _db.ImageMasterSessions.Find(x => x.Id == sid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
        if (session == null) return NotFound(ApiResponse<object>.Fail("SESSION_NOT_FOUND", "会话不存在"));

        var m = new ImageMasterMessage
        {
            Id = Guid.NewGuid().ToString("N"),
            SessionId = sid,
            OwnerUserId = adminId,
            Role = role,
            Content = content,
            CreatedAt = DateTime.UtcNow
        };
        await _db.ImageMasterMessages.InsertOneAsync(m, cancellationToken: ct);
        await _db.ImageMasterSessions.UpdateOneAsync(
            x => x.Id == sid,
            Builders<ImageMasterSession>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { message = m }));
    }

    [HttpGet("sessions/{id}/canvas")]
    public async Task<IActionResult> GetCanvas(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var sid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var session = await _db.ImageMasterSessions.Find(x => x.Id == sid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
        if (session == null) return NotFound(ApiResponse<object>.Fail("SESSION_NOT_FOUND", "会话不存在"));

        var canvas = await _db.ImageMasterCanvases
            .Find(x => x.SessionId == sid && x.OwnerUserId == adminId)
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (canvas == null)
        {
            return Ok(ApiResponse<object>.Ok(new { canvas = (object?)null }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            canvas = new
            {
                id = canvas.Id,
                sessionId = canvas.SessionId,
                schemaVersion = canvas.SchemaVersion,
                payloadJson = canvas.PayloadJson,
                createdAt = canvas.CreatedAt,
                updatedAt = canvas.UpdatedAt
            }
        }));
    }

    [HttpPut("sessions/{id}/canvas")]
    public async Task<IActionResult> SaveCanvas(string id, [FromBody] SaveCanvasRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var sid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var session = await _db.ImageMasterSessions.Find(x => x.Id == sid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
        if (session == null) return NotFound(ApiResponse<object>.Fail("SESSION_NOT_FOUND", "会话不存在"));

        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:sessions:canvas:save:{adminId}:{sid}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        var schemaVersion = request?.SchemaVersion ?? 1;
        if (schemaVersion < 1 || schemaVersion > 1000) schemaVersion = 1;

        var payloadJson = (request?.PayloadJson ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(payloadJson))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "payloadJson 不能为空"));
        }
        // 保护：避免异常大 JSON 打爆 Mongo（画布状态应远小于图片）
        if (Encoding.UTF8.GetByteCount(payloadJson) > 512 * 1024)
        {
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "画布数据过大（上限 512KB）"));
        }

        // 基础校验：必须是合法 JSON
        try
        {
            _ = JsonDocument.Parse(payloadJson);
        }
        catch
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "payloadJson 必须是合法 JSON"));
        }

        var now = DateTime.UtcNow;
        var update = Builders<ImageMasterCanvas>.Update
            .Set(x => x.SchemaVersion, schemaVersion)
            .Set(x => x.PayloadJson, payloadJson)
            .Set(x => x.UpdatedAt, now)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.OwnerUserId, adminId)
            .SetOnInsert(x => x.SessionId, sid)
            .SetOnInsert(x => x.CreatedAt, now);

        // 不依赖“唯一索引”：先取最新记录并按 Id 更新；不存在则插入
        var existed = await _db.ImageMasterCanvases
            .Find(x => x.OwnerUserId == adminId && x.SessionId == sid)
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);

        ImageMasterCanvas? res;
        if (existed != null)
        {
            await _db.ImageMasterCanvases.UpdateOneAsync(
                x => x.Id == existed.Id,
                update,
                cancellationToken: ct);
            res = await _db.ImageMasterCanvases.Find(x => x.Id == existed.Id).FirstOrDefaultAsync(ct);
        }
        else
        {
            var doc = new ImageMasterCanvas
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerUserId = adminId,
                SessionId = sid,
                SchemaVersion = schemaVersion,
                PayloadJson = payloadJson,
                CreatedAt = now,
                UpdatedAt = now
            };
            await _db.ImageMasterCanvases.InsertOneAsync(doc, cancellationToken: ct);
            res = doc;
        }

        if (res == null)
        {
            return StatusCode(StatusCodes.Status500InternalServerError,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "保存画布失败（数据库未返回结果）"));
        }

        // 更新会话更新时间，便于列表排序
        await _db.ImageMasterSessions.UpdateOneAsync(
            x => x.Id == sid && x.OwnerUserId == adminId,
            Builders<ImageMasterSession>.Update.Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        var payload = new
        {
            canvas = new
            {
                id = res.Id,
                sessionId = res.SessionId,
                schemaVersion = res.SchemaVersion,
                payloadJson = res.PayloadJson,
                createdAt = res.CreatedAt,
                updatedAt = res.UpdatedAt
            }
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:sessions:canvas:save:{adminId}:{sid}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpGet("workspaces/{id}/detail")]
    public async Task<IActionResult> GetWorkspaceDetail(string id, [FromQuery] int messageLimit = 200, [FromQuery] int assetLimit = 80, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        messageLimit = Math.Clamp(messageLimit, 1, 500);
        assetLimit = Math.Clamp(assetLimit, 1, 200);

        var messages = await _db.ImageMasterMessages
            .Find(x => x.WorkspaceId == wid)
            .SortBy(x => x.CreatedAt)
            .Limit(messageLimit)
            .ToListAsync(ct);

        var assets = await _db.ImageAssets
            .Find(x => x.WorkspaceId == wid)
            .SortByDescending(x => x.CreatedAt)
            .Limit(assetLimit)
            .ToListAsync(ct);

        var canvas = await _db.ImageMasterCanvases
            .Find(x => x.WorkspaceId == wid)
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);

        // best-effort：更新 lastOpenedAt
        try
        {
            var now = DateTime.UtcNow;
            await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == wid, Builders<ImageMasterWorkspace>.Update.Set(x => x.LastOpenedAt, now), cancellationToken: ct);
        }
        catch
        {
            // ignore
        }

        ImageMasterViewport? viewport = null;
        try
        {
            if (ws.ViewportByUserId != null && ws.ViewportByUserId.TryGetValue(adminId, out var v))
            {
                viewport = v;
            }
        }
        catch
        {
            // ignore
        }

        // 唤醒逻辑：检测 running 状态的 marker，同步 run 的真实状态
        // 后端是状态的唯一来源，前端只是观察者
        await TrySyncRunningMarkersAsync(ws, ct);

        return Ok(ApiResponse<object>.Ok(new { workspace = ws, messages, assets, canvas, viewport }));
    }

    [HttpPut("workspaces/{id}/viewport")]
    public async Task<IActionResult> SaveWorkspaceViewport(string id, [FromBody] SaveViewportRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:viewport:save:{adminId}:{wid}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        // validate
        var z = request?.Z ?? double.NaN;
        var x = request?.X ?? double.NaN;
        var y = request?.Y ?? double.NaN;
        if (!double.IsFinite(z) || !double.IsFinite(x) || !double.IsFinite(y))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "viewport 参数无效"));
        }
        // 同前端 clamp：0.05 ~ 3
        if (z < 0.05) z = 0.05;
        if (z > 3) z = 3;

        var now = DateTime.UtcNow;
        var vp = new ImageMasterViewport { Z = z, X = x, Y = y, UpdatedAt = now };

        // 仅写入 UI 偏好：不更新 workspace.UpdatedAt，避免列表排序抖动
        var update = Builders<ImageMasterWorkspace>.Update
            .Set($"viewportByUserId.{adminId}", vp)
            .Set(x => x.LastOpenedAt, now);

        await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == wid, update, cancellationToken: ct);

        var payload = new { viewport = vp };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:viewport:save:{adminId}:{wid}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpPost("workspaces/{id}/messages")]
    public async Task<IActionResult> AddWorkspaceMessage(string id, [FromBody] AddMessageRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var role = (request?.Role ?? "User").Trim();
        if (role != "User" && role != "Assistant") role = "User";
        var content = (request?.Content ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(content)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "content 不能为空"));
        if (content.Length > 64 * 1024) content = content[..(64 * 1024)];

        var m = new ImageMasterMessage
        {
            Id = Guid.NewGuid().ToString("N"),
            WorkspaceId = wid,
            OwnerUserId = adminId,
            Role = role,
            Content = content,
            CreatedAt = DateTime.UtcNow
        };
        await _db.ImageMasterMessages.InsertOneAsync(m, cancellationToken: ct);
        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == wid,
            Builders<ImageMasterWorkspace>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { message = m }));
    }

    [HttpGet("workspaces/{id}/canvas")]
    public async Task<IActionResult> GetWorkspaceCanvas(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var canvas = await _db.ImageMasterCanvases.Find(x => x.WorkspaceId == wid).FirstOrDefaultAsync(ct);
        if (canvas == null) return Ok(ApiResponse<object>.Ok(new { canvas = (object?)null }));

        return Ok(ApiResponse<object>.Ok(new
        {
            canvas = new
            {
                id = canvas.Id,
                workspaceId = canvas.WorkspaceId,
                schemaVersion = canvas.SchemaVersion,
                payloadJson = canvas.PayloadJson,
                createdAt = canvas.CreatedAt,
                updatedAt = canvas.UpdatedAt
            }
        }));
    }

    [HttpPut("workspaces/{id}/canvas")]
    public async Task<IActionResult> SaveWorkspaceCanvas(string id, [FromBody] SaveCanvasRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:canvas:save:{adminId}:{wid}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        var schemaVersion = request?.SchemaVersion ?? 1;
        if (schemaVersion < 1 || schemaVersion > 1000) schemaVersion = 1;

        var payloadJson = (request?.PayloadJson ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(payloadJson))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "payloadJson 不能为空"));
        }
        if (Encoding.UTF8.GetByteCount(payloadJson) > 512 * 1024)
        {
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "画布数据过大（上限 512KB）"));
        }
        try
        {
            _ = JsonDocument.Parse(payloadJson);
        }
        catch
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "payloadJson 必须是合法 JSON"));
        }

        var now = DateTime.UtcNow;
        var newCanvasHash = Sha256Hex(payloadJson);
        var assetsHash = (ws.AssetsHash ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(assetsHash))
        {
            assetsHash = Guid.NewGuid().ToString("N");
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == wid,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.AssetsHash, assetsHash),
                cancellationToken: ct);
        }
        // 不依赖“唯一索引”：先取最新记录并按 Id 更新；不存在则插入
        var existed = await _db.ImageMasterCanvases
            .Find(x => x.WorkspaceId == wid)
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);

        ImageMasterCanvas? res;
        if (existed != null)
        {
            var update = Builders<ImageMasterCanvas>.Update
                .Set(x => x.SchemaVersion, schemaVersion)
                .Set(x => x.PayloadJson, payloadJson)
                .Set(x => x.UpdatedAt, now);

            await _db.ImageMasterCanvases.UpdateOneAsync(x => x.Id == existed.Id, update, cancellationToken: ct);
            res = await _db.ImageMasterCanvases.Find(x => x.Id == existed.Id).FirstOrDefaultAsync(ct);
        }
        else
        {
            var doc = new ImageMasterCanvas
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerUserId = ws.OwnerUserId,
                WorkspaceId = wid,
                SchemaVersion = schemaVersion,
                PayloadJson = payloadJson,
                CreatedAt = now,
                UpdatedAt = now
            };
            await _db.ImageMasterCanvases.InsertOneAsync(doc, cancellationToken: ct);
            res = doc;
        }

        if (res == null)
        {
            return StatusCode(StatusCodes.Status500InternalServerError,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "保存画布失败（数据库未返回结果）"));
        }

        // 真实画布变更才更新 contentHash（避免“无变化也刷新封面”）
        var updateWs = Builders<ImageMasterWorkspace>.Update.Set(x => x.UpdatedAt, now);
        if (!string.Equals((ws.CanvasHash ?? string.Empty).Trim(), newCanvasHash, StringComparison.Ordinal))
        {
            var newContentHash = ComputeContentHash(newCanvasHash, assetsHash);
            updateWs = updateWs
                .Set(x => x.CanvasHash, newCanvasHash)
                .Set(x => x.ContentHash, newContentHash);
        }
        await _db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == wid, updateWs, cancellationToken: ct);

        var payload = new
        {
            canvas = new
            {
                id = res.Id,
                workspaceId = res.WorkspaceId,
                schemaVersion = res.SchemaVersion,
                payloadJson = res.PayloadJson,
                createdAt = res.CreatedAt,
                updatedAt = res.UpdatedAt
            }
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:canvas:save:{adminId}:{wid}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpPost("workspaces/{id}/assets")]
    public async Task<IActionResult> UploadWorkspaceAsset(string id, [FromBody] UploadAssetRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:assets:upload:{adminId}:{wid}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        // 复用原 UploadAsset 逻辑
        byte[] bytes;
        string mime;
        if (!string.IsNullOrWhiteSpace(request?.SourceUrl))
        {
            var src = request!.SourceUrl!.Trim();
            if (!TryValidateExternalImageUrl(src, out var uri))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "sourceUrl 无效或不安全"));
            }
            (bytes, mime) = await DownloadExternalAsync(uri!, ct);
        }
        else
        {
            var raw = (request?.Data ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(raw))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "data/sourceUrl 不能为空"));
            }
            if (!TryDecodeDataUrlOrBase64(raw, out mime, out bytes))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "data 格式无效"));
            }
        }

        if (bytes.LongLength > 15 * 1024 * 1024)
        {
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "图片过大（上限 15MB）"));
        }
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片"));
        }

        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);

        var asset = new ImageAsset
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            WorkspaceId = wid,
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

        // 文章配图：同一 workspace + insertionIndex 只保留最新 1 张（避免导出替换顺序错乱）
        // - 只删除元数据；底层文件按 sha 全库引用计数决定是否删除（同 DeleteWorkspace 逻辑）
        if (asset.ArticleInsertionIndex.HasValue)
        {
            var idx = asset.ArticleInsertionIndex.Value;
            if (idx < 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "articleInsertionIndex 无效"));
            var old = await _db.ImageAssets.Find(x => x.WorkspaceId == wid && x.ArticleInsertionIndex == idx).FirstOrDefaultAsync(ct);
            if (old != null)
            {
                await _db.ImageAssets.DeleteOneAsync(x => x.Id == old.Id, ct);
                try
                {
                    // 若新旧 sha 相同，底层文件仍会被新记录引用，禁止删除物理文件
                    if (!string.Equals(old.Sha256, stored.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        var remain = await _db.ImageAssets.CountDocumentsAsync(x => x.Sha256 == old.Sha256, cancellationToken: ct);
                        if (remain <= 0)
                        {
                            await _assetStorage.DeleteByShaAsync(old.Sha256, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                        }
                    }
                }
                catch
                {
                    // ignore: best-effort
                }
            }
        }

        try
        {
            await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: ct);
        }
        catch
        {
            throw;
        }

        // Fire-and-forget: 异步提取图片描述（用于多图组合功能）
        _ = _imageDescriptionService.ExtractDescriptionAsync(asset.Id);

        // 资产变化：更新 assetsHash/contentHash（不改封面）
        var now = DateTime.UtcNow;
        var newAssetsHash = Guid.NewGuid().ToString("N");
        var canvasHash = (ws.CanvasHash ?? string.Empty).Trim();
        var newContentHash = ComputeContentHash(canvasHash, newAssetsHash);
        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == wid,
            Builders<ImageMasterWorkspace>.Update
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.AssetsHash, newAssetsHash)
                .Set(x => x.ContentHash, newContentHash),
            cancellationToken: ct);

        // 文章配图：写入/推进 workflow（doneCount/phase），用于前端恢复进度与禁止跳未来
        if (asset.ArticleInsertionIndex.HasValue)
        {
            var idx = asset.ArticleInsertionIndex.Value;
            var wf = ws.ArticleWorkflow ?? new ArticleIllustrationWorkflow();
            wf.AssetIdByMarkerIndex ??= new Dictionary<string, string>(StringComparer.Ordinal);
            wf.AssetIdByMarkerIndex[idx.ToString()] = asset.Id;
            wf.DoneImageCount = wf.AssetIdByMarkerIndex.Values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count();
            wf.ExpectedImageCount ??= (wf.Markers?.Count ?? 0);
            // 3 个状态模式：生图完成后仍保持在 MarkersGenerated (2) 状态
            wf.UpdatedAt = DateTime.UtcNow;
            
            // 新增：更新对应 marker 的状态
            if (wf.Markers != null && idx < wf.Markers.Count)
            {
                var marker = wf.Markers[idx];
                marker.Status = "done";
                marker.AssetId = asset.Id;
                marker.ErrorMessage = null;
                marker.UpdatedAt = DateTime.UtcNow;
            }

            // history/debug 不在此写入；仅在"提交型修改"时快照
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == wid,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.ArticleWorkflow, wf),
                cancellationToken: ct);
        }

        // 初始封面：仅在完全没有封面时，设置第一张（避免空白；不会覆盖后续 refresh/手动选择）
        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == wid && (x.CoverAssetId == null) && (x.CoverAssetIds == null || x.CoverAssetIds.Count == 0),
            Builders<ImageMasterWorkspace>.Update
                .Set(x => x.CoverAssetId, asset.Id)
                .Set(x => x.CoverAssetIds, new List<string> { asset.Id })
                .Set(x => x.CoverHash, newContentHash)
                .Set(x => x.CoverUpdatedAt, now),
            cancellationToken: ct);

        var payload = new { asset };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:assets:upload:{adminId}:{wid}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }
        return Ok(ApiResponse<object>.Ok(payload));
    }

    /// <summary>
    /// ImageMaster：创建“可断线继续”的生图任务 runId。
    /// - 后台执行：生图 -> 落 COS -> 写入 workspace 资产 -> 回填画布元素（TargetKey）
    /// - 前端即使关闭页面，任务也会继续；下次打开 workspace 会从服务器恢复结果
    /// </summary>
    [HttpPost("workspaces/{id}/image-gen/runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> CreateWorkspaceImageGenRun(string id, [FromBody] CreateWorkspaceImageGenRunRequest request, CancellationToken ct)
    {
        var traceId = HttpContext.TraceIdentifier;
        try
        {
            var adminId = GetAdminId();

            // === [DEBUG] Log incoming request body from frontend ===
            var imageRefsDebug = request?.ImageRefs != null && request.ImageRefs.Count > 0
                ? string.Join(", ", request.ImageRefs.Select(r =>
                    $"@img{r.RefId}:{r.Label}(sha={r.AssetSha256?[..Math.Min(8, r.AssetSha256?.Length ?? 0)]}...)"))
                : "(none)";
            _logger.LogInformation(
                "[CreateWorkspaceImageGenRun] Incoming Request:\n" +
                "  TraceId: {TraceId}\n" +
                "  WorkspaceId: {WorkspaceId}\n" +
                "  AdminId: {AdminId}\n" +
                "  Prompt: {Prompt}\n" +
                "  TargetKey: {TargetKey}\n" +
                "  ConfigModelId: {ConfigModelId}\n" +
                "  PlatformId: {PlatformId}\n" +
                "  ModelId: {ModelId}\n" +
                "  Size: {Size}\n" +
                "  InitImageAssetSha256: {InitSha}\n" +
                "  ImageRefs Count: {ImageRefsCount}\n" +
                "  ImageRefs: {ImageRefs}",
                traceId,
                id,
                adminId,
                request?.Prompt,
                request?.TargetKey,
                request?.ConfigModelId,
                request?.PlatformId,
                request?.ModelId,
                request?.Size,
                request?.InitImageAssetSha256,
                request?.ImageRefs?.Count ?? 0,
                imageRefsDebug);

            var wid = (id ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

            var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
            if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
            if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

            var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
            if (idemKey.Length > 200) idemKey = idemKey[..200];
            if (!string.IsNullOrWhiteSpace(idemKey))
            {
                var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
                if (existed != null) return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
            }

            var prompt = (request?.Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(prompt)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空"));

            var targetKey = (request?.TargetKey ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(targetKey)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "targetKey 不能为空"));

            // 模型：configModelId 或 platformId+modelId
            var cfgModelId = (request?.ConfigModelId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(cfgModelId)) cfgModelId = null;
            var platformId = (request?.PlatformId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
            var modelId = (request?.ModelId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
            if (!string.IsNullOrWhiteSpace(cfgModelId))
            {
                var m = await _db.LLMModels.Find(x => x.Id == cfgModelId && x.Enabled).FirstOrDefaultAsync(ct);
                if (m == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "指定的模型不存在或未启用"));
                platformId = m.PlatformId;
                modelId = m.ModelName;
            }
            else
            {
                if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelId))
                {
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "必须提供 configModelId，或提供 platformId + modelId"));
                }
            }

            var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
            var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "url" : request!.ResponseFormat!.Trim();

            // 首帧引用：允许任意已落盘的 sha（不强制必须属于当前 workspace 的 ImageAssets 记录）
            var initSha = (request?.InitImageAssetSha256 ?? string.Empty).Trim().ToLowerInvariant();
            if (!string.IsNullOrWhiteSpace(initSha))
            {
                if (initSha.Length != 64 || !Regex.IsMatch(initSha, "^[0-9a-f]{64}$"))
                {
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "initImageAssetSha256 格式不正确"));
                }
                var found = await _assetStorage.TryReadByShaAsync(initSha, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                if (found == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "参考图文件不存在或不可用"));
            }
            else
            {
                initSha = null;
            }

            // 关键：先把“占位元素”写入画布（服务端写入，避免前端关闭导致元素不存在）
            await UpsertWorkspaceCanvasPlaceholderAsync(
                workspaceId: wid,
                ownerUserId: ws.OwnerUserId,
                targetKey: targetKey,
                prompt: prompt,
                x: request?.X,
                y: request?.Y,
                w: request?.W,
                h: request?.H,
                ct: ct);

            // 转换多图引用（新架构）
            List<PrdAgent.Core.Models.MultiImage.ImageRefInput>? imageRefs = null;
            if (request?.ImageRefs != null && request.ImageRefs.Count > 0)
            {
                imageRefs = request.ImageRefs.Select(dto => new PrdAgent.Core.Models.MultiImage.ImageRefInput
                {
                    RefId = dto.RefId,
                    AssetSha256 = (dto.AssetSha256 ?? string.Empty).Trim().ToLowerInvariant(),
                    Url = dto.Url ?? string.Empty,
                    Label = dto.Label ?? string.Empty,
                    Role = dto.Role
                }).ToList();
            }

            var run = new ImageGenRun
            {
                OwnerAdminId = adminId,
                Status = ImageGenRunStatus.Queued,
                ConfigModelId = cfgModelId,
                PlatformId = platformId,
                ModelId = modelId,
                Size = size,
                ResponseFormat = responseFormat,
                MaxConcurrency = 1,
                Items = new List<ImageGenRunPlanItem> { new() { Prompt = prompt, Count = 1, Size = null } },
                Total = 1,
                Done = 0,
                Failed = 0,
                CancelRequested = false,
                LastSeq = 0,
                IdempotencyKey = string.IsNullOrWhiteSpace(idemKey) ? null : idemKey,
                CreatedAt = DateTime.UtcNow,
                AppCallerCode = AppCallerRegistry.VisualAgent.Image.Text2Img, // 默认文生图，Worker 会根据参考图动态调整
                AppKey = AppKey, // 硬编码视觉创作的应用标识
                WorkspaceId = wid,
                TargetCanvasKey = targetKey,
                InitImageAssetSha256 = initSha,
                ImageRefs = imageRefs, // 多图引用（新架构）
                MaskBase64 = string.IsNullOrWhiteSpace(request?.MaskBase64) ? null : request!.MaskBase64!.Trim(),
                TargetX = request?.X,
                TargetY = request?.Y,
                TargetW = request?.W,
                TargetH = request?.H,
            };

            try
            {
                await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: ct);
            }
            catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && !string.IsNullOrWhiteSpace(idemKey))
            {
                var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
                if (existed != null) return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
                throw;
            }

            return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ImageMaster CreateWorkspaceImageGenRun failed: trace={TraceId}", traceId);
            return StatusCode(StatusCodes.Status500InternalServerError,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"创建生图任务失败（traceId={traceId}）"));
        }
    }

    private async Task UpsertWorkspaceCanvasPlaceholderAsync(
        string workspaceId,
        string ownerUserId,
        string targetKey,
        string prompt,
        double? x,
        double? y,
        double? w,
        double? h,
        CancellationToken ct)
    {
        var canvas = await _db.ImageMasterCanvases
            .Find(x2 => x2.WorkspaceId == workspaceId)
            .SortByDescending(x2 => x2.UpdatedAt)
            .ThenByDescending(x2 => x2.CreatedAt)
            .FirstOrDefaultAsync(ct);
        var payload = (canvas?.PayloadJson ?? string.Empty).Trim();

        // 兼容历史脏数据：避免 payloadJson 非法导致 500（CreateRun 会先写占位）
        JsonNode root;
        if (string.IsNullOrWhiteSpace(payload))
        {
            root = new JsonObject { ["schemaVersion"] = 1, ["elements"] = new JsonArray() };
        }
        else
        {
            try
            {
                root = JsonNode.Parse(payload) ?? new JsonObject { ["schemaVersion"] = 1, ["elements"] = new JsonArray() };
            }
            catch
            {
                root = new JsonObject { ["schemaVersion"] = 1, ["elements"] = new JsonArray() };
            }
        }

        // root 必须是 object；否则重置为默认结构
        if (root is not JsonObject)
        {
            root = new JsonObject { ["schemaVersion"] = 1, ["elements"] = new JsonArray() };
        }

        var elements = root["elements"] as JsonArray ?? new JsonArray();
        root["elements"] = elements;

        JsonObject? target = null;
        foreach (var n in elements)
        {
            var o = n as JsonObject;
            if (o == null) continue;
            var k = (o["key"]?.GetValue<string>() ?? string.Empty).Trim();
            if (string.Equals(k, targetKey, StringComparison.Ordinal))
            {
                target = o;
                break;
            }
        }
        if (target == null)
        {
            target = new JsonObject { ["key"] = targetKey };
            elements.Add(target);
        }

        target["kind"] = "generator";
        target["status"] = "running";
        target["prompt"] = prompt ?? "";
        if (x.HasValue) target["x"] = x.Value;
        if (y.HasValue) target["y"] = y.Value;
        if (w.HasValue) target["w"] = w.Value;
        if (h.HasValue) target["h"] = h.Value;

        var json = root.ToJsonString(JsonOptions);
        var now = DateTime.UtcNow;
        if (canvas == null)
        {
            var doc = new ImageMasterCanvas
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerUserId = ownerUserId,
                WorkspaceId = workspaceId,
                SchemaVersion = 1,
                PayloadJson = json,
                CreatedAt = now,
                UpdatedAt = now
            };
            await _db.ImageMasterCanvases.InsertOneAsync(doc, cancellationToken: ct);
        }
        else
        {
            await _db.ImageMasterCanvases.UpdateOneAsync(
                x2 => x2.Id == canvas.Id,
                Builders<ImageMasterCanvas>.Update.Set(x2 => x2.PayloadJson, json).Set(x2 => x2.UpdatedAt, now),
                cancellationToken: ct);
        }
    }

    [HttpDelete("workspaces/{id}/assets/{assetId}")]
    public async Task<IActionResult> DeleteWorkspaceAsset(string id, string assetId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        var aid = (assetId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid) || string.IsNullOrWhiteSpace(aid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id/assetId 不能为空"));
        }

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var asset = await _db.ImageAssets.Find(x => x.Id == aid && x.WorkspaceId == wid).FirstOrDefaultAsync(ct);
        if (asset == null) return NotFound(ApiResponse<object>.Fail("ASSET_NOT_FOUND", "资产不存在"));

        await _db.ImageAssets.DeleteOneAsync(x => x.Id == aid && x.WorkspaceId == wid, ct);

        // 当 sha 在全库不再被任何 ImageAssets 引用时才删除底层文件
        try
        {
            var remain = await _db.ImageAssets.CountDocumentsAsync(x => x.Sha256 == asset.Sha256, cancellationToken: ct);
            if (remain <= 0)
            {
                await _assetStorage.DeleteByShaAsync(asset.Sha256, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
            }
        }
        catch
        {
            // ignore
        }

        // 资产变化：更新 assetsHash/contentHash；同时保证封面引用不指向已删除资产（不做“刷新”，仅做一致性修复）
        var now = DateTime.UtcNow;
        var newAssetsHash = Guid.NewGuid().ToString("N");
        var canvasHash = (ws.CanvasHash ?? string.Empty).Trim();
        var newContentHash = ComputeContentHash(canvasHash, newAssetsHash);

        var nextCoverIds = (ws.CoverAssetIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x) && !string.Equals(x.Trim(), aid, StringComparison.Ordinal))
            .Select(x => x.Trim())
            .Take(6)
            .ToList();
        var nextCoverId = string.Equals((ws.CoverAssetId ?? string.Empty).Trim(), aid, StringComparison.Ordinal)
            ? nextCoverIds.FirstOrDefault()
            : ws.CoverAssetId;

        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == wid,
            Builders<ImageMasterWorkspace>.Update
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.AssetsHash, newAssetsHash)
                .Set(x => x.ContentHash, newContentHash)
                .Set(x => x.CoverAssetIds, nextCoverIds)
                .Set(x => x.CoverAssetId, string.IsNullOrWhiteSpace(nextCoverId) ? null : nextCoverId),
            cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    [HttpPost("workspaces/{id}/cover/refresh")]
    public async Task<IActionResult> RefreshWorkspaceCover(string id, [FromQuery] int limit = 6, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        limit = Math.Clamp(limit, 1, 6);
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:cover:refresh:{adminId}:{wid}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        var contentHash = (ws.ContentHash ?? string.Empty).Trim();
        var coverHash = (ws.CoverHash ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(contentHash)
            && string.Equals(contentHash, coverHash, StringComparison.Ordinal)
            && ws.CoverAssetIds != null
            && ws.CoverAssetIds.Count > 0)
        {
            var payloadNoop = new
            {
                workspace = new
                {
                    id = ws.Id,
                    coverAssetId = ws.CoverAssetId,
                    coverAssetIds = ws.CoverAssetIds ?? new List<string>(),
                    contentHash = ws.ContentHash,
                    coverHash = ws.CoverHash,
                    coverStale = false,
                    coverUpdatedAt = ws.CoverUpdatedAt
                }
            };
            if (!string.IsNullOrWhiteSpace(idemKey))
            {
                var cacheKey = $"imageMaster:workspaces:cover:refresh:{adminId}:{wid}:{idemKey}";
                await _cache.SetAsync(cacheKey, payloadNoop, IdemExpiry);
            }
            return Ok(ApiResponse<object>.Ok(payloadNoop));
        }

        var assets = await _db.ImageAssets
            .Find(x => x.WorkspaceId == wid)
            .SortByDescending(x => x.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        var ids = assets.Select(x => x.Id).Where(x => !string.IsNullOrWhiteSpace(x)).Take(limit).ToList();
        var now = DateTime.UtcNow;

        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == wid,
            Builders<ImageMasterWorkspace>.Update
                .Set(x => x.CoverAssetIds, ids)
                .Set(x => x.CoverAssetId, ids.FirstOrDefault())
                .Set(x => x.CoverHash, string.IsNullOrWhiteSpace(contentHash) ? null : contentHash)
                .Set(x => x.CoverUpdatedAt, now),
            cancellationToken: ct);

        var coverAssets = assets.Select(a => new { id = a.Id, url = a.Url, width = a.Width, height = a.Height }).ToList();
        var payload = new
        {
            workspace = new
            {
                id = wid,
                coverAssetId = ids.FirstOrDefault(),
                coverAssetIds = ids,
                coverAssets,
                contentHash = ws.ContentHash,
                coverHash = string.IsNullOrWhiteSpace(contentHash) ? null : contentHash,
                coverStale = false,
                coverUpdatedAt = now
            }
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:workspaces:cover:refresh:{adminId}:{wid}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpPost("assets")]
    public async Task<IActionResult> UploadAsset([FromBody] UploadAssetRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:assets:upload:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null) return Ok(ApiResponse<object>.Ok(cached));
        }

        // 1) bytes from dataUrl/base64 OR from sourceUrl
        byte[] bytes;
        string mime;
        if (!string.IsNullOrWhiteSpace(request?.SourceUrl))
        {
            var src = request!.SourceUrl!.Trim();
            if (!TryValidateExternalImageUrl(src, out var uri))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "sourceUrl 无效或不安全"));
            }

            (bytes, mime) = await DownloadExternalAsync(uri!, ct);
        }
        else
        {
            var raw = (request?.Data ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(raw))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "data/sourceUrl 不能为空"));
            }
            if (!TryDecodeDataUrlOrBase64(raw, out mime, out bytes))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "data 格式无效"));
            }
        }

        // 2) size limit (avoid memory abuse)
        if (bytes.LongLength > 15 * 1024 * 1024)
        {
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "图片过大（上限 15MB）"));
        }
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片"));
        }

        // 3) store file (sha de-dupe at storage level) and upsert meta
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);

        var asset = new ImageAsset
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            Sha256 = stored.Sha256,
            Mime = stored.Mime,
            SizeBytes = stored.SizeBytes,
            Url = stored.Url,
            Prompt = (request?.Prompt ?? string.Empty).Trim(),
            CreatedAt = DateTime.UtcNow
        };
        if (asset.Prompt != null && asset.Prompt.Length > 300) asset.Prompt = asset.Prompt[..300].Trim();
        if (request?.Width is > 0 and < 20000) asset.Width = request.Width!.Value;
        if (request?.Height is > 0 and < 20000) asset.Height = request.Height!.Value;

        await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: ct);

        // Fire-and-forget: 异步提取图片描述（用于多图组合功能）
        _ = _imageDescriptionService.ExtractDescriptionAsync(asset.Id);

        var payload = new { asset };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"imageMaster:assets:upload:{adminId}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdemExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }

    [HttpGet("assets/{id}")]
    public async Task<IActionResult> GetAsset(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var aid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(aid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        var asset = await _db.ImageAssets.Find(x => x.Id == aid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
        if (asset == null) return NotFound(ApiResponse<object>.Fail("ASSET_NOT_FOUND", "资产不存在"));
        return Ok(ApiResponse<object>.Ok(new { asset }));
    }

    /// <summary>
    /// 手动触发图片描述提取（用于多图组合功能）
    /// </summary>
    [HttpPost("assets/{id}/describe")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> DescribeAsset(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var aid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(aid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        }

        var asset = await _db.ImageAssets.Find(x => x.Id == aid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
        if (asset == null)
        {
            return NotFound(ApiResponse<object>.Fail("ASSET_NOT_FOUND", "资产不存在"));
        }

        try
        {
            var description = await _imageDescriptionService.ExtractDescriptionSyncAsync(aid, ct);
            if (string.IsNullOrWhiteSpace(description))
            {
                return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "描述提取失败"));
            }

            // 重新查询以获取更新后的资产
            asset = await _db.ImageAssets.Find(x => x.Id == aid).FirstOrDefaultAsync(ct);
            return Ok(ApiResponse<object>.Ok(new
            {
                description = asset?.Description,
                extractedAt = asset?.DescriptionExtractedAt,
                modelId = asset?.DescriptionModelId
            }));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to extract description for asset {AssetId}", aid);
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "描述提取失败"));
        }
    }

    [HttpDelete("assets/{id}")]
    public async Task<IActionResult> DeleteAsset(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var aid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(aid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var asset = await _db.ImageAssets.Find(x => x.Id == aid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
        if (asset == null) return NotFound(ApiResponse<object>.Fail("ASSET_NOT_FOUND", "资产不存在"));

        await _db.ImageAssets.DeleteOneAsync(x => x.Id == aid && x.OwnerUserId == adminId, ct);

        // 当 sha 在全库不再被任何 ImageAssets 引用时才删除底层文件，避免误删共享内容。
        try
        {
            var remain = await _db.ImageAssets.CountDocumentsAsync(x => x.Sha256 == asset.Sha256, cancellationToken: ct);
            if (remain <= 0)
            {
                _logger.LogInformation(
                    "ImageMaster deleting physical asset. adminId={AdminId} assetId={AssetId} sha={Sha} url={Url} domain={Domain} type={Type}",
                    adminId,
                    asset.Id,
                    asset.Sha256,
                    asset.Url,
                    AppDomainPaths.DomainVisualAgent,
                    AppDomainPaths.TypeImg);
                await _assetStorage.DeleteByShaAsync(asset.Sha256, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "ImageMaster delete asset file failed: sha={Sha}", asset.Sha256);
        }
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    [HttpGet("assets/file/{name}")]
    [AllowAnonymous] // 仅图片文件读取，不返回敏感信息；但依赖 sha 不可猜测（64 hex）
    public async Task<IActionResult> GetAssetFile(string name, CancellationToken ct)
    {
        var n = (name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(n)) return NotFound();
        var dot = n.IndexOf('.');
        var sha = dot > 0 ? n[..dot] : n;
        if (sha.Length != 64) return NotFound();

        // 按优先级尝试多个 domain/type 组合
        var searchPaths = new (string domain, string type)[]
        {
            (AppDomainPaths.DomainVisualAgent, AppDomainPaths.TypeImg),
            (AppDomainPaths.DomainDefectAgent, AppDomainPaths.TypeLog),
        };

        foreach (var (domain, type) in searchPaths)
        {
            var found = await _assetStorage.TryReadByShaAsync(sha, ct, domain: domain, type: type);
            if (found != null)
            {
                return File(found.Value.bytes, found.Value.mime);
            }
        }

        return NotFound();
    }

    private static bool TryDecodeDataUrlOrBase64(string raw, out string mime, out byte[] bytes)
    {
        mime = "image/png";
        bytes = Array.Empty<byte>();
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return false;
        if (s.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = s.IndexOf(',');
            if (comma < 0) return false;
            var header = s.Substring(5, comma - 5);
            var payload = s[(comma + 1)..];
            var semi = header.IndexOf(';');
            var ct = semi >= 0 ? header[..semi] : header;
            if (!string.IsNullOrWhiteSpace(ct)) mime = ct.Trim();
            s = payload.Trim();
        }
        try
        {
            bytes = Convert.FromBase64String(s);
            return bytes.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryValidateExternalImageUrl(string raw, out Uri? uri)
    {
        uri = null;
        if (!Uri.TryCreate((raw ?? string.Empty).Trim(), UriKind.Absolute, out var u)) return false;
        if (!string.Equals(u.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return false;
        if (string.IsNullOrWhiteSpace(u.Host)) return false;
        if (string.Equals(u.Host, "localhost", StringComparison.OrdinalIgnoreCase)) return false;
        if (IPAddress.TryParse(u.Host, out var ip))
        {
            if (IPAddress.IsLoopback(ip)) return false;
        }
        uri = u;
        return true;
    }

    private async Task<(byte[] bytes, string mime)> DownloadExternalAsync(Uri uri, CancellationToken ct)
    {
        var http = _httpClientFactory.CreateClient("LoggedHttpClient");
        http.Timeout = TimeSpan.FromSeconds(60);
        http.DefaultRequestHeaders.Remove("Authorization");
        using var req = new HttpRequestMessage(HttpMethod.Get, uri);
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!resp.IsSuccessStatusCode)
        {
            _logger.LogWarning("ImageMaster download failed: HTTP {Status} host={Host}", (int)resp.StatusCode, uri.Host);
            throw new InvalidOperationException("下载失败");
        }
        var mime = resp.Content.Headers.ContentType?.MediaType ?? "image/png";
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var ms = new MemoryStream(capacity: 1024 * 1024);
        await stream.CopyToAsync(ms, ct);
        return (ms.ToArray(), mime);
    }

    // ---------------------------
    // 文章配图场景专用接口
    // ---------------------------

    /// <summary>
    /// 文章配图场景：调用 LLM 在文章中插入配图提示词标记（流式返回）
    /// </summary>
    [HttpPost("workspaces/{id}/article/generate-markers")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task GenerateArticleMarkers(string id, [FromBody] PrdAgent.Api.Models.Requests.GenerateArticleMarkersRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid))
        {
            await WriteJsonResponseAsync(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"), StatusCodes.Status400BadRequest, ct);
            return;
        }

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null)
        {
            await WriteJsonResponseAsync(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"), StatusCodes.Status404NotFound, ct);
            return;
        }
        if (ws.OwnerUserId == "__FORBIDDEN__")
        {
            await WriteJsonResponseAsync(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"), StatusCodes.Status403Forbidden, ct);
            return;
        }

        var articleContent = (request?.ArticleContent ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(articleContent))
        {
            await WriteJsonResponseAsync(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "articleContent 不能为空"), StatusCodes.Status400BadRequest, ct);
            return;
        }

        var userInstruction = (request?.UserInstruction ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(userInstruction))
        {
            await WriteJsonResponseAsync(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "userInstruction 不能为空"), StatusCodes.Status400BadRequest, ct);
            return;
        }

        // 设置 SSE 响应头
        Response.ContentType = "text/event-stream";
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");

        try
        {
            var appCallerCode = AppCallerRegistry.LiteraryAgent.Content.Chat;
            var llmClient = _gateway.CreateClient(appCallerCode, "chat");
            var requestId = Guid.NewGuid().ToString("N");
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: requestId,
                GroupId: null,
                SessionId: wid,
                UserId: adminId,
                ViewRole: "ADMIN",
                DocumentChars: articleContent.Length,
                DocumentHash: Sha256Hex(articleContent),
                SystemPromptRedacted: "[LITERARY_ARTICLE_MARKERS]",
                RequestType: "chat",
                RequestPurpose: appCallerCode));

            // 调用主模型 LLM
            var client = llmClient;
            var systemPrompt = userInstruction;
            var userPrompt = articleContent;

            var messages = new List<LLMMessage>
            {
                new() { Role = "user", Content = userPrompt }
            };

            // 服务器权威性设计：LLM 调用使用 CancellationToken.None，确保客户端被动断开不会中断处理
            // 只有显式取消 API 才能中断任务
            var fullResponse = new StringBuilder();
            var clientDisconnected = false;
            await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, false, CancellationToken.None))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullResponse.Append(chunk.Content);

                    // SSE 写入捕获异常：客户端断开时不中断 LLM 处理
                    if (!clientDisconnected)
                    {
                        try
                        {
                            var eventData = JsonSerializer.Serialize(new { type = "delta", text = chunk.Content }, JsonOptions);
                            await Response.WriteAsync($"data: {eventData}\n\n");
                            await Response.Body.FlushAsync();
                        }
                        catch (OperationCanceledException)
                        {
                            clientDisconnected = true;
                            _logger.LogDebug("GenerateArticleMarkers: 客户端已断开，继续处理 LLM 响应");
                        }
                        catch (ObjectDisposedException)
                        {
                            clientDisconnected = true;
                            _logger.LogDebug("GenerateArticleMarkers: 连接已关闭，继续处理 LLM 响应");
                        }
                        catch (Exception ex) when (ex.InnerException is OperationCanceledException)
                        {
                            clientDisconnected = true;
                            _logger.LogDebug("GenerateArticleMarkers: 客户端已断开（内部取消），继续处理 LLM 响应");
                        }
                    }
                }
                else if (chunk.Type == "error")
                {
                    if (!clientDisconnected)
                    {
                        try
                        {
                            var errorData = JsonSerializer.Serialize(new { type = "error", message = chunk.ErrorMessage }, JsonOptions);
                            await Response.WriteAsync($"data: {errorData}\n\n");
                            await Response.Body.FlushAsync();
                        }
                        catch { /* 客户端已断开，忽略 */ }
                    }
                    return;
                }
            }

            // 保存生成的内容到 workspace，并触发"提交型修改"逻辑（version++、清后续、清旧配图）
            var now = DateTime.UtcNow;
            var generatedContent = fullResponse.ToString();
            var extractedMarkers = PrdAgent.Core.Services.ArticleMarkerExtractor.Extract(generatedContent);

            // 快照当前 workflow 到历史（debug-only，最多保留 10 条）
            var history = ws.ArticleWorkflowHistory ?? new List<ArticleIllustrationWorkflow>();
            if (ws.ArticleWorkflow != null)
            {
                history.Insert(0, ws.ArticleWorkflow);
                if (history.Count > 10) history = history.Take(10).ToList();
            }

            // 清空后续阶段：清旧图片资产，重置 images 进度
            // 服务器权威性设计：数据库操作使用 CancellationToken.None，确保数据完整持久化
            var oldAssets = await _db.ImageAssets.Find(x => x.WorkspaceId == wid && x.ArticleInsertionIndex != null).ToListAsync(CancellationToken.None);
            if (oldAssets.Count > 0)
            {
                await _db.ImageAssets.DeleteManyAsync(x => x.WorkspaceId == wid && x.ArticleInsertionIndex != null, CancellationToken.None);
                // best-effort 删除底层文件（按 sha 引用计数）
                foreach (var a in oldAssets)
                {
                    try
                    {
                        var remain = await _db.ImageAssets.CountDocumentsAsync(x => x.Sha256 == a.Sha256, cancellationToken: CancellationToken.None);
                        if (remain <= 0)
                        {
                            await _assetStorage.DeleteByShaAsync(a.Sha256, CancellationToken.None, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                        }
                    }
                    catch
                    {
                        // ignore
                    }
                }
            }

            var newWorkflow = new ArticleIllustrationWorkflow
            {
                Version = (ws.ArticleWorkflow?.Version ?? 0) + 1,
                Phase = 2, // MarkersGenerated
                Markers = extractedMarkers.Select(m => new ArticleIllustrationMarker { Index = m.Index, Text = m.Text }).ToList(),
                ExpectedImageCount = extractedMarkers.Count,
                DoneImageCount = 0,
                AssetIdByMarkerIndex = new Dictionary<string, string>(),
                UpdatedAt = now
            };

            // 服务器权威性设计：数据库更新使用 CancellationToken.None
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == wid,
                Builders<ImageMasterWorkspace>.Update
                    .Set(x => x.ArticleContentWithMarkers, generatedContent)
                    .Set(x => x.ArticleWorkflow, newWorkflow)
                    .Set(x => x.ArticleWorkflowHistory, history)
                    .Set(x => x.UpdatedAt, now),
                cancellationToken: CancellationToken.None);

            _logger.LogInformation("GenerateArticleMarkers completed for workspace {WorkspaceId}, markers: {MarkerCount}, clientDisconnected: {ClientDisconnected}",
                wid, extractedMarkers.Count, clientDisconnected);

            // 发送完成事件（如果客户端仍连接）
            if (!clientDisconnected)
            {
                try
                {
                    var doneData = JsonSerializer.Serialize(new { type = "done", fullText = generatedContent }, JsonOptions);
                    await Response.WriteAsync($"data: {doneData}\n\n");
                    await Response.Body.FlushAsync();
                }
                catch
                {
                    // 客户端已断开，但数据已保存，任务完成
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GenerateArticleMarkers failed for workspace {WorkspaceId}", wid);
            try
            {
                var errorData = JsonSerializer.Serialize(new { type = "error", message = "生成失败" }, JsonOptions);
                await Response.WriteAsync($"data: {errorData}\n\n");
                await Response.Body.FlushAsync();
            }
            catch
            {
                // 客户端已断开，忽略
            }
        }
    }

    /// <summary>
    /// 文章配图场景：提取所有 [[...]] 标记并返回位置信息
    /// </summary>
    [HttpPost("workspaces/{id}/article/extract-markers")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> ExtractArticleMarkers(string id, [FromBody] PrdAgent.Api.Models.Requests.ExtractArticleMarkersRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var content = (request?.ArticleContentWithMarkers ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(content)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "articleContentWithMarkers 不能为空"));

        var markers = PrdAgent.Core.Services.ArticleMarkerExtractor.Extract(content);
        var dto = markers.Select(m => new
        {
            index = m.Index,
            text = m.Text,
            startPos = m.StartPos,
            endPos = m.EndPos
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { markers = dto }));
    }

    /// <summary>
    /// 文章配图场景：导出文章（替换 [[...]] 为实际图片 CDN URL）
    /// </summary>
    [HttpPost("workspaces/{id}/article/export")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> ExportArticle(string id, [FromBody] PrdAgent.Api.Models.Requests.ExportArticleRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        // 获取 workspace 的所有 assets（按 articleInsertionIndex 排序）
        var assets = await _db.ImageAssets
            .Find(x => x.WorkspaceId == wid && x.ArticleInsertionIndex != null)
            .SortBy(x => x.ArticleInsertionIndex)
            .ToListAsync(ct);

        var content = ws.ArticleContentWithMarkers ?? ws.ArticleContent ?? string.Empty;
        if (string.IsNullOrWhiteSpace(content)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "文章内容为空"));

        // 替换标记为图片链接
        var exportedContent = PrdAgent.Core.Services.ArticleMarkerExtractor.ReplaceMarkersWithImages(content, assets);

        var exportFormat = (request?.ExportFormat ?? "markdown").Trim().ToLowerInvariant();
        return Ok(ApiResponse<object>.Ok(new
        {
            content = exportedContent,
            format = exportFormat,
            assetCount = assets.Count
        }));
    }

    /// <summary>
    /// 文章配图场景：保存单条 marker 的编辑状态（用户修改提示词/生图状态变化时）
    /// </summary>
    [HttpPatch("workspaces/{id}/article/markers/{markerIndex}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> UpdateArticleMarker(
        string id, 
        int markerIndex, 
        [FromBody] UpdateMarkerRequest request, 
        CancellationToken ct)
    {
        var adminId = GetAdminId();
        var wid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(wid)) 
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var ws = await GetWorkspaceIfAllowedAsync(wid, adminId, ct);
        if (ws == null) return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "Workspace 不存在"));
        if (ws.OwnerUserId == "__FORBIDDEN__") 
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var wf = ws.ArticleWorkflow;
        if (wf == null || wf.Markers == null || markerIndex < 0 || markerIndex >= wf.Markers.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "markerIndex 无效"));

        var marker = wf.Markers[markerIndex];
        
        // 更新字段（只更新非 null 的字段）
        if (request.DraftText != null) marker.DraftText = request.DraftText;
        if (request.Status != null) marker.Status = request.Status;
        if (request.RunId != null) marker.RunId = request.RunId;
        if (request.ErrorMessage != null) marker.ErrorMessage = request.ErrorMessage;
        if (request.Url != null) marker.Url = request.Url;  // 保存图片 URL
        if (request.PlanItem != null)
        {
            // 保存意图解析结果
            marker.PlanItem = new ArticleIllustrationPlanItem
            {
                Prompt = request.PlanItem.Prompt,
                Count = request.PlanItem.Count,
                Size = request.PlanItem.Size
            };
        }
        marker.UpdatedAt = DateTime.UtcNow;

        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == wid,
            Builders<ImageMasterWorkspace>.Update
                .Set(x => x.ArticleWorkflow, wf)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { marker }));
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
            var parsingMarkers = wf.Markers
                .Where(m => m.Status == "parsing")
                .ToList();

            foreach (var marker in parsingMarkers)
            {
                // 如果 UpdatedAt 为空（历史数据），使用 workflow 的 UpdatedAt 或直接视为超时
                var markerTime = marker.UpdatedAt ?? wf.UpdatedAt;
                var elapsed = now - markerTime;
                if (elapsed > TimeSpan.FromMinutes(5))
                {
                    marker.Status = "error";
                    marker.ErrorMessage = "意图解析超时，请重试";
                    marker.UpdatedAt = now;
                    needUpdate = true;
                    _logger?.LogInformation(
                        "Auto-corrected stuck parsing marker: workspace={WorkspaceId}, index={Index}, elapsed={Elapsed}min",
                        ws.Id, marker.Index, elapsed.TotalMinutes);
                }
            }

            // 2. 检测 running 状态的 marker，同步 run 的真实状态
            var runningMarkers = wf.Markers
                .Where(m => m.Status == "running" && !string.IsNullOrEmpty(m.RunId))
                .ToList();

            if (runningMarkers.Count == 0 && !needUpdate)
            {
                return;
            }

            if (runningMarkers.Count == 0)
            {
                // 只有 parsing 超时的更新
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

                // Run 已完成
                if (run.Status == ImageGenRunStatus.Completed)
                {
                    // 从 run items 获取 url
                    var item = await _db.ImageGenRunItems
                        .Find(i => i.RunId == run.Id && i.Status == ImageGenRunItemStatus.Done)
                        .FirstOrDefaultAsync(ct);
                    
                    marker.Status = "done";
                    marker.Url = item?.Url ?? marker.Url; // 优先使用 run item 的 url
                    marker.ErrorMessage = null;
                    marker.UpdatedAt = now;
                    needUpdate = true;
                }
                // Run 失败或取消
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
                // Run 还在运行，但超时（超过 10 分钟认为卡住）
                else if (run.Status == ImageGenRunStatus.Running || run.Status == ImageGenRunStatus.Queued)
                {
                    var elapsed = now - run.CreatedAt;
                    if (elapsed > TimeSpan.FromMinutes(10))
                    {
                        marker.Status = "error";
                        marker.ErrorMessage = "生图任务超时，请重试";
                        marker.UpdatedAt = now;
                        needUpdate = true;
                    }
                }
            }

            // 如果有状态变更，更新数据库
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
            // 唤醒逻辑是 best-effort，不应影响主流程
            _logger?.LogWarning(ex, "TrySyncRunningMarkersAsync failed for workspace {WorkspaceId}", ws.Id);
        }
    }

    private async Task WriteJsonResponseAsync(object data, int statusCode, CancellationToken ct)
    {
        Response.StatusCode = statusCode;
        Response.ContentType = "application/json";
        await Response.WriteAsync(JsonSerializer.Serialize(data, JsonOptions), ct);
    }

    // ────────────────────────────────────────────
    // 手绘板 AI 对话（SSE 流式）
    // ────────────────────────────────────────────

    /// <summary>
    /// 手绘板 AI 助手：流式对话（SSE）
    /// 用于辅助用户绘制草图 / 生成字符画
    /// </summary>
    [HttpPost("drawing-board/chat")]
    [Produces("text/event-stream")]
    public async Task DrawingBoardChat([FromBody] DrawingBoardChatRequest request, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        const string systemPrompt = """
            你是一位专业的手绘助手和字符画艺术家。用户正在使用手绘画板创建草图/字符画，作为 AI 图片生成的参考底图。

            你的职责：
            1. 当用户描述想要的画面时，生成对应的字符画（ASCII art），用 ```ascii 代码块包裹
            2. 提供绘画建议和构图指导
            3. 帮助用户理清想法，将模糊的描述转化为具体的视觉方案

            字符画规范：
            - 使用等宽字符组成图案，尽量使用简单字符（/ \ | - _ = + * . : 空格）
            - 宽度控制在 40-70 字符，高度控制在 15-35 行
            - 重点表达主体轮廓和空间关系，不需要过度细节
            - 如果用户要求修改，只输出修改后的完整字符画

            请用简洁、友好的中文回答。当用户的描述足够清晰时，优先生成字符画而非长篇解释。
            """;

        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt }
        };

        if (request.Messages is { Count: > 0 })
        {
            foreach (var msg in request.Messages)
            {
                if (string.IsNullOrWhiteSpace(msg.Content)) continue;
                messages.Add(new JsonObject
                {
                    ["role"] = msg.Role?.ToLowerInvariant() switch { "assistant" => "assistant", _ => "user" },
                    ["content"] = msg.Content
                });
            }
        }

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.VisualAgent.DrawingBoard.Chat,
            ModelType = "chat",
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = 0.8,
                ["max_tokens"] = 4000
            }
        };

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (!string.IsNullOrEmpty(chunk.Content))
                {
                    var data = JsonSerializer.Serialize(new { type = "text", content = chunk.Content });
                    try
                    {
                        await Response.WriteAsync($"data: {data}\n\n", ct);
                        await Response.Body.FlushAsync(ct);
                    }
                    catch (OperationCanceledException) { /* 客户端断开，继续处理 */ }
                    catch (ObjectDisposedException) { }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var data = JsonSerializer.Serialize(new { type = "error", content = chunk.Error ?? "未知错误" });
                    try
                    {
                        await Response.WriteAsync($"data: {data}\n\n", ct);
                        await Response.Body.FlushAsync(ct);
                    }
                    catch { }
                }
            }

            try
            {
                await Response.WriteAsync("data: [DONE]\n\n", ct);
                await Response.Body.FlushAsync(ct);
            }
            catch { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Drawing board chat streaming error");
            var errData = JsonSerializer.Serialize(new { type = "error", content = $"对话失败: {ex.Message}" });
            try
            {
                await Response.WriteAsync($"data: {errData}\n\n", ct);
                await Response.Body.FlushAsync(ct);
            }
            catch { }
        }
    }
}

public class CreateWorkspaceImageGenRunRequest
{
    public string Prompt { get; set; } = string.Empty;
    public string TargetKey { get; set; } = string.Empty;
    public double? X { get; set; }
    public double? Y { get; set; }
    public double? W { get; set; }
    public double? H { get; set; }

    public string? ConfigModelId { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelId { get; set; }
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // url | b64_json

    /// <summary>
    /// 单图场景向后兼容（被 ImageRefs 取代）
    /// </summary>
    public string? InitImageAssetSha256 { get; set; }

    /// <summary>
    /// 多图引用列表（新架构）。
    /// 前端传递 @imgN 对应的图片列表。
    /// 示例：[{"refId": 1, "assetSha256": "abc...", "url": "...", "label": "风格图"}]
    /// </summary>
    public List<ImageRefInputDto>? ImageRefs { get; set; }

    /// <summary>
    /// 可选：局部重绘蒙版（base64 data URI）。白色 = 重绘区域，黑色 = 保持。
    /// </summary>
    public string? MaskBase64 { get; set; }
}

/// <summary>
/// 图片引用输入 DTO
/// </summary>
public class ImageRefInputDto
{
    /// <summary>
    /// 引用 ID，对应前端的 @img1, @img2 中的数字
    /// </summary>
    public int RefId { get; set; }

    /// <summary>
    /// 图片资产 SHA256（用于从 COS 读取原图）
    /// </summary>
    public string AssetSha256 { get; set; } = string.Empty;

    /// <summary>
    /// 图片 URL（展示用，或作为 AssetSha256 的备用）
    /// </summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// 用户给图片的标签/描述
    /// </summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>
    /// 可选：图片角色
    /// </summary>
    public string? Role { get; set; }
}

public class CreateSessionRequest
{
    public string? Title { get; set; }
}

public class AddMessageRequest
{
    public string? Role { get; set; }
    public string? Content { get; set; }
}

public class CreateWorkspaceRequest
{
    public string? Title { get; set; }
    public string? ScenarioType { get; set; }
}

public class UpdateWorkspaceRequest
{
    public string? Title { get; set; }
    public List<string>? MemberUserIds { get; set; }
    public string? CoverAssetId { get; set; }
    public string? ArticleContent { get; set; }
    public string? ScenarioType { get; set; }
    public string? FolderName { get; set; }
}

public class GenerateWorkspaceTitleRequest
{
    public string? Prompt { get; set; }
}

public class UploadAssetRequest
{
    public string? Data { get; set; } // dataURL/base64
    public string? SourceUrl { get; set; } // re-host external url
    public string? Prompt { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }

    // 文章配图场景（可选）：用于导出时替换 [插图] 标记
    public int? ArticleInsertionIndex { get; set; }
    public string? OriginalMarkerText { get; set; }
}

public class SaveCanvasRequest
{
    public int? SchemaVersion { get; set; }
    public string? PayloadJson { get; set; }
}

public class SaveViewportRequest
{
    public double? Z { get; set; }
    public double? X { get; set; }
    public double? Y { get; set; }
}

public class DrawingBoardChatRequest
{
    public List<DrawingBoardChatMessage>? Messages { get; set; }
}

public class DrawingBoardChatMessage
{
    public string? Role { get; set; }
    public string Content { get; set; } = string.Empty;
}
