using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public sealed record DesignKnowledgeReferenceIdentity(string EntryId, string StoreId);

public sealed class DesignKnowledgeSnapshotException : Exception
{
    public DesignKnowledgeSnapshotException(string code, string message) : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}

public interface IDesignKnowledgeSnapshotResolver
{
    Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveAsync(
        string userId,
        IReadOnlyList<DesignKnowledgeReferenceIdentity> references,
        CancellationToken ct);
}

/// <summary>
/// 将客户端提交的知识条目身份解析为服务端权威快照。客户端不能提供正文、标题或内容哈希。
/// </summary>
public sealed class DesignKnowledgeSnapshotResolver : IDesignKnowledgeSnapshotResolver
{
    public const int MaxReferenceCount = 3;
    public const int MaxTotalContentCharacters = 60_000;
    private const int MaxLeafSourceCandidates = 64;

    private readonly MongoDbContext _db;
    private readonly ITeamService _teams;
    private readonly IAdminPermissionService _permissions;

    public DesignKnowledgeSnapshotResolver(
        MongoDbContext db,
        ITeamService teams,
        IAdminPermissionService permissions)
    {
        _db = db;
        _teams = teams;
        _permissions = permissions;
    }

    public async Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveAsync(
        string userId,
        IReadOnlyList<DesignKnowledgeReferenceIdentity> references,
        CancellationToken ct)
    {
        if (references.Count > MaxReferenceCount)
            throw Invalid("首版一次最多引用 3 篇知识");
        if (references.Count == 0)
            return Array.Empty<DesignKnowledgeSnapshot>();

        var normalized = references.Select(reference => new DesignKnowledgeReferenceIdentity(
            reference.EntryId?.Trim() ?? string.Empty,
            reference.StoreId?.Trim() ?? string.Empty)).ToList();
        if (normalized.Any(reference => reference.EntryId.Length == 0 || reference.StoreId.Length == 0))
            throw Invalid("引用知识缺少条目或知识库身份");
        if (normalized.Select(reference => reference.EntryId).Distinct(StringComparer.Ordinal).Count() != normalized.Count)
            throw Invalid("引用知识中存在重复条目，请重新选择");

        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        IReadOnlyList<string>? permissions = null;
        var snapshots = new List<DesignKnowledgeSnapshot>(normalized.Count);
        var totalCharacters = 0;

        foreach (var reference in normalized)
        {
            var entry = await _db.DocumentEntries
                .Find(candidate => candidate.Id == reference.EntryId
                                   && candidate.StoreId == reference.StoreId
                                   && !candidate.IsFolder)
                .FirstOrDefaultAsync(ct);
            var store = entry == null
                ? null
                : await _db.DocumentStores.Find(candidate => candidate.Id == reference.StoreId).FirstOrDefaultAsync(ct);
            if (entry == null || store == null || !await CanReadAsync(store, userId, myTeamIds, ct, async () =>
                permissions ??= await _permissions.GetEffectivePermissionsAsync(userId, false, ct)))
                throw NotFound();

            var (content, sourceTitle) = await ReadAuthorizedContentAsync(
                entry,
                store,
                userId,
                myTeamIds,
                ct,
                async () => permissions ??= await _permissions.GetEffectivePermissionsAsync(userId, false, ct));
            if (string.IsNullOrWhiteSpace(content))
                throw Invalid($"知识「{entry.Title}」没有可读取的正文，请更换条目");

            totalCharacters = checked(totalCharacters + content.Length);
            if (totalCharacters > MaxTotalContentCharacters)
                throw Invalid($"引用知识正文合计不能超过 {MaxTotalContentCharacters:N0} 个字符，请减少选择或缩短内容");

            snapshots.Add(new DesignKnowledgeSnapshot
            {
                EntryId = entry.Id,
                StoreId = store.Id,
                StoreName = store.Name,
                Title = NormalizeTitle(entry.Title, sourceTitle),
                Content = content,
                ContentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant(),
            });
        }

        return snapshots;
    }

    private async Task<(string? Content, string? Title)> ReadAuthorizedContentAsync(
        DocumentEntry entry,
        DocumentStore entryStore,
        string userId,
        IReadOnlyCollection<string> myTeamIds,
        CancellationToken ct,
        Func<Task<IReadOnlyList<string>>> getPermissions)
    {
        ParsedPrd? document = null;
        if (!string.IsNullOrWhiteSpace(entry.DocumentId))
        {
            document = await _db.Documents.Find(candidate => candidate.Id == entry.DocumentId).FirstOrDefaultAsync(ct);
            if (document == null)
                throw NotFound();
        }

        Attachment? attachment = null;
        if (!string.IsNullOrWhiteSpace(entry.AttachmentId))
        {
            attachment = await _db.Attachments
                .Find(candidate => candidate.AttachmentId == entry.AttachmentId)
                .FirstOrDefaultAsync(ct);
            if (attachment == null)
                throw NotFound();
        }

        if (document == null && attachment == null)
            return (null, null);

        if (!await HasServerBoundLeafAsync(entry, document, attachment, ct)
            && !await HasReadableSourceEntryAsync(
                entry,
                entryStore,
                document,
                attachment,
                userId,
                myTeamIds,
                ct,
                getPermissions))
            throw NotFound();

        if (!string.IsNullOrEmpty(document?.RawContent))
            return (document.RawContent, document.Title);
        if (!string.IsNullOrEmpty(attachment?.ExtractedText))
            return (attachment.ExtractedText, attachment.FileName);

        return (null, null);
    }

    /// <summary>
    /// ContentIndex、版本快照和附件上传者均由服务端写入，客户端的 AddEntry/UpdateEntry DTO
    /// 不能伪造这些字段。它们用于区分“服务端把正文写给了该条目”和“只拿到 leaf ID 后重挂”。
    /// </summary>
    private async Task<bool> HasServerBoundLeafAsync(
        DocumentEntry entry,
        ParsedPrd? document,
        Attachment? attachment,
        CancellationToken ct)
    {
        if (document != null)
        {
            var indexMatches = ContentIndexMatches(entry, document.RawContent);
            if (!indexMatches)
            {
                var contentHash = Sha256(document.RawContent);
                var hasMatchingVersion = await _db.DocumentEntryVersions.CountDocumentsAsync(
                    version => version.EntryId == entry.Id
                               && version.StoreId == entry.StoreId
                               && version.ContentHash == contentHash,
                    cancellationToken: ct) > 0;
                if (!hasMatchingVersion)
                    return false;
            }
        }

        if (attachment != null
            && attachment.UploaderId != entry.CreatedBy
            && attachment.UploaderId != entry.UpdatedBy
            && !ContentIndexMatches(entry, attachment.ExtractedText))
            return false;

        return true;
    }

    /// <summary>
    /// 重挂条目本身没有服务端正文绑定时，只能沿同一组 leaf 找到另一个服务端绑定的来源条目，
    /// 且当前用户此刻仍能读取来源条目所在知识库。撤权后不会因为副本位于自己的库而继续读取。
    /// </summary>
    private async Task<bool> HasReadableSourceEntryAsync(
        DocumentEntry entry,
        DocumentStore entryStore,
        ParsedPrd? document,
        Attachment? attachment,
        string userId,
        IReadOnlyCollection<string> myTeamIds,
        CancellationToken ct,
        Func<Task<IReadOnlyList<string>>> getPermissions)
    {
        var filter = Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Ne(candidate => candidate.Id, entry.Id),
            Builders<DocumentEntry>.Filter.Eq(candidate => candidate.IsFolder, false),
            document == null
                ? Builders<DocumentEntry>.Filter.Or(
                    Builders<DocumentEntry>.Filter.Eq(candidate => candidate.DocumentId, null),
                    Builders<DocumentEntry>.Filter.Eq(candidate => candidate.DocumentId, string.Empty))
                : Builders<DocumentEntry>.Filter.Eq(candidate => candidate.DocumentId, document.Id),
            attachment == null
                ? Builders<DocumentEntry>.Filter.Or(
                    Builders<DocumentEntry>.Filter.Eq(candidate => candidate.AttachmentId, null),
                    Builders<DocumentEntry>.Filter.Eq(candidate => candidate.AttachmentId, string.Empty))
                : Builders<DocumentEntry>.Filter.Eq(candidate => candidate.AttachmentId, attachment.AttachmentId));

        var candidates = await _db.DocumentEntries
            .Find(filter)
            .SortBy(candidate => candidate.CreatedAt)
            .Limit(MaxLeafSourceCandidates)
            .ToListAsync(ct);
        if (candidates.Count == 0)
            return false;

        var storeIds = candidates.Select(candidate => candidate.StoreId)
            .Append(entryStore.Id)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var stores = await _db.DocumentStores
            .Find(candidate => storeIds.Contains(candidate.Id))
            .ToListAsync(ct);
        var storesById = stores.ToDictionary(candidate => candidate.Id, StringComparer.Ordinal);

        foreach (var candidate in candidates)
        {
            if (!storesById.TryGetValue(candidate.StoreId, out var sourceStore)
                || !await CanReadAsync(sourceStore, userId, myTeamIds, ct, getPermissions))
                continue;
            if (await HasServerBoundLeafAsync(candidate, document, attachment, ct))
                return true;
        }

        return false;
    }

    private static bool ContentIndexMatches(DocumentEntry entry, string? content)
    {
        if (string.IsNullOrWhiteSpace(entry.ContentIndex) || string.IsNullOrEmpty(content))
            return false;
        var indexable = EntryContentWriteService.ToIndexableText(content, entry.ContentType);
        var expected = (indexable.Length > 2000 ? indexable[..2000] : indexable).Trim();
        return expected.Length > 0 && string.Equals(entry.ContentIndex, expected, StringComparison.Ordinal);
    }

    private static string Sha256(string content) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    private async Task<bool> CanReadAsync(
        DocumentStore store,
        string userId,
        IReadOnlyCollection<string> myTeamIds,
        CancellationToken ct,
        Func<Task<IReadOnlyList<string>>> getPermissions)
    {
        if (store.OwnerId == userId || store.IsPublic
            || (store.SharedTeamIds?.Any(myTeamIds.Contains) ?? false))
            return true;

        if (!string.IsNullOrWhiteSpace(store.PmProjectId))
        {
            var project = await _db.PmProjects
                .Find(candidate => candidate.Id == store.PmProjectId && !candidate.IsDeleted)
                .FirstOrDefaultAsync(ct);
            if (project != null
                && (project.OwnerId == userId
                    || project.LeaderId == userId
                    || project.MemberIds.Contains(userId)
                    || project.ObserverIds.Contains(userId)
                    || (project.Stakeholders?.Any(item => item.UserId == userId) ?? false)))
                return true;
        }

        if (!string.IsNullOrWhiteSpace(store.ProductKnowledgeRef))
        {
            var parts = store.ProductKnowledgeRef.Split(':', 2);
            string? productId = parts.Length == 2 && parts[0] == "product"
                ? parts[1]
                : parts.Length == 2 && parts[0] == "version"
                    ? (await _db.ProductVersions
                        .Find(candidate => candidate.Id == parts[1] && !candidate.IsDeleted)
                        .FirstOrDefaultAsync(ct))?.ProductId
                    : null;
            if (!string.IsNullOrWhiteSpace(productId))
            {
                var product = await _db.Products
                    .Find(candidate => candidate.Id == productId && !candidate.IsDeleted)
                    .FirstOrDefaultAsync(ct);
                if (product != null && (product.IsProductOwner(userId) || product.MemberIds.Contains(userId)))
                    return true;
            }
        }

        if (!string.IsNullOrWhiteSpace(store.ShituCategoryRef))
        {
            var effectivePermissions = await getPermissions();
            return effectivePermissions.Contains(AdminPermissionCatalog.Super)
                   || effectivePermissions.Contains(AdminPermissionCatalog.ShituAgentUse)
                   || effectivePermissions.Contains(AdminPermissionCatalog.ShituAgentManage);
        }

        return false;
    }

    private static string NormalizeTitle(string? entryTitle, string? sourceTitle)
    {
        var title = string.IsNullOrWhiteSpace(entryTitle)
            ? string.IsNullOrWhiteSpace(sourceTitle) ? "未命名知识" : sourceTitle.Trim()
            : entryTitle.Trim();
        return title.Length <= 200 ? title : title[..200];
    }

    private static DesignKnowledgeSnapshotException Invalid(string message) =>
        new(ErrorCodes.INVALID_FORMAT, message);

    private static DesignKnowledgeSnapshotException NotFound() =>
        new(ErrorCodes.NOT_FOUND, "引用知识不存在或当前账号无权读取");
}
