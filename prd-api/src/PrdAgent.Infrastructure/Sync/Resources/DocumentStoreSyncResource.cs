using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Database;

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

    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly ITeamService _teams;
    private readonly ILogger<DocumentStoreSyncResource> _logger;

    public DocumentStoreSyncResource(
        MongoDbContext db,
        IDocumentService documentService,
        ITeamService teams,
        ILogger<DocumentStoreSyncResource> logger)
    {
        _db = db;
        _documentService = documentService;
        _teams = teams;
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
        // 项目库 / 产品库走各自访问轴，互传 v1 不列入（避免越权）。
        var filter = Builders<DocumentStore>.Filter.And(
            ownerOrTeam,
            Builders<DocumentStore>.Filter.Eq(s => s.PmProjectId, (string?)null),
            Builders<DocumentStore>.Filter.Eq(s => s.ProductKnowledgeRef, (string?)null));

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
        var records = new List<SyncRecord>();
        foreach (var e in entries)
        {
            string? content = null;
            if (!e.IsFolder && !string.IsNullOrEmpty(e.DocumentId))
                content = (await _documentService.GetByIdAsync(e.DocumentId))?.RawContent;

            string? parentLineage = null;
            if (!string.IsNullOrEmpty(e.ParentId) && byId.TryGetValue(e.ParentId, out var parent))
                parentLineage = LineageOf(parent);

            records.Add(new SyncRecord
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
            },
            Records = records,
        };
    }

    public async Task<string?> ComputeSignatureAsync(string itemId, CancellationToken ct)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == itemId).FirstOrDefaultAsync(ct);
        if (store == null) return null;
        var entries = await _db.DocumentEntries.Find(e => e.StoreId == itemId).ToListAsync(ct);
        var parts = entries
            .Select(e => $"{LineageOf(e)}|{e.UpdatedAt.Ticks}|{e.Title}|{(e.IsFolder ? 1 : 0)}")
            .OrderBy(x => x, StringComparer.Ordinal);
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
            };
            await _db.DocumentStores.InsertOneAsync(target, cancellationToken: ct);
        }

        var outcome = await ApplyRecordsAsync(target, bundle.Records, mode, ownerUserId, ownerName, ownerAvatar, ct);
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
        DocumentStore target, List<SyncRecord> records, SyncApplyMode mode,
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
        int created = 0, updated = 0, skipped = 0, failed = 0;
        var addOnly = mode == SyncApplyMode.AddOnly;

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
                            .Set(e => e.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
                    exFolder.Title = f.Title;
                    exFolder.ParentId = parentId;
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
                Metadata = WithLineage(f.Metadata, f.LineageId),
                CreatedBy = actorUserId,
                CreatedByName = actorName,
                CreatedByAvatarFileName = actorAvatar,
                UpdatedBy = actorUserId,
                UpdatedByName = actorName,
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
                if (fe.Content == null) { skipped++; continue; }
                var parentId = ResolveParent(fe.ParentLineageId);

                if (byLineage.TryGetValue(fe.LineageId, out var exFolderConflict) && exFolderConflict.IsFolder)
                {
                    skipped++;
                    continue;
                }

                if (byLineage.TryGetValue(fe.LineageId, out var exEntry) && !exEntry.IsFolder)
                {
                    if (addOnly) { skipped++; continue; }
                    var existingContent = !string.IsNullOrEmpty(exEntry.DocumentId)
                        ? (await _documentService.GetByIdAsync(exEntry.DocumentId))?.RawContent ?? string.Empty
                        : string.Empty;
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
                            .Set(e => e.FileSize, fe.FileSize)
                            .Set(e => e.ContentType, string.IsNullOrEmpty(fe.ContentType) ? "text/markdown" : fe.ContentType)
                            .Set(e => e.Metadata, WithLineage(fe.Metadata, fe.LineageId))
                            .Set(e => e.UpdatedBy, actorUserId)
                            .Set(e => e.UpdatedByName, actorName)
                            .Set(e => e.UpdatedAt, DateTime.UtcNow)
                            .Set(e => e.LastChangedAt, DateTime.UtcNow), cancellationToken: ct);
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

        var count = await _db.DocumentEntries.CountDocumentsAsync(e => e.StoreId == target.Id, cancellationToken: ct);
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == target.Id,
            Builders<DocumentStore>.Update.Set(s => s.DocumentCount, (int)count).Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return new SyncApplyOutcome
        {
            Created = created,
            Updated = updated,
            Skipped = skipped,
            Failed = failed,
            Message = $"新增{created}/更新{updated}/跳过{skipped}" + (failed > 0 ? $"/失败{failed}" : ""),
        };
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

    private static bool TagsEqual(List<string>? a, List<string>? b)
        => (a ?? new()).OrderBy(x => x, StringComparer.Ordinal)
            .SequenceEqual((b ?? new()).OrderBy(x => x, StringComparer.Ordinal));

    private static bool MetaEqual(Dictionary<string, string>? a, Dictionary<string, string>? b)
    {
        static string Norm(Dictionary<string, string>? m) => string.Join("\n", (m ?? new())
            .Where(kv => kv.Key != SyncLineageKey)
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
