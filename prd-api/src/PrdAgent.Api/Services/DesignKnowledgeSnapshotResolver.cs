using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

public sealed record DesignKnowledgeReferenceIdentity(
    string EntryId,
    string StoreId,
    string? ExpectedContentHash = null);

public sealed record DesignKnowledgeWorkspaceSnapshot(
    IReadOnlyList<DesignKnowledgeSnapshot> KnowledgeReferences,
    DesignKnowledgeOriginalSnapshot Originals);

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
    /// <summary>读取当前权威快照，供创建任务前预检；不得直接用于创建 Run。</summary>
    Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveAsync(
        string userId,
        IReadOnlyList<DesignKnowledgeReferenceIdentity> references,
        CancellationToken ct);

    /// <summary>创建 Run 前重新读取权威正文，并校验客户端预检时取得的内容哈希。</summary>
    Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveForRunAsync(
        string userId,
        IReadOnlyList<DesignKnowledgeReferenceIdentity> references,
        CancellationToken ct);

    Task<DesignKnowledgeWorkspaceSnapshot> ResolveWorkspaceForRunAsync(
        string userId, IReadOnlyList<DesignKnowledgeReferenceIdentity> references, CancellationToken ct);

    Task<IReadOnlyList<DesignWorkspaceFile>> ReadWorkspaceOriginalsAsync(
        string userId, IReadOnlyList<DesignKnowledgeSnapshot> snapshots, DesignKnowledgeOriginalSnapshot originals, CancellationToken ct);
}

/// <summary>
/// 将客户端提交的知识条目身份与预检 contentHash 解析为服务端权威快照。
/// 客户端不能提供正文或标题；contentHash 只是乐观锁，服务端仍重新读取权威内容并计算哈希。
/// </summary>
public sealed class DesignKnowledgeSnapshotResolver : IDesignKnowledgeSnapshotResolver
{
    public const int MaxReferenceCount = 3;
    public const int MaxTotalContentCharacters = 60_000;
    public const string ContentHashRequiredCode = "KNOWLEDGE_SOURCE_HASH_REQUIRED";
    public const string ContentChangedCode = "KNOWLEDGE_SOURCE_CHANGED";
    private const int MaxLeafSourceCandidates = 64;

    private readonly MongoDbContext _db;
    private readonly ITeamService _teams;
    private readonly IAdminPermissionService _permissions;
    private readonly IAssetStorage? _storage;

    public DesignKnowledgeSnapshotResolver(
        MongoDbContext db,
        ITeamService teams,
        IAdminPermissionService permissions,
        IAssetStorage? storage = null)
    {
        _db = db;
        _teams = teams;
        _permissions = permissions;
        _storage = storage;
    }

    public async Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveAsync(
        string userId,
        IReadOnlyList<DesignKnowledgeReferenceIdentity> references,
        CancellationToken ct) => await ResolveInternalAsync(userId, references, requireExpectedHash: false, ct);

    public async Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveForRunAsync(
        string userId,
        IReadOnlyList<DesignKnowledgeReferenceIdentity> references,
        CancellationToken ct) => await ResolveInternalAsync(userId, references, requireExpectedHash: true, ct);

    public async Task<DesignKnowledgeWorkspaceSnapshot> ResolveWorkspaceForRunAsync(
        string userId, IReadOnlyList<DesignKnowledgeReferenceIdentity> references, CancellationToken ct)
    {
        var originals = new DesignKnowledgeOriginalSnapshot();
        var snapshots = await ResolveInternalAsync(userId, references, requireExpectedHash: true, ct, originals);
        // Verify authority and original bindings again after the bounded storage reads.
        await ReadWorkspaceOriginalsAsync(userId, snapshots, originals, ct);
        return new(snapshots, originals);
    }

    public async Task<IReadOnlyList<DesignWorkspaceFile>> ReadWorkspaceOriginalsAsync(
        string userId, IReadOnlyList<DesignKnowledgeSnapshot> snapshots, DesignKnowledgeOriginalSnapshot originals, CancellationToken ct)
    {
        if (originals.Version != 1 || originals.References.Count != snapshots.Count
            || snapshots.Where((x, index) => x.EntryId != originals.References[index].EntryId || x.StoreId != originals.References[index].StoreId).Any())
            throw Invalid("知识原件快照版本不受支持，请重新选择来源并创建任务");
        var identities = snapshots.Select(x => new DesignKnowledgeReferenceIdentity(x.EntryId, x.StoreId ?? string.Empty, x.ContentHash)).ToList();
        await ResolveForRunAsync(userId, identities, ct);
        var files = new List<DesignWorkspaceFile>();
        long totalBytes = 0;
        for (var index = 0; index < snapshots.Count; index++)
        {
            var snapshot = snapshots[index];
            var binding = originals.References[index];
            var attachment = await ReadMatchingOriginalAsync(userId, binding, ct);
            if (attachment == null) continue;
            var bytes = await ReadOriginalBytesAsync(attachment, ct);
            totalBytes += bytes.LongLength;
            if (totalBytes > DesignArtifactWorkspaceBroker.MaxInputBytes
                || Sha256Bytes(bytes) != binding.File!.Sha256)
                throw OriginalChanged();
            var extension = Path.GetExtension(binding.File.FileName);
            if (!System.Text.RegularExpressions.Regex.IsMatch(extension, @"^\.[a-zA-Z0-9]{1,10}$")) extension = ".bin";
            var path = $"knowledge/{index + 1:D2}-{Sha256(snapshot.EntryId)[..16]}/source{extension.ToLowerInvariant()}";
            files.Add(new DesignWorkspaceFile(path, Convert.ToBase64String(bytes), binding.File.Sha256,
                bytes.LongLength, binding.File.MimeType));
        }
        await ResolveForRunAsync(userId, identities, ct);
        foreach (var binding in originals.References)
            await ReadMatchingOriginalAsync(userId, binding, ct);
        return files;
    }

    private async Task<Attachment?> ReadMatchingOriginalAsync(string userId, DesignKnowledgeOriginalBinding snapshot, CancellationToken ct)
    {
        var entry = await _db.DocumentEntries.Find(x => x.Id == snapshot.EntryId && x.StoreId == snapshot.StoreId && !x.IsFolder).FirstOrDefaultAsync(ct);
        if (entry == null || !string.Equals(entry.AttachmentId ?? string.Empty, snapshot.File?.AttachmentId ?? string.Empty, StringComparison.Ordinal))
            throw OriginalChanged();
        if (snapshot.File == null) return null;
        var attachment = await _db.Attachments.Find(x => x.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync(ct);
        var frozen = snapshot.File;
        if (attachment == null || attachment.StorageKey != frozen.StorageKey || attachment.Size != frozen.Size
            || attachment.MimeType != frozen.MimeType || OriginalFileName(attachment) != frozen.FileName)
            throw OriginalChanged();
        await RequireOriginalReadAccessAsync(userId, attachment, ct);
        return attachment;
    }

    private async Task RequireOriginalReadAccessAsync(string userId, Attachment attachment, CancellationToken ct)
    {
        // Knowing/copying extracted text does not grant access to embedded binary
        // parts. ContentIndexMatches is therefore deliberately not authority here.
        if (string.IsNullOrWhiteSpace(attachment.UploaderId)) throw NotFound();
        if (attachment.UploaderId == userId) return;
        var sourceEntries = await _db.DocumentEntries.Find(x => !x.IsFolder
                && x.AttachmentId == attachment.AttachmentId
                && (x.CreatedBy == attachment.UploaderId || x.UpdatedBy == attachment.UploaderId))
            .SortBy(x => x.CreatedAt).Limit(MaxLeafSourceCandidates).ToListAsync(ct);
        var storeIds = sourceEntries.Select(x => x.StoreId).Distinct(StringComparer.Ordinal).ToList();
        var stores = await _db.DocumentStores.Find(x => storeIds.Contains(x.Id)).ToListAsync(ct);
        var teams = await _teams.GetMyTeamIdsAsync(userId, ct);
        IReadOnlyList<string>? permissions = null;
        foreach (var store in stores)
            if (await CanReadAsync(store, userId, teams, ct, async () =>
                    permissions ??= await _permissions.GetEffectivePermissionsAsync(userId, false, ct))) return;
        throw NotFound();
    }

    private async Task<byte[]> ReadOriginalBytesAsync(Attachment attachment, CancellationToken ct)
    {
        if (_storage == null) throw Invalid("知识原件读取服务不可用，请联系管理员");
        if (string.IsNullOrWhiteSpace(attachment.StorageKey)
            || !DesignArtifactPublicPath.TryNormalize(attachment.StorageKey, out _))
            throw Invalid("该知识原件缺少可信存储引用，请重新上传后再使用文件工作区");
        if (attachment.Size <= 0 || attachment.Size > DesignArtifactWorkspaceBroker.MaxInputBytes)
            throw Invalid("知识原件超过工作区传输上限或为空，请精简或重新上传");
        if (!System.Net.Http.Headers.MediaTypeHeaderValue.TryParse(attachment.MimeType, out _))
            throw Invalid("知识原件类型无效，请重新上传");
        byte[]? bytes;
        try { bytes = await _storage.TryDownloadBytesAsync(attachment.StorageKey, ct); }
        catch (Exception error) when (error is not OperationCanceledException)
        { throw Invalid("知识原件读取失败，请稍后重试或重新上传"); }
        if (bytes == null || bytes.LongLength != attachment.Size)
            throw OriginalChanged();
        return bytes;
    }

    private static string OriginalFileName(Attachment attachment) => Path.GetFileName(attachment.FileName.Replace('\\', '/'));
    private static string Sha256Bytes(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static DesignKnowledgeSnapshotException OriginalChanged() => new(ContentChangedCode,
        "知识原件已变化、缺失或超出工作区传输上限，请重新选择来源后创建任务");

    private async Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveInternalAsync(
        string userId,
        IReadOnlyList<DesignKnowledgeReferenceIdentity> references,
        bool requireExpectedHash,
        CancellationToken ct,
        DesignKnowledgeOriginalSnapshot? originals = null)
    {
        if (references.Count > MaxReferenceCount)
            throw Invalid("首版一次最多引用 3 篇知识");
        if (references.Count == 0)
            return Array.Empty<DesignKnowledgeSnapshot>();

        var normalized = references.Select(reference => new DesignKnowledgeReferenceIdentity(
            reference.EntryId?.Trim() ?? string.Empty,
            reference.StoreId?.Trim() ?? string.Empty,
            NormalizeHash(reference.ExpectedContentHash))).ToList();
        if (normalized.Any(reference => reference.EntryId.Length == 0 || reference.StoreId.Length == 0))
            throw Invalid("引用知识缺少条目或知识库身份");
        if (normalized.Select(reference => reference.EntryId).Distinct(StringComparer.Ordinal).Count() != normalized.Count)
            throw Invalid("引用知识中存在重复条目，请重新选择");
        if (requireExpectedHash && normalized.Any(reference => !IsSha256(reference.ExpectedContentHash)))
            throw new DesignKnowledgeSnapshotException(
                ContentHashRequiredCode,
                "引用内容版本缺失，请刷新来源后重试");

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

            var (content, sourceTitle, sourceAttachment) = await ReadAuthorizedContentAsync(
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

            var contentHashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
            var contentHash = Convert.ToHexString(contentHashBytes).ToLowerInvariant();
            if (requireExpectedHash
                && !CryptographicOperations.FixedTimeEquals(
                    contentHashBytes,
                    Convert.FromHexString(reference.ExpectedContentHash!)))
            {
                throw new DesignKnowledgeSnapshotException(
                    ContentChangedCode,
                    "引用内容已变化，请刷新来源后重试");
            }

            DesignKnowledgeOriginalFile? original = null;
            if (originals != null && sourceAttachment != null)
            {
                await RequireOriginalReadAccessAsync(userId, sourceAttachment, ct);
                var bytes = await ReadOriginalBytesAsync(sourceAttachment, ct);
                original = new DesignKnowledgeOriginalFile
                {
                    AttachmentId = sourceAttachment.AttachmentId, StorageKey = sourceAttachment.StorageKey!,
                    FileName = OriginalFileName(sourceAttachment), MimeType = sourceAttachment.MimeType,
                    Size = bytes.LongLength, Sha256 = Sha256Bytes(bytes),
                };
            }
            originals?.References.Add(new DesignKnowledgeOriginalBinding { EntryId = entry.Id, StoreId = store.Id, File = original });
            snapshots.Add(new DesignKnowledgeSnapshot
            {
                EntryId = entry.Id,
                StoreId = store.Id,
                StoreName = store.Name,
                Title = NormalizeTitle(entry.Title, sourceTitle),
                Content = content,
                ContentHash = contentHash,
            });
        }

        return snapshots;
    }

    private static string? NormalizeHash(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim().ToLowerInvariant();

    private static bool IsSha256(string? value)
    {
        if (value?.Length != 64) return false;
        try
        {
            return Convert.FromHexString(value).Length == 32;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private async Task<(string? Content, string? Title, Attachment? Original)> ReadAuthorizedContentAsync(
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
            return (null, null, null);

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
            return (document.RawContent, document.Title, attachment);
        if (!string.IsNullOrEmpty(attachment?.ExtractedText))
            return (attachment.ExtractedText, attachment.FileName, attachment);

        return (null, null, attachment);
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
