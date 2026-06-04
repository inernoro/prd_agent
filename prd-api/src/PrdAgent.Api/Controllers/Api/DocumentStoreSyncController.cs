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

    /// <summary>加载并校验可写空间（owner / 团队成员 / 项目库成员）。无权返回 null + error。
    /// 与 DocumentStoreController.CanWriteStoreAsync 的可写判定保持一致（含 PmProject 成员），
    /// 否则项目知识库的成员能编辑该库却用不了同步功能（Codex P2）。</summary>
    private async Task<(DocumentStore? store, IActionResult? error)> LoadWritableStoreAsync(string storeId, string userId)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return (null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在")));
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        var canWrite = store.OwnerId == userId
            || (store.SharedTeamIds != null && store.SharedTeamIds.Any(myTeamIds.Contains))
            || await IsPmProjectWriterAsync(store, userId)
            || await IsProductKnowledgeWriterAsync(store, userId);
        if (!canWrite)
            return (null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在")));
        return (store, null);
    }

    /// <summary>产品知识库写权限：产品 owner/成员（与 DocumentStoreController.IsProductKnowledgeMemberAsync 同口径）。</summary>
    private async Task<bool> IsProductKnowledgeWriterAsync(DocumentStore s, string userId)
    {
        if (string.IsNullOrEmpty(s.ProductKnowledgeRef)) return false;
        var parts = s.ProductKnowledgeRef.Split(':', 2);
        if (parts.Length != 2) return false;
        string? productId = parts[0] switch
        {
            "product" => parts[1],
            "version" => (await _db.ProductVersions.Find(x => x.Id == parts[1] && !x.IsDeleted).FirstOrDefaultAsync())?.ProductId,
            _ => null,
        };
        if (string.IsNullOrEmpty(productId)) return false;
        var p = await _db.Products.Find(x => x.Id == productId && !x.IsDeleted).FirstOrDefaultAsync();
        if (p == null) return false;
        return p.OwnerId == userId || p.MemberIds.Contains(userId);
    }

    /// <summary>项目知识库写权限：owner/leader/成员（与 DocumentStoreController.IsPmProjectMemberAsync(write:true) 同口径）。</summary>
    private async Task<bool> IsPmProjectWriterAsync(DocumentStore s, string userId)
    {
        if (string.IsNullOrEmpty(s.PmProjectId)) return false;
        var p = await _db.PmProjects.Find(x => x.Id == s.PmProjectId && !x.IsDeleted).FirstOrDefaultAsync();
        if (p == null) return false;
        return p.OwnerId == userId || p.LeaderId == userId || p.MemberIds.Contains(userId);
    }

    /// <summary>本地配对是否为"库对级共享配对"——任何能写两侧库的人都可管理。</summary>
    private async Task<bool> CanManageLocalLinkAsync(DocumentStoreSyncLink link, string userId)
        => link.LinkType == DocumentSyncLinkType.Local
            && (await LoadWritableStoreAsync(link.LocalStoreId, userId)).error == null
            && (await LoadWritableStoreAsync(link.RemoteStoreId, userId)).error == null;

    /// <summary>
    /// 加载一条当前用户【可管理】的配对：owner 永远可；本地同环境配对额外放行"能写两侧库"的任何人
    /// （库对级共享配对，用户拍板）。跨环境配对仍按 owner 隔离。无权返回 null。
    /// </summary>
    private async Task<DocumentStoreSyncLink?> LoadManageableLinkAsync(string linkId, string userId)
    {
        var link = await _db.DocumentStoreSyncLinks.Find(l => l.Id == linkId).FirstOrDefaultAsync();
        if (link == null) return null;
        if (link.OwnerId == userId) return link;
        return await CanManageLocalLinkAsync(link, userId) ? link : null;
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

        // 文件夹先建（parent-first，多趟扫描）。本地函数封装"建一个文件夹"，供主循环与兜底复用。
        async Task UpsertFolderAsync(SyncEntryDto f, string? parentId)
        {
            if (byLineage.TryGetValue(f.LineageId, out var exFolder))
            {
                lineageToTargetId[f.LineageId] = exFolder.Id;
                // 血缘已存在：标题/父/标签/元信息有变化则更新（真正的 upsert，不只是 skip），
                // 否则重命名/移动文件夹在后续同步不传播。
                var newTags = f.Tags ?? new List<string>();
                if (exFolder.Title != f.Title || exFolder.ParentId != parentId
                    || !TagsEqual(exFolder.Tags, f.Tags) || !MetaEqual(exFolder.Metadata, f.Metadata))
                {
                    await _db.DocumentEntries.UpdateOneAsync(e => e.Id == exFolder.Id,
                        Builders<DocumentEntry>.Update
                            .Set(e => e.Title, f.Title)
                            .Set(e => e.ParentId, parentId)
                            .Set(e => e.Tags, newTags)
                            .Set(e => e.Metadata, WithLineage(f.Metadata, f.LineageId))
                            .Set(e => e.UpdatedBy, actorUserId)
                            .Set(e => e.UpdatedByName, actorName)
                            .Set(e => e.UpdatedAt, DateTime.UtcNow));
                    exFolder.Title = f.Title;
                    exFolder.ParentId = parentId;
                    updated++;
                }
                else
                {
                    skipped++;
                }
                return;
            }
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

        var pendingFolders = entries.Where(e => e.IsFolder).ToList();
        var guard = 0;
        while (pendingFolders.Count > 0 && guard++ < 5000)
        {
            var progressed = false;
            foreach (var f in pendingFolders.ToList())
            {
                if (!string.IsNullOrEmpty(f.ParentLineageId)
                    && !lineageToTargetId.ContainsKey(f.ParentLineageId)
                    && !byLineage.ContainsKey(f.ParentLineageId))
                    continue; // 父还没建，下趟

                await UpsertFolderAsync(f, ResolveParent(f.ParentLineageId));
                pendingFolders.Remove(f);
                progressed = true;
            }
            if (!progressed) break;
        }
        // 兜底：仍有未解析父引用的文件夹（孤儿/环引用），直接建在能解析到的父（解析不到则根），
        // 保证它们存在 —— 否则其子文件会因找不到父文件夹而全部落到库根（比落在残缺树下更糟）。
        foreach (var f in pendingFolders)
            await UpsertFolderAsync(f, ResolveParent(f.ParentLineageId));

        // 文件类条目
        foreach (var fe in entries.Where(e => !e.IsFolder))
        {
            try
            {
                // 只跳过"无正文"（null：二进制/无关联文档）；空字符串是合法的空文本文档，要照常同步，
                // 否则"清空文档正文/新建空文档"的变更不会传到对端，快照却前进 → 两侧永久不一致（Codex P2）。
                if (fe.Content == null) { skipped++; continue; }
                var parentId = ResolveParent(fe.ParentLineageId);

                if (byLineage.TryGetValue(fe.LineageId, out var exEntry) && !exEntry.IsFolder)
                {
                    // 已存在：内容未变则跳过，避免 bump UpdatedAt 导致永远 pending
                    var existingContent = !string.IsNullOrEmpty(exEntry.DocumentId)
                        ? (await _documentService.GetByIdAsync(exEntry.DocumentId))?.RawContent ?? string.Empty
                        : string.Empty;
                    // 全字段比对再决定跳过：正文 hash + 标题 + 父 + 标签 + 摘要 + 元信息。
                    // 只比正文会漏掉"仅改标签/摘要/元信息"的同步（两侧永久不一致却显示已同步）。
                    if (Sha256Hex(existingContent) == Sha256Hex(fe.Content)
                        && exEntry.Title == fe.Title && exEntry.ParentId == parentId
                        && TagsEqual(exEntry.Tags, fe.Tags) && exEntry.Summary == fe.Summary
                        && MetaEqual(exEntry.Metadata, fe.Metadata))
                    {
                        skipped++;
                        continue;
                    }
                    var oldDocId = exEntry.DocumentId;
                    var parsed = await BuildAndSaveDocAsync(fe.Content, fe.Title);
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
                    await CleanupReplacedDocAsync(oldDocId, parsed.Id, exEntry.Id);
                    updated++;
                }
                else
                {
                    var parsed = await BuildAndSaveDocAsync(fe.Content, fe.Title);
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

    // 同步写正文：空/纯空白是合法的空文本文档，但 DocumentService.ParseAsync 会对其抛异常，
    // 故此处手工构造一个内容寻址（hash 派生 Id）的空文档，避免空文档每次同步都失败（Codex P2）。
    private async Task<ParsedPrd> BuildAndSaveDocAsync(string content, string title)
    {
        ParsedPrd parsed;
        if (string.IsNullOrWhiteSpace(content))
            parsed = new ParsedPrd { Id = Sha256Hex(content.Replace("\r\n", "\n")), RawContent = content };
        else
            parsed = await _documentService.ParseAsync(content);
        parsed.Title = title;
        await _documentService.SaveAsync(parsed);
        return parsed;
    }

    // 替换正文后清理被换下的旧 ParsedPrd：内容寻址 Id，仍有其它条目引用则跳过（防误删共享正文）。
    // 与 DocumentStoreController 替换路径同口径；失败只记日志不影响同步结果。
    private async Task CleanupReplacedDocAsync(string? oldDocId, string newDocId, string keepEntryId)
    {
        if (string.IsNullOrEmpty(oldDocId) || oldDocId == newDocId) return;
        try
        {
            var stillReferenced = await _db.DocumentEntries
                .Find(e => e.DocumentId == oldDocId && e.Id != keepEntryId)
                .AnyAsync(CancellationToken.None);
            if (!stillReferenced)
                await _db.Documents.DeleteOneAsync(d => d.Id == oldDocId, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[doc-sync] 清理旧 ParsedPrd 失败 docId={DocId}", oldDocId);
        }
    }

    // 标签集合相等（顺序无关）。
    private static bool TagsEqual(List<string>? a, List<string>? b)
        => (a ?? new()).OrderBy(x => x, StringComparer.Ordinal)
            .SequenceEqual((b ?? new()).OrderBy(x => x, StringComparer.Ordinal));

    // 元信息相等（忽略内部血缘键 syncLineageId，其余 key=value 顺序无关比对）。
    private static bool MetaEqual(Dictionary<string, string>? a, Dictionary<string, string>? b)
    {
        static string Norm(Dictionary<string, string>? m) => string.Join("\n", (m ?? new())
            .Where(kv => kv.Key != SyncLineageKey)
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => kv.Key + "=" + kv.Value));
        return Norm(a) == Norm(b);
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
        // 保留对端 base URL 里的 path 前缀（API 部署在子路径下时不能只取 authority，否则全失败）。
        var baseLeft = baseUri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        var url = $"{baseLeft}/api/document-store/stores/{link.RemoteStoreId}/{subPath}";
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

        // 既匹配「本库作为发起方(LocalStoreId)」的配对，也匹配「本库作为本地配对的对端(RemoteStoreId)」的配对，
        // 这样本地两库配对的【目标库】详情右上角也能显示同步徽章（用户要求：任何同步中的库都标）。
        // 本地配对是库对级共享：本库的本地配对对任何能写本库的人可见（上面已校验可写）；
        // 跨环境配对仍按 owner 隔离。
        var links = await _db.DocumentStoreSyncLinks
            .Find(l => (l.LocalStoreId == storeId
                    || (l.LinkType == DocumentSyncLinkType.Local && l.RemoteStoreId == storeId))
                && (l.LinkType == DocumentSyncLinkType.Local || l.OwnerId == userId))
            .SortByDescending(l => l.UpdatedAt)
            .ToListAsync();

        var thisSig = await ComputeSignatureAsync(storeId);
        var items = new List<object>();
        foreach (var l in links)
        {
            string status;
            if (l.LocalStoreId == storeId)
            {
                // 正向：本库即配对的本地侧
                var remoteSig = await GetRemoteSignatureAsync(l);
                status = ResolveStatus(l, thisSig, remoteSig);
            }
            else
            {
                // 反向（本地配对的对端侧）：本库 = 配对的 remote，另一库 = 配对的 local。
                // 交换签名槽位让 ResolveStatus 仍按 LastLocal/LastRemote 正确比对。
                var otherSig = await ComputeSignatureAsync(l.LocalStoreId);
                status = ResolveStatus(l, otherSig, thisSig);
            }
            items.Add(ToDto(l, status, null, null));
        }
        return Ok(ApiResponse<object>.Ok(new { items, hasSyncToken = !string.IsNullOrEmpty(store!.SyncToken) }));
    }

    /// <summary>列出当前用户的全部同步配对（跨所有库，供「跨环境同步」页签展示）。</summary>
    [Authorize]
    [HttpGet("sync/links")]
    public async Task<IActionResult> ListAllLinks()
    {
        var userId = GetUserId();
        // 自己拥有的全部配对 + 库对级共享的本地配对（能写两侧库的就该看到并能管理）。
        var owned = await _db.DocumentStoreSyncLinks
            .Find(l => l.OwnerId == userId)
            .SortByDescending(l => l.UpdatedAt)
            .ToListAsync();
        var sharedLocal = await _db.DocumentStoreSyncLinks
            .Find(l => l.LinkType == DocumentSyncLinkType.Local && l.OwnerId != userId)
            .SortByDescending(l => l.UpdatedAt)
            .ToListAsync();
        var links = new List<DocumentStoreSyncLink>(owned);
        foreach (var l in sharedLocal)
            if (await CanManageLocalLinkAsync(l, userId)) links.Add(l);

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

        // 去重：库对级共享配对（用户拍板）——同一对本地库全局只允许一条配对，不分谁建、不分方向。
        // 不再按 OwnerId 过滤，避免两个能写这两个库的同事各建一条造成并行配对、重复全量、各看各的状态。
        var tgt = request.TargetStoreId;
        var existing = await _db.DocumentStoreSyncLinks
            .Find(l => l.LinkType == DocumentSyncLinkType.Local
                && ((l.LocalStoreId == storeId && l.RemoteStoreId == tgt)
                    || (l.LocalStoreId == tgt && l.RemoteStoreId == storeId)))
            .FirstOrDefaultAsync();
        if (existing != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "这两个库已配对（含反向，库对级共享）"));

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

        // 未显式传 BaseUrl 时回退到当前请求地址：必须带上 PathBase（子路径部署如 /prod），
        // 否则生成的 skblink 丢前缀，对端探测打到 https://host/api 而非 https://host/prod/api（Codex P2）。
        var baseUrl = !string.IsNullOrWhiteSpace(request?.BaseUrl)
            ? request!.BaseUrl!.TrimEnd('/')
            : $"{Request.Scheme}://{Request.Host}{Request.PathBase}".TrimEnd('/');

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
        // 自连禁止：仅拦"真·自连"——指向本环境(scheme+host+port+path 全等) + 同一库 Id。
        // 跨环境克隆常保留同一 store Id（test↔prod 同库），且可能同 host 不同端口/子路径，
        // 必须按完整 base 比较而非仅 host，否则会误拦合法跨环境链接（CallRemoteAsync 也保留 path 前缀）。
        var sameEnv = Uri.TryCreate(payload.BaseUrl.TrimEnd('/'), UriKind.Absolute, out var pbUri)
            && Uri.TryCreate($"{Request.Scheme}://{Request.Host}{Request.PathBase}".TrimEnd('/'), UriKind.Absolute, out var curUri)
            && Uri.Compare(pbUri, curUri, UriComponents.SchemeAndServer | UriComponents.Path,
                UriFormat.SafeUnescaped, StringComparison.OrdinalIgnoreCase) == 0;
        if (payload.StoreId == storeId && sameEnv)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能连接知识库自己，请粘贴另一个库的连接链接"));

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

        // 去重：同一本地库 + 同一对端库 + 同一对端地址不允许重复配对（与 CreateLocalLink 对齐，
        // 否则同一条 skblink 粘两次会产生并行配对各自跑全量同步、列表混乱）。
        var dupRemote = await _db.DocumentStoreSyncLinks.Find(l =>
                l.OwnerId == userId && l.LocalStoreId == storeId
                && l.RemoteStoreId == link.RemoteStoreId && l.RemoteBaseUrl == link.RemoteBaseUrl)
            .FirstOrDefaultAsync();
        if (dupRemote != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "该跨环境配对已存在"));

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
        var link = await LoadManageableLinkAsync(linkId, userId);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "同步配对不存在"));
        var (local, error) = await LoadWritableStoreAsync(link.LocalStoreId, userId);
        if (error != null) return error;
        // 本地配对：每次运行都重新校验对端本地库的当前可写权限。
        // 否则团队分享被撤销后，旧配对仍能读写对端库（Codex P1 越权）。跨环境配对靠对端令牌鉴权，无此问题。
        if (link.LinkType == DocumentSyncLinkType.Local)
        {
            var (_, remoteErr) = await LoadWritableStoreAsync(link.RemoteStoreId, userId);
            if (remoteErr != null)
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "对端知识库已无访问权限（可能团队分享已撤销），无法同步"));
        }

        var (actorUserId, actorName, actorAvatar) = await GetActorAsync(userId);
        var summary = new List<string>();
        var totalFailed = 0;
        try
        {
            async Task DoPullAsync()
            {
                var bundle = await FetchRemoteBundleAsync(link);
                if (bundle == null) throw new InvalidOperationException("拉取对端内容失败");
                var r = await ApplyBundleAsync(local!, bundle, actorUserId, actorName, actorAvatar);
                totalFailed += r.Failed;
                summary.Add($"拉取 新增{r.Created}/更新{r.Updated}/跳过{r.Skipped}" + (r.Failed > 0 ? $"/失败{r.Failed}" : ""));
            }
            async Task DoPushAsync()
            {
                var localBundle = await BuildBundleAsync(local!);
                var r = await PushBundleAsync(link, localBundle, actorUserId, actorName, actorAvatar);
                totalFailed += r.Failed;
                summary.Add($"推送 新增{r.Created}/更新{r.Updated}/跳过{r.Skipped}" + (r.Failed > 0 ? $"/失败{r.Failed}" : ""));
            }

            if (link.Direction == DocumentSyncDirection.Pull)
            {
                await DoPullAsync();
            }
            else if (link.Direction == DocumentSyncDirection.Push)
            {
                await DoPushAsync();
            }
            else
            {
                // both：用上次同步的签名快照判定"哪一侧改了"，避免无脑 pull/push 互相覆盖丢数据。
                // - 仅本地改 → push；仅对端改 → pull；
                // - 两侧都改（真冲突）→ 先 push 再 pull：共享条目以本地为准（不自动合并冲突），
                //   两侧各自新增的条目都保留（不丢数据）；
                // - 首次同步 → 同上 push+pull 取并集。
                var preLocalSig = await ComputeSignatureAsync(link.LocalStoreId);
                var preRemoteSig = await GetRemoteSignatureAsync(link);
                var firstSync = link.LastSyncedAt == null;
                var localChanged = firstSync || preLocalSig != link.LastLocalSignature;
                // 对端签名取不到（null）时，不能当作"未变"——否则会跳过 pull 却把快照刷成最新，掩盖对端真实漂移。
                // 当作"可能有变"去尝试 pull：对端真不可达时 DoPullAsync 会抛错落到 error，绝不假装已同步。
                var remoteChanged = firstSync || preRemoteSig == null || preRemoteSig != link.LastRemoteSignature;

                if (firstSync || (localChanged && remoteChanged))
                {
                    if (!firstSync) summary.Add("两侧都有改动，冲突条目以本地为准");
                    await DoPushAsync();
                    await DoPullAsync();
                }
                else if (localChanged)
                {
                    await DoPushAsync();
                }
                else if (remoteChanged)
                {
                    await DoPullAsync();
                }
                else
                {
                    summary.Add("两侧均无变化");
                }
            }

            // 同步后快照两侧签名
            var localSig = await ComputeSignatureAsync(link.LocalStoreId);
            var remoteSig = await GetRemoteSignatureAsync(link);
            var resultText = string.Join("；", summary);

            // 有条目应用失败：不能判 synced，也【不推进签名快照】——否则把失败后的状态记成"已同步基线"，
            // 之后 drift 检测看不到差异，失败条目永不重试（Bugbot/Codex）。保留旧快照让其持续显示待同步。
            if (totalFailed > 0)
            {
                var failText = (string.IsNullOrEmpty(resultText) ? "" : resultText + "；") + $"有 {totalFailed} 条同步失败，请重试";
                await _db.DocumentStoreSyncLinks.UpdateOneAsync(l => l.Id == link.Id,
                    Builders<DocumentStoreSyncLink>.Update
                        .Set(l => l.LastSyncedAt, DateTime.UtcNow)
                        .Set(l => l.Status, DocumentSyncLinkStatus.Error)
                        .Set(l => l.LastResult, failText)
                        .Set(l => l.UpdatedAt, DateTime.UtcNow));
                link.LastSyncedAt = DateTime.UtcNow;
                link.Status = DocumentSyncLinkStatus.Error;
                link.LastResult = failText;
                return Ok(ApiResponse<object>.Ok(ToDto(link, DocumentSyncLinkStatus.Error, localSig, remoteSig, local!.Name)));
            }

            // 对端签名抓取失败（null）时，仅当该方向"在意对端"才标 pending（pull/both）：
            // 否则 LastRemoteSignature 为 null 会让 pull/both 假装"已同步"。push-only 不关心对端漂移，照常 synced。
            var remoteMatters = link.Direction != DocumentSyncDirection.Push;
            var postStatus = (remoteSig == null && remoteMatters) ? DocumentSyncLinkStatus.Pending : DocumentSyncLinkStatus.Synced;
            if (remoteSig == null && remoteMatters) resultText = string.IsNullOrEmpty(resultText) ? "同步已执行，但对端状态获取失败，请稍后重试确认" : resultText + "；对端状态获取失败，请稍后重试确认";
            await _db.DocumentStoreSyncLinks.UpdateOneAsync(l => l.Id == link.Id,
                Builders<DocumentStoreSyncLink>.Update
                    .Set(l => l.LastSyncedAt, DateTime.UtcNow)
                    .Set(l => l.LastLocalSignature, localSig)
                    .Set(l => l.LastRemoteSignature, remoteSig)
                    .Set(l => l.Status, postStatus)
                    .Set(l => l.LastResult, resultText)
                    .Set(l => l.UpdatedAt, DateTime.UtcNow));

            link.LastSyncedAt = DateTime.UtcNow;
            link.LastLocalSignature = localSig;
            link.LastRemoteSignature = remoteSig;
            link.Status = postStatus;
            link.LastResult = resultText;
            return Ok(ApiResponse<object>.Ok(ToDto(link, postStatus, localSig, remoteSig, local!.Name)));
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
        var link = await LoadManageableLinkAsync(linkId, userId);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "同步配对不存在"));
        if (!DocumentSyncDirection.IsValid(request?.Direction))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方向无效"));

        await _db.DocumentStoreSyncLinks.UpdateOneAsync(l => l.Id == linkId,
            Builders<DocumentStoreSyncLink>.Update
                .Set(l => l.Direction, request!.Direction)
                .Set(l => l.UpdatedAt, DateTime.UtcNow));
        link.Direction = request!.Direction!;
        // 状态依赖方向（push 只看本地、pull 只看对端、both 看两侧），改方向后必须按新方向重算，
        // 否则列表保留旧状态（如 both→push 后仍显示因对端漂移而来的「待同步」）。同时回带库名供前端直接替换。
        var localName = (await _db.DocumentStores.Find(s => s.Id == link.LocalStoreId).FirstOrDefaultAsync())?.Name;
        var localSig = await ComputeSignatureAsync(link.LocalStoreId);
        var remoteSig = await GetRemoteSignatureAsync(link);
        var status = ResolveStatus(link, localSig, remoteSig);
        return Ok(ApiResponse<object>.Ok(ToDto(link, status, localSig, remoteSig, localName)));
    }

    /// <summary>
    /// 撤销配对（删除本端的配对记录，停止本端发起的同步）。
    /// 注意：这只断开"本库 → 对端"的出站连接，用的是对端令牌，不影响本库自己的 SyncToken。
    /// 要让"别人凭本库 skblink 连进来"彻底失效，须调 revoke-token（清空本库 SyncToken）—— 二者是不同方向的动作。
    /// </summary>
    [Authorize]
    [HttpDelete("sync/{linkId}")]
    public async Task<IActionResult> DeleteLink(string linkId)
    {
        var userId = GetUserId();
        var link = await LoadManageableLinkAsync(linkId, userId);
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
        if (link.LastSyncedAt == null) return DocumentSyncLinkStatus.Never;
        // 签名与上次同步快照不一致 = 该侧有改动。按方向只关心"会被本次同步搬动"的那侧：
        // push 只看本地、pull 只看对端、both 看任一侧。
        var localChanged = localSig != null && link.LastLocalSignature != null && localSig != link.LastLocalSignature;
        // 对端视为"有改动 / 待同步"的三种情况（与 RunSync 的 null 处理一致）：
        //   a) 当前对端签名取不到（null）——对端不可达/令牌失效，无法确认已同步，不能假装 synced；
        //   b) 上次没抓到对端快照（LastRemoteSignature 为 null）——状态未知；
        //   c) 两侧都有快照但漂移了。
        var remoteChanged = remoteSig == null
            || link.LastRemoteSignature == null
            || remoteSig != link.LastRemoteSignature;
        var relevant = link.Direction switch
        {
            DocumentSyncDirection.Push => localChanged,
            DocumentSyncDirection.Pull => remoteChanged,
            _ => localChanged || remoteChanged,
        };
        // 已落库的 error 保持 error（直到一次成功同步把它清成 synced）：失败后即便有新漂移也应显示「同步出错」
        // 而非「待同步」，否则用户以为只是有待同步内容、看不出上次失败（Bugbot: error status shown as pending）。
        // 重试入口始终在（「立即同步」按钮不依赖状态），不会因此卡住。
        if (link.Status == DocumentSyncLinkStatus.Error)
            return DocumentSyncLinkStatus.Error;
        return relevant ? DocumentSyncLinkStatus.Pending : DocumentSyncLinkStatus.Synced;
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
