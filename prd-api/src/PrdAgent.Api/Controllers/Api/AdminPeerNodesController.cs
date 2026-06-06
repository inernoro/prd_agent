using System.Net.Http;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 系统互联（跨节点互传）管理端 —— 管理员配置对端节点、生成配对码、握手、解除配对。
/// 「设置 → 系统互联」页面的后端入口。详见 doc/design.peer-sync.md §8。
/// </summary>
[ApiController]
[Route("api/admin/peer-nodes")]
[Authorize]
[AdminController("peer-sync", AdminPermissionCatalog.PeerSyncManage,
    WritePermission = AdminPermissionCatalog.PeerSyncManage)]
public class AdminPeerNodesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IPeerNodeService _peer;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<AdminPeerNodesController> _logger;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public AdminPeerNodesController(
        MongoDbContext db,
        IPeerNodeService peer,
        ISafeOutboundUrlValidator urlValidator,
        IHttpClientFactory httpFactory,
        ILogger<AdminPeerNodesController> logger)
    {
        _db = db;
        _peer = peer;
        _urlValidator = urlValidator;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private string SelfBaseUrl(string? overrideUrl)
        => !string.IsNullOrWhiteSpace(overrideUrl)
            ? overrideUrl!.TrimEnd('/')
            : $"{Request.Scheme}://{Request.Host}{Request.PathBase}".TrimEnd('/');

    /// <summary>列出已配对节点 + 本节点标识（不返回 SharedSecret）。</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        var nodes = await _db.PeerNodes.Find(_ => true).SortByDescending(n => n.UpdatedAt).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            selfNodeId,
            selfBaseUrl = SelfBaseUrl(null),
            items = nodes.Select(ToDto).ToList(),
        }));
    }

    /// <summary>生成一次性配对码（5 分钟有效，供对端管理员粘贴）。</summary>
    [HttpPost("pairing-code")]
    public async Task<IActionResult> GeneratePairingCode(CancellationToken ct)
    {
        var code = PeerNodeService.GeneratePairingCode();
        await _db.PeerPairingCodes.InsertOneAsync(new PeerPairingCode
        {
            Id = code,
            CreatedBy = GetUserId(),
            ExpiresAt = DateTime.UtcNow.AddMinutes(5),
        }, cancellationToken: ct);
        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            pairingCode = code,
            expiresInSeconds = 300,
            selfNodeId,
            selfBaseUrl = SelfBaseUrl(null),
        }));
    }

    /// <summary>添加对端节点：填对端 baseUrl + 对端生成的配对码，触发握手建立互信。</summary>
    [HttpPost]
    public async Task<IActionResult> Add([FromBody] AddPeerRequest request, CancellationToken ct)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.BaseUrl) || string.IsNullOrWhiteSpace(request.PairingCode))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请填写对端地址和配对码"));

        var baseUrl = request.BaseUrl.Trim().TrimEnd('/');
        Uri baseUri;
        try { baseUri = await _urlValidator.EnsureSafeHttpUrlAsync(baseUrl, "peer-sync", ct); }
        catch (Exception ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"对端地址不合法：{ex.Message}")); }

        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        var selfBaseUrl = SelfBaseUrl(request.SelfBaseUrl);

        // 向对端发起握手（配对码鉴权，未握手前无共享密钥，故 handshake 端点本身 AllowAnonymous）
        var handshakeBody = new HandshakePayload
        {
            PairingCode = request.PairingCode.Trim(),
            InitiatorNodeId = selfNodeId,
            InitiatorBaseUrl = selfBaseUrl,
            InitiatorDisplayName = string.IsNullOrWhiteSpace(request.SelfDisplayName) ? "对端 MAP 节点" : request.SelfDisplayName!.Trim(),
        };
        var baseLeft = baseUri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        var url = $"{baseLeft}/api/peer-sync/handshake";

        HandshakeResult? result;
        try
        {
            var client = _httpFactory.CreateClient("PeerSync");
            client.Timeout = TimeSpan.FromSeconds(30);
            var content = new StringContent(JsonSerializer.Serialize(handshakeBody, JsonOpts), Encoding.UTF8, "application/json");
            using var resp = await client.PostAsync(url, content, ct);
            var json = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[peer-sync] handshake failed {Status}: {Body}", resp.StatusCode, json);
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    $"对端握手失败（HTTP {(int)resp.StatusCode}）：配对码可能已过期或对端不可达"));
            }
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "对端握手响应格式不正确"));
            result = JsonSerializer.Deserialize<HandshakeResult>(data.GetRawText(), JsonOpts);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[peer-sync] handshake request error to {Url}", url);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"无法连接对端：{ex.Message}"));
        }

        if (result == null || string.IsNullOrWhiteSpace(result.NodeId) || string.IsNullOrWhiteSpace(result.SharedSecret))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "对端握手未返回有效凭据"));

        if (result.NodeId == selfNodeId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能与本节点自己配对"));

        // 落本端 PeerNode（指向对端 B）
        var existing = await _db.PeerNodes.Find(n => n.RemoteNodeId == result.NodeId).FirstOrDefaultAsync(ct);
        var displayName = string.IsNullOrWhiteSpace(request.DisplayName)
            ? (string.IsNullOrWhiteSpace(result.DisplayName) ? "对端节点" : result.DisplayName!)
            : request.DisplayName!.Trim();
        if (existing != null)
        {
            await _db.PeerNodes.UpdateOneAsync(n => n.Id == existing.Id,
                Builders<PeerNode>.Update
                    .Set(n => n.DisplayName, displayName)
                    .Set(n => n.BaseUrl, baseUrl)
                    .Set(n => n.SharedSecret, result.SharedSecret)
                    .Set(n => n.Status, PeerNodeStatus.Connected)
                    .Set(n => n.LastError, (string?)null)
                    .Set(n => n.LastContactAt, DateTime.UtcNow)
                    .Set(n => n.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
            var reloaded = await _db.PeerNodes.Find(n => n.Id == existing.Id).FirstOrDefaultAsync(ct);
            return Ok(ApiResponse<object>.Ok(ToDto(reloaded!)));
        }

        var node = new PeerNode
        {
            RemoteNodeId = result.NodeId,
            DisplayName = displayName,
            BaseUrl = baseUrl,
            SharedSecret = result.SharedSecret,
            Status = PeerNodeStatus.Connected,
            LastContactAt = DateTime.UtcNow,
            CreatedBy = GetUserId(),
        };
        await _db.PeerNodes.InsertOneAsync(node, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(ToDto(node)));
    }

    /// <summary>测试连通性（HMAC 签名 ping 对端）。</summary>
    [HttpPost("{id}/test")]
    public async Task<IActionResult> Test(string id, CancellationToken ct)
    {
        var node = await _db.PeerNodes.Find(n => n.Id == id).FirstOrDefaultAsync(ct);
        if (node == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对端节点不存在"));

        try
        {
            var baseUri = await _urlValidator.EnsureSafeHttpUrlAsync(node.BaseUrl, "peer-sync", ct);
            var baseLeft = baseUri.GetLeftPart(UriPartial.Path).TrimEnd('/');
            const string path = "/api/peer-sync/ping";
            var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
            var (ts, sign) = _peer.Sign(node.SharedSecret, "GET", path, string.Empty);
            var client = _httpFactory.CreateClient("PeerSync");
            client.Timeout = TimeSpan.FromSeconds(20);
            var req = new HttpRequestMessage(HttpMethod.Get, baseLeft + path);
            req.Headers.TryAddWithoutValidation("X-Peer-Node", selfNodeId);
            req.Headers.TryAddWithoutValidation("X-Peer-Ts", ts);
            req.Headers.TryAddWithoutValidation("X-Peer-Sign", sign);
            using var resp = await client.SendAsync(req, ct);
            var ok = resp.IsSuccessStatusCode;
            await _db.PeerNodes.UpdateOneAsync(n => n.Id == id,
                Builders<PeerNode>.Update
                    .Set(n => n.Status, ok ? PeerNodeStatus.Connected : PeerNodeStatus.Error)
                    .Set(n => n.LastError, ok ? null : $"ping 返回 HTTP {(int)resp.StatusCode}")
                    .Set(n => n.LastContactAt, ok ? DateTime.UtcNow : node.LastContactAt)
                    .Set(n => n.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
            return Ok(ApiResponse<object>.Ok(new { ok, status = (int)resp.StatusCode }));
        }
        catch (Exception ex)
        {
            await _db.PeerNodes.UpdateOneAsync(n => n.Id == id,
                Builders<PeerNode>.Update.Set(n => n.Status, PeerNodeStatus.Error)
                    .Set(n => n.LastError, ex.Message).Set(n => n.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
            return Ok(ApiResponse<object>.Ok(new { ok = false, error = ex.Message }));
        }
    }

    /// <summary>解除配对（删除本端记录；对端残留需对端管理员手动删，见 debt.peer-sync.md）。</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var node = await _db.PeerNodes.Find(n => n.Id == id).FirstOrDefaultAsync(ct);
        if (node == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对端节点不存在"));
        await _db.PeerNodes.DeleteOneAsync(n => n.Id == id, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    private static object ToDto(PeerNode n) => new
    {
        n.Id,
        n.RemoteNodeId,
        n.DisplayName,
        n.BaseUrl,
        n.Status,
        n.LastError,
        n.LastContactAt,
        n.CreatedAt,
        n.UpdatedAt,
    };

    // ── DTO ──
    public class AddPeerRequest
    {
        public string? BaseUrl { get; set; }
        public string? PairingCode { get; set; }
        public string? DisplayName { get; set; }      // 我方给对端起的名字（如「正式环境」）
        public string? SelfBaseUrl { get; set; }       // 本节点对外地址（默认从请求推断）
        public string? SelfDisplayName { get; set; }   // 对端将用此名字称呼本节点
    }

    // 与 PeerSyncController.HandshakePayload / HandshakeResult 对应（同进程内复用同结构）
    public class HandshakePayload
    {
        public string PairingCode { get; set; } = string.Empty;
        public string InitiatorNodeId { get; set; } = string.Empty;
        public string InitiatorBaseUrl { get; set; } = string.Empty;
        public string InitiatorDisplayName { get; set; } = string.Empty;
    }

    public class HandshakeResult
    {
        public string NodeId { get; set; } = string.Empty;
        public string? DisplayName { get; set; }
        public string SharedSecret { get; set; } = string.Empty;
    }
}
