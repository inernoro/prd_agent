using System.Net.Http;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 系统级跨节点互传：node-to-node 数据端点（HMAC 验签）+ 用户发起互传。
/// 同一份代码每个节点既能发又能收。详见 doc/design.peer-sync.md §8。
/// </summary>
[ApiController]
[Route("api/peer-sync")]
public class PeerSyncController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IPeerNodeService _peer;
    private readonly ISyncResourceRegistry _registry;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<PeerSyncController> _logger;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public PeerSyncController(
        MongoDbContext db,
        IPeerNodeService peer,
        ISyncResourceRegistry registry,
        ISafeOutboundUrlValidator urlValidator,
        IHttpClientFactory httpFactory,
        ILogger<PeerSyncController> logger)
    {
        _db = db;
        _peer = peer;
        _registry = registry;
        _urlValidator = urlValidator;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    // ═══════════════════════════════════════════════════════════════
    // node-to-node（被对端调用，HMAC 验签 / 配对码验证）
    // ═══════════════════════════════════════════════════════════════

    /// <summary>接收握手：校验配对码 → 生成共享密钥 → 落 PeerNode(发起方) → 返回密钥。</summary>
    [AllowAnonymous]
    [HttpPost("handshake")]
    public async Task<IActionResult> Handshake(CancellationToken ct)
    {
        var body = await ReadBodyAsync();
        HandshakePayload? payload;
        try { payload = JsonSerializer.Deserialize<HandshakePayload>(body, JsonOpts); }
        catch { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "握手请求格式不正确")); }
        if (payload == null || string.IsNullOrWhiteSpace(payload.PairingCode)
            || string.IsNullOrWhiteSpace(payload.InitiatorNodeId) || string.IsNullOrWhiteSpace(payload.InitiatorBaseUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "握手请求缺少必要信息"));

        var code = await _db.PeerPairingCodes.Find(c => c.Id == payload.PairingCode).FirstOrDefaultAsync(ct);
        if (code == null || code.Used || code.ExpiresAt < DateTime.UtcNow)
            return StatusCode(401, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "配对码无效或已过期"));

        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        if (payload.InitiatorNodeId == selfNodeId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能与本节点自己配对"));

        // SSRF 校验发起方回连地址
        var initiatorBaseUrl = payload.InitiatorBaseUrl.Trim().TrimEnd('/');
        try { await _urlValidator.EnsureSafeHttpUrlAsync(initiatorBaseUrl, "peer-sync", ct); }
        catch (Exception ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"发起方地址不合法：{ex.Message}")); }

        var secret = PrdAgent.Infrastructure.Services.PeerNodeService.GenerateSharedSecret();
        var existing = await _db.PeerNodes.Find(n => n.RemoteNodeId == payload.InitiatorNodeId).FirstOrDefaultAsync(ct);
        // 握手发起方/接受方都用配对管理员；接受方无登录上下文，用配对码创建者作为兜底归属操作者。
        var fallbackUser = code.CreatedBy;
        if (existing != null)
        {
            await _db.PeerNodes.UpdateOneAsync(n => n.Id == existing.Id,
                Builders<PeerNode>.Update
                    .Set(n => n.DisplayName, string.IsNullOrWhiteSpace(payload.InitiatorDisplayName) ? existing.DisplayName : payload.InitiatorDisplayName)
                    .Set(n => n.BaseUrl, initiatorBaseUrl)
                    .Set(n => n.SharedSecret, secret)
                    .Set(n => n.Status, PeerNodeStatus.Connected)
                    .Set(n => n.LastError, (string?)null)
                    .Set(n => n.LastContactAt, DateTime.UtcNow)
                    .Set(n => n.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
        }
        else
        {
            await _db.PeerNodes.InsertOneAsync(new PeerNode
            {
                RemoteNodeId = payload.InitiatorNodeId,
                DisplayName = string.IsNullOrWhiteSpace(payload.InitiatorDisplayName) ? "对端节点" : payload.InitiatorDisplayName,
                BaseUrl = initiatorBaseUrl,
                SharedSecret = secret,
                Status = PeerNodeStatus.Connected,
                LastContactAt = DateTime.UtcNow,
                CreatedBy = fallbackUser,
            }, cancellationToken: ct);
        }

        await _db.PeerPairingCodes.UpdateOneAsync(c => c.Id == code.Id,
            Builders<PeerPairingCode>.Update.Set(c => c.Used, true).Set(c => c.UsedByNodeId, payload.InitiatorNodeId),
            cancellationToken: ct);

        var settings = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new HandshakeResult
        {
            NodeId = selfNodeId,
            DisplayName = settings?.DesktopName ?? "MAP 节点",
            SharedSecret = secret,
        }));
    }

    /// <summary>连通 + 验签自检。</summary>
    [AllowAnonymous]
    [HttpGet("ping")]
    public async Task<IActionResult> Ping(CancellationToken ct)
    {
        var (node, _, error) = await VerifyPeerAsync(string.Empty, ct);
        if (error != null) return error;
        return Ok(ApiResponse<object>.Ok(new { ok = true, node = node!.RemoteNodeId }));
    }

    /// <summary>本节点支持的资源类型。</summary>
    [AllowAnonymous]
    [HttpGet("capabilities")]
    public async Task<IActionResult> Capabilities(CancellationToken ct)
    {
        var (_, _, error) = await VerifyPeerAsync(string.Empty, ct);
        if (error != null) return error;
        return Ok(ApiResponse<object>.Ok(new { items = _registry.Capabilities }));
    }

    /// <summary>取条目签名（对端变更检测）。</summary>
    [AllowAnonymous]
    [HttpPost("resources/{type}/signature")]
    public async Task<IActionResult> RemoteSignature(string type, CancellationToken ct)
    {
        var (node, body, error) = await VerifyPeerAsync(null, ct);
        if (error != null) return error;
        var resource = _registry.Resolve(type);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));
        var req = Deserialize<ItemRequest>(body);
        if (req == null || string.IsNullOrWhiteSpace(req.ItemId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 itemId"));
        var sig = await resource.ComputeSignatureAsync(req.ItemId, ct);
        return Ok(ApiResponse<object>.Ok(new { signature = sig }));
    }

    /// <summary>导出条目 bundle（对端 pull 用，受信节点绕过按用户访问校验）。</summary>
    [AllowAnonymous]
    [HttpPost("resources/{type}/export")]
    public async Task<IActionResult> RemoteExport(string type, CancellationToken ct)
    {
        var (node, body, error) = await VerifyPeerAsync(null, ct);
        if (error != null) return error;
        var resource = _registry.Resolve(type);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));
        var req = Deserialize<ItemRequest>(body);
        if (req == null || string.IsNullOrWhiteSpace(req.ItemId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 itemId"));
        var bundle = await resource.ExportAsync(req.ItemId, SyncActor.PeerSystem, ct);
        if (bundle == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "条目不存在"));
        return Ok(ApiResponse<object>.Ok(bundle));
    }

    /// <summary>应用 bundle（对端 push 用）。归属兜底用配对管理员。</summary>
    [AllowAnonymous]
    [HttpPost("resources/{type}/apply")]
    public async Task<IActionResult> RemoteApply(string type, CancellationToken ct)
    {
        var (node, body, error) = await VerifyPeerAsync(null, ct);
        if (error != null) return error;
        var resource = _registry.Resolve(type);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));
        var req = Deserialize<ApplyRequest>(body);
        if (req == null || req.Bundle == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 bundle"));

        var actor = await BuildActorAsync(node!.CreatedBy, ct);
        var mode = req.Mode == "add-only" ? SyncApplyMode.AddOnly : SyncApplyMode.Overwrite;
        var outcome = await resource.ApplyAsync(req.Bundle, actor, mode, req.TargetKey, ct);
        return Ok(ApiResponse<object>.Ok(outcome));
    }

    // ═══════════════════════════════════════════════════════════════
    // 用户发起（需登录）
    // ═══════════════════════════════════════════════════════════════

    /// <summary>列出可发送的对端节点（已连接，不含 secret）+ 本节点支持的资源能力。</summary>
    [Authorize]
    [HttpGet("nodes")]
    public async Task<IActionResult> ListNodes(CancellationToken ct)
    {
        var nodes = await _db.PeerNodes.Find(n => n.Status == PeerNodeStatus.Connected)
            .SortBy(n => n.DisplayName).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            items = nodes.Select(n => new { n.Id, n.RemoteNodeId, n.DisplayName, n.BaseUrl, n.Status }).ToList(),
            capabilities = _registry.Capabilities,
        }));
    }

    /// <summary>列出本节点当前用户可发送的某类资源条目。</summary>
    [Authorize]
    [HttpGet("resources/{type}/items")]
    public async Task<IActionResult> ListItems(string type, CancellationToken ct)
    {
        var resource = _registry.Resolve(type);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));
        var actor = await BuildActorAsync(this.GetRequiredUserId(), ct);
        var items = await resource.ListItemsAsync(actor, ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>发起互传：push（本地→对端）/ pull（对端→本地）/ both（双向，仅双向资源）。</summary>
    [Authorize]
    [HttpPost("transfer")]
    public async Task<IActionResult> Transfer([FromBody] TransferRequest request, CancellationToken ct)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.NodeId)
            || string.IsNullOrWhiteSpace(request.ResourceType) || request.ItemIds == null || request.ItemIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择对端节点、资源类型和至少一个条目"));

        var node = await _db.PeerNodes.Find(n => n.Id == request.NodeId && n.Status == PeerNodeStatus.Connected)
            .FirstOrDefaultAsync(ct);
        if (node == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "对端节点不存在或未连接"));

        // 防自指：对端 RemoteNodeId 等于本节点 selfNodeId（共享 DB 误配等）→ 拒绝，避免同 DB 自互传。
        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        if (node.RemoteNodeId == selfNodeId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该对端实际指向本节点自己（同 nodeId / 共享数据库），不能互传"));

        var resource = _registry.Resolve(request.ResourceType);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));

        var direction = (request.Direction ?? "push").Trim().ToLowerInvariant();
        if (direction is not ("push" or "pull" or "both"))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方向无效（push/pull/both）"));
        if (direction == "both" && !resource.SupportsBidirectional)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"{resource.DisplayName}不支持双向同步"));

        var mode = request.Mode == "add-only" ? SyncApplyMode.AddOnly : SyncApplyMode.Overwrite;
        var actor = await BuildActorAsync(this.GetRequiredUserId(), ct);

        var results = new List<object>();
        var anyFail = false;
        foreach (var itemId in request.ItemIds.Distinct())
        {
            try
            {
                var perItem = new List<string>();
                if (direction is "push" or "both")
                {
                    var bundle = await resource.ExportAsync(itemId, actor, ct);
                    if (bundle == null) { results.Add(new { itemId, ok = false, message = "本地条目不存在或无权访问" }); anyFail = true; continue; }
                    var outcome = await PushToPeerAsync(node, resource.ResourceType, bundle, itemId, mode, ct);
                    perItem.Add("发送 " + (outcome?.Message ?? "完成"));
                    if (outcome == null || outcome.Failed > 0) anyFail = true;
                }
                if (direction is "pull" or "both")
                {
                    var bundle = await PullFromPeerAsync(node, resource.ResourceType, itemId, ct);
                    if (bundle == null) { results.Add(new { itemId, ok = false, message = "对端条目不存在或不可达" }); anyFail = true; continue; }
                    var outcome = await resource.ApplyAsync(bundle, actor, mode, itemId, ct);
                    perItem.Add("拉取 " + (outcome.Message ?? "完成"));
                    if (outcome.Failed > 0) anyFail = true;
                }
                results.Add(new { itemId, ok = true, message = string.Join("；", perItem) });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[peer-sync] transfer item {ItemId} failed", itemId);
                results.Add(new { itemId, ok = false, message = ex.Message });
                anyFail = true;
            }
        }

        await _db.PeerNodes.UpdateOneAsync(n => n.Id == node.Id,
            Builders<PeerNode>.Update.Set(n => n.LastContactAt, DateTime.UtcNow).Set(n => n.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { direction, results, anyFail }));
    }

    // ═══════════════════════════════════════════════════════════════
    // 内部辅助
    // ═══════════════════════════════════════════════════════════════

    private async Task<SyncApplyOutcome?> PushToPeerAsync(PeerNode node, string type, SyncResourceBundle bundle, string targetKey, SyncApplyMode mode, CancellationToken ct)
    {
        var payload = new ApplyRequest { Bundle = bundle, TargetKey = targetKey, Mode = mode == SyncApplyMode.AddOnly ? "add-only" : "overwrite" };
        var (ok, json, status) = await CallPeerAsync(node, HttpMethod.Post, $"/api/peer-sync/resources/{type}/apply", payload, ct);
        if (!ok) throw new InvalidOperationException($"对端 apply 失败（HTTP {status}）");
        return ExtractData<SyncApplyOutcome>(json);
    }

    private async Task<SyncResourceBundle?> PullFromPeerAsync(PeerNode node, string type, string itemId, CancellationToken ct)
    {
        var payload = new ItemRequest { ItemId = itemId };
        var (ok, json, status) = await CallPeerAsync(node, HttpMethod.Post, $"/api/peer-sync/resources/{type}/export", payload, ct);
        if (!ok) return null;
        return ExtractData<SyncResourceBundle>(json);
    }

    /// <summary>带 HMAC 签名调用对端（SSRF 校验 + 保留 base 子路径）。</summary>
    private async Task<(bool ok, string json, int status)> CallPeerAsync(PeerNode node, HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var baseUri = await _urlValidator.EnsureSafeHttpUrlAsync(node.BaseUrl, "peer-sync", ct);
        var baseLeft = baseUri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        var bodyStr = body != null ? JsonSerializer.Serialize(body, JsonOpts) : string.Empty;
        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        var (ts, sign) = _peer.Sign(node.SharedSecret, method.Method, path, bodyStr);

        var req = new HttpRequestMessage(method, baseLeft + path);
        req.Headers.TryAddWithoutValidation("X-Peer-Node", selfNodeId);
        req.Headers.TryAddWithoutValidation("X-Peer-Ts", ts);
        req.Headers.TryAddWithoutValidation("X-Peer-Sign", sign);
        if (body != null)
            req.Content = new StringContent(bodyStr, Encoding.UTF8, "application/json");

        var client = _httpFactory.CreateClient("PeerSync");
        client.Timeout = TimeSpan.FromSeconds(120);
        using var resp = await client.SendAsync(req, ct);
        var json = await resp.Content.ReadAsStringAsync(ct);
        return (resp.IsSuccessStatusCode, json, (int)resp.StatusCode);
    }

    /// <summary>
    /// 校验对端请求签名。expectedBody 传 null 时读取并返回原始 body 参与验签（POST 用）；
    /// 传 string.Empty 表示无 body（GET 用）。失败返回 error IActionResult。
    /// </summary>
    private async Task<(PeerNode? node, string body, IActionResult? error)> VerifyPeerAsync(string? expectedBody, CancellationToken ct)
    {
        var body = expectedBody ?? await ReadBodyAsync();
        if (!Request.Headers.TryGetValue("X-Peer-Node", out var nodeIdVals)
            || !Request.Headers.TryGetValue("X-Peer-Ts", out var tsVals)
            || !Request.Headers.TryGetValue("X-Peer-Sign", out var signVals))
            return (null, body, Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "缺少节点签名头")));

        var remoteNodeId = nodeIdVals.ToString();
        // 防自指（shared-DB / 配置错误兜底）：发起方 nodeId 等于本节点 selfNodeId 时直接拒绝，
        // 避免在共享数据库部署下发生「自己签自己」的伪互传。
        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        if (remoteNodeId == selfNodeId)
            return (null, body, Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "不能与本节点自己同步（同 nodeId）")));

        var node = await _db.PeerNodes.Find(n => n.RemoteNodeId == remoteNodeId).FirstOrDefaultAsync(ct);
        if (node == null || string.IsNullOrEmpty(node.SharedSecret))
            return (null, body, Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未知或未配对的节点")));

        var path = Request.Path.Value ?? string.Empty;
        if (!_peer.Verify(node.SharedSecret, Request.Method, path, body, tsVals.ToString(), signVals.ToString()))
            return (null, body, Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "签名校验失败")));

        return (node, body, null);
    }

    private async Task<string> ReadBodyAsync()
    {
        Request.EnableBuffering();
        Request.Body.Position = 0;
        using var reader = new StreamReader(Request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        var body = await reader.ReadToEndAsync();
        Request.Body.Position = 0;
        return body;
    }

    private async Task<SyncActor> BuildActorAsync(string userId, CancellationToken ct)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        var name = user != null && !string.IsNullOrWhiteSpace(user.DisplayName) ? user.DisplayName
            : (user?.Username ?? "同步");
        return new SyncActor(userId, name, user?.Email);
    }

    private static T? Deserialize<T>(string body) where T : class
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try { return JsonSerializer.Deserialize<T>(body, JsonOpts); } catch { return null; }
    }

    private static T? ExtractData<T>(string json) where T : class
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("data", out var data))
                return JsonSerializer.Deserialize<T>(data.GetRawText(), JsonOpts);
        }
        catch { /* ignore */ }
        return null;
    }

    // ── DTO ──
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

    public class ItemRequest { public string ItemId { get; set; } = string.Empty; }

    public class ApplyRequest
    {
        public SyncResourceBundle? Bundle { get; set; }
        public string? TargetKey { get; set; }
        public string? Mode { get; set; }
    }

    public class TransferRequest
    {
        public string? NodeId { get; set; }
        public string? ResourceType { get; set; }
        public List<string>? ItemIds { get; set; }
        public string? Direction { get; set; }
        public string? Mode { get; set; }
    }
}
