using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
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
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct);

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

    [HttpGet("assets/file/{name}")]
    [AllowAnonymous] // 仅图片文件读取，不返回敏感信息；但依赖 sha 不可猜测（64 hex）
    public async Task<IActionResult> GetAssetFile(string name, CancellationToken ct)
    {
        var n = (name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(n)) return NotFound();
        var dot = n.IndexOf('.');
        var sha = dot > 0 ? n[..dot] : n;
        if (sha.Length != 64) return NotFound();

        var found = await _assetStorage.TryReadByShaAsync(sha, ct);
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

public class UploadAssetRequest
{
    public string? Data { get; set; } // dataURL/base64
    public string? SourceUrl { get; set; } // re-host external url
    public string? Prompt { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }
}


