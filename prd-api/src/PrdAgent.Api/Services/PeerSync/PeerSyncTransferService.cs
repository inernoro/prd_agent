using System.Net.Http;
using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.PeerSync;

/// <summary>
/// 跨节点互传的「per-item 核心 + 网络/台账/归属辅助」单一实现（SSOT）。
///
/// 历史上这段逻辑全在 PeerSyncController 里，且内嵌了大量 PR #742 review 的安全修正
/// （先推后拉、bundle.resourceType 校验、LastContactAt 语义、归属权限取数等）。
/// 自动同步（PeerSyncScheduleWorker）必须复用同一条路径，绝不能复制一份让两边漂移
/// （遵守 compute-then-send：发送阶段只接收已解析的 node/resource/actor/mode，不再二次决策）。
/// 因此把它抽到本服务，Controller 的手动 transfer 与 worker 的自动 transfer 都调它。
/// 仅 Request-bound 的部分（HMAC 验签、读 body、本机 URL 解析）留在 Controller。
/// </summary>
public interface IPeerSyncTransferService
{
    /// <summary>按 userId 构建同步操作者上下文（含 system role + allow-deny 的有效权限集）。</summary>
    Task<SyncActor> BuildActorAsync(string userId, bool isRoot, CancellationToken ct);

    /// <summary>
    /// 同步单个条目（push / pull / both 的完整两阶段 + 运行台账 + 状态回写）。
    /// 调用方负责前置鉴权（itemId 在 actor 可访问范围内）。本方法不再做方向/模式决策。
    /// </summary>
    Task<PeerItemSyncResult> SyncItemAsync(
        PeerNode node, ISyncableResource resource, string itemId, string itemName,
        string direction, string runDirection, SyncApplyMode mode, SyncActor actor,
        bool preserveTimestamps, bool rewriteAssetLinks, string? sourceBaseUrl,
        CancellationToken ct);

    /// <summary>把对端 apply 选项塞进 bundle.Extras（保留原时间 / 重写资源链接 / 源站地址）。</summary>
    void AttachPeerApplyOptions(SyncResourceBundle bundle, bool preserveTimestamps, bool rewriteAssetLinks, string? sourceBaseUrl);

    /// <summary>把 document-store 的 peer 同步状态回写到 DocumentStore（仅该资源消费）。</summary>
    Task MarkPeerSyncAsync(string resourceType, string? itemId, string status, string direction, PeerNode node, string? result, CancellationToken ct);

    /// <summary>一次性落一条 incoming 运行台账（对端 apply 过来，无两阶段进行中）。</summary>
    Task RecordRunAsync(
        string resourceType, string itemId, string itemName, string direction, string origin,
        PeerNode node, SyncApplyOutcome outcome, bool success,
        string triggeredByUserId, string? triggeredByName, DateTime startedAt, CancellationToken ct);
}

/// <summary>单条目同步的聚合结果（供 Controller 拼响应、worker 写状态）。</summary>
public sealed class PeerItemSyncResult
{
    public bool Ok { get; set; }
    /// <summary>本条目是否至少与对端成功 HTTP 通信过一次（用于 bump LastContactAt）。</summary>
    public bool AnyPeerContact { get; set; }
    public int Created { get; set; }
    public int Updated { get; set; }
    public int Skipped { get; set; }
    public int Deleted { get; set; }
    public int Failed { get; set; }
    public int AssetsRewritten { get; set; }
    public int AssetRewriteFailed { get; set; }
    public string Message { get; set; } = string.Empty;
}

public sealed class PeerSyncTransferService : IPeerSyncTransferService
{
    private readonly MongoDbContext _db;
    private readonly IPeerNodeService _peer;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly IHttpClientFactory _httpFactory;
    private readonly IAdminPermissionService _permissionService;
    private readonly ILogger<PeerSyncTransferService> _logger;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public PeerSyncTransferService(
        MongoDbContext db,
        IPeerNodeService peer,
        ISafeOutboundUrlValidator urlValidator,
        IHttpClientFactory httpFactory,
        IAdminPermissionService permissionService,
        ILogger<PeerSyncTransferService> logger)
    {
        _db = db;
        _peer = peer;
        _urlValidator = urlValidator;
        _httpFactory = httpFactory;
        _permissionService = permissionService;
        _logger = logger;
    }

    public async Task<PeerItemSyncResult> SyncItemAsync(
        PeerNode node, ISyncableResource resource, string itemId, string itemName,
        string direction, string runDirection, SyncApplyMode mode, SyncActor actor,
        bool preserveTimestamps, bool rewriteAssetLinks, string? sourceBaseUrl,
        CancellationToken ct)
    {
        var itemStartedAt = DateTime.UtcNow;
        var result = new PeerItemSyncResult();
        string? runId = null;
        try
        {
            // 先落「进行中」运行台账，再开干 —— 这样另一个浏览器 tab / 同步中心轮询能看到 in-progress（动起来）。
            // 台账方向用 runDirection（区分 align-*），状态回写/网络用 direction（push/pull/both）。
            runId = await StartRunAsync(resource.ResourceType, itemId, itemName, runDirection, node, actor, itemStartedAt, ct);
            await MarkPeerSyncAsync(resource.ResourceType, itemId, "syncing", direction, node, "正在跨系统同步", ct);

            // PR #742 review fix：每条目独立 ok 标记。Push 或 Pull 任一阶段 outcome.Failed>0、
            // outcome 为 null（对端返回无效）、bundle 为 null 都判失败，前端可正确标红、不再误显示"成功"。
            var perItem = new List<string>();
            var itemOk = true;
            var pushOk = true;
            var created = 0;
            var updated = 0;
            var skipped = 0;
            var deleted = 0;
            var failed = 0;
            var assetsRewritten = 0;
            var assetRewriteFailed = 0;
            if (direction is "push" or "both")
            {
                var bundle = await resource.ExportAsync(itemId, actor, ct);
                if (bundle == null)
                {
                    await MarkPeerSyncAsync(resource.ResourceType, itemId, "error", direction, node, "本地条目不存在或无权访问", ct);
                    await FinishRunAsync(runId, PeerSyncRunStatus.Error, 0, 0, 0, 0, 1, 0, 0, "本地条目不存在或无权访问", itemStartedAt, ct);
                    result.Ok = false;
                    result.Failed = 1;
                    result.Message = "本地条目不存在或无权访问";
                    return result;
                }
                AttachPeerApplyOptions(bundle, preserveTimestamps, rewriteAssetLinks, sourceBaseUrl);
                var outcome = await PushToPeerAsync(node, resource.ResourceType, bundle, itemId, mode, direction, preserveTimestamps, rewriteAssetLinks, sourceBaseUrl, ct);
                // outcome != null = 已收到对端 HTTP 响应 = 通信成功（即便 Failed>0 也算"通"了）
                if (outcome == null)
                {
                    perItem.Add("发送 失败（对端返回无效）");
                    itemOk = false;
                    pushOk = false;
                }
                else
                {
                    result.AnyPeerContact = true;
                    perItem.Add("发送 " + (outcome.Message ?? "完成"));
                    created += outcome.Created;
                    updated += outcome.Updated;
                    skipped += outcome.Skipped;
                    deleted += outcome.Deleted;
                    failed += outcome.Failed;
                    assetsRewritten += outcome.AssetsRewritten;
                    assetRewriteFailed += outcome.AssetRewriteFailed;
                    if (outcome.Failed > 0 || outcome.AssetRewriteFailed > 0) { itemOk = false; pushOk = false; }
                }
            }
            // PR #742 review High：both 模式下若 push 失败仍跑 pull 会用对端覆盖本地未推上去的改动 ——
            // 用户的本地编辑可能被丢。语义应为「先推后拉，推不通就不拉」，避免静默数据丢失。
            if (direction == "pull" || (direction == "both" && pushOk))
            {
                var bundle = await PullFromPeerAsync(node, resource.ResourceType, itemId, ct);
                if (bundle == null)
                {
                    var message = string.Join("；", perItem.Append("拉取 失败（对端条目不存在或不可达）"));
                    await MarkPeerSyncAsync(resource.ResourceType, itemId, "error", direction, node, message, ct);
                    await FinishRunAsync(runId, PeerSyncRunStatus.Error, created, updated, skipped, deleted, failed + 1, assetsRewritten, assetRewriteFailed, message, itemStartedAt, ct);
                    result.Ok = false;
                    result.Created = created; result.Updated = updated; result.Skipped = skipped;
                    result.Deleted = deleted; result.Failed = failed + 1;
                    result.AssetsRewritten = assetsRewritten; result.AssetRewriteFailed = assetRewriteFailed;
                    result.Message = message;
                    return result;
                }
                // PR #742 review P2 fix：对称 RemoteApply 的类型校验 — 旧版/定制的对端或路由错配
                // 可能回 bundle.ResourceType 与本地请求的不一致，直接 ApplyAsync 会用错 handler 污染数据。
                if (!string.Equals(bundle.ResourceType, resource.ResourceType, StringComparison.Ordinal))
                {
                    var message = string.Join("；", perItem.Append($"拉取 失败（对端 bundle.resourceType={bundle.ResourceType} 与请求 {resource.ResourceType} 不匹配）"));
                    await MarkPeerSyncAsync(resource.ResourceType, itemId, "error", direction, node, message, ct);
                    await FinishRunAsync(runId, PeerSyncRunStatus.Error, created, updated, skipped, deleted, failed + 1, assetsRewritten, assetRewriteFailed, message, itemStartedAt, ct);
                    result.Ok = false;
                    result.Created = created; result.Updated = updated; result.Skipped = skipped;
                    result.Deleted = deleted; result.Failed = failed + 1;
                    result.AssetsRewritten = assetsRewritten; result.AssetRewriteFailed = assetRewriteFailed;
                    result.Message = message;
                    return result;
                }
                result.AnyPeerContact = true; // bundle != null = 对端 HTTP 200 应答 = 通信成功
                AttachPeerApplyOptions(bundle, preserveTimestamps, rewriteAssetLinks, node.BaseUrl);
                var outcome = await resource.ApplyAsync(bundle, actor, mode, itemId, ct);
                perItem.Add("拉取 " + (outcome.Message ?? "完成"));
                created += outcome.Created;
                updated += outcome.Updated;
                skipped += outcome.Skipped;
                deleted += outcome.Deleted;
                failed += outcome.Failed;
                assetsRewritten += outcome.AssetsRewritten;
                assetRewriteFailed += outcome.AssetRewriteFailed;
                if (outcome.Failed > 0 || outcome.AssetRewriteFailed > 0) { itemOk = false; }
            }
            else if (direction == "both" && !pushOk)
            {
                perItem.Add("拉取 已跳过（push 未成功，避免对端覆盖本地未推上去的改动）");
            }
            var summary = string.Join("；", perItem);
            await MarkPeerSyncAsync(resource.ResourceType, itemId, itemOk ? "synced" : "error", direction, node, summary, ct);
            // 没有任何增删改 = 跳过，台账标 skipped 让「发出去/历史」一眼看出本轮无变化。
            var runStatus = !itemOk ? PeerSyncRunStatus.Error
                : (created == 0 && updated == 0 && deleted == 0) ? PeerSyncRunStatus.Skipped
                : PeerSyncRunStatus.Synced;
            await FinishRunAsync(runId, runStatus, created, updated, skipped, deleted, failed, assetsRewritten, assetRewriteFailed, summary, itemStartedAt, ct);
            result.Ok = itemOk;
            result.Created = created; result.Updated = updated; result.Skipped = skipped;
            result.Deleted = deleted; result.Failed = failed;
            result.AssetsRewritten = assetsRewritten; result.AssetRewriteFailed = assetRewriteFailed;
            result.Message = summary;
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[peer-sync] transfer item {ItemId} failed", itemId);
            await MarkPeerSyncAsync(resource.ResourceType, itemId, "error", direction, node, ex.Message, ct);
            await FinishRunAsync(runId, PeerSyncRunStatus.Error, 0, 0, 0, 0, 1, 0, 0, ex.Message, itemStartedAt, ct);
            result.Ok = false;
            result.Failed = 1;
            result.Message = ex.Message;
            return result;
        }
    }

    public void AttachPeerApplyOptions(
        SyncResourceBundle bundle,
        bool preserveTimestamps,
        bool rewriteAssetLinks,
        string? sourceBaseUrl)
    {
        bundle.Item.Extras ??= new Dictionary<string, JsonElement>();
        bundle.Item.Extras["peerApplyOptions"] = JsonSerializer.SerializeToElement(new
        {
            preserveTimestamps,
            rewriteAssetLinks,
            sourceBaseUrl,
        }, JsonOpts);
    }

    public async Task MarkPeerSyncAsync(
        string resourceType,
        string? itemId,
        string status,
        string direction,
        PeerNode node,
        string? result,
        CancellationToken ct)
    {
        if (!string.Equals(resourceType, "document-store", StringComparison.Ordinal) || string.IsNullOrWhiteSpace(itemId))
            return;

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == itemId,
            Builders<DocumentStore>.Update
                .Set(s => s.PeerSyncStatus, status)
                .Set(s => s.PeerSyncDirection, direction)
                .Set(s => s.PeerSyncNodeId, node.RemoteNodeId)
                .Set(s => s.PeerSyncNodeName, node.DisplayName)
                .Set(s => s.PeerSyncNodeBaseUrl, node.BaseUrl)
                .Set(s => s.PeerSyncLastAt, DateTime.UtcNow)
                .Set(s => s.PeerSyncLastResult, result),
            cancellationToken: ct);
    }

    public static SyncApplyMode ParseMode(string? mode) => mode switch
    {
        "mirror" => SyncApplyMode.Mirror,
        "add-only" => SyncApplyMode.AddOnly,
        _ => SyncApplyMode.Overwrite,
    };

    public static string ModeToString(SyncApplyMode mode) => mode switch
    {
        SyncApplyMode.Mirror => "mirror",
        SyncApplyMode.AddOnly => "add-only",
        _ => "overwrite",
    };

    private async Task<string> StartRunAsync(
        string resourceType, string itemId, string itemName, string direction,
        PeerNode node, SyncActor actor, DateTime startedAt, CancellationToken ct)
    {
        var run = new PeerSyncRun
        {
            ResourceType = resourceType,
            ItemId = itemId,
            ItemName = itemName,
            Direction = direction,
            Origin = PeerSyncOrigin.Outgoing,
            PeerNodeId = node.RemoteNodeId,
            PeerNodeName = node.DisplayName,
            PeerNodeBaseUrl = node.BaseUrl,
            Status = PeerSyncRunStatus.Syncing,
            TriggeredByUserId = actor.UserId,
            TriggeredByName = actor.UserName,
            StartedAt = startedAt,
        };
        await _db.PeerSyncRuns.InsertOneAsync(run, cancellationToken: ct);
        return run.Id;
    }

    private async Task FinishRunAsync(
        string? runId, string status, int created, int updated, int skipped, int deleted,
        int failed, int assetsRewritten, int assetRewriteFailed, string? message,
        DateTime startedAt, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(runId)) return;
        var now = DateTime.UtcNow;
        await _db.PeerSyncRuns.UpdateOneAsync(r => r.Id == runId,
            Builders<PeerSyncRun>.Update
                .Set(r => r.Status, status)
                .Set(r => r.Created, created)
                .Set(r => r.Updated, updated)
                .Set(r => r.Skipped, skipped)
                .Set(r => r.Deleted, deleted)
                .Set(r => r.Failed, failed)
                .Set(r => r.AssetsRewritten, assetsRewritten)
                .Set(r => r.AssetRewriteFailed, assetRewriteFailed)
                .Set(r => r.Message, message)
                .Set(r => r.DurationMs, (int)Math.Max(0, (now - startedAt).TotalMilliseconds))
                .Set(r => r.FinishedAt, now),
            cancellationToken: ct);
    }

    public async Task RecordRunAsync(
        string resourceType, string itemId, string itemName, string direction, string origin,
        PeerNode node, SyncApplyOutcome outcome, bool success,
        string triggeredByUserId, string? triggeredByName, DateTime startedAt, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var status = !success ? PeerSyncRunStatus.Error
            : (outcome.Created == 0 && outcome.Updated == 0 && outcome.Deleted == 0) ? PeerSyncRunStatus.Skipped
            : PeerSyncRunStatus.Synced;
        var run = new PeerSyncRun
        {
            ResourceType = resourceType,
            ItemId = itemId,
            ItemName = itemName,
            Direction = direction,
            Origin = origin,
            PeerNodeId = node.RemoteNodeId,
            PeerNodeName = node.DisplayName,
            PeerNodeBaseUrl = node.BaseUrl,
            Status = status,
            Created = outcome.Created,
            Updated = outcome.Updated,
            Skipped = outcome.Skipped,
            Deleted = outcome.Deleted,
            Failed = outcome.Failed,
            AssetsRewritten = outcome.AssetsRewritten,
            AssetRewriteFailed = outcome.AssetRewriteFailed,
            Message = outcome.Message,
            TriggeredByUserId = triggeredByUserId,
            TriggeredByName = triggeredByName,
            DurationMs = (int)Math.Max(0, (now - startedAt).TotalMilliseconds),
            StartedAt = startedAt,
            FinishedAt = now,
        };
        await _db.PeerSyncRuns.InsertOneAsync(run, cancellationToken: ct);
    }

    private async Task<SyncApplyOutcome?> PushToPeerAsync(
        PeerNode node,
        string type,
        SyncResourceBundle bundle,
        string targetKey,
        SyncApplyMode mode,
        string direction,
        bool preserveTimestamps,
        bool rewriteAssetLinks,
        string? sourceBaseUrl,
        CancellationToken ct)
    {
        var payload = new ApplyRequest
        {
            Bundle = bundle,
            TargetKey = targetKey,
            Mode = ModeToString(mode),
            Direction = direction,
            PreserveTimestamps = preserveTimestamps,
            RewriteAssetLinks = rewriteAssetLinks,
            SourceBaseUrl = sourceBaseUrl,
        };
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

        var client = _httpFactory.CreateClient("PeerSync");
        client.Timeout = TimeSpan.FromSeconds(120);
        using var resp = await SendSignedPeerRequestAsync(client, node, method, baseLeft, path, bodyStr, selfNodeId, ts, sign, ct);
        var json = await resp.Content.ReadAsStringAsync(ct);
        return (resp.IsSuccessStatusCode, json, (int)resp.StatusCode);
    }

    private async Task<HttpResponseMessage> SendSignedPeerRequestAsync(
        HttpClient client,
        PeerNode node,
        HttpMethod method,
        string baseUrl,
        string path,
        string bodyStr,
        string selfNodeId,
        string ts,
        string sign,
        CancellationToken ct)
    {
        HttpRequestMessage BuildRequest(string requestUrl)
        {
            var req = new HttpRequestMessage(method, requestUrl);
            req.Headers.TryAddWithoutValidation("X-Peer-Node", selfNodeId);
            req.Headers.TryAddWithoutValidation("X-Peer-Ts", ts);
            req.Headers.TryAddWithoutValidation("X-Peer-Sign", sign);
            if (!string.IsNullOrEmpty(bodyStr))
                req.Content = new StringContent(bodyStr, Encoding.UTF8, "application/json");
            return req;
        }

        var url = baseUrl + path;
        var resp = await client.SendAsync(BuildRequest(url), ct);
        if (!PeerSyncRedirectHelper.IsRedirect(resp.StatusCode))
            return resp;

        if (!PeerSyncRedirectHelper.TryBuildSameHostHttpsRedirect(
                new Uri(url), resp.Headers.Location, path,
                out var redirectedBaseUrl, out var redirectedUrl, out var reason))
            return resp;

        await _urlValidator.EnsureSafeHttpUrlAsync(redirectedBaseUrl, "peer-sync", ct);
        _logger.LogInformation("[peer-sync] normalized peer call baseUrl via redirect {NodeId}: {Original} -> {Redirected}",
            node.RemoteNodeId, baseUrl, redirectedBaseUrl);
        resp.Dispose();

        var redirectedResp = await client.SendAsync(BuildRequest(redirectedUrl), ct);
        if (redirectedResp.IsSuccessStatusCode && !string.Equals(node.BaseUrl, redirectedBaseUrl, StringComparison.Ordinal))
        {
            await _db.PeerNodes.UpdateOneAsync(n => n.Id == node.Id,
                Builders<PeerNode>.Update
                    .Set(n => n.BaseUrl, redirectedBaseUrl)
                    .Set(n => n.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            node.BaseUrl = redirectedBaseUrl;
        }
        return redirectedResp;
    }

    public async Task<SyncActor> BuildActorAsync(string userId, bool isRoot, CancellationToken ct)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        var name = user != null && !string.IsNullOrWhiteSpace(user.DisplayName) ? user.DisplayName
            : (user?.Username ?? "同步");

        // PR #742 review P2 fix：用 IAdminPermissionService.GetEffectivePermissionsAsync 取
        // system role + allow - deny 的有效权限集（与 AdminPermissionMiddleware 同款数据源），
        // 保证资源层得到的 actor 视角准确（PeerSyncController 非 admin controller，claims 里多半没有 permissions）。
        IReadOnlyCollection<string> perms;
        try
        {
            var list = await _permissionService.GetEffectivePermissionsAsync(userId, isRoot, ct);
            perms = list.ToHashSet(StringComparer.Ordinal);
        }
        catch
        {
            perms = new HashSet<string>(StringComparer.Ordinal);
        }
        var isSuper = isRoot || perms.Contains(AdminPermissionCatalog.Super);
        return new SyncActor(userId, name, user?.Email, IsAdmin: isSuper, Permissions: perms);
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
}

// ── 跨节点互传 DTO（原 PeerSyncController 内嵌，抽出供 Controller + 本服务共用）──

public class ItemRequest { public string ItemId { get; set; } = string.Empty; }

public class ApplyRequest
{
    public SyncResourceBundle? Bundle { get; set; }
    public string? TargetKey { get; set; }
    public string? Mode { get; set; }
    public string? Direction { get; set; }
    public bool? PreserveTimestamps { get; set; }
    public bool? RewriteAssetLinks { get; set; }
    public string? SourceBaseUrl { get; set; }
}

public class TransferRequest
{
    public string? NodeId { get; set; }
    public string? ResourceType { get; set; }
    public List<string>? ItemIds { get; set; }
    public string? Direction { get; set; }
    public string? Mode { get; set; }
    /// <summary>强制对齐：remote（远端为准）/ local（本地为准）/ both（同时对准）。设置后覆盖 Direction/Mode。</summary>
    public string? Align { get; set; }
    public bool? PreserveTimestamps { get; set; }
    public bool? RewriteAssetLinks { get; set; }
}
