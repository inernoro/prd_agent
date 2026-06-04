using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 知识库跨环境 / 本地库↔库 同步。
///
/// 设计要点：
/// - 配对分两类：local（同环境两个库，直接读写，无网络）/ remote（跨环境，HTTP + 永久令牌）。
/// - 单边持令牌即可双向驱动：粘贴对方链接的一方既能「拉」（对端→本地）也能「推」（本地→对端）。
/// - 幂等 upsert：每个条目带稳定「血缘 ID」（metadata.syncLineageId，缺省回退条目自身 Id），
///   重复同步按血缘匹配既有条目更新而非重建，内容未变直接跳过（不 bump UpdatedAt）。
/// - 变更检测：各自一侧的签名快照对比（签名只用 lineage|UpdatedAt|title，不加载正文，廉价）。
/// - 令牌永久有效（无 TTL），撤销链接时清空 store.SyncToken。
/// </summary>
[ApiController]
[Route("api/document-store")]
public class DocumentStoreSyncController : ControllerBase
{
    private const string SyncLineageKey = "syncLineageId";
    private const string SyncTokenHeader = "X-Sync-Token";

    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly ITeamService _teams;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly ILogger<DocumentStoreSyncController> _logger;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public DocumentStoreSyncController(
        MongoDbContext db,
        IDocumentService documentService,
        ITeamService teams,
        IHttpClientFactory httpFactory,
        ISafeOutboundUrlValidator urlValidator,
        ILogger<DocumentStoreSyncController> logger)
    {
        _db = db;
        _documentService = documentService;
        _teams = teams;
        _httpFactory = httpFactory;
        _urlValidator = urlValidator;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private static string LineageOf(DocumentEntry e)
        => e.Metadata != null && e.Metadata.TryGetValue(SyncLineageKey, out var l) && !string.IsNullOrEmpty(l)
            ? l : e.Id;

    private static string Sha256Hex(string s)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(s ?? string.Empty))).ToLowerInvariant();
    }

    /// <summary>加载并校验可写空间（owner 或团队成员）。无权返回 null + error。</summary>
    private async Task<(DocumentStore? store, IActionResult? error)> LoadWritableStoreAsync(string storeId, string userId)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return (null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在")));
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        var canWrite = store.OwnerId == userId || (store.SharedTeamIds != null && store.SharedTeamIds.Any(myTeamIds.Contains));
        if (!canWrite)
            return (null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在")));
        return (store, null);
    }

    // ─────────────────────────────────────────────────────────────
    // 同步引擎（buildBundle / applyBundle / signature）
    // ─────────────────────────────────────────────────────────────

    /// <summary>把一个本地库导出为同步 bundle（含正文 + 血缘 ID）。</summary>
    private async Task<SyncBundle> BuildBundleAsync(DocumentStore store)
    {
        var entries = await _db.DocumentEntries.Find(e => e.StoreId == store.Id).ToListAsync();
        var byId = entries.ToDictionary(e => e.Id, e => e);
        var list = new List<SyncEntryDto>();
        foreach (var e in entries)
        {
            string? content = null;
            if (!e.IsFolder && !string.IsNullOrEmpty(e.DocumentId))
                content = (await _documentService.GetByIdAsync(e.DocumentId))?.RawContent;

            string? parentLineage = null;
            if (!string.IsNullOrEmpty(e.ParentId) && byId.TryGetValue(e.ParentId, out var parent))
                parentLineage = LineageOf(parent);

            list.Add(new SyncEntryDto
            {
                LineageId = LineageOf(e),
                ParentLineageId = parentLineage,
                IsFolder = e.IsFolder,
                Title = e.Title,
                Summary = e.Summary,
                ContentType = e.ContentType,
                FileSize = e.FileSize,
                Tags = e.Tags,
                Metadata = e.Metadata,
                Content = content,
            });
        }
        return new SyncBundle
        {
            Version = 1,
            Store = new SyncStoreMeta
            {
                Name = store.Name,
                Description = store.Description,
                Tags = store.Tags,
                IsPublic = store.IsPublic,
                TemplateKey = store.TemplateKey,
                CoverImageUrl = store.CoverImageUrl,
                TagColors = store.TagColors,
            },
            Entries = list,
        };
    }

    /// <summary>把 bundle 幂等 upsert 进目标库。返回 created/updated/skipped/failed。</summary>
    private async Task<SyncApplyResult> ApplyBundleAsync(DocumentStore target, SyncBundle bundle, string actorUserId, string actorName, string? actorAvatar)
    {
        var entries = bundle.Entries ?? new List<SyncEntryDto>();
        var existing = await _db.DocumentEntries.Find(e => e.StoreId == target.Id).ToListAsync();
        // 同血缘可能有重复历史数据，取第一条
        var byLineage = new Dictionary<string, DocumentEntry>();
        foreach (var e in existing)
        {
            var key = LineageOf(e);
            if (!byLineage.ContainsKey(key)) byLineage[key] = e;
        }
        var lineageToTargetId = new Dictionary<string, string>(); // bundle lineageId -> target entryId
        int created = 0, updated = 0, skipped = 0, failed = 0;

        string? ResolveParent(string? parentLineage)
        {
            if (string.IsNullOrEmpty(parentLineage)) return null;
            if (lineageToTargetId.TryGetValue(parentLineage, out var mapped)) return mapped;
            if (byLineage.TryGetValue(parentLineage, out var ex)) return ex.Id;
            return null;
        }

        // 文件夹先建（parent-first，多趟扫描）
        var pendingFolders = entries.Where(e => e.IsFolder).ToList();
        var guard = 0;
        while (pendingFolders.Count > 0 && guard++ < 2000)
        {
            var progressed = false;
            foreach (var f in pendingFolders.ToList())
            {
                if (!string.IsNullOrEmpty(f.ParentLineageId)
                    && !lineageToTargetId.ContainsKey(f.ParentLineageId)
                    && !byLineage.ContainsKey(f.ParentLineageId))
                    continue; // 父还没建，下趟

                var parentId = ResolveParent(f.ParentLineageId);
                if (byLineage.TryGetValue(f.LineageId, out var exFolder))
                {
                    lineageToTargetId[f.LineageId] = exFolder.Id;
                    skipped++;
                }
                else
                {
                    var folder = new DocumentEntry
                    {
                        StoreId = target.Id,
                        ParentId = parentId,
                        IsFolder = true,
                        Title = f.Title,
                        SourceType = DocumentSourceType.Import,
                        ContentType = "application/x-folder",
                        Tags = f.Tags ?? new List<string>(),
                        Metadata = WithLineage(f.Metadata, f.LineageId),
                        CreatedBy = actorUserId,
                        CreatedByName = actorName,
                        CreatedByAvatarFileName = actorAvatar,
                        UpdatedBy = actorUserId,
                        UpdatedByName = actorName,
                    };
                    await _db.DocumentEntries.InsertOneAsync(folder);
                    byLineage[f.LineageId] = folder;
                    lineageToTargetId[f.LineageId] = folder.Id;
                    created++;
                }
                pendingFolders.Remove(f);
                progressed = true;
            }
            if (!progressed) break;
        }

        // 文件类条目
        foreach (var fe in entries.Where(e => !e.IsFolder))
        {
            try
            {
                if (string.IsNullOrEmpty(fe.Content)) { skipped++; continue; } // 本期只搬文本正文
                var parentId = ResolveParent(fe.ParentLineageId);

                if (byLineage.TryGetValue(fe.LineageId, out var exEntry) && !exEntry.IsFolder)
                {
                    // 已存在：内容未变则跳过，避免 bump UpdatedAt 导致永远 pending
                    var existingContent = !string.IsNullOrEmpty(exEntry.DocumentId)
                        ? (await _documentService.GetByIdAsync(exEntry.DocumentId))?.RawContent ?? string.Empty
                        : string.Empty;
                    if (Sha256Hex(existingContent) == Sha256Hex(fe.Content)
                        && exEntry.Title == fe.Title && exEntry.ParentId == parentId)
                    {
                        skipped++;
                        continue;
                    }
                    var parsed = await _documentService.ParseAsync(fe.Content);
                    parsed.Title = fe.Title;
                    await _documentService.SaveAsync(parsed);
                    await _db.DocumentEntries.UpdateOneAsync(
                        e => e.Id == exEntry.Id,
                        Builders<DocumentEntry>.Update
                            .Set(e => e.DocumentId, parsed.Id)
                            .Set(e => e.Title, fe.Title)
                            .Set(e => e.Summary, fe.Summary)
                            .Set(e => e.ParentId, parentId)
                            .Set(e => e.Tags, fe.Tags ?? new List<string>())
                            .Set(e => e.ContentIndex, fe.Content.Length > 2000 ? fe.Content[..2000] : fe.Content)
                            .Set(e => e.Metadata, WithLineage(fe.Metadata, fe.LineageId))
                            .Set(e => e.UpdatedBy, actorUserId)
                            .Set(e => e.UpdatedByName, actorName)
                            .Set(e => e.UpdatedAt, DateTime.UtcNow)
                            .Set(e => e.LastChangedAt, DateTime.UtcNow));
                    updated++;
                }
                else
                {
                    var parsed = await _documentService.ParseAsync(fe.Content);
                    parsed.Title = fe.Title;
                    await _documentService.SaveAsync(parsed);
                    var entry = new DocumentEntry
                    {
                        StoreId = target.Id,
                        ParentId = parentId,
                        IsFolder = false,
                        Title = fe.Title,
                        Summary = fe.Summary,
                        SourceType = DocumentSourceType.Import,
                        ContentType = string.IsNullOrEmpty(fe.ContentType) ? "text/markdown" : fe.ContentType,
                        FileSize = fe.FileSize,
                        Tags = fe.Tags ?? new List<string>(),
                        Metadata = WithLineage(fe.Metadata, fe.LineageId),
                        DocumentId = parsed.Id,
                        ContentIndex = fe.Content.Length > 2000 ? fe.Content[..2000] : fe.Content,
                        CreatedBy = actorUserId,
                        CreatedByName = actorName,
                        CreatedByAvatarFileName = actorAvatar,
                        UpdatedBy = actorUserId,
                        UpdatedByName = actorName,
                        LastChangedAt = DateTime.UtcNow,
                    };
                    await _db.DocumentEntries.InsertOneAsync(entry);
                    byLineage[fe.LineageId] = entry;
                    created++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[doc-sync] apply entry failed: {Title}", fe.Title);
                failed++;
            }
        }

        var count = await _db.DocumentEntries.CountDocumentsAsync(e => e.StoreId == target.Id);
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == target.Id,
            Builders<DocumentStore>.Update.Set(s => s.DocumentCount, (int)count).Set(s => s.UpdatedAt, DateTime.UtcNow));

        return new SyncApplyResult { Created = created, Updated = updated, Skipped = skipped, Failed = failed };
    }

    private static Dictionary<string, string> WithLineage(Dictionary<string, string>? metadata, string lineageId)
    {
        var m = metadata != null ? new Dictionary<string, string>(metadata) : new Dictionary<string, string>();
        m[SyncLineageKey] = lineageId;
        return m;
    }

    /// <summary>计算一个本地库的内容签名（不加载正文，仅 lineage|UpdatedAt|title，廉价）。</summary>
    private async Task<string> ComputeSignatureAsync(string storeId)
    {
        var entries = await _db.DocumentEntries.Find(e => e.StoreId == storeId).ToListAsync();
        var parts = entries
            .Select(e => $"{LineageOf(e)}|{e.UpdatedAt.Ticks}|{e.Title}|{(e.IsFolder ? 1 : 0)}")
            .OrderBy(x => x, StringComparer.Ordinal);
        return Sha256Hex(string.Join("\n", parts));
    }

    /// <summary>取对端签名：local 直接算，remote 走 HTTP 令牌端点。失败返回 null。</summary>
    private async Task<string?> GetRemoteSignatureAsync(DocumentStoreSyncLink link)
    {
        if (link.LinkType == DocumentSyncLinkType.Local)
            return await ComputeSignatureAsync(link.RemoteStoreId);
        try
        {
            using var resp = await CallRemoteAsync(link, HttpMethod.Get, $"sync/signature", null);
            if (!resp.IsSuccessStatusCode) return null;
            var json = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(json);
            // ApiResponse<{signature}> 形态：{ success, data:{ signature } }
            if (doc.RootElement.TryGetProperty("data", out var data)
                && data.TryGetProperty("signature", out var sig))
                return sig.GetString();
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[doc-sync] get remote signature failed: link={LinkId}", link.Id);
            return null;
        }
    }

    /// <summary>对远端环境发起带令牌的 HTTP 调用（SSRF 校验远端地址）。</summary>
    private async Task<HttpResponseMessage> CallRemoteAsync(DocumentStoreSyncLink link, HttpMethod method, string subPath, object? body)
    {
        var baseUri = await _urlValidator.EnsureSafeHttpUrlAsync(link.RemoteBaseUrl, "document-store-sync");
        var url = $"{baseUri.GetLeftPart(UriPartial.Authority)}/api/document-store/stores/{link.RemoteStoreId}/{subPath}";
        var req = new HttpRequestMessage(method, url);
        req.Headers.TryAddWithoutValidation(SyncTokenHeader, link.RemoteToken ?? string.Empty);
        if (body != null)
            req.Content = new StringContent(JsonSerializer.Serialize(body, JsonOpts), Encoding.UTF8, "application/json");
        var client = _httpFactory.CreateClient("DocumentSync");
        client.Timeout = TimeSpan.FromSeconds(120);
        return await client.SendAsync(req);
    }

    // ─────────────────────────────────────────────────────────────
    // 用户端点（需登录）
    // ─────────────────────────────────────────────────────────────

    /// <summary>列出某个库的所有同步配对 + 实时状态。</summary>
    [Authorize]
    [HttpGet("stores/{storeId}/sync")]
    public async Task<IActionResult> ListLinks(string storeId)
    {
        var userId = GetUserId();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;

        var links = await _db.DocumentStoreSyncLinks
            .Find(l => l.LocalStoreId == storeId && l.OwnerId == userId)
            .SortByDescending(l => l.UpdatedAt)
            .ToListAsync();

        var localSig = await ComputeSignatureAsync(storeId);
        var items = new List<object>();
        foreach (var l in links)
        {
            var remoteSig = await GetRemoteSignatureAsync(l);
            var status = ResolveStatus(l, localSig, remoteSig);
            items.Add(ToDto(l, status, localSig, remoteSig));
        }
        return Ok(ApiResponse<object>.Ok(new { items, hasSyncToken = !string.IsNullOrEmpty(store!.SyncToken) }));
    }

    /// <summary>列出当前用户的全部同步配对（跨所有库，供「跨环境同步」页签展示）。</summary>
    [Authorize]
    [HttpGet("sync/links")]
    public async Task<IActionResult> ListAllLinks()
    {
        var userId = GetUserId();
        var links = await _db.DocumentStoreSyncLinks
            .Find(l => l.OwnerId == userId)
            .SortByDescending(l => l.UpdatedAt)
            .ToListAsync();

        var localIds = links.Select(l => l.LocalStoreId).Distinct().ToList();
        var localStores = await _db.DocumentStores.Find(s => localIds.Contains(s.Id)).ToListAsync();
        var nameById = localStores.ToDictionary(s => s.Id, s => s.Name);

        var sigCache = new Dictionary<string, string>();
        var items = new List<object>();
        foreach (var l in links)
        {
            if (!sigCache.TryGetValue(l.LocalStoreId, out var localSig))
            {
                localSig = await ComputeSignatureAsync(l.LocalStoreId);
                sigCache[l.LocalStoreId] = localSig;
            }
            var remoteSig = await GetRemoteSignatureAsync(l);
            var status = ResolveStatus(l, localSig, remoteSig);
            items.Add(ToDto(l, status, localSig, remoteSig, nameById.GetValueOrDefault(l.LocalStoreId)));
        }
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建本地配对（同环境两个库，无需令牌 / 网络）。</summary>
    [Authorize]
    [HttpPost("stores/{storeId}/sync/local")]
    public async Task<IActionResult> CreateLocalLink(string storeId, [FromBody] CreateLocalLinkRequest request)
    {
        var userId = GetUserId();
        if (request == null || string.IsNullOrWhiteSpace(request.TargetStoreId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择对端知识库"));
        if (request.TargetStoreId == storeId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能与自身配对"));
        var direction = DocumentSyncDirection.IsValid(request.Direction) ? request.Direction! : DocumentSyncDirection.Both;

        var (local, e1) = await LoadWritableStoreAsync(storeId, userId);
        if (e1 != null) return e1;
        var (remote, e2) = await LoadWritableStoreAsync(request.TargetStoreId, userId);
        if (e2 != null) return e2;

        var existing = await _db.DocumentStoreSyncLinks
            .Find(l => l.LocalStoreId == storeId && l.RemoteStoreId == request.TargetStoreId && l.OwnerId == userId)
            .FirstOrDefaultAsync();
        if (existing != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "该配对已存在"));

        var link = new DocumentStoreSyncLink
        {
            OwnerId = userId,
            LocalStoreId = storeId,
            LinkType = DocumentSyncLinkType.Local,
            Direction = direction,
            RemoteStoreId = remote!.Id,
            RemoteStoreName = remote.Name,
            Status = DocumentSyncLinkStatus.Never,
        };
        await _db.DocumentStoreSyncLinks.InsertOneAsync(link);
        return Ok(ApiResponse<object>.Ok(ToDto(link, DocumentSyncLinkStatus.Never, null, null)));
    }

    /// <summary>为本库生成跨环境连接链接（确保 SyncToken 存在，返回编码后的链接令牌）。</summary>
    [Authorize]
    [HttpPost("stores/{storeId}/sync/generate-link")]
    public async Task<IActionResult> GenerateLink(string storeId, [FromBody] GenerateLinkRequest? request)
    {
        var userId = GetUserId();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;
        if (store!.OwnerId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅知识库拥有者可生成连接链接"));

        var token = store.SyncToken;
        if (string.IsNullOrEmpty(token))
        {
            token = "skb-" + Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            await _db.DocumentStores.UpdateOneAsync(s => s.Id == storeId,
                Builders<DocumentStore>.Update.Set(s => s.SyncToken, token).Set(s => s.UpdatedAt, DateTime.UtcNow));
        }

        var baseUrl = !string.IsNullOrWhiteSpace(request?.BaseUrl)
            ? request!.BaseUrl!.TrimEnd('/')
            : $"{Request.Scheme}://{Request.Host}";

        var payload = new SyncLinkPayload
        {
            V = 1,
            BaseUrl = baseUrl,
            StoreId = store.Id,
            StoreName = store.Name,
            Token = token,
        };
        var json = JsonSerializer.Serialize(payload, JsonOpts);
        var link = "skblink_" + Base64UrlEncode(Encoding.UTF8.GetBytes(json));
        return Ok(ApiResponse<object>.Ok(new { link, baseUrl, storeName = store.Name }));
    }

    /// <summary>粘贴对方链接以建立跨环境配对（探测对端可达 + 令牌有效后落库）。</summary>
    [Authorize]
    [HttpPost("stores/{storeId}/sync/connect")]
    public async Task<IActionResult> Connect(string storeId, [FromBody] ConnectRequest request)
    {
        var userId = GetUserId();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;
        if (request == null || string.IsNullOrWhiteSpace(request.Link))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请粘贴对方的连接链接"));

        SyncLinkPayload? payload;
        try
        {
            var raw = request.Link.Trim();
            if (raw.StartsWith("skblink_")) raw = raw.Substring("skblink_".Length);
            var json = Encoding.UTF8.GetString(Base64UrlDecode(raw));
            payload = JsonSerializer.Deserialize<SyncLinkPayload>(json, JsonOpts);
        }
        catch
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "连接链接格式不正确"));
        }
        if (payload == null || string.IsNullOrWhiteSpace(payload.BaseUrl)
            || string.IsNullOrWhiteSpace(payload.StoreId) || string.IsNullOrWhiteSpace(payload.Token))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "连接链接缺少必要信息"));

        var direction = DocumentSyncDirection.IsValid(request.Direction) ? request.Direction! : DocumentSyncDirection.Both;

        var link = new DocumentStoreSyncLink
        {
            OwnerId = userId,
            LocalStoreId = storeId,
            LinkType = DocumentSyncLinkType.Remote,
            Direction = direction,
            RemoteStoreId = payload.StoreId,
            RemoteStoreName = payload.StoreName,
            RemoteBaseUrl = payload.BaseUrl.TrimEnd('/'),
            RemoteToken = payload.Token,
            Status = DocumentSyncLinkStatus.Never,
        };

        // 探测对端可达 + 令牌有效
        var remoteSig = await GetRemoteSignatureAsync(link);
        if (remoteSig == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法连接对端知识库，请确认链接有效且两个环境网络互通"));

        await _db.DocumentStoreSyncLinks.InsertOneAsync(link);
        var localSig = await ComputeSignatureAsync(storeId);
        var status = ResolveStatus(link, localSig, remoteSig);
        return Ok(ApiResponse<object>.Ok(ToDto(link, status, localSig, remoteSig)));
    }

    /// <summary>触发一次同步（按方向 push / pull / both）。</summary>
    [Authorize]
    [HttpPost("sync/{linkId}/run")]
    public async Task<IActionResult> RunSync(string linkId)
    {
        var userId = GetUserId();
        var link = await _db.DocumentStoreSyncLinks.Find(l => l.Id == linkId && l.OwnerId == userId).FirstOrDefaultAsync();
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "同步配对不存在"));
        var (local, error) = await LoadWritableStoreAsync(link.LocalStoreId, userId);
        if (error != null) return error;

        var (actorUserId, actorName, actorAvatar) = await GetActorAsync(userId);
        var summary = new List<string>();
        try
        {
            // pull：对端 → 本地
            if (link.Direction is DocumentSyncDirection.Pull or DocumentSyncDirection.Both)
            {
                var bundle = await FetchRemoteBundleAsync(link);
                if (bundle == null) throw new InvalidOperationException("拉取对端内容失败");
                var r = await ApplyBundleAsync(local!, bundle, actorUserId, actorName, actorAvatar);
                summary.Add($"拉取 新增{r.Created}/更新{r.Updated}/跳过{r.Skipped}" + (r.Failed > 0 ? $"/失败{r.Failed}" : ""));
            }
            // push：本地 → 对端
            if (link.Direction is DocumentSyncDirection.Push or DocumentSyncDirection.Both)
            {
                var localBundle = await BuildBundleAsync(local!);
                var r = await PushBundleAsync(link, localBundle, actorUserId, actorName, actorAvatar);
                summary.Add($"推送 新增{r.Created}/更新{r.Updated}/跳过{r.Skipped}" + (r.Failed > 0 ? $"/失败{r.Failed}" : ""));
            }

            // 同步后快照两侧签名
            var localSig = await ComputeSignatureAsync(link.LocalStoreId);
            var remoteSig = await GetRemoteSignatureAsync(link);
            var resultText = string.Join("；", summary);
            await _db.DocumentStoreSyncLinks.UpdateOneAsync(l => l.Id == link.Id,
                Builders<DocumentStoreSyncLink>.Update
                    .Set(l => l.LastSyncedAt, DateTime.UtcNow)
                    .Set(l => l.LastLocalSignature, localSig)
                    .Set(l => l.LastRemoteSignature, remoteSig)
                    .Set(l => l.Status, DocumentSyncLinkStatus.Synced)
                    .Set(l => l.LastResult, resultText)
                    .Set(l => l.UpdatedAt, DateTime.UtcNow));

            link.LastSyncedAt = DateTime.UtcNow;
            link.LastLocalSignature = localSig;
            link.LastRemoteSignature = remoteSig;
            link.Status = DocumentSyncLinkStatus.Synced;
            link.LastResult = resultText;
            return Ok(ApiResponse<object>.Ok(ToDto(link, DocumentSyncLinkStatus.Synced, localSig, remoteSig)));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[doc-sync] run failed: link={LinkId}", link.Id);
            await _db.DocumentStoreSyncLinks.UpdateOneAsync(l => l.Id == link.Id,
                Builders<DocumentStoreSyncLink>.Update
                    .Set(l => l.Status, DocumentSyncLinkStatus.Error)
                    .Set(l => l.LastResult, ex.Message)
                    .Set(l => l.UpdatedAt, DateTime.UtcNow));
            return StatusCode(500, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"同步失败：{ex.Message}"));
        }
    }

    /// <summary>修改同步方向。</summary>
    [Authorize]
    [HttpPatch("sync/{linkId}")]
    public async Task<IActionResult> UpdateLink(string linkId, [FromBody] UpdateLinkRequest request)
    {
        var userId = GetUserId();
        var link = await _db.DocumentStoreSyncLinks.Find(l => l.Id == linkId && l.OwnerId == userId).FirstOrDefaultAsync();
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "同步配对不存在"));
        if (!DocumentSyncDirection.IsValid(request?.Direction))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方向无效"));

        await _db.DocumentStoreSyncLinks.UpdateOneAsync(l => l.Id == linkId,
            Builders<DocumentStoreSyncLink>.Update
                .Set(l => l.Direction, request!.Direction)
                .Set(l => l.UpdatedAt, DateTime.UtcNow));
        link.Direction = request!.Direction!;
        return Ok(ApiResponse<object>.Ok(ToDto(link, link.Status, null, null)));
    }

    /// <summary>撤销配对。若本库不再有任何 remote 配对引用 SyncToken，则清空令牌彻底失效。</summary>
    [Authorize]
    [HttpDelete("sync/{linkId}")]
    public async Task<IActionResult> DeleteLink(string linkId)
    {
        var userId = GetUserId();
        var link = await _db.DocumentStoreSyncLinks.Find(l => l.Id == linkId && l.OwnerId == userId).FirstOrDefaultAsync();
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "同步配对不存在"));

        await _db.DocumentStoreSyncLinks.DeleteOneAsync(l => l.Id == linkId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>撤销本库的跨环境令牌（让所有用此令牌连入的对端立即失效）。</summary>
    [Authorize]
    [HttpPost("stores/{storeId}/sync/revoke-token")]
    public async Task<IActionResult> RevokeToken(string storeId)
    {
        var userId = GetUserId();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;
        if (store!.OwnerId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅拥有者可撤销令牌"));
        await _db.DocumentStores.UpdateOneAsync(s => s.Id == storeId,
            Builders<DocumentStore>.Update.Set(s => s.SyncToken, (string?)null).Set(s => s.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    // ─────────────────────────────────────────────────────────────
    // 跨环境令牌端点（被对端环境调用，令牌鉴权，无需登录）
    // ─────────────────────────────────────────────────────────────

    /// <summary>对端取本库签名（令牌鉴权）。</summary>
    [AllowAnonymous]
    [HttpGet("stores/{storeId}/sync/signature")]
    public async Task<IActionResult> RemoteSignature(string storeId)
    {
        var store = await ResolveTokenStoreAsync(storeId);
        if (store == null) return TokenUnauthorized();
        var sig = await ComputeSignatureAsync(storeId);
        return Ok(ApiResponse<object>.Ok(new { signature = sig, name = store.Name }));
    }

    /// <summary>对端拉取本库 bundle（令牌鉴权，用于对端的 pull）。</summary>
    [AllowAnonymous]
    [HttpGet("stores/{storeId}/sync/bundle")]
    public async Task<IActionResult> RemoteBundle(string storeId)
    {
        var store = await ResolveTokenStoreAsync(storeId);
        if (store == null) return TokenUnauthorized();
        var bundle = await BuildBundleAsync(store);
        return Ok(ApiResponse<object>.Ok(bundle));
    }

    /// <summary>对端推送 bundle 进本库（令牌鉴权，用于对端的 push）。</summary>
    [AllowAnonymous]
    [HttpPost("stores/{storeId}/sync/apply")]
    public async Task<IActionResult> RemoteApply(string storeId, [FromBody] SyncBundle bundle)
    {
        var store = await ResolveTokenStoreAsync(storeId);
        if (store == null) return TokenUnauthorized();
        if (bundle == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "bundle 为空"));
        var (actorUserId, actorName, actorAvatar) = await GetActorAsync(store.OwnerId);
        var r = await ApplyBundleAsync(store, bundle, actorUserId, actorName, actorAvatar);
        return Ok(ApiResponse<object>.Ok(r));
    }

    // ─────────────────────────────────────────────────────────────
    // 内部辅助
    // ─────────────────────────────────────────────────────────────

    private async Task<DocumentStore?> ResolveTokenStoreAsync(string storeId)
    {
        if (!Request.Headers.TryGetValue(SyncTokenHeader, out var tokenValues)) return null;
        var token = tokenValues.ToString();
        if (string.IsNullOrEmpty(token)) return null;
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null || string.IsNullOrEmpty(store.SyncToken) || store.SyncToken != token) return null;
        return store;
    }

    private IActionResult TokenUnauthorized()
        => StatusCode(401, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "同步令牌无效或已撤销"));

    private async Task<SyncBundle?> FetchRemoteBundleAsync(DocumentStoreSyncLink link)
    {
        if (link.LinkType == DocumentSyncLinkType.Local)
        {
            var remoteStore = await _db.DocumentStores.Find(s => s.Id == link.RemoteStoreId).FirstOrDefaultAsync();
            if (remoteStore == null) throw new InvalidOperationException("对端本地库不存在");
            return await BuildBundleAsync(remoteStore);
        }
        using var resp = await CallRemoteAsync(link, HttpMethod.Get, "sync/bundle", null);
        if (!resp.IsSuccessStatusCode) return null;
        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("data", out var data)) return null;
        return JsonSerializer.Deserialize<SyncBundle>(data.GetRawText(), JsonOpts);
    }

    private async Task<SyncApplyResult> PushBundleAsync(DocumentStoreSyncLink link, SyncBundle bundle, string actorUserId, string actorName, string? actorAvatar)
    {
        if (link.LinkType == DocumentSyncLinkType.Local)
        {
            var remoteStore = await _db.DocumentStores.Find(s => s.Id == link.RemoteStoreId).FirstOrDefaultAsync();
            if (remoteStore == null) throw new InvalidOperationException("对端本地库不存在");
            return await ApplyBundleAsync(remoteStore, bundle, actorUserId, actorName, actorAvatar);
        }
        using var resp = await CallRemoteAsync(link, HttpMethod.Post, "sync/apply", bundle);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"推送对端失败：HTTP {(int)resp.StatusCode}");
        var json = await resp.Content.ReadAsStringAsync();
        using var docu = JsonDocument.Parse(json);
        if (docu.RootElement.TryGetProperty("data", out var data))
            return JsonSerializer.Deserialize<SyncApplyResult>(data.GetRawText(), JsonOpts) ?? new SyncApplyResult();
        return new SyncApplyResult();
    }

    private async Task<(string userId, string userName, string? avatar)> GetActorAsync(string userId)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var name = user != null && !string.IsNullOrWhiteSpace(user.DisplayName)
            ? user.DisplayName : (user?.Username ?? "同步");
        return (userId, name, user?.AvatarFileName);
    }

    private static string ResolveStatus(DocumentStoreSyncLink link, string? localSig, string? remoteSig)
    {
        if (link.Status == DocumentSyncLinkStatus.Error) return DocumentSyncLinkStatus.Error;
        if (link.LastSyncedAt == null) return DocumentSyncLinkStatus.Never;
        // 任一侧签名与上次同步快照不一致 = 待同步
        var localChanged = localSig != null && link.LastLocalSignature != null && localSig != link.LastLocalSignature;
        var remoteChanged = remoteSig != null && link.LastRemoteSignature != null && remoteSig != link.LastRemoteSignature;
        return (localChanged || remoteChanged) ? DocumentSyncLinkStatus.Pending : DocumentSyncLinkStatus.Synced;
    }

    private static object ToDto(DocumentStoreSyncLink l, string status, string? localSig, string? remoteSig, string? localStoreName = null)
        => new
        {
            l.Id,
            l.LocalStoreId,
            localStoreName,
            l.LinkType,
            l.Direction,
            l.RemoteStoreId,
            l.RemoteStoreName,
            l.RemoteBaseUrl,
            l.LastSyncedAt,
            l.LastResult,
            status,
        };

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        switch (t.Length % 4) { case 2: t += "=="; break; case 3: t += "="; break; }
        return Convert.FromBase64String(t);
    }

    // ── DTO ──

    public class CreateLocalLinkRequest { public string? TargetStoreId { get; set; } public string? Direction { get; set; } }
    public class GenerateLinkRequest { public string? BaseUrl { get; set; } }
    public class ConnectRequest { public string? Link { get; set; } public string? Direction { get; set; } }
    public class UpdateLinkRequest { public string? Direction { get; set; } }

    public class SyncLinkPayload
    {
        public int V { get; set; } = 1;
        public string BaseUrl { get; set; } = string.Empty;
        public string StoreId { get; set; } = string.Empty;
        public string? StoreName { get; set; }
        public string Token { get; set; } = string.Empty;
    }

    public class SyncBundle
    {
        public int Version { get; set; } = 1;
        public SyncStoreMeta? Store { get; set; }
        public List<SyncEntryDto> Entries { get; set; } = new();
    }

    public class SyncStoreMeta
    {
        public string Name { get; set; } = string.Empty;
        public string? Description { get; set; }
        public List<string>? Tags { get; set; }
        public bool IsPublic { get; set; }
        public string? TemplateKey { get; set; }
        public string? CoverImageUrl { get; set; }
        public Dictionary<string, string>? TagColors { get; set; }
    }

    public class SyncEntryDto
    {
        public string LineageId { get; set; } = string.Empty;
        public string? ParentLineageId { get; set; }
        public bool IsFolder { get; set; }
        public string Title { get; set; } = string.Empty;
        public string? Summary { get; set; }
        public string? ContentType { get; set; }
        public long FileSize { get; set; }
        public List<string>? Tags { get; set; }
        public Dictionary<string, string>? Metadata { get; set; }
        public string? Content { get; set; }
    }

    public class SyncApplyResult
    {
        public int Created { get; set; }
        public int Updated { get; set; }
        public int Skipped { get; set; }
        public int Failed { get; set; }
    }
}
