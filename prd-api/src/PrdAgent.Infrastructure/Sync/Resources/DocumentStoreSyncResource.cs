using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Net.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Sync.Resources;

/// <summary>
/// 知识库（文档空间）的跨节点互传资源实现。
///
/// 复用现有 DocumentStoreSyncController 的同步算法（血缘幂等 upsert、parent-first 文件夹、
/// 空正文兜底、全字段比对跳过），但适配到通用 SyncResourceBundle 契约，并加上「按用户名/邮箱对齐归属」。
/// 知识库支持双向（SupportsBidirectional = true）。
///
/// 注意：本实现与 DocumentStoreSyncController 的 token 路径并存——两者都用 metadata.syncLineageId
/// 作血缘键，数据互通。旧 skblink 手动配对保留，新系统级配对走本资源。见 doc/design.peer-sync.md §6.1。
/// </summary>
public class DocumentStoreSyncResource : ISyncableResource
{
    private const string SyncLineageKey = "syncLineageId";
    private const string PeerSourceContentHashKey = "peerSourceContentHash";
    // 二进制附件条目（无正文、走 AttachmentId）的来源 URL 幂等键：接收方据此判断「这个对端附件是否已下载重建过」，
    // 命中即廉价跳过，不重复下载。见 debt.peer-sync A 系列。
    private const string PeerSourceAttachmentUrlKey = "peerSourceAttachmentUrl";
    // 源头附件字节数（与 url 同写）：用于幂等的「同源同字节」判定与漂移签名。必须与 url 一样比的是「源头侧的
    // att.Size」（导出端发的 pa.Size），不能拿来跟本地 DocumentEntry.FileSize 比 —— 二者是不同字段、不保证相等，
    // 那样会让每次同步都误判 size 变化、反复重下（Bugbot: Binary sync size mismatch loop）。
    private const string PeerSourceAttachmentSizeKey = "peerSourceAttachmentSize";
    private const long MaxPeerAttachmentBytes = 50L * 1024 * 1024;

    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly ITeamService _teams;
    private readonly IAssetStorage _assetStorage;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly IConfiguration _config;
    private readonly ILogger<DocumentStoreSyncResource> _logger;

    public DocumentStoreSyncResource(
        MongoDbContext db,
        IDocumentService documentService,
        ITeamService teams,
        IAssetStorage assetStorage,
        IHttpClientFactory httpFactory,
        ISafeOutboundUrlValidator urlValidator,
        IConfiguration config,
        ILogger<DocumentStoreSyncResource> logger)
    {
        _db = db;
        _documentService = documentService;
        _teams = teams;
        _assetStorage = assetStorage;
        _httpFactory = httpFactory;
        _urlValidator = urlValidator;
        _config = config;
        _logger = logger;
    }

    public string ResourceType => "document-store";
    public string DisplayName => "知识库";
    public bool SupportsBidirectional => true;
    public int SchemaVersion => 1;

    // ─────────────────────────────────────────────────────────────
    // 列出可发送条目
    // ─────────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<SyncItemSummary>> ListItemsAsync(SyncActor actor, CancellationToken ct)
    {
        var myTeamIds = await _teams.GetMyTeamIdsAsync(actor.UserId);
        var ownerOrTeam = myTeamIds.Count == 0
            ? Builders<DocumentStore>.Filter.Eq(s => s.OwnerId, actor.UserId)
            : Builders<DocumentStore>.Filter.Or(
                Builders<DocumentStore>.Filter.Eq(s => s.OwnerId, actor.UserId),
                Builders<DocumentStore>.Filter.AnyIn(s => s.SharedTeamIds, myTeamIds));
        // 项目库 / 产品库 / 识途库走各自访问轴，互传 v1 不列入（避免越权）。
        var filter = Builders<DocumentStore>.Filter.And(
            ownerOrTeam,
            Builders<DocumentStore>.Filter.Eq(s => s.PmProjectId, (string?)null),
            Builders<DocumentStore>.Filter.Eq(s => s.ProductKnowledgeRef, (string?)null),
            Builders<DocumentStore>.Filter.Eq(s => s.ShituCategoryRef, (string?)null));

        var stores = await _db.DocumentStores.Find(filter).SortByDescending(s => s.UpdatedAt).ToListAsync(ct);
        return stores.Select(s => new SyncItemSummary
        {
            ItemId = s.Id,
            Name = s.Name,
            Description = s.Description,
            RecordCount = s.DocumentCount,
            UpdatedAt = s.UpdatedAt,
        }).ToList();
    }

    // ─────────────────────────────────────────────────────────────
    // 导出 / 签名
    // ─────────────────────────────────────────────────────────────

    public async Task<SyncResourceBundle?> ExportAsync(string itemId, SyncActor actor, CancellationToken ct)
    {
        var store = await LoadAccessibleStoreAsync(itemId, actor.UserId, ct);
        if (store == null) return null;

        var owner = await _db.Users.Find(u => u.UserId == store.OwnerId).FirstOrDefaultAsync(ct);

        var entries = await _db.DocumentEntries.Find(e => e.StoreId == store.Id).ToListAsync(ct);
        var byId = entries.ToDictionary(e => e.Id, e => e);
        // 二进制/文件条目（无 DocumentId、有 AttachmentId）的附件元信息：批量取出，导出时带上其访问 URL，
        // 接收方据此下载 + 重传到自己存储 + 重建条目（debt.peer-sync A 系列：二进制附件跨节点）。
        var attachmentIds = entries
            .Where(e => !e.IsFolder && string.IsNullOrEmpty(e.DocumentId) && !string.IsNullOrEmpty(e.AttachmentId))
            .Select(e => e.AttachmentId!).Distinct().ToList();
        var attById = attachmentIds.Count > 0
            ? (await _db.Attachments.Find(a => attachmentIds.Contains(a.AttachmentId)).ToListAsync(ct))
                .GroupBy(a => a.AttachmentId).ToDictionary(g => g.Key, g => g.First())
            : new Dictionary<string, Attachment>();
        var records = new List<SyncRecord>();
        foreach (var e in entries)
        {
            string? content = null;
            if (!e.IsFolder && !string.IsNullOrEmpty(e.DocumentId))
                content = (await _documentService.GetByIdAsync(e.DocumentId))?.RawContent;

            string? parentLineage = null;
            if (!string.IsNullOrEmpty(e.ParentId) && byId.TryGetValue(e.ParentId, out var parent))
                parentLineage = LineageOf(parent);

            var record = new SyncRecord
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
                ContentHash = content != null ? Sha256Hex(content) : null,
                SortOrder = e.SortOrder,
                Category = e.Category,
                CreatedAt = e.CreatedAt,
                UpdatedAt = e.UpdatedAt,
                LastChangedAt = e.LastChangedAt,
            };
            // 文件条目：带上附件访问信息，接收方据此下载重传重建（content 为 null 不再被跳过）。
            // sourceId = 规范的「源头身份」：本条目若本身来自对端（metadata 有 peerSourceAttachmentUrl），
            // 再导出时必须沿用原始源头 URL 而非本地副本 URL，否则 both（push 再 pull）回流时源头认不出自己的文件，
            // 两侧 peerSourceAttachmentUrl 互相错位 → 双向同步永不收敛（Codex P1）。
            // url = 本节点实际可下载地址（始终对本节点可达），与 sourceId 分离：身份做幂等/签名，url 做取字节。
            if (content == null && !e.IsFolder && !string.IsNullOrEmpty(e.AttachmentId)
                && attById.TryGetValue(e.AttachmentId!, out var att) && !string.IsNullOrWhiteSpace(att.Url))
            {
                var sourceId = e.Metadata != null
                    && e.Metadata.TryGetValue(PeerSourceAttachmentUrlKey, out var psu) && !string.IsNullOrEmpty(psu)
                    ? psu : att.Url;
                record.Extras["peerAttachment"] = JsonSerializer.SerializeToElement(new
                {
                    sourceId,
                    url = att.Url,
                    mimeType = att.MimeType,
                    fileName = att.FileName,
                    size = att.Size,
                    type = att.Type.ToString(),
                    thumbnailUrl = att.ThumbnailUrl,
                    extractedText = att.ExtractedText,
                });
            }
            records.Add(record);
        }

        // 主文档 / 置顶按血缘导出（接收方翻译回本端 entry id）。
        string? primaryLineage = !string.IsNullOrEmpty(store.PrimaryEntryId) && byId.TryGetValue(store.PrimaryEntryId, out var pe)
            ? LineageOf(pe) : null;
        var pinnedLineages = (store.PinnedEntryIds ?? new List<string>())
            .Where(id => byId.ContainsKey(id))
            .Select(id => LineageOf(byId[id]))
            .ToList();

        return new SyncResourceBundle
        {
            SchemaVersion = SchemaVersion,
            ResourceType = ResourceType,
            Item = new SyncBundleItem
            {
                Key = store.Id,
                Name = store.Name,
                Description = store.Description,
                Tags = store.Tags,
                OwnerUserName = owner?.Username,
                OwnerEmail = owner?.Email,
                CreatedAt = store.CreatedAt,
                UpdatedAt = store.UpdatedAt,
                TemplateKey = store.TemplateKey,
                PrimaryEntryLineage = primaryLineage,
                PinnedEntryLineages = pinnedLineages.Count > 0 ? pinnedLineages : null,
                DefaultSortMode = store.DefaultSortMode,
            },
            Records = records,
        };
    }

    public async Task<string?> ComputeSignatureAsync(string itemId, CancellationToken ct)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == itemId).FirstOrDefaultAsync(ct);
        if (store == null) return null;
        // PR #742 review P2 fix：项目库 / 产品库走专属访问轴，peer-sync 不放行。
        // RemoteSignature 端点对配对节点开放，若不在这里拦，对端能用 store id 探出该库存在性 + 漂移信号。
        if (!string.IsNullOrEmpty(store.PmProjectId) || !string.IsNullOrEmpty(store.ProductKnowledgeRef))
            return null;
        // PR #742 review P2 fix（两轮闭环）：
        // - 一轮：之前签名带 UpdatedAt.Ticks，apply 写入时用 DateTime.UtcNow 覆盖 → 两节点同步后内容
        //   完全一致但签名永远不同 → 双向漂移检测永久报"不同步"。改用内容稳定字段。
        // - 二轮：只 hash ContentIndex（前 2000 字符）会漏掉文档后段 drift。改用 ParsedPrd.RawContent
        //   全文 sha256，确保任何内容变化都触发签名差异。代价是加载所有文档 — signature 不是高频
        //   路径（漂移检测调用），可接受；apply 路径本来就要全量传输 RawContent，带宽匹配。
        var entries = await _db.DocumentEntries.Find(e => e.StoreId == itemId).ToListAsync(ct);
        var byId = entries.ToDictionary(e => e.Id, e => e);
        // 二进制附件条目：纳入「来源附件标识」做签名，否则仅二进制文件变化的库签名不变 → 漂移检测误报「已同步」。
        // 标识用 peerSourceAttachmentUrl（接收节点）∥ att.Url（源节点）—— 两节点对同一份文件得到同一个值，
        // 与是否共享 CDN 无关，避免「内容一致但签名永不同」的伪漂移。
        var binAttachmentIds = entries
            .Where(e => !e.IsFolder && string.IsNullOrEmpty(e.DocumentId) && !string.IsNullOrEmpty(e.AttachmentId))
            .Select(e => e.AttachmentId!).Distinct().ToList();
        var binAttById = binAttachmentIds.Count > 0
            ? (await _db.Attachments.Find(a => binAttachmentIds.Contains(a.AttachmentId)).ToListAsync(ct))
                .GroupBy(a => a.AttachmentId).ToDictionary(g => g.Key, g => g.First())
            : new Dictionary<string, Attachment>();
        string? ParentLineage(string? parentId)
            => string.IsNullOrEmpty(parentId) || !byId.TryGetValue(parentId!, out var p) ? null : LineageOf(p);
        var parts = new List<string>(entries.Count);
        foreach (var e in entries)
        {
            string contentHash = string.Empty;
            if (!e.IsFolder && !string.IsNullOrEmpty(e.DocumentId))
            {
                var doc = await _documentService.GetByIdAsync(e.DocumentId);
                contentHash = Sha256Hex(doc?.RawContent ?? string.Empty);
            }
            else if (!e.IsFolder && string.IsNullOrEmpty(e.DocumentId) && !string.IsNullOrEmpty(e.AttachmentId))
            {
                // 标识 + 源头字节数都取「源头侧口径」，保证两节点对同一文件得同一签名：
                // 接收方读 metadata 的 peerSourceAttachmentUrl/Size；源头节点（无该 metadata）读自身 att.Url/att.Size。
                // 不能用 e.FileSize（entry 字段，与 att.Size 不同口径）做签名，否则两侧恒不等（Bugbot: size mismatch loop）。
                binAttById.TryGetValue(e.AttachmentId!, out var att);
                var attIdentity = e.Metadata != null && e.Metadata.TryGetValue(PeerSourceAttachmentUrlKey, out var src) && !string.IsNullOrEmpty(src)
                    ? src
                    : (att?.Url ?? string.Empty);
                var attSize = AppliedSourceAttachmentSize(e.Metadata) ?? att?.Size ?? 0;
                contentHash = Sha256Hex("attachment:" + attIdentity + ":" + attSize.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            var tags = string.Join(",", (e.Tags ?? new List<string>()).OrderBy(t => t, StringComparer.Ordinal));
            // 纳入 SortOrder/Category（v1.1）：否则仅手动排序/分类变化的库签名不变，漂移检测会误报「已同步」
            // 而下一次 transfer 仍会改数据（Codex）。SortOrder 用 InvariantCulture 保证跨 locale 哈希稳定。
            var sortOrder = e.SortOrder?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
            parts.Add($"{LineageOf(e)}|{(e.IsFolder ? 1 : 0)}|{e.Title}|{ParentLineage(e.ParentId) ?? string.Empty}|{tags}|{contentHash}|{sortOrder}|{e.Category ?? string.Empty}");
        }
        parts.Sort(StringComparer.Ordinal);
        // 库级稳定字段（默认排序）也纳入签名：仅改默认排序时同样应被漂移检测捕获。
        parts.Add($"__store__|defaultSortMode={store.DefaultSortMode ?? string.Empty}");
        return Sha256Hex(string.Join("\n", parts));
    }

    // ─────────────────────────────────────────────────────────────
    // 接收应用（按用户名/邮箱对齐归属 + 血缘幂等 upsert）
    // ─────────────────────────────────────────────────────────────

    public async Task<SyncApplyOutcome> ApplyAsync(
        SyncResourceBundle bundle, SyncActor actor, SyncApplyMode mode, string? targetKey, CancellationToken ct)
    {
        // 1) 归属对齐：用户名 → 邮箱 → 兜底归到操作者
        var (ownerUserId, ownerName, ownerAvatar, authorMatched) = await ResolveOwnerAsync(bundle.Item, actor, ct);
        var options = ReadOptions(bundle);

        // 2) 解析 / 创建目标库（保留同一 Id 便于 test↔prod 同库）
        var key = !string.IsNullOrWhiteSpace(targetKey) ? targetKey! : bundle.Item.Key;
        var target = string.IsNullOrWhiteSpace(key)
            ? null
            : await _db.DocumentStores.Find(s => s.Id == key).FirstOrDefaultAsync(ct);
        // PR #742 review P2：apply 路径不许写入项目知识库 / 产品知识库 —— 这些走专属访问轴
        // （PmProject 成员 / Product owner），peer-sync 不在该轴上，否则配对方可越权改它们。
        // ListItems / Export 已排除这类库，此处兜底；命中即返回错误，不静默创建新库或写入。
        if (target != null && (!string.IsNullOrEmpty(target.PmProjectId) || !string.IsNullOrEmpty(target.ProductKnowledgeRef)))
        {
            return new SyncApplyOutcome
            {
                Failed = bundle.Records?.Count ?? 0,
                Message = "目标库属于项目库 / 产品库，受专属访问轴保护，peer-sync 不能写入",
            };
        }
        if (target == null)
        {
            target = new DocumentStore
            {
                Id = !string.IsNullOrWhiteSpace(key) ? key : Guid.NewGuid().ToString("N"),
                Name = string.IsNullOrWhiteSpace(bundle.Item.Name) ? "（来自对端的知识库）" : bundle.Item.Name,
                Description = bundle.Item.Description,
                OwnerId = ownerUserId,
                Tags = bundle.Item.Tags ?? new List<string>(),
                TemplateKey = bundle.Item.TemplateKey,
                CreatedAt = options.PreserveTimestamps && bundle.Item.CreatedAt.HasValue ? bundle.Item.CreatedAt.Value : DateTime.UtcNow,
                UpdatedAt = options.PreserveTimestamps && bundle.Item.UpdatedAt.HasValue ? bundle.Item.UpdatedAt.Value : DateTime.UtcNow,
            };
            await _db.DocumentStores.InsertOneAsync(target, cancellationToken: ct);
        }

        var outcome = await ApplyRecordsAsync(target, bundle.Item, bundle.Records, mode, options, ownerUserId, ownerName, ownerAvatar, ct);
        outcome.TargetItemId = target.Id;
        outcome.UnmatchedAuthors = authorMatched ? 0 : 1;
        if (!authorMatched)
            outcome.Message = (outcome.Message == null ? "" : outcome.Message + "；")
                + $"作者「{bundle.Item.OwnerUserName ?? bundle.Item.OwnerEmail ?? "未知"}」在本节点无同名用户，已归到你名下";
        return outcome;
    }

    private async Task<(string userId, string name, string? avatar, bool matched)> ResolveOwnerAsync(
        SyncBundleItem item, SyncActor actor, CancellationToken ct)
    {
        User? user = null;
        if (!string.IsNullOrWhiteSpace(item.OwnerUserName))
            user = await _db.Users.Find(u => u.Username == item.OwnerUserName).FirstOrDefaultAsync(ct);
        if (user == null && !string.IsNullOrWhiteSpace(item.OwnerEmail))
            user = await _db.Users.Find(u => u.Email == item.OwnerEmail).FirstOrDefaultAsync(ct);

        if (user != null)
        {
            var name = !string.IsNullOrWhiteSpace(user.DisplayName) ? user.DisplayName : user.Username;
            return (user.UserId, name, user.AvatarFileName, true);
        }
        // 兜底归到操作者
        var op = await _db.Users.Find(u => u.UserId == actor.UserId).FirstOrDefaultAsync(ct);
        var opName = op != null && !string.IsNullOrWhiteSpace(op.DisplayName) ? op.DisplayName
            : (op?.Username ?? actor.UserName ?? "同步");
        return (actor.UserId, opName, op?.AvatarFileName, false);
    }

    /// <summary>把记录幂等 upsert 进目标库（沿用 DocumentStoreSyncController.ApplyBundleAsync 的算法）。</summary>
    private async Task<SyncApplyOutcome> ApplyRecordsAsync(
        DocumentStore target, SyncBundleItem item, List<SyncRecord> records, SyncApplyMode mode,
        DocumentStorePeerApplyOptions options,
        string actorUserId, string actorName, string? actorAvatar, CancellationToken ct)
    {
        records ??= new List<SyncRecord>();
        var existing = await _db.DocumentEntries.Find(e => e.StoreId == target.Id).ToListAsync(ct);
        var byLineage = new Dictionary<string, DocumentEntry>();
        foreach (var e in existing)
        {
            var k = LineageOf(e);
            if (!byLineage.ContainsKey(k)) byLineage[k] = e;
        }
        var lineageToTargetId = new Dictionary<string, string>();
        int created = 0, updated = 0, skipped = 0, failed = 0, deleted = 0, assetsRewritten = 0, assetRewriteFailed = 0;
        var addOnly = mode == SyncApplyMode.AddOnly;
        var mirror = mode == SyncApplyMode.Mirror;
        var now = DateTime.UtcNow;
        DateTime PickTime(DateTime? source) => PickTimestamp(source, options.PreserveTimestamps, now);

        string? ResolveParent(string? parentLineage)
        {
            if (string.IsNullOrEmpty(parentLineage)) return null;
            if (lineageToTargetId.TryGetValue(parentLineage, out var mapped)) return mapped;
            if (byLineage.TryGetValue(parentLineage, out var ex)) return ex.Id;
            return null;
        }

        async Task UpsertFolderAsync(SyncRecord f, string? parentId)
        {
            if (byLineage.TryGetValue(f.LineageId, out var exFolder))
            {
                lineageToTargetId[f.LineageId] = exFolder.Id;
                if (addOnly) { skipped++; return; }
                var newTags = f.Tags ?? new List<string>();
                // 含 SortOrder/Category（v1.1）：仅文件夹手动排序/分类变化时也要落更新，否则目录顺序漂移
                // 被漏同步（Bugbot: Apply exported folder ordering on import）。
                var contentChanged = exFolder.Title != f.Title || exFolder.ParentId != parentId
                    || !TagsEqual(exFolder.Tags, f.Tags) || !MetaEqual(exFolder.Metadata, f.Metadata)
                    || exFolder.SortOrder != f.SortOrder || exFolder.Category != f.Category;
                var timestampsChanged = NeedsRecordTimestampRefresh(exFolder, f, options.PreserveTimestamps);
                if (contentChanged || timestampsChanged)
                {
                    var update = Builders<DocumentEntry>.Update
                        .Set(e => e.Title, f.Title)
                        .Set(e => e.ParentId, parentId)
                        .Set(e => e.Tags, newTags)
                        .Set(e => e.SortOrder, f.SortOrder)
                        .Set(e => e.Category, f.Category)
                        .Set(e => e.Metadata, WithLineage(f.Metadata, f.LineageId))
                        .Set(e => e.UpdatedBy, actorUserId)
                        .Set(e => e.UpdatedByName, actorName)
                        .Set(e => e.UpdatedAt, PickTime(f.UpdatedAt));
                    if (options.PreserveTimestamps && f.CreatedAt.HasValue)
                        update = update.Set(e => e.CreatedAt, PickTime(f.CreatedAt));
                    if (options.PreserveTimestamps && (f.LastChangedAt.HasValue || f.UpdatedAt.HasValue))
                        update = update.Set(e => e.LastChangedAt, PickTime(f.LastChangedAt ?? f.UpdatedAt));

                    await _db.DocumentEntries.UpdateOneAsync(e => e.Id == exFolder.Id, update, cancellationToken: ct);
                    exFolder.Title = f.Title;
                    exFolder.ParentId = parentId;
                    exFolder.Tags = newTags;
                    exFolder.SortOrder = f.SortOrder;
                    exFolder.Category = f.Category;
                    exFolder.Metadata = WithLineage(f.Metadata, f.LineageId);
                    exFolder.UpdatedAt = PickTime(f.UpdatedAt);
                    if (options.PreserveTimestamps && f.CreatedAt.HasValue)
                        exFolder.CreatedAt = PickTime(f.CreatedAt);
                    if (options.PreserveTimestamps && (f.LastChangedAt.HasValue || f.UpdatedAt.HasValue))
                        exFolder.LastChangedAt = PickTime(f.LastChangedAt ?? f.UpdatedAt);
                    updated++;
                }
                else skipped++;
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
                SortOrder = f.SortOrder,
                Category = f.Category,
                Metadata = WithLineage(f.Metadata, f.LineageId),
                CreatedBy = actorUserId,
                CreatedByName = actorName,
                CreatedByAvatarFileName = actorAvatar,
                UpdatedBy = actorUserId,
                UpdatedByName = actorName,
                CreatedAt = PickTime(f.CreatedAt),
                UpdatedAt = PickTime(f.UpdatedAt),
            };
            await _db.DocumentEntries.InsertOneAsync(folder, cancellationToken: ct);
            byLineage[f.LineageId] = folder;
            lineageToTargetId[f.LineageId] = folder.Id;
            created++;
        }

        // 文件夹 parent-first 多趟扫描
        var pendingFolders = records.Where(e => e.IsFolder).ToList();
        var guard = 0;
        while (pendingFolders.Count > 0 && guard++ < 5000)
        {
            var progressed = false;
            foreach (var f in pendingFolders.ToList())
            {
                if (!string.IsNullOrEmpty(f.ParentLineageId)
                    && !lineageToTargetId.ContainsKey(f.ParentLineageId)
                    && !byLineage.ContainsKey(f.ParentLineageId))
                    continue;
                await UpsertFolderAsync(f, ResolveParent(f.ParentLineageId));
                pendingFolders.Remove(f);
                progressed = true;
            }
            if (!progressed) break;
        }
        foreach (var f in pendingFolders)
            await UpsertFolderAsync(f, ResolveParent(f.ParentLineageId));

        // 文件类记录
        foreach (var fe in records.Where(e => !e.IsFolder))
        {
            try
            {
                if (fe.Content == null)
                {
                    // 二进制 / 文件条目（无正文、走 AttachmentId）：对端导出时带了 peerAttachment 元信息，
                    // 接收方据此下载文件 → 重传到自己存储 → 重建条目，从而真正做到「两库一篇不差」。
                    // 旧节点 / 无附件信息的占位记录仍按原行为跳过（不阻塞同步）。
                    if (!TryReadPeerAttachment(fe, out var pa))
                    {
                        skipped++;
                        continue;
                    }

                    var binParentId = ResolveParent(fe.ParentLineageId);

                    if (byLineage.TryGetValue(fe.LineageId, out var exBinFolder) && exBinFolder.IsFolder)
                    {
                        skipped++;
                        continue;
                    }

                    if (byLineage.TryGetValue(fe.LineageId, out var exBin) && !exBin.IsFolder)
                    {
                        if (addOnly) { skipped++; continue; }
                        // 目标 ContentType/FileSize 取「源头条目值」（fe），缺省退回现有值；下载新件时再用 stored 兜底。
                        // 这两个字段也纳入变更检测 + 落更新，否则即便文件未变、仅源头改了类型/大小也会被廉价跳过漏同步
                        // （Bugbot: Binary sync skips entry metadata）。比的都是「源头条目口径」(fe vs 上次写入的 exBin)，无重下循环风险。
                        var binTargetContentType = !string.IsNullOrEmpty(fe.ContentType) ? fe.ContentType : exBin.ContentType;
                        var binTargetFileSize = fe.FileSize > 0 ? fe.FileSize : exBin.FileSize;
                        // 附件提取文本快照：纳入变更检测，使「文件未变但提取文本变了」也能进重写分支刷新 Attachment.ExtractedText
                        // （Bugbot: Stale attachment extracted text）。
                        var binIncomingContentIndex = BinaryContentIndex(pa.ExtractedText);
                        var binFieldsChanged = exBin.Title != fe.Title || exBin.ParentId != binParentId
                            || !TagsEqual(exBin.Tags, fe.Tags) || exBin.Summary != fe.Summary
                            || !MetaEqual(exBin.Metadata, fe.Metadata)
                            || exBin.SortOrder != fe.SortOrder || exBin.Category != fe.Category
                            || exBin.ContentType != binTargetContentType || exBin.FileSize != binTargetFileSize
                            || exBin.ContentIndex != binIncomingContentIndex;
                        // 幂等不只看 URL，还要比「源头字节数」：对象存储是内容寻址（sha256→URL），同 URL 即同字节，
                        // 但万一底层存储复用了 URL 又换了字节，size 不一致即强制重下（Bugbot: Stale file when URL unchanged）。
                        // 关键：比的是「上次记录的源头 size」(AppliedSourceAttachmentSize) 与「本次源头 size」(pa.Size)，
                        // 二者同口径；绝不拿本地 DocumentEntry.FileSize 比，否则 entry.FileSize≠att.Size 时会无限重下
                        // （Bugbot: Binary sync size mismatch loop）。任一侧 size 未知（<=0/未记录）时退回仅 URL 判定。
                        var binAppliedSize = AppliedSourceAttachmentSize(exBin.Metadata);
                        var binSizeMatches = pa.Size <= 0 || binAppliedSize == null || binAppliedSize.Value == pa.Size;
                        var binApplied = HasAppliedSourceAttachment(exBin.Metadata, pa.SourceId) && binSizeMatches;
                        var binTimestampsChanged = NeedsRecordTimestampRefresh(exBin, fe, options.PreserveTimestamps);

                        // 二进制已下载且字段无变化 → 廉价跳过（必要时只刷新时间戳）。
                        if (binApplied && !binFieldsChanged)
                        {
                            if (binTimestampsChanged)
                            {
                                var tsUpdate = Builders<DocumentEntry>.Update
                                    .Set(e => e.UpdatedBy, actorUserId)
                                    .Set(e => e.UpdatedByName, actorName)
                                    .Set(e => e.UpdatedAt, PickTime(fe.UpdatedAt))
                                    .Set(e => e.Metadata, WithPeerSourceAttachment(WithLineage(fe.Metadata, fe.LineageId), pa.SourceId, pa.Size));
                                if (options.PreserveTimestamps && fe.CreatedAt.HasValue)
                                    tsUpdate = tsUpdate.Set(e => e.CreatedAt, PickTime(fe.CreatedAt));
                                if (options.PreserveTimestamps && (fe.LastChangedAt.HasValue || fe.UpdatedAt.HasValue))
                                    tsUpdate = tsUpdate.Set(e => e.LastChangedAt, PickTime(fe.LastChangedAt ?? fe.UpdatedAt));
                                await _db.DocumentEntries.UpdateOneAsync(e => e.Id == exBin.Id, tsUpdate, cancellationToken: ct);
                            }
                            skipped++;
                            continue;
                        }

                        // 此前若同血缘是文本条目（带 DocumentId），转成二进制后要清理被替换的 ParsedPrd，
                        // 否则留孤儿解析文档（Bugbot: Orphan doc after binary overwrite）。
                        var binOldDocId = exBin.DocumentId;
                        var binAttachmentId = exBin.AttachmentId;
                        if (!binApplied)
                        {
                            var stored = await DownloadAndStoreAttachmentAsync(pa, options.SourceBaseUrl, ct);
                            if (stored == null) { failed++; continue; }
                            var att = BuildAttachment(pa, stored, actorUserId);
                            await ReLocalizeAttachmentThumbnailAsync(att, pa, ct);
                            await _db.Attachments.InsertOneAsync(att, cancellationToken: ct);
                            binAttachmentId = att.AttachmentId;
                            // 下载到新件后用 stored 兜底缺省类型/大小。
                            binTargetContentType = string.IsNullOrEmpty(fe.ContentType) ? stored.Mime : fe.ContentType;
                            binTargetFileSize = fe.FileSize > 0 ? fe.FileSize : stored.SizeBytes;
                        }
                        else if (!string.IsNullOrEmpty(exBin.AttachmentId))
                        {
                            // 文件未变（同 sourceId+size 跳过重下），但提取文本/文件名可能变了 → 刷新已存在 Attachment 行，
                            // 否则 Attachment.ExtractedText 永远停在首次下载值（Bugbot: Stale attachment extracted text）。
                            var attRefresh = Builders<Attachment>.Update
                                .Set(a => a.ExtractedText, pa.ExtractedText);
                            if (!string.IsNullOrWhiteSpace(pa.FileName))
                                attRefresh = attRefresh.Set(a => a.FileName, pa.FileName!);
                            await _db.Attachments.UpdateOneAsync(a => a.AttachmentId == exBin.AttachmentId, attRefresh, cancellationToken: ct);
                        }
                        var binMeta = WithPeerSourceAttachment(WithLineage(fe.Metadata, fe.LineageId), pa.SourceId, pa.Size);
                        var binUpdatedAt = PickTime(fe.UpdatedAt);
                        var binChangedAt = PickTime(fe.LastChangedAt ?? fe.UpdatedAt);
                        var binUpdate = Builders<DocumentEntry>.Update
                            .Set(e => e.AttachmentId, binAttachmentId)
                            .Set(e => e.DocumentId, (string?)null)
                            .Set(e => e.Title, fe.Title)
                            .Set(e => e.Summary, fe.Summary)
                            .Set(e => e.ParentId, binParentId)
                            .Set(e => e.Tags, fe.Tags ?? new List<string>())
                            .Set(e => e.ContentType, binTargetContentType)
                            .Set(e => e.ContentIndex, binIncomingContentIndex)
                            .Set(e => e.FileSize, binTargetFileSize)
                            .Set(e => e.SortOrder, fe.SortOrder)
                            .Set(e => e.Category, fe.Category)
                            .Set(e => e.Metadata, binMeta)
                            .Set(e => e.UpdatedBy, actorUserId)
                            .Set(e => e.UpdatedByName, actorName)
                            .Set(e => e.UpdatedAt, binUpdatedAt)
                            .Set(e => e.LastChangedAt, binChangedAt);
                        if (options.PreserveTimestamps && fe.CreatedAt.HasValue)
                            binUpdate = binUpdate.Set(e => e.CreatedAt, PickTime(fe.CreatedAt));
                        await _db.DocumentEntries.UpdateOneAsync(e => e.Id == exBin.Id, binUpdate, cancellationToken: ct);
                        if (!string.IsNullOrEmpty(binOldDocId))
                            await CleanupReplacedDocAsync(binOldDocId, string.Empty, exBin.Id);
                        updated++;
                        continue;
                    }

                    // 新建二进制条目
                    var storedNew = await DownloadAndStoreAttachmentAsync(pa, options.SourceBaseUrl, ct);
                    if (storedNew == null) { failed++; continue; }
                    var attNew = BuildAttachment(pa, storedNew, actorUserId);
                    await ReLocalizeAttachmentThumbnailAsync(attNew, pa, ct);
                    await _db.Attachments.InsertOneAsync(attNew, cancellationToken: ct);
                    var entryBin = new DocumentEntry
                    {
                        StoreId = target.Id,
                        ParentId = binParentId,
                        IsFolder = false,
                        Title = fe.Title,
                        Summary = fe.Summary,
                        SourceType = DocumentSourceType.Import,
                        AttachmentId = attNew.AttachmentId,
                        ContentType = string.IsNullOrEmpty(fe.ContentType) ? storedNew.Mime : fe.ContentType,
                        ContentIndex = BinaryContentIndex(pa.ExtractedText),
                        FileSize = fe.FileSize > 0 ? fe.FileSize : storedNew.SizeBytes,
                        Tags = fe.Tags ?? new List<string>(),
                        SortOrder = fe.SortOrder,
                        Category = fe.Category,
                        Metadata = WithPeerSourceAttachment(WithLineage(fe.Metadata, fe.LineageId), pa.SourceId, pa.Size),
                        CreatedBy = actorUserId,
                        CreatedByName = actorName,
                        CreatedByAvatarFileName = actorAvatar,
                        UpdatedBy = actorUserId,
                        UpdatedByName = actorName,
                        CreatedAt = PickTime(fe.CreatedAt),
                        UpdatedAt = PickTime(fe.UpdatedAt),
                        LastChangedAt = PickTime(fe.LastChangedAt ?? fe.UpdatedAt),
                    };
                    await _db.DocumentEntries.InsertOneAsync(entryBin, cancellationToken: ct);
                    byLineage[fe.LineageId] = entryBin;
                    created++;
                    continue;
                }
                var parentId = ResolveParent(fe.ParentLineageId);
                var content = fe.Content;

                if (byLineage.TryGetValue(fe.LineageId, out var exFolderConflict) && exFolderConflict.IsFolder)
                {
                    skipped++;
                    continue;
                }

                if (byLineage.TryGetValue(fe.LineageId, out var exEntry) && !exEntry.IsFolder)
                {
                    if (addOnly) { skipped++; continue; }
                    var sourceContentHash = Sha256Hex(content);
                    var targetMetadata = WithPeerSourceContentHash(WithLineage(fe.Metadata, fe.LineageId), sourceContentHash);
                    // 「纯二进制」= 有 AttachmentId 且无 DocumentId。仅这种条目转文本时才算形态切换、才清 AttachmentId。
                    // 关键：双形态条目（PDF/DOCX 等同时有 DocumentId + AttachmentId）导出只发文本（见 debt B4），both 回流时
                    // 源头会拉回「纯文本回声」；若把「有 AttachmentId」一律当作二进制转文本，会把源头双形态条目的文件引用清掉
                    // （Codex P1: Preserve attachments on dual text/file records）。故所有形态切换逻辑都只认 wasBinaryOnly。
                    var wasBinaryOnly = !string.IsNullOrEmpty(exEntry.AttachmentId) && string.IsNullOrEmpty(exEntry.DocumentId);
                    var recordFieldsChanged = exEntry.Title != fe.Title || exEntry.ParentId != parentId
                        || !TagsEqual(exEntry.Tags, fe.Tags) || exEntry.Summary != fe.Summary
                        || !MetaEqual(exEntry.Metadata, fe.Metadata)
                        // v1.1 字段：仅排序/分类变化时也要落更新，否则只改 sortOrder/category 的对端改动会被廉价跳过
                        // （Bugbot: Sort and category skip sync）。全量更新分支已 Set 这两个字段，故这里必须纳入比较。
                        || exEntry.SortOrder != fe.SortOrder || exEntry.Category != fe.Category
                        // 形态切换：现有为纯二进制文件，对端改成文本（哪怕空文本、其它字段没变）也必须走全量更新分支，
                        // 否则空文本与「文件无 DocumentId 取到的 string.Empty」哈希相等 → 被廉价跳过，条目永远停在旧文件
                        // （Codex: Handle empty text when replacing a synced file）。转换后 fullUpdate 写 DocumentId 并清
                        // AttachmentId，下次 wasBinaryOnly 即为 false，无循环。
                        || wasBinaryOnly;
                    var timestampsChanged = NeedsRecordTimestampRefresh(exEntry, fe, options.PreserveTimestamps);
                    if (!recordFieldsChanged && HasAppliedSourceContent(exEntry.Metadata, sourceContentHash))
                    {
                        if (timestampsChanged)
                        {
                            var timestampUpdate = Builders<DocumentEntry>.Update
                                .Set(e => e.UpdatedBy, actorUserId)
                                .Set(e => e.UpdatedByName, actorName)
                                .Set(e => e.UpdatedAt, PickTime(fe.UpdatedAt))
                                .Set(e => e.Metadata, targetMetadata);
                            if (options.PreserveTimestamps && fe.CreatedAt.HasValue)
                                timestampUpdate = timestampUpdate.Set(e => e.CreatedAt, PickTime(fe.CreatedAt));
                            if (options.PreserveTimestamps && (fe.LastChangedAt.HasValue || fe.UpdatedAt.HasValue))
                                timestampUpdate = timestampUpdate.Set(e => e.LastChangedAt, PickTime(fe.LastChangedAt ?? fe.UpdatedAt));

                            await _db.DocumentEntries.UpdateOneAsync(e => e.Id == exEntry.Id, timestampUpdate, cancellationToken: ct);
                        }
                        skipped++;
                        continue;
                    }
                    var existingContent = !string.IsNullOrEmpty(exEntry.DocumentId)
                        ? (await _documentService.GetByIdAsync(exEntry.DocumentId))?.RawContent ?? string.Empty
                        : string.Empty;
                    if (options.RewriteAssetLinks)
                    {
                        var rewrite = await RewriteEmbeddedAssetsAsync(content, options.SourceBaseUrl, ct);
                        content = rewrite.Content;
                        assetsRewritten += rewrite.Rewritten;
                        assetRewriteFailed += rewrite.Failed;
                    }
                    var contentChanged = Sha256Hex(existingContent) != Sha256Hex(content) || recordFieldsChanged;
                    if (!contentChanged && !timestampsChanged)
                    {
                        if (!HasAppliedSourceContent(exEntry.Metadata, sourceContentHash))
                        {
                            await _db.DocumentEntries.UpdateOneAsync(
                                e => e.Id == exEntry.Id,
                                Builders<DocumentEntry>.Update.Set(e => e.Metadata, targetMetadata),
                                cancellationToken: ct);
                        }
                        skipped++;
                        continue;
                    }
                    if (!contentChanged)
                    {
                        var timeOnlyUpdate = Builders<DocumentEntry>.Update
                            .Set(e => e.UpdatedBy, actorUserId)
                            .Set(e => e.UpdatedByName, actorName)
                            .Set(e => e.UpdatedAt, PickTime(fe.UpdatedAt))
                            .Set(e => e.Metadata, targetMetadata);
                        if (options.PreserveTimestamps && fe.CreatedAt.HasValue)
                            timeOnlyUpdate = timeOnlyUpdate.Set(e => e.CreatedAt, PickTime(fe.CreatedAt));
                        if (options.PreserveTimestamps && (fe.LastChangedAt.HasValue || fe.UpdatedAt.HasValue))
                            timeOnlyUpdate = timeOnlyUpdate.Set(e => e.LastChangedAt, PickTime(fe.LastChangedAt ?? fe.UpdatedAt));

                        await _db.DocumentEntries.UpdateOneAsync(e => e.Id == exEntry.Id, timeOnlyUpdate, cancellationToken: ct);
                        updated++;
                        continue;
                    }
                    var oldDocId = exEntry.DocumentId;
                    var parsed = await BuildAndSaveDocAsync(content, fe.Title);
                    var updatedAt = PickTime(fe.UpdatedAt);
                    var changedAt = PickTime(fe.LastChangedAt ?? fe.UpdatedAt);
                    var fullUpdate = Builders<DocumentEntry>.Update
                        .Set(e => e.DocumentId, parsed.Id)
                        .Set(e => e.Title, fe.Title)
                        .Set(e => e.Summary, fe.Summary)
                        .Set(e => e.ParentId, parentId)
                        .Set(e => e.Tags, fe.Tags ?? new List<string>())
                        .Set(e => e.ContentIndex, content.Length > 2000 ? content[..2000] : content)
                        .Set(e => e.FileSize, fe.FileSize)
                        .Set(e => e.ContentType, string.IsNullOrEmpty(fe.ContentType) ? "text/markdown" : fe.ContentType)
                        .Set(e => e.SortOrder, fe.SortOrder)
                        .Set(e => e.Category, fe.Category)
                        .Set(e => e.Metadata, targetMetadata)
                        .Set(e => e.UpdatedBy, actorUserId)
                        .Set(e => e.UpdatedByName, actorName)
                        .Set(e => e.UpdatedAt, updatedAt)
                        .Set(e => e.LastChangedAt, changedAt);
                    if (options.PreserveTimestamps && fe.CreatedAt.HasValue)
                        fullUpdate = fullUpdate.Set(e => e.CreatedAt, PickTime(fe.CreatedAt));
                    // 仅「纯二进制 → 文本」转换才清 AttachmentId（与二进制路径清 DocumentId 对称）。
                    // 双形态条目（DocumentId + AttachmentId 并存，如 PDF/DOCX）正常文本更新时**不**清 AttachmentId，
                    // 否则 both 回流会让源头丢失原始文件引用（Codex P1: Preserve attachments on dual text/file records）。
                    if (wasBinaryOnly)
                        fullUpdate = fullUpdate.Set(e => e.AttachmentId, (string?)null);

                    await _db.DocumentEntries.UpdateOneAsync(e => e.Id == exEntry.Id, fullUpdate, cancellationToken: ct);
                    await CleanupReplacedDocAsync(oldDocId, parsed.Id, exEntry.Id);
                    updated++;
                }
                else
                {
                    if (options.RewriteAssetLinks)
                    {
                        var rewrite = await RewriteEmbeddedAssetsAsync(content, options.SourceBaseUrl, ct);
                        content = rewrite.Content;
                        assetsRewritten += rewrite.Rewritten;
                        assetRewriteFailed += rewrite.Failed;
                    }
                    var sourceContentHash = Sha256Hex(fe.Content);
                    var parsed = await BuildAndSaveDocAsync(content, fe.Title);
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
                        SortOrder = fe.SortOrder,
                        Category = fe.Category,
                        Metadata = WithPeerSourceContentHash(WithLineage(fe.Metadata, fe.LineageId), sourceContentHash),
                        DocumentId = parsed.Id,
                        ContentIndex = content.Length > 2000 ? content[..2000] : content,
                        CreatedBy = actorUserId,
                        CreatedByName = actorName,
                        CreatedByAvatarFileName = actorAvatar,
                        UpdatedBy = actorUserId,
                        UpdatedByName = actorName,
                        CreatedAt = PickTime(fe.CreatedAt),
                        UpdatedAt = PickTime(fe.UpdatedAt),
                        LastChangedAt = PickTime(fe.LastChangedAt ?? fe.UpdatedAt),
                    };
                    await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: ct);
                    byLineage[fe.LineageId] = entry;
                    created++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[peer-sync] apply entry failed: {Title}", fe.Title);
                failed++;
            }
        }

        // 镜像对齐（强制对齐·远端为准 / 本地为准）：删除目标端存在、但本次 bundle 里没有的条目。
        // 这是 MAP 知识库传输协议里唯一会删除数据的路径，故仅 SyncApplyMode.Mirror 触发，
        // 且 PeerSyncController 在 align-remote/align-local 时才传 Mirror。普通 push/pull/both 不删。
        if (mirror)
        {
            var incomingLineages = records.Select(r => r.LineageId).ToHashSet(StringComparer.Ordinal);
            var toDelete = existing.Where(e => !incomingLineages.Contains(LineageOf(e))).ToList();
            foreach (var e in toDelete)
            {
                try
                {
                    await _db.DocumentEntries.DeleteOneAsync(x => x.Id == e.Id, ct);
                    if (!e.IsFolder && !string.IsNullOrEmpty(e.DocumentId))
                        await CleanupReplacedDocAsync(e.DocumentId, string.Empty, e.Id);
                    deleted++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[peer-sync] mirror delete entry failed: {Title}", e.Title);
                    failed++;
                }
            }
        }

        var count = await _db.DocumentEntries.CountDocumentsAsync(e => e.StoreId == target.Id, cancellationToken: ct);
        var fallbackStoreUpdatedAt = records.Select(r => r.UpdatedAt).Where(t => t.HasValue).Select(t => t!.Value)
            .DefaultIfEmpty(target.UpdatedAt).Max();
        var sourceStoreUpdatedAt = item.UpdatedAt.HasValue
            ? new[] { item.UpdatedAt.Value, fallbackStoreUpdatedAt }.Max()
            : fallbackStoreUpdatedAt;
        var storeUpdatedAt = addOnly && created == 0 && updated == 0
            ? target.UpdatedAt
            : options.PreserveTimestamps
            ? sourceStoreUpdatedAt
            : now;
        var storeUpdate = Builders<DocumentStore>.Update
            .Set(s => s.DocumentCount, (int)count)
            .Set(s => s.UpdatedAt, storeUpdatedAt);
        if (!addOnly)
        {
            storeUpdate = storeUpdate
                .Set(s => s.Name, string.IsNullOrWhiteSpace(item.Name) ? target.Name : item.Name)
                .Set(s => s.Description, item.Description)
                .Set(s => s.Tags, item.Tags ?? new List<string>())
                .Set(s => s.TemplateKey, item.TemplateKey);
            if (options.PreserveTimestamps && item.CreatedAt.HasValue)
                storeUpdate = storeUpdate.Set(s => s.CreatedAt, PickTime(item.CreatedAt));

            // 主文档 / 置顶 / 排序偏好：把对端血缘翻译回本端 entry id 后落库（v1.1 字段完整性）。
            // 解析顺序：本轮新建映射 → 既有条目映射；都查不到说明该条目没传过来，跳过不报错。
            string? ResolveLineage(string? lin) => string.IsNullOrEmpty(lin) ? null
                : lineageToTargetId.TryGetValue(lin!, out var tid) ? tid
                : byLineage.TryGetValue(lin!, out var ex) ? ex.Id : null;
            var primaryTargetId = ResolveLineage(item.PrimaryEntryLineage);
            if (primaryTargetId != null)
                storeUpdate = storeUpdate.Set(s => s.PrimaryEntryId, primaryTargetId);
            if (item.PinnedEntryLineages != null)
            {
                var pinnedIds = item.PinnedEntryLineages
                    .Select(ResolveLineage)
                    .Where(x => !string.IsNullOrEmpty(x))
                    .Cast<string>()
                    .Distinct()
                    .ToList();
                storeUpdate = storeUpdate.Set(s => s.PinnedEntryIds, pinnedIds);
            }
            if (item.DefaultSortMode != null)
                storeUpdate = storeUpdate.Set(s => s.DefaultSortMode, item.DefaultSortMode);
        }

        await _db.DocumentStores.UpdateOneAsync(s => s.Id == target.Id, storeUpdate, cancellationToken: ct);

        return new SyncApplyOutcome
        {
            TargetItemId = target.Id,
            Created = created,
            Updated = updated,
            Skipped = skipped,
            Failed = failed,
            Deleted = deleted,
            AssetsRewritten = assetsRewritten,
            AssetRewriteFailed = assetRewriteFailed,
            Message = $"新增{created}/更新{updated}/跳过{skipped}"
                + (deleted > 0 ? $"/删除{deleted}" : "")
                + (failed > 0 ? $"/失败{failed}" : "")
                + (assetsRewritten > 0 || assetRewriteFailed > 0 ? $"；图片重传{assetsRewritten}/失败{assetRewriteFailed}" : ""),
        };
    }

    private sealed record DocumentStorePeerApplyOptions(
        bool PreserveTimestamps,
        bool RewriteAssetLinks,
        string? SourceBaseUrl);

    private static DocumentStorePeerApplyOptions ReadOptions(SyncResourceBundle bundle)
    {
        var preserveTimestamps = true;
        var rewriteAssetLinks = true;
        string? sourceBaseUrl = null;

        if (bundle.Item.Extras != null
            && bundle.Item.Extras.TryGetValue("peerApplyOptions", out var raw)
            && raw.ValueKind == JsonValueKind.Object)
        {
            if (raw.TryGetProperty("preserveTimestamps", out var preserve) && preserve.ValueKind is JsonValueKind.True or JsonValueKind.False)
                preserveTimestamps = preserve.GetBoolean();
            if (raw.TryGetProperty("rewriteAssetLinks", out var rewrite) && rewrite.ValueKind is JsonValueKind.True or JsonValueKind.False)
                rewriteAssetLinks = rewrite.GetBoolean();
            if (raw.TryGetProperty("sourceBaseUrl", out var source) && source.ValueKind == JsonValueKind.String)
                sourceBaseUrl = source.GetString();
        }

        return new DocumentStorePeerApplyOptions(preserveTimestamps, rewriteAssetLinks, sourceBaseUrl);
    }

    private async Task<(string Content, int Rewritten, int Failed)> RewriteEmbeddedAssetsAsync(
        string content,
        string? sourceBaseUrl,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(content))
            return (content, 0, 0);

        var matches = ExtractAssetUrlMatches(content).ToList();
        if (matches.Count == 0)
            return (content, 0, 0);

        var failed = 0;
        Uri? sourceBase = null;
        Uri? rejectedSourceBase = null;
        if (!string.IsNullOrWhiteSpace(sourceBaseUrl)
            && Uri.TryCreate(sourceBaseUrl.Trim().TrimEnd('/'), UriKind.Absolute, out var parsedSourceBase)
            && parsedSourceBase.Scheme is "http" or "https")
        {
            try
            {
                sourceBase = await _urlValidator.EnsureSafeHttpUrlAsync(parsedSourceBase.ToString(), "peer-sync asset source", ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[peer-sync] unsafe asset source base rejected: {Url}", sourceBaseUrl);
                rejectedSourceBase = parsedSourceBase;
            }
        }

        var allowedBases = GetConfiguredAssetBaseUris().ToList();
        if (sourceBase != null)
            allowedBases.Insert(0, OriginOf(sourceBase));
        if (allowedBases.Count == 0)
        {
            if (rejectedSourceBase != null)
                failed += CountSourceScopedMatches(matches, OriginOf(rejectedSourceBase));
            return (content, 0, failed);
        }

        var rewritten = 0;
        var next = content;
        var cache = new Dictionary<string, StoredAsset?>(StringComparer.Ordinal);
        foreach (var match in matches.OrderByDescending(m => m.Index))
        {
            var sourceUri = ToAllowedSourceUri(match.Raw, sourceBase, allowedBases);
            if (sourceUri == null)
            {
                if (rejectedSourceBase != null
                    && ToAllowedSourceUri(match.Raw, rejectedSourceBase, new[] { OriginOf(rejectedSourceBase) }) != null)
                    failed++;
                continue;
            }

            try
            {
                await _urlValidator.EnsureSafeHttpUrlAsync(sourceUri.ToString(), "peer-sync asset", ct);
                var cacheKey = sourceUri.ToString();
                if (!cache.TryGetValue(cacheKey, out var asset))
                {
                    asset = await DownloadAndStoreAssetAsync(sourceUri, ct);
                    cache[cacheKey] = asset;
                }
                if (asset == null)
                {
                    failed++;
                    continue;
                }
                next = next.Remove(match.Index, match.Length).Insert(match.Index, asset.Url);
                rewritten++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[peer-sync] rewrite asset failed: {Url}", sourceUri);
                failed++;
            }
        }

        return (next, rewritten, failed);
    }

    private static int CountSourceScopedMatches(IEnumerable<AssetUrlMatch> matches, Uri sourceBase)
        => matches.Count(m => ToAllowedSourceUri(m.Raw, sourceBase, new[] { sourceBase }) != null);

    private static Uri OriginOf(Uri uri)
        => new($"{uri.Scheme}://{uri.Authority}");

    private async Task<StoredAsset?> DownloadAndStoreAssetAsync(Uri uri, CancellationToken ct)
    {
        var client = _httpFactory.CreateClient("PeerSync");
        client.Timeout = TimeSpan.FromSeconds(60);
        using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
            return null;

        var mime = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return null;

        var length = response.Content.Headers.ContentLength;
        if (length.HasValue && length.Value > 25 * 1024 * 1024)
            return null;

        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (bytes.Length > 25 * 1024 * 1024)
            return null;

        var fileName = Path.GetFileName(uri.LocalPath);
        return await _assetStorage.SaveAsync(bytes, mime, ct, domain: "prd-agent", type: "doc", fileName: fileName);
    }

    // ─────────────────────────────────────────────────────────────
    // 二进制附件跨节点（peerAttachment）
    // ─────────────────────────────────────────────────────────────

    private sealed record PeerAttachmentInfo(
        string SourceId, string Url, string? MimeType, string? FileName, long Size,
        AttachmentType Type, string? ThumbnailUrl, string? ExtractedText);

    /// <summary>从导出记录的 Extras["peerAttachment"] 解析附件元信息（旧节点 / 缺字段返回 false）。</summary>
    private static bool TryReadPeerAttachment(SyncRecord record, out PeerAttachmentInfo info)
    {
        info = null!;
        if (record.Extras == null
            || !record.Extras.TryGetValue("peerAttachment", out var raw)
            || raw.ValueKind != JsonValueKind.Object)
            return false;
        if (!raw.TryGetProperty("url", out var urlEl) || urlEl.ValueKind != JsonValueKind.String)
            return false;
        var url = urlEl.GetString();
        if (string.IsNullOrWhiteSpace(url)) return false;

        // sourceId 缺省（旧导出无该字段）时退回 url 自身作为身份，保持向下兼容。
        var sourceId = raw.TryGetProperty("sourceId", out var sidEl) && sidEl.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(sidEl.GetString())
            ? sidEl.GetString()! : url!;
        string? mime = raw.TryGetProperty("mimeType", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
        string? fileName = raw.TryGetProperty("fileName", out var f) && f.ValueKind == JsonValueKind.String ? f.GetString() : null;
        long size = raw.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number && s.TryGetInt64(out var sv) ? sv : 0;
        var type = raw.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String
            && string.Equals(t.GetString(), nameof(AttachmentType.Document), StringComparison.OrdinalIgnoreCase)
            ? AttachmentType.Document : AttachmentType.Image;
        string? thumb = raw.TryGetProperty("thumbnailUrl", out var th) && th.ValueKind == JsonValueKind.String ? th.GetString() : null;
        string? extracted = raw.TryGetProperty("extractedText", out var ex) && ex.ValueKind == JsonValueKind.String ? ex.GetString() : null;

        info = new PeerAttachmentInfo(sourceId, url!, mime, fileName, size, type, thumb, extracted);
        return true;
    }

    /// <summary>二进制条目的文本索引：取附件提取文本前 2000 字（无提取文本则 null，清掉旧文本残留）。</summary>
    private static string? BinaryContentIndex(string? extractedText)
        => string.IsNullOrEmpty(extractedText)
            ? null
            : (extractedText.Length > 2000 ? extractedText[..2000] : extractedText);

    private static Attachment BuildAttachment(PeerAttachmentInfo pa, StoredAsset stored, string uploaderUserId)
        => new()
        {
            UploaderId = uploaderUserId,
            FileName = string.IsNullOrWhiteSpace(pa.FileName) ? Path.GetFileName(stored.Url) : pa.FileName!,
            MimeType = string.IsNullOrWhiteSpace(pa.MimeType) ? stored.Mime : pa.MimeType!,
            Size = pa.Size > 0 ? pa.Size : stored.SizeBytes,
            Url = stored.Url,
            Type = pa.Type,
            ExtractedText = pa.ExtractedText,
        };

    /// <summary>缩略图（仅图片）尽力本地化：失败则置空，避免留下指向对端的悬挂 URL。</summary>
    private async Task ReLocalizeAttachmentThumbnailAsync(Attachment att, PeerAttachmentInfo pa, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(pa.ThumbnailUrl)) return;
        if (!Uri.TryCreate(pa.ThumbnailUrl, UriKind.Absolute, out var thumbUri) || thumbUri.Scheme is not ("http" or "https"))
            return;
        try
        {
            await _urlValidator.EnsureSafeHttpUrlAsync(thumbUri.ToString(), "peer-sync attachment thumbnail", ct);
            var stored = await DownloadAndStoreAssetAsync(thumbUri, ct);
            if (stored != null) att.ThumbnailUrl = stored.Url;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[peer-sync] thumbnail re-localize failed: {Url}", pa.ThumbnailUrl);
        }
    }

    /// <summary>把对端附件 URL 解析为可下载的绝对地址：绝对 http(s) 直接用；相对路径（如本地存储后端返回的
    /// <c>/api/...</c>）按 sourceBaseUrl 拼成绝对，使自托管/本地存储节点也能同步附件（Codex: relative peer attachment URLs）。</summary>
    private static Uri? ResolvePeerAttachmentUri(string raw, string? sourceBaseUrl)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (Uri.TryCreate(raw, UriKind.Absolute, out var abs))
            return abs.Scheme is "http" or "https" ? abs : null;
        if (raw.StartsWith("/", StringComparison.Ordinal)
            && !string.IsNullOrWhiteSpace(sourceBaseUrl)
            && Uri.TryCreate(sourceBaseUrl.Trim().TrimEnd('/'), UriKind.Absolute, out var baseUri)
            && baseUri.Scheme is "http" or "https"
            && Uri.TryCreate(baseUri, raw, out var resolved)
            && resolved.Scheme is "http" or "https")
            return resolved;
        return null;
    }

    /// <summary>下载对端附件文件并重传到本节点存储（通用，不限图片）。SSRF 防护 + 大小上限。</summary>
    private async Task<StoredAsset?> DownloadAndStoreAttachmentAsync(PeerAttachmentInfo pa, string? sourceBaseUrl, CancellationToken ct)
    {
        var uri = ResolvePeerAttachmentUri(pa.Url, sourceBaseUrl);
        if (uri == null)
            return null;
        await _urlValidator.EnsureSafeHttpUrlAsync(uri.ToString(), "peer-sync attachment", ct);

        var client = _httpFactory.CreateClient("PeerSync");
        client.Timeout = TimeSpan.FromSeconds(120);
        using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
            return null;

        var length = response.Content.Headers.ContentLength;
        if (length.HasValue && length.Value > MaxPeerAttachmentBytes)
            return null;

        // 边读边卡上限：对端若不带 Content-Length，直接 ReadAsByteArrayAsync 会把整个响应缓进内存后才判超限，
        // 恶意/超大附件可远超 50MB 撑爆内存、拖死同步 worker（Codex P2）。改为流式拷贝，越界即中止。
        byte[] bytes;
        await using (var src = await response.Content.ReadAsStreamAsync(ct))
        using (var ms = new MemoryStream())
        {
            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = await src.ReadAsync(buffer.AsMemory(0, buffer.Length), ct)) > 0)
            {
                total += read;
                if (total > MaxPeerAttachmentBytes)
                    return null;
                ms.Write(buffer, 0, read);
            }
            bytes = ms.ToArray();
        }

        var mime = !string.IsNullOrWhiteSpace(pa.MimeType)
            ? pa.MimeType!
            : response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
        var fileName = !string.IsNullOrWhiteSpace(pa.FileName) ? pa.FileName : Path.GetFileName(uri.LocalPath);
        return await _assetStorage.SaveAsync(bytes, mime, ct, domain: "prd-agent", type: "doc", fileName: fileName);
    }

    private static Dictionary<string, string> WithPeerSourceAttachment(Dictionary<string, string> metadata, string sourceUrl, long sourceSize)
    {
        metadata[PeerSourceAttachmentUrlKey] = sourceUrl;
        if (sourceSize > 0)
            metadata[PeerSourceAttachmentSizeKey] = sourceSize.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return metadata;
    }

    private static bool HasAppliedSourceAttachment(Dictionary<string, string>? metadata, string sourceUrl)
        => metadata != null
            && metadata.TryGetValue(PeerSourceAttachmentUrlKey, out var applied)
            && string.Equals(applied, sourceUrl, StringComparison.Ordinal);

    /// <summary>已记录的源头附件字节数（与导出端 pa.Size 同口径）；未记录返回 null（退回仅 URL 判定）。</summary>
    private static long? AppliedSourceAttachmentSize(Dictionary<string, string>? metadata)
        => metadata != null
            && metadata.TryGetValue(PeerSourceAttachmentSizeKey, out var raw)
            && long.TryParse(raw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var v)
            ? v : (long?)null;

    private IEnumerable<Uri> GetConfiguredAssetBaseUris()
    {
        var keys = new[]
        {
            "R2_PUBLIC_BASE_URL",
            "TENCENT_COS_PUBLIC_BASE_URL",
            "CDN_BASE_URL",
            "ASSET_PUBLIC_BASE_URL",
            "PUBLIC_ASSET_BASE_URL",
        };

        foreach (var key in keys)
        {
            var value = _config[key];
            if (string.IsNullOrWhiteSpace(value)) continue;
            if (Uri.TryCreate(value.Trim().TrimEnd('/'), UriKind.Absolute, out var uri)
                && uri.Scheme is "http" or "https")
                yield return uri;
        }
    }

    private static Uri? ToAllowedSourceUri(string raw, Uri? sourceBase, IReadOnlyList<Uri> allowedBases)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            return null;

        Uri uri;
        if (Uri.TryCreate(raw, UriKind.Absolute, out var absolute))
        {
            uri = absolute;
        }
        else if (raw.StartsWith("/", StringComparison.Ordinal) && sourceBase != null)
        {
            uri = new Uri(sourceBase, raw);
        }
        else
        {
            return null;
        }

        if (uri.Scheme is not ("http" or "https"))
            return null;
        if (!allowedBases.Any(b => IsSameOriginOrChildPath(uri, b)))
            return null;
        return uri;
    }

    private static bool IsSameOriginOrChildPath(Uri uri, Uri allowedBase)
    {
        if (!string.Equals(uri.Scheme, allowedBase.Scheme, StringComparison.OrdinalIgnoreCase))
            return false;
        if (!string.Equals(uri.Host, allowedBase.Host, StringComparison.OrdinalIgnoreCase))
            return false;
        if (uri.Port != allowedBase.Port)
            return false;
        var basePath = allowedBase.AbsolutePath.TrimEnd('/');
        return basePath.Length == 0 || basePath == "/"
            || uri.AbsolutePath.StartsWith(basePath + "/", StringComparison.OrdinalIgnoreCase)
            || string.Equals(uri.AbsolutePath, basePath, StringComparison.OrdinalIgnoreCase);
    }

    private sealed record AssetUrlMatch(string Raw, int Index, int Length);

    private static IEnumerable<AssetUrlMatch> ExtractAssetUrlMatches(string content)
    {
        foreach (Match m in Regex.Matches(content, @"!\[[^\]]*\]\((?<url>[^)\s]+)(?:\s+""[^""]*"")?\)", RegexOptions.IgnoreCase))
        {
            var group = m.Groups["url"];
            var url = group.Value.Trim();
            if (LooksLikeImageUrl(url))
                yield return new AssetUrlMatch(url, group.Index, group.Length);
        }
        foreach (Match m in Regex.Matches(content, "<img\\b[^>]*?\\bsrc=[\"'](?<url>[^\"']+)[\"']", RegexOptions.IgnoreCase))
        {
            var group = m.Groups["url"];
            var url = group.Value.Trim();
            if (LooksLikeImageUrl(url))
                yield return new AssetUrlMatch(url, group.Index, group.Length);
        }
    }

    private static bool LooksLikeImageUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url) || url.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            return false;
        var path = url.Split('?', '#')[0];
        return path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".gif", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".webp", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".avif", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".svg", StringComparison.OrdinalIgnoreCase);
    }

    // ─────────────────────────────────────────────────────────────
    // 内部辅助（与 DocumentStoreSyncController 同口径）
    // ─────────────────────────────────────────────────────────────

    private async Task<DocumentStore?> LoadAccessibleStoreAsync(string storeId, string userId, CancellationToken ct)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync(ct);
        if (store == null) return null;
        // PR #742 review High：项目知识库 / 产品知识库走专属访问轴，本接口不放行，避免跨轴泄漏。
        if (!string.IsNullOrEmpty(store.PmProjectId) || !string.IsNullOrEmpty(store.ProductKnowledgeRef))
        {
            // 项目/产品库不通过 peer-sync 导出（v1 已在 ListItemsAsync 排除，此处兜底）
            return null;
        }
        // 受信对端节点（node-to-node 导出，已 HMAC 验签）绕过按登录用户的访问校验。
        if (userId == SyncActor.PeerSystemUserId) return store;
        if (store.OwnerId == userId) return store;
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (store.SharedTeamIds != null && store.SharedTeamIds.Any(myTeamIds.Contains)) return store;
        return null;
    }

    private static string LineageOf(DocumentEntry e)
        => e.Metadata != null && e.Metadata.TryGetValue(SyncLineageKey, out var l) && !string.IsNullOrEmpty(l)
            ? l : e.Id;

    private static Dictionary<string, string> WithLineage(Dictionary<string, string>? metadata, string lineageId)
    {
        var m = metadata != null ? new Dictionary<string, string>(metadata) : new Dictionary<string, string>();
        m[SyncLineageKey] = lineageId;
        return m;
    }

    private static Dictionary<string, string> WithPeerSourceContentHash(Dictionary<string, string> metadata, string sourceContentHash)
    {
        metadata[PeerSourceContentHashKey] = sourceContentHash;
        return metadata;
    }

    private static bool HasAppliedSourceContent(Dictionary<string, string>? metadata, string sourceContentHash)
        => metadata != null
            && metadata.TryGetValue(PeerSourceContentHashKey, out var applied)
            && string.Equals(applied, sourceContentHash, StringComparison.Ordinal);

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
            _logger.LogWarning(ex, "[peer-sync] 清理旧 ParsedPrd 失败 docId={DocId}", oldDocId);
        }
    }

    private static DateTime PickTimestamp(DateTime? source, bool preserveTimestamps, DateTime fallback)
        => preserveTimestamps && source.HasValue ? source.Value : fallback;

    private static bool NeedsRecordTimestampRefresh(DocumentEntry existing, SyncRecord incoming, bool preserveTimestamps)
    {
        if (!preserveTimestamps) return false;
        return NeedsTimestampRefresh(existing.CreatedAt, incoming.CreatedAt, preserveTimestamps)
            || NeedsTimestampRefresh(existing.UpdatedAt, incoming.UpdatedAt, preserveTimestamps)
            || NeedsTimestampRefresh(existing.LastChangedAt, incoming.LastChangedAt ?? incoming.UpdatedAt, preserveTimestamps);
    }

    private static bool NeedsTimestampRefresh(DateTime existing, DateTime? incoming, bool preserveTimestamps)
        => preserveTimestamps && incoming.HasValue && !SameTimestamp(existing, incoming.Value);

    private static bool NeedsTimestampRefresh(DateTime? existing, DateTime? incoming, bool preserveTimestamps)
        => preserveTimestamps && incoming.HasValue && (!existing.HasValue || !SameTimestamp(existing.Value, incoming.Value));

    private static bool SameTimestamp(DateTime a, DateTime b)
        => TruncateToMongoPrecision(a) == TruncateToMongoPrecision(b);

    private static DateTime TruncateToMongoPrecision(DateTime value)
    {
        var utc = value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();
        return new DateTime(utc.Ticks - utc.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
    }

    private static bool TagsEqual(List<string>? a, List<string>? b)
        => (a ?? new()).OrderBy(x => x, StringComparer.Ordinal)
            .SequenceEqual((b ?? new()).OrderBy(x => x, StringComparer.Ordinal));

    private static bool MetaEqual(Dictionary<string, string>? a, Dictionary<string, string>? b)
    {
        // 这三个键都是接收方在 apply 时单边写入的同步内部标记（源端 metadata 没有），
        // 比对前必须剥离，否则「收到的 metadata 没有该键、本地有」会让 MetaEqual 恒判不等，
        // 导致二进制/文本条目每次重同步都被当作「已变化」反复重写（Bugbot: MetaEqual ignores attachment URL key）。
        static string Norm(Dictionary<string, string>? m) => string.Join("\n", (m ?? new())
            .Where(kv => kv.Key != SyncLineageKey && kv.Key != PeerSourceContentHashKey
                && kv.Key != PeerSourceAttachmentUrlKey && kv.Key != PeerSourceAttachmentSizeKey)
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => kv.Key + "=" + kv.Value));
        return Norm(a) == Norm(b);
    }

    private static string Sha256Hex(string s)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(s ?? string.Empty))).ToLowerInvariant();
    }
}
