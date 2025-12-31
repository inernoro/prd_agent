using System.Net;
using System.Security.Cryptography;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using MongoDB.Driver.Core.Servers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Admin;

[ApiController]
[Route("api/v1/admin/image-master")]
[Authorize(Roles = "ADMIN")]
public class AdminImageMasterController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ICacheManager _cache;
    private readonly ILogger<AdminImageMasterController> _logger;

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

    public AdminImageMasterController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        IHttpClientFactory httpClientFactory,
        ICacheManager cache,
        ILogger<AdminImageMasterController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _httpClientFactory = httpClientFactory;
        _cache = cache;
        _logger = logger;
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
                lastOpenedAt = ws.LastOpenedAt
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

        var now = DateTime.UtcNow;
        var assetsHash = Guid.NewGuid().ToString("N");
        var canvasHash = string.Empty;
        var contentHash = ComputeContentHash(canvasHash, assetsHash);
        var ws = new ImageMasterWorkspace
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            Title = title,
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
                    await _assetStorage.DeleteByShaAsync(a.Sha256, ct, domain: AppDomainPaths.DomainImageMaster, type: AppDomainPaths.TypeImg);
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

        var canvas = await _db.ImageMasterCanvases.Find(x => x.SessionId == sid && x.OwnerUserId == adminId).FirstOrDefaultAsync(ct);
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

        var res = await _db.ImageMasterCanvases.FindOneAndUpdateAsync<ImageMasterCanvas, ImageMasterCanvas>(
            x => x.OwnerUserId == adminId && x.SessionId == sid,
            update,
            new FindOneAndUpdateOptions<ImageMasterCanvas, ImageMasterCanvas>
            {
                IsUpsert = true,
                ReturnDocument = ReturnDocument.After
            },
            ct);

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

        var canvas = await _db.ImageMasterCanvases.Find(x => x.WorkspaceId == wid).FirstOrDefaultAsync(ct);

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
        var update = Builders<ImageMasterCanvas>.Update
            .Set(x => x.SchemaVersion, schemaVersion)
            .Set(x => x.PayloadJson, payloadJson)
            .Set(x => x.UpdatedAt, now)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.OwnerUserId, ws.OwnerUserId)
            .SetOnInsert(x => x.WorkspaceId, wid)
            .SetOnInsert(x => x.CreatedAt, now);

        var res = await _db.ImageMasterCanvases.FindOneAndUpdateAsync<ImageMasterCanvas, ImageMasterCanvas>(
            x => x.WorkspaceId == wid,
            update,
            new FindOneAndUpdateOptions<ImageMasterCanvas, ImageMasterCanvas> { IsUpsert = true, ReturnDocument = ReturnDocument.After },
            ct);

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

        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainImageMaster, type: AppDomainPaths.TypeImg);

        // workspace+sha unique：复用已存在记录（允许不同 owner 上传同一 sha，但同 workspace 只保留一条）
        var existing = await _db.ImageAssets.Find(x => x.WorkspaceId == wid && x.Sha256 == stored.Sha256).FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            var payloadExisting = new { asset = existing };
            if (!string.IsNullOrWhiteSpace(idemKey))
            {
                var cacheKey = $"imageMaster:workspaces:assets:upload:{adminId}:{wid}:{idemKey}";
                await _cache.SetAsync(cacheKey, payloadExisting, IdemExpiry);
            }
            return Ok(ApiResponse<object>.Ok(payloadExisting));
        }

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
            CreatedAt = DateTime.UtcNow
        };
        if (asset.Prompt != null && asset.Prompt.Length > 300) asset.Prompt = asset.Prompt[..300].Trim();
        if (request?.Width is > 0 and < 20000) asset.Width = request.Width!.Value;
        if (request?.Height is > 0 and < 20000) asset.Height = request.Height!.Value;

        try
        {
            await _db.ImageAssets.InsertOneAsync(asset, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 兜底：并发写入导致冲突；按 workspace+sha 回查并返回，避免前端看到 500
            var again = await _db.ImageAssets.Find(x => x.WorkspaceId == wid && x.Sha256 == stored.Sha256).FirstOrDefaultAsync(ct);
            if (again != null)
            {
                return Ok(ApiResponse<object>.Ok(new { asset = again }));
            }
            throw;
        }
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
                await _assetStorage.DeleteByShaAsync(asset.Sha256, ct, domain: AppDomainPaths.DomainImageMaster, type: AppDomainPaths.TypeImg);
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
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainImageMaster, type: AppDomainPaths.TypeImg);

        // owner+sha unique: try find existing
        var existing = await _db.ImageAssets.Find(x => x.OwnerUserId == adminId && x.Sha256 == stored.Sha256).FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            var payloadExisting = new { asset = existing };
            if (!string.IsNullOrWhiteSpace(idemKey))
            {
                var cacheKey = $"imageMaster:assets:upload:{adminId}:{idemKey}";
                await _cache.SetAsync(cacheKey, payloadExisting, IdemExpiry);
            }
            return Ok(ApiResponse<object>.Ok(payloadExisting));
        }

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
                    AppDomainPaths.DomainImageMaster,
                    AppDomainPaths.TypeImg);
                await _assetStorage.DeleteByShaAsync(asset.Sha256, ct, domain: AppDomainPaths.DomainImageMaster, type: AppDomainPaths.TypeImg);
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

        var found = await _assetStorage.TryReadByShaAsync(sha, ct, domain: AppDomainPaths.DomainImageMaster, type: AppDomainPaths.TypeImg);
        if (found == null) return NotFound();
        return File(found.Value.bytes, found.Value.mime);
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
}

public class UpdateWorkspaceRequest
{
    public string? Title { get; set; }
    public List<string>? MemberUserIds { get; set; }
    public string? CoverAssetId { get; set; }
}

public class UploadAssetRequest
{
    public string? Data { get; set; } // dataURL/base64
    public string? SourceUrl { get; set; } // re-host external url
    public string? Prompt { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
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


