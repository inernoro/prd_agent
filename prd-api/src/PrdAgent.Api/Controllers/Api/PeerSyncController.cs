using System.Net.Http;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.PeerSync;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 系统级跨节点互传：node-to-node 数据端点（HMAC 验签）+ 用户发起互传。
/// 同一份代码每个节点既能发又能收。详见 doc/design.platform.peer-sync.md §8。
/// </summary>
[ApiController]
[Route("api/peer-sync")]
public class PeerSyncController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IPeerNodeService _peer;
    private readonly ISyncResourceRegistry _registry;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly IPeerSyncTransferService _transfer;
    private readonly IConfiguration _config;
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
        IPeerSyncTransferService transfer,
        IConfiguration config,
        ILogger<PeerSyncController> logger)
    {
        _db = db;
        _peer = peer;
        _registry = registry;
        _urlValidator = urlValidator;
        _transfer = transfer;
        _config = config;
        _logger = logger;
    }

    // ═══════════════════════════════════════════════════════════════
    // node-to-node（被对端调用，HMAC 验签 / 配对码验证）
    // ═══════════════════════════════════════════════════════════════

    /// <summary>
    /// 接收握手。
    /// 新路径：prepare 只校验配对码 + 暂存共享密钥；confirm 成功后才落 PeerNode。
    /// 旧路径：commit=true 时保持兼容，直接落 PeerNode。
    /// </summary>
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

        // PR #742 review fix：软校验前置 — 自指 / SSRF 这类配置错误不消费一次性配对码，
        // 否则管理员每次填错都要重发码。先做不需要 DB 状态的校验，再原子 claim。
        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        if (payload.InitiatorNodeId == selfNodeId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能与本节点自己配对"));

        // SSRF 校验发起方回连地址
        var initiatorBaseUrl = payload.InitiatorBaseUrl.Trim().TrimEnd('/');
        try { await _urlValidator.EnsureSafeHttpUrlAsync(initiatorBaseUrl, "peer-sync", ct); }
        catch (Exception ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"发起方地址不合法：{ex.Message}")); }

        // 原子 claim 配对码（PR #742 review fix）：FindOneAndUpdate 以「未使用 + 未过期」为条件，
        // 命中即刻把 Used 设为 true 并落 UsedByNodeId。并发 handshake 同一码只有一方拿得到，
        // 失败方拿到 null，直接 401。避免「先读后写」窗口里两个发起方各拿到不同 secret。
        var nowUtc = DateTime.UtcNow;
        var claimFilter = Builders<PeerPairingCode>.Filter.And(
            Builders<PeerPairingCode>.Filter.Eq(c => c.Id, payload.PairingCode),
            Builders<PeerPairingCode>.Filter.Eq(c => c.Used, false),
            Builders<PeerPairingCode>.Filter.Gte(c => c.ExpiresAt, nowUtc));
        var claimUpdate = Builders<PeerPairingCode>.Update
            .Set(c => c.Used, true)
            .Set(c => c.UsedByNodeId, payload.InitiatorNodeId);
        var code = await _db.PeerPairingCodes.FindOneAndUpdateAsync(
            claimFilter, claimUpdate,
            new FindOneAndUpdateOptions<PeerPairingCode> { ReturnDocument = ReturnDocument.Before },
            ct);
        if (code == null)
            return StatusCode(401, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "配对码无效、已使用或已过期"));

        var secret = PrdAgent.Infrastructure.Services.PeerNodeService.GenerateSharedSecret();
        var displayName = string.IsNullOrWhiteSpace(payload.InitiatorDisplayName)
            ? "对端节点"
            : payload.InitiatorDisplayName.Trim();

        if (!payload.Commit)
        {
            await _db.PeerPairingCodes.UpdateOneAsync(
                c => c.Id == payload.PairingCode && c.UsedByNodeId == payload.InitiatorNodeId,
                Builders<PeerPairingCode>.Update
                    .Set(c => c.PendingInitiatorBaseUrl, initiatorBaseUrl)
                    .Set(c => c.PendingInitiatorDisplayName, displayName)
                    .Set(c => c.PendingSharedSecret, secret),
                cancellationToken: ct);
        }
        else
        {
            await UpsertPeerNodeAsync(
                payload.InitiatorNodeId,
                initiatorBaseUrl,
                displayName,
                secret,
                code.CreatedBy,
                ct);
        }

        // 配对码已在上面 FindOneAndUpdate 时原子 claim，不需要再 set Used。
        var settings = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new HandshakeResult
        {
            NodeId = selfNodeId,
            DisplayName = settings?.DesktopName ?? "MAP 节点",
            SharedSecret = secret,
        }));
    }

    /// <summary>两阶段握手确认：只有 confirm 成功后，接收端才正式写入 PeerNode。</summary>
    [AllowAnonymous]
    [HttpPost("handshake/confirm")]
    public async Task<IActionResult> ConfirmHandshake([FromBody] HandshakeConfirmPayload payload, CancellationToken ct)
    {
        if (payload == null || string.IsNullOrWhiteSpace(payload.PairingCode)
            || string.IsNullOrWhiteSpace(payload.InitiatorNodeId)
            || string.IsNullOrWhiteSpace(payload.SharedSecret))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "确认请求缺少必要信息"));

        var code = await _db.PeerPairingCodes.Find(c =>
            c.Id == payload.PairingCode.Trim()
            && c.Used
            && c.UsedByNodeId == payload.InitiatorNodeId.Trim()
            && c.PendingSharedSecret == payload.SharedSecret).FirstOrDefaultAsync(ct);
        if (code == null)
            return StatusCode(401, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "握手确认无效或已失效"));

        var baseUrl = !string.IsNullOrWhiteSpace(payload.InitiatorBaseUrl)
            ? payload.InitiatorBaseUrl.Trim().TrimEnd('/')
            : code.PendingInitiatorBaseUrl?.Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(baseUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "确认请求缺少发起方地址"));
        try { await _urlValidator.EnsureSafeHttpUrlAsync(baseUrl, "peer-sync", ct); }
        catch (Exception ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"发起方地址不合法：{ex.Message}")); }

        var displayName = !string.IsNullOrWhiteSpace(payload.InitiatorDisplayName)
            ? payload.InitiatorDisplayName.Trim()
            : (string.IsNullOrWhiteSpace(code.PendingInitiatorDisplayName) ? "对端节点" : code.PendingInitiatorDisplayName!);

        var initiatorNodeId = payload.InitiatorNodeId.Trim();
        var existing = await _db.PeerNodes.Find(n => n.RemoteNodeId == initiatorNodeId).FirstOrDefaultAsync(ct);

        await UpsertPeerNodeAsync(initiatorNodeId, baseUrl!, displayName, payload.SharedSecret, code.CreatedBy, ct);
        await _db.PeerPairingCodes.UpdateOneAsync(c => c.Id == code.Id,
            Builders<PeerPairingCode>.Update
                .Set(c => c.ConfirmedAt, DateTime.UtcNow)
                .Set(c => c.PendingReplacedPeerNodeId, existing?.Id)
                .Set(c => c.PendingPreviousDisplayName, existing?.DisplayName)
                .Set(c => c.PendingPreviousBaseUrl, existing?.BaseUrl)
                .Set(c => c.PendingPreviousSharedSecret, existing?.SharedSecret)
                .Set(c => c.PendingPreviousStatus, existing?.Status)
                .Set(c => c.PendingPreviousLastError, existing?.LastError)
                .Set(c => c.PendingPreviousLastContactAt, existing?.LastContactAt)
                .Set(c => c.PendingPreviousCreatedBy, existing?.CreatedBy),
            cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { ok = true }));
    }

    /// <summary>两阶段握手完成：发起端已探活并本地落库，之后 cancel 不再允许撤销正式连接。</summary>
    [AllowAnonymous]
    [HttpPost("handshake/finalize")]
    public async Task<IActionResult> FinalizeHandshake([FromBody] HandshakeConfirmPayload payload, CancellationToken ct)
    {
        if (payload == null || string.IsNullOrWhiteSpace(payload.PairingCode)
            || string.IsNullOrWhiteSpace(payload.InitiatorNodeId)
            || string.IsNullOrWhiteSpace(payload.SharedSecret))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "完成请求缺少必要信息"));

        var code = await _db.PeerPairingCodes.Find(c =>
            c.Id == payload.PairingCode.Trim()
            && c.Used
            && c.UsedByNodeId == payload.InitiatorNodeId.Trim()
            && c.PendingSharedSecret == payload.SharedSecret
            && c.ConfirmedAt != null
            && c.FinalizedAt == null).FirstOrDefaultAsync(ct);
        if (code == null)
            return StatusCode(409, ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "握手完成请求无效或已处理"));

        await _db.PeerPairingCodes.UpdateOneAsync(c => c.Id == code.Id,
            Builders<PeerPairingCode>.Update
                .Set(c => c.FinalizedAt, DateTime.UtcNow)
                .Set(c => c.PendingSharedSecret, (string?)null)
                .Set(c => c.PendingInitiatorBaseUrl, (string?)null)
                .Set(c => c.PendingInitiatorDisplayName, (string?)null)
                .Set(c => c.PendingReplacedPeerNodeId, (string?)null)
                .Set(c => c.PendingPreviousDisplayName, (string?)null)
                .Set(c => c.PendingPreviousBaseUrl, (string?)null)
                .Set(c => c.PendingPreviousSharedSecret, (string?)null)
                .Set(c => c.PendingPreviousStatus, (string?)null)
                .Set(c => c.PendingPreviousLastError, (string?)null)
                .Set(c => c.PendingPreviousLastContactAt, (DateTime?)null)
                .Set(c => c.PendingPreviousCreatedBy, (string?)null),
            cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { finalized = true }));
    }

    /// <summary>两阶段握手失败清理：confirm 后探活失败或发起端落库失败时撤销接收端正式记录。</summary>
    [AllowAnonymous]
    [HttpPost("handshake/cancel")]
    public async Task<IActionResult> CancelHandshake([FromBody] HandshakeConfirmPayload payload, CancellationToken ct)
    {
        if (payload == null || string.IsNullOrWhiteSpace(payload.PairingCode)
            || string.IsNullOrWhiteSpace(payload.InitiatorNodeId)
            || string.IsNullOrWhiteSpace(payload.SharedSecret))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "撤销请求缺少必要信息"));

        var code = await _db.PeerPairingCodes.Find(c =>
            c.Id == payload.PairingCode.Trim()
            && c.UsedByNodeId == payload.InitiatorNodeId.Trim()
            && c.PendingSharedSecret == payload.SharedSecret
            && c.FinalizedAt == null).FirstOrDefaultAsync(ct);
        if (code == null)
            return Ok(ApiResponse<object>.Ok(new { cancelled = false }));

        if (code.ConfirmedAt != null
            && !string.IsNullOrWhiteSpace(code.PendingReplacedPeerNodeId)
            && !string.IsNullOrWhiteSpace(code.PendingPreviousSharedSecret))
        {
            await _db.PeerNodes.UpdateOneAsync(
                n => n.Id == code.PendingReplacedPeerNodeId
                    && n.RemoteNodeId == payload.InitiatorNodeId.Trim()
                    && n.SharedSecret == payload.SharedSecret,
                Builders<PeerNode>.Update
                    .Set(n => n.DisplayName, code.PendingPreviousDisplayName ?? "对端节点")
                    .Set(n => n.BaseUrl, code.PendingPreviousBaseUrl ?? string.Empty)
                    .Set(n => n.SharedSecret, code.PendingPreviousSharedSecret)
                    .Set(n => n.Status, code.PendingPreviousStatus ?? PeerNodeStatus.Connected)
                    .Set(n => n.LastError, code.PendingPreviousLastError)
                    .Set(n => n.LastContactAt, code.PendingPreviousLastContactAt)
                    .Set(n => n.CreatedBy, code.PendingPreviousCreatedBy ?? code.CreatedBy)
                    .Set(n => n.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }
        else if (code.ConfirmedAt != null)
        {
            await _db.PeerNodes.DeleteOneAsync(n =>
                n.RemoteNodeId == payload.InitiatorNodeId.Trim()
                && n.SharedSecret == payload.SharedSecret, ct);
        }
        await _db.PeerPairingCodes.UpdateOneAsync(c => c.Id == code.Id,
            Builders<PeerPairingCode>.Update
                .Set(c => c.Used, false)
                .Set(c => c.UsedByNodeId, (string?)null)
                .Set(c => c.PendingSharedSecret, (string?)null)
                .Set(c => c.PendingInitiatorBaseUrl, (string?)null)
                .Set(c => c.PendingInitiatorDisplayName, (string?)null)
                .Set(c => c.PendingReplacedPeerNodeId, (string?)null)
                .Set(c => c.PendingPreviousDisplayName, (string?)null)
                .Set(c => c.PendingPreviousBaseUrl, (string?)null)
                .Set(c => c.PendingPreviousSharedSecret, (string?)null)
                .Set(c => c.PendingPreviousStatus, (string?)null)
                .Set(c => c.PendingPreviousLastError, (string?)null)
                .Set(c => c.PendingPreviousLastContactAt, (DateTime?)null)
                .Set(c => c.PendingPreviousCreatedBy, (string?)null)
                .Set(c => c.FinalizedAt, (DateTime?)null)
                .Set(c => c.ConfirmedAt, (DateTime?)null),
            cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { cancelled = true }));
    }

    private async Task UpsertPeerNodeAsync(
        string remoteNodeId,
        string baseUrl,
        string displayName,
        string sharedSecret,
        string fallbackUser,
        CancellationToken ct)
    {
        var existing = await _db.PeerNodes.Find(n => n.RemoteNodeId == remoteNodeId).FirstOrDefaultAsync(ct);
        var displayNameToSet = string.IsNullOrWhiteSpace(displayName)
            ? (existing?.DisplayName ?? "对端节点")
            : displayName;
        await _db.PeerNodes.UpdateOneAsync(
            n => n.RemoteNodeId == remoteNodeId,
            Builders<PeerNode>.Update
                .SetOnInsert(n => n.Id, Guid.NewGuid().ToString("N"))
                .SetOnInsert(n => n.RemoteNodeId, remoteNodeId)
                .SetOnInsert(n => n.CreatedAt, DateTime.UtcNow)
                .Set(n => n.DisplayName, displayNameToSet)
                .Set(n => n.BaseUrl, baseUrl)
                .Set(n => n.SharedSecret, sharedSecret)
                .Set(n => n.Status, PeerNodeStatus.Connected)
                .Set(n => n.LastError, (string?)null)
                .Set(n => n.LastContactAt, DateTime.UtcNow)
                .Set(n => n.CreatedBy, fallbackUser)
                .Set(n => n.UpdatedAt, DateTime.UtcNow),
            new UpdateOptions { IsUpsert = true }, ct);
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

    /// <summary>取条目签名（对端变更检测）。
    /// 单向资源同样拒绝，避免对端旁路本接口拿到漂移信号反推数据存在性。</summary>
    [AllowAnonymous]
    [HttpPost("resources/{type}/signature")]
    public async Task<IActionResult> RemoteSignature(string type, CancellationToken ct)
    {
        var (node, body, error) = await VerifyPeerAsync(null, ct);
        if (error != null) return error;
        var resource = _registry.Resolve(type);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));
        if (!resource.SupportsBidirectional)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"{resource.DisplayName}是单向（push-only）资源，对端不能查询本端签名"));
        var req = Deserialize<ItemRequest>(body);
        if (req == null || string.IsNullOrWhiteSpace(req.ItemId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 itemId"));
        var sig = await resource.ComputeSignatureAsync(req.ItemId, ct);
        return Ok(ApiResponse<object>.Ok(new { signature = sig }));
    }

    /// <summary>导出条目 bundle（对端 pull 用，受信节点绕过按用户访问校验）。
    /// PR #742 review P2 fix：单向资源（SupportsBidirectional=false）禁止 export ——
    /// 用户层 transfer 已拒 pull/both，但若对端旁路直接调本端点仍可强行拉取数据。</summary>
    [AllowAnonymous]
    [HttpPost("resources/{type}/export")]
    public async Task<IActionResult> RemoteExport(string type, CancellationToken ct)
    {
        var (node, body, error) = await VerifyPeerAsync(null, ct);
        if (error != null) return error;
        var resource = _registry.Resolve(type);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));
        if (!resource.SupportsBidirectional)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"{resource.DisplayName}是单向（push-only）资源，对端不能从本节点拉取"));
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

        // PR #742 review Medium fix：URL 段 {type} 决定走哪个 handler，但 bundle 自带 ResourceType。
        // 不校验匹配，配对节点可以把知识库 bundle POST 到 /defect-agent/apply，导致 defect resource
        // 拿着文档记录硬塞 DefectReport，数据形状错位污染。要求两者一致才放行。
        if (!string.Equals(req.Bundle.ResourceType, resource.ResourceType, StringComparison.Ordinal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"bundle.resourceType={req.Bundle.ResourceType} 与端点 {resource.ResourceType} 不匹配"));

        var actor = await BuildActorAsync(node!.CreatedBy, ct);
        var mode = PeerSyncTransferService.ParseMode(req.Mode);
        _transfer.AttachPeerApplyOptions(req.Bundle, req.PreserveTimestamps ?? true, req.RewriteAssetLinks ?? true, req.SourceBaseUrl);
        var startedAt = DateTime.UtcNow;
        var outcome = await resource.ApplyAsync(req.Bundle, actor, mode, req.TargetKey, ct);
        // incoming：对端推/对齐过来。mirror 时对端是「本地为准」，本端被镜像（可能删条目）。
        var receiverDirection = mode == SyncApplyMode.Mirror ? "align-local"
            : string.Equals(req.Direction, "both", StringComparison.OrdinalIgnoreCase) ? "both" : "received";
        var success = outcome.Failed == 0 && outcome.AssetRewriteFailed == 0;
        if (!string.IsNullOrWhiteSpace(outcome.TargetItemId))
        {
            await _transfer.MarkPeerSyncAsync(resource.ResourceType, outcome.TargetItemId, success ? "synced" : "error", receiverDirection, node,
                outcome.Message, ct, updateDirection: false);
            await _transfer.RecordRunAsync(resource.ResourceType, outcome.TargetItemId, req.Bundle.Item?.Name ?? "",
                receiverDirection, PeerSyncOrigin.Incoming, node, outcome, success, node.CreatedBy, "对端节点",
                startedAt, ct);
        }
        return Ok(ApiResponse<object>.Ok(outcome));
    }

    // ═══════════════════════════════════════════════════════════════
    // 用户发起（需登录）
    // ═══════════════════════════════════════════════════════════════

    /// <summary>列出可发送的对端节点（已连接，不含 secret）+ 本节点支持的资源能力。
    /// 过滤掉 RemoteNodeId == selfNodeId 的影子记录（CDS 共享 DB 部署的产物，生产环境不会有）。</summary>
    [Authorize]
    [HttpGet("nodes")]
    public async Task<IActionResult> ListNodes(CancellationToken ct)
    {
        var selfNodeId = await _peer.GetSelfNodeIdAsync(ct);
        var nodes = await _db.PeerNodes
            .Find(n => n.Status == PeerNodeStatus.Connected && n.RemoteNodeId != selfNodeId)
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

        // 强制对齐（force-align）：remote=远端为准(pull+镜像删) / local=本地为准(push+镜像删) / both=同时对准(both,不删)。
        // 镜像删除是 MAP 知识库传输协议里唯一的数据破坏路径，前端必须二次确认后才带 align。
        var align = string.IsNullOrWhiteSpace(request.Align) ? null : request.Align!.Trim().ToLowerInvariant();
        string direction;
        SyncApplyMode mode;
        if (align != null)
        {
            if (align is not ("remote" or "local" or "both"))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "对齐模式无效（remote/local/both）"));
            if (!resource.SupportsBidirectional)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"{resource.DisplayName}是单向资源，不支持强制对齐"));
            direction = align == "remote" ? "pull" : align == "local" ? "push" : "both";
            mode = align == "both" ? SyncApplyMode.Overwrite : SyncApplyMode.Mirror;
        }
        else
        {
            direction = (request.Direction ?? "push").Trim().ToLowerInvariant();
            if (direction is not ("push" or "pull" or "both"))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方向无效（push/pull/both）"));
            // PR #742 review P2：非双向资源拒绝 pull/both，否则 push-only 的 DefectSyncResource 等会被绕过状态机
            // 反向 import 对端数据（例如把对端的 resolved 缺陷拉回本地覆盖本地未结的状态）。
            if (!resource.SupportsBidirectional && direction != "push")
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"{resource.DisplayName}是单向（push-only）资源，不支持 {direction}"));
            mode = request.Mode == "add-only" ? SyncApplyMode.AddOnly : SyncApplyMode.Overwrite;
        }
        // 运行台账里记录的「方向/动作」：对齐用 align-*，普通走 push/pull/both。
        var runDirection = align != null ? $"align-{align}" : direction;

        var actor = await BuildActorAsync(this.GetRequiredUserId(), ct);
        var sourceBaseUrl = GetRequestBaseUrl();

        // PR #742 Review High：授权门——每个 itemId 必须出现在 actor 自己的 ListItemsAsync 结果里。
        // 这一道门同时拦：(a) 越权 push 自己看不到的条目；(b) pull 到不存在/不可写的目标 store/project。
        // ListItemsAsync 已经按 actor 视角做了访问过滤，此处用集合判定，资源层不必再各自重复鉴权。
        var allowedItems = await resource.ListItemsAsync(actor, ct);
        var allowedSet = allowedItems.Select(i => i.ItemId).ToHashSet(StringComparer.Ordinal);
        var itemNames = allowedItems.GroupBy(i => i.ItemId).ToDictionary(g => g.Key, g => g.First().Name, StringComparer.Ordinal);

        var results = new List<object>();
        var anyFail = false;
        // PR #742 review Medium fix：跟踪是否真的与对端发生过成功的 HTTP 通信。
        // 之前总是 bump LastContactAt，即便全部 itemId 在本地（无权访问 / Export 返回 null）就失败、
        // 一次都没真正联系对端。LastContactAt 语义是"最近成功通信"（与 admin ping test 对齐），不该被误更新。
        var anyPeerContact = false;
        // 本次手动 transfer 的租约持有者标识（区别于 worker 的实例 id）。
        var manualLeaseOwner = $"manual:{this.GetRequiredUserId()}:{Guid.NewGuid():N}";
        var isDocStore = string.Equals(resource.ResourceType, "document-store", StringComparison.Ordinal);
        foreach (var itemId in request.ItemIds.Distinct())
        {
            if (!allowedSet.Contains(itemId))
            {
                results.Add(new { itemId, ok = false, message = "无权访问该条目（不在你的可访问范围内）" });
                anyFail = true;
                continue;
            }
            // 与自动同步 worker 共用同一把库级互斥锁：抢不到说明该库正被后台自动同步 / 他人手动同步占用，
            // 直接跳过，避免同库并发同步（尤其手动 mirror 删除与自动 overwrite 交错损坏数据，Bugbot）。
            // 与 worker 共用同一 TTL（30min，足以覆盖单库最坏同步耗时，防大库超时后被并发抢锁）。
            var leased = isDocStore && await _transfer.TryAcquireStoreSyncLeaseAsync(itemId, manualLeaseOwner, Services.PeerSync.PeerSyncScheduleWorker.LeaseDuration, ct);
            if (isDocStore && !leased)
            {
                results.Add(new { itemId, ok = false, message = "该知识库正在同步中（后台自动或他人手动），请稍后重试" });
                anyFail = true;
                continue;
            }
            try
            {
                // per-item 两阶段同步核心已抽到 IPeerSyncTransferService（与自动同步 worker 共用同一条路径）。
                // 注意：StartRun 的台账方向用 runDirection（align-* 区分对齐），状态回写/网络用 direction。
                var r = await _transfer.SyncItemAsync(
                    node, resource, itemId, itemNames.GetValueOrDefault(itemId, string.Empty),
                    direction, runDirection, mode, actor,
                    request.PreserveTimestamps ?? true, request.RewriteAssetLinks ?? true, sourceBaseUrl, ct);
                if (r.AnyPeerContact) anyPeerContact = true;
                if (!r.Ok) anyFail = true;
                results.Add(new { itemId, ok = r.Ok, message = r.Message, created = r.Created, updated = r.Updated, skipped = r.Skipped, deleted = r.Deleted, failed = r.Failed, assetsRewritten = r.AssetsRewritten, assetRewriteFailed = r.AssetRewriteFailed });
            }
            finally
            {
                if (isDocStore) await _transfer.ReleaseStoreSyncLeaseAsync(itemId, manualLeaseOwner, ct);
            }
        }

        // 仅在至少有一次真正与对端 HTTP 通信成功时才 bump LastContactAt（与 admin ping test 同口径），
        // 否则字段会变成"最近 transfer 尝试时间"——偏离原文档的"最近成功通信"语义。
        var nodeUpdate = anyPeerContact
            ? Builders<PeerNode>.Update.Set(n => n.LastContactAt, DateTime.UtcNow).Set(n => n.UpdatedAt, DateTime.UtcNow)
            : Builders<PeerNode>.Update.Set(n => n.UpdatedAt, DateTime.UtcNow);
        await _db.PeerNodes.UpdateOneAsync(n => n.Id == node.Id, nodeUpdate, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { direction, results, anyFail }));
    }

    /// <summary>同步中心：列出运行台账（当前状态 / 失败处理 / 接收审计 / 历史，前端按 origin/direction/status 分组）。
    /// itemId 为空 = 该用户全部可见条目的记录；否则限定单条目（带访问校验）。</summary>
    [Authorize]
    [HttpGet("runs")]
    public async Task<IActionResult> ListRuns(
        [FromQuery] string resourceType, [FromQuery] string? itemId, [FromQuery] int limit, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(resourceType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 resourceType"));
        var resource = _registry.Resolve(resourceType);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));
        var actor = await BuildActorAsync(this.GetRequiredUserId(), ct);
        var allowed = (await resource.ListItemsAsync(actor, ct)).Select(i => i.ItemId).ToHashSet(StringComparer.Ordinal);

        var take = limit is <= 0 or > 200 ? 80 : limit;
        var filter = Builders<PeerSyncRun>.Filter.Eq(r => r.ResourceType, resourceType);
        if (!string.IsNullOrWhiteSpace(itemId))
        {
            if (!allowed.Contains(itemId))
                return Ok(ApiResponse<object>.Ok(new { items = Array.Empty<PeerSyncRun>() }));
            filter &= Builders<PeerSyncRun>.Filter.Eq(r => r.ItemId, itemId);
        }
        else
        {
            filter &= Builders<PeerSyncRun>.Filter.In(r => r.ItemId, allowed);
        }
        var runs = await _db.PeerSyncRuns.Find(filter).SortByDescending(r => r.StartedAt).Limit(take).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items = runs }));
    }

    /// <summary>
    /// 开/关某知识库的「后台自动同步」。开启后 PeerSyncScheduleWorker 按周期复用该库最近一次同步的
    /// 对端 + 方向，自动跑 push/pull/both（非破坏性，绝不删条目）。仅 document-store 支持。
    /// 必须先手动同步过一次（确定对端 + 方向）才能开启 —— 避免凭空向某个对端发流量。
    /// </summary>
    [Authorize]
    [HttpPost("auto-sync")]
    public async Task<IActionResult> SetAutoSync([FromBody] AutoSyncRequest request, CancellationToken ct)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.ResourceType) || string.IsNullOrWhiteSpace(request.ItemId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 resourceType 或 itemId"));
        if (!string.Equals(request.ResourceType, "document-store", StringComparison.Ordinal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "目前仅知识库支持后台自动同步"));

        var resource = _registry.Resolve(request.ResourceType);
        if (resource == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "资源类型未注册"));

        // 鉴权：itemId 必须在 actor 自己的可访问范围内（与 transfer 同口径）。
        var actor = await BuildActorAsync(this.GetRequiredUserId(), ct);
        var allowed = (await resource.ListItemsAsync(actor, ct)).Select(i => i.ItemId).ToHashSet(StringComparer.Ordinal);
        if (!allowed.Contains(request.ItemId))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "条目不存在或无权访问"));

        var store = await _db.DocumentStores.Find(s => s.Id == request.ItemId).FirstOrDefaultAsync(ct);
        if (store == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));

        if (request.Enabled && (string.IsNullOrWhiteSpace(store.PeerSyncNodeId) || string.IsNullOrWhiteSpace(store.PeerSyncDirection)))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                "请先手动同步一次（确定对端节点与方向）后，再开启后台自动同步"));

        var interval = PeerSyncSchedule.ClampInterval(request.IntervalMinutes);
        await _db.DocumentStores.UpdateOneAsync(s => s.Id == request.ItemId,
            Builders<DocumentStore>.Update
                .Set(s => s.PeerSyncAutoEnabled, request.Enabled)
                .Set(s => s.PeerSyncIntervalMinutes, interval),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            enabled = request.Enabled,
            intervalMinutes = interval,
            direction = store.PeerSyncDirection,
            nodeName = store.PeerSyncNodeName,
        }));
    }

    // ═══════════════════════════════════════════════════════════════
    // 内部辅助
    // ═══════════════════════════════════════════════════════════════

    private string GetRequestBaseUrl()
    {
        var envBase = Environment.GetEnvironmentVariable("PEER_SELF_BASE_URL");
        if (!string.IsNullOrWhiteSpace(envBase))
            return envBase.Trim().TrimEnd('/');
        return Request.ResolveServerUrl(_config).TrimEnd('/');
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

    /// <summary>
    /// 构建用户发起端点的同步操作者：isRoot 取自 JWT claims（PeerSyncController 非 admin controller，
    /// permissions claim 多半为空），其余有效权限由 IPeerSyncTransferService.BuildActorAsync 走中间件同款数据源补齐。
    /// 接收端点（RemoteApply）以 node.CreatedBy 调用：此时 User 是 HMAC/匿名上下文，isRoot 自然为 false。
    /// </summary>
    private Task<SyncActor> BuildActorAsync(string userId, CancellationToken ct)
    {
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal)
            || string.Equals(User.FindFirst("isAiSuperAccess")?.Value, "1", StringComparison.Ordinal);
        // 把 JWT 里的 permissions claims 作为兜底传下去：GetEffectivePermissionsAsync 瞬时失败时
        // 退回 claims，避免 super-via-permission 用户被误判为普通用户（Bugbot）。
        var claimsPerms = User.FindAll("permissions").Select(c => c.Value).ToList();
        return _transfer.BuildActorAsync(userId, isRoot, ct, claimsPerms);
    }

    private static T? Deserialize<T>(string body) where T : class
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try { return JsonSerializer.Deserialize<T>(body, JsonOpts); } catch { return null; }
    }

    // ── DTO ──
    public class HandshakePayload
    {
        public string PairingCode { get; set; } = string.Empty;
        public string InitiatorNodeId { get; set; } = string.Empty;
        public string InitiatorBaseUrl { get; set; } = string.Empty;
        public string InitiatorDisplayName { get; set; } = string.Empty;
        public bool Commit { get; set; } = true;
    }

    public class HandshakeConfirmPayload
    {
        public string PairingCode { get; set; } = string.Empty;
        public string InitiatorNodeId { get; set; } = string.Empty;
        public string? InitiatorBaseUrl { get; set; }
        public string? InitiatorDisplayName { get; set; }
        public string SharedSecret { get; set; } = string.Empty;
    }

    public class HandshakeResult
    {
        public string NodeId { get; set; } = string.Empty;
        public string? DisplayName { get; set; }
        public string SharedSecret { get; set; } = string.Empty;
    }

    public class AutoSyncRequest
    {
        public string? ResourceType { get; set; }
        public string? ItemId { get; set; }
        public bool Enabled { get; set; }
        /// <summary>同步周期（分钟）。null = 默认 60；服务端会夹到 [5, +∞)。</summary>
        public int? IntervalMinutes { get; set; }
    }

}
