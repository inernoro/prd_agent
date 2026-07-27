using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public sealed class TutorialLinkGraphService
{
    private readonly MongoDbContext _db;

    public TutorialLinkGraphService(MongoDbContext db) => _db = db;

    public async Task<TutorialLinkGraph?> GetAsync(string storeId, string publisher, CancellationToken ct)
        => await _db.TutorialLinkGraphs.Find(graph => graph.StoreId == storeId && graph.Publisher == publisher)
            .FirstOrDefaultAsync(ct);

    public async Task<TutorialLinkGraphMutationResult> SaveDraftAsync(
        string storeId,
        string publisher,
        TutorialLinkGraphRevision graph,
        string? expectedDraftSha256,
        string actor,
        CancellationToken ct)
    {
        var validation = await ValidateAsync(storeId, publisher, graph, ct);
        if (validation != null) return TutorialLinkGraphMutationResult.Invalid(validation);
        var prepared = TutorialLinkGraphPolicy.PrepareRevision(graph, actor);
        var current = await GetAsync(storeId, publisher, ct);
        if (!ExpectedMatches(current?.Draft?.GraphSha256, expectedDraftSha256))
            return TutorialLinkGraphMutationResult.Stale("草稿已变化，请重新读取后再保存");

        if (current == null)
        {
            current = new TutorialLinkGraph
            {
                Id = DeterministicId(storeId, publisher),
                StoreId = storeId,
                Publisher = publisher,
                Draft = prepared,
            };
            try
            {
                await _db.TutorialLinkGraphs.InsertOneAsync(current, cancellationToken: ct);
                return TutorialLinkGraphMutationResult.Success(current);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                return TutorialLinkGraphMutationResult.Stale("图谱已由另一发布任务创建，请重新读取");
            }
        }

        var observedUpdatedAt = current.UpdatedAt;
        current.Draft = prepared;
        current.UpdatedAt = DateTime.UtcNow;
        var replaced = await _db.TutorialLinkGraphs.ReplaceOneAsync(
            item => item.Id == current.Id && item.UpdatedAt == observedUpdatedAt,
            current,
            cancellationToken: ct);
        return replaced.ModifiedCount == 1
            ? TutorialLinkGraphMutationResult.Success(current)
            : TutorialLinkGraphMutationResult.Stale("草稿在保存期间发生变化，请重新读取");
    }

    public async Task<TutorialLinkGraphMutationResult> PublishAsync(
        string storeId,
        string publisher,
        string expectedDraftSha256,
        string? expectedPublishedSha256,
        string actor,
        CancellationToken ct)
    {
        var current = await GetAsync(storeId, publisher, ct);
        if (current?.Draft == null) return TutorialLinkGraphMutationResult.Invalid("没有可发布的草稿");
        if (!string.Equals(current.Draft.GraphSha256, expectedDraftSha256, StringComparison.OrdinalIgnoreCase))
            return TutorialLinkGraphMutationResult.Stale("草稿 SHA 已变化，请重新读取后再发布");
        if (!ExpectedMatches(current.Published?.GraphSha256, expectedPublishedSha256))
            return TutorialLinkGraphMutationResult.Stale("已发布版本已变化，请重新读取后再发布");
        var validation = await ValidateAsync(storeId, publisher, current.Draft, ct);
        if (validation != null) return TutorialLinkGraphMutationResult.Invalid(validation);

        var observedUpdatedAt = current.UpdatedAt;
        var published = CloneRevision(current.Draft, actor);
        current.Published = published;
        current.Versions.Add(new TutorialLinkGraphPublishedVersion
        {
            Revision = published,
            PublishedBy = actor,
        });
        if (current.Versions.Count > TutorialLinkGraphPolicy.MaxVersions)
            current.Versions = current.Versions.TakeLast(TutorialLinkGraphPolicy.MaxVersions).ToList();
        current.UpdatedAt = DateTime.UtcNow;
        var replaced = await _db.TutorialLinkGraphs.ReplaceOneAsync(
            item => item.Id == current.Id && item.UpdatedAt == observedUpdatedAt,
            current,
            cancellationToken: ct);
        return replaced.ModifiedCount == 1
            ? TutorialLinkGraphMutationResult.Success(current)
            : TutorialLinkGraphMutationResult.Stale("发布期间图谱发生变化，原已发布版本保持不变");
    }

    public async Task<TutorialLinkGraphMutationResult> RollbackAsync(
        string storeId,
        string publisher,
        string versionId,
        string expectedPublishedSha256,
        string actor,
        CancellationToken ct)
    {
        var current = await GetAsync(storeId, publisher, ct);
        if (current?.Published == null) return TutorialLinkGraphMutationResult.Invalid("当前没有已发布版本");
        if (!string.Equals(current.Published.GraphSha256, expectedPublishedSha256, StringComparison.OrdinalIgnoreCase))
            return TutorialLinkGraphMutationResult.Stale("已发布版本已变化，请重新读取后再回滚");
        var target = current.Versions.SingleOrDefault(version => version.VersionId == versionId);
        if (target == null) return TutorialLinkGraphMutationResult.Invalid("回滚版本不存在或已超出保留历史");
        var validation = await ValidateAsync(storeId, publisher, target.Revision, ct);
        if (validation != null) return TutorialLinkGraphMutationResult.Invalid($"目标版本已不满足当前内容约束：{validation}");

        var observedUpdatedAt = current.UpdatedAt;
        var published = CloneRevision(target.Revision, actor);
        current.Published = published;
        current.Draft = published;
        current.Versions.Add(new TutorialLinkGraphPublishedVersion
        {
            Revision = published,
            PublishedBy = actor,
            RolledBackFromVersionId = versionId,
        });
        if (current.Versions.Count > TutorialLinkGraphPolicy.MaxVersions)
            current.Versions = current.Versions.TakeLast(TutorialLinkGraphPolicy.MaxVersions).ToList();
        current.UpdatedAt = DateTime.UtcNow;
        var replaced = await _db.TutorialLinkGraphs.ReplaceOneAsync(
            item => item.Id == current.Id && item.UpdatedAt == observedUpdatedAt,
            current,
            cancellationToken: ct);
        return replaced.ModifiedCount == 1
            ? TutorialLinkGraphMutationResult.Success(current)
            : TutorialLinkGraphMutationResult.Stale("回滚期间图谱发生变化，原已发布版本保持不变");
    }

    private async Task<string?> ValidateAsync(
        string storeId,
        string publisher,
        TutorialLinkGraphRevision graph,
        CancellationToken ct)
    {
        var shape = TutorialLinkGraphPolicy.ValidateShape(graph);
        if (shape != null) return shape;
        var entries = await _db.DocumentEntries.Find(entry => entry.StoreId == storeId).ToListAsync(ct);
        if (DocumentStorePublisherPolicy.HasIdentityConflicts(entries, publisher))
            return "受管教程节点存在重复或非法 sourceId";
        var managedDocumentEntries = entries
            .Where(entry => !entry.IsFolder
                            && entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.PublisherKey, out var marker)
                            && string.Equals(marker, publisher, StringComparison.Ordinal)
                            && entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceIdKey, out var sourceId)
                            && DocumentStorePublisherPolicy.IsSafeToken(sourceId))
            .ToList();
        var managedDocuments = managedDocumentEntries
            .Select(entry => entry.Metadata[DocumentStorePublisherPolicy.SourceIdKey])
            .ToHashSet(StringComparer.Ordinal);
        var contentContractMismatch = managedDocumentEntries.Any(entry =>
            !entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.ManifestSha256Key, out var manifestSha256)
            || !string.Equals(manifestSha256, graph.ManifestSha256, StringComparison.OrdinalIgnoreCase)
            || !entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceRevisionKey, out var sourceRevision)
            || !string.Equals(sourceRevision, graph.SourceRevision, StringComparison.Ordinal));
        if (contentContractMismatch)
            return "图谱的 manifestSha256 或 sourceRevision 与已发布教程内容不一致";
        var referenced = graph.Surfaces.SelectMany(surface => surface.TutorialSourceIds)
            .ToHashSet(StringComparer.Ordinal);
        var missing = referenced.Except(managedDocuments, StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToList();
        if (missing.Count > 0) return $"图谱引用了不存在的教程节点：{string.Join(", ", missing)}";
        var orphaned = managedDocuments.Where(sourceId => sourceId != "book-index")
            .Except(referenced, StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToList();
        if (orphaned.Count > 0) return $"存在没有页面反向链接的教程节点：{string.Join(", ", orphaned)}";
        return null;
    }

    private static bool ExpectedMatches(string? actual, string? expected)
        => string.IsNullOrWhiteSpace(actual)
            ? string.IsNullOrWhiteSpace(expected)
            : string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);

    private static string DeterministicId(string storeId, string publisher)
        => DocumentStorePublisherPolicy.Sha256($"{storeId}\n{publisher}\ntutorial-link-graph")[..32];

    private static TutorialLinkGraphRevision CloneRevision(TutorialLinkGraphRevision source, string actor)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(source);
        var clone = System.Text.Json.JsonSerializer.Deserialize<TutorialLinkGraphRevision>(json)
                    ?? throw new InvalidOperationException("无法复制教程双链图谱");
        clone.SavedAt = DateTime.UtcNow;
        clone.SavedBy = actor;
        return clone;
    }
}

public sealed record TutorialLinkGraphMutationResult(
    TutorialLinkGraph? Graph,
    TutorialLinkGraphMutationStatus Status,
    string? Message)
{
    public static TutorialLinkGraphMutationResult Success(TutorialLinkGraph graph) => new(graph, TutorialLinkGraphMutationStatus.Success, null);
    public static TutorialLinkGraphMutationResult Invalid(string message) => new(null, TutorialLinkGraphMutationStatus.Invalid, message);
    public static TutorialLinkGraphMutationResult Stale(string message) => new(null, TutorialLinkGraphMutationStatus.Stale, message);
}

public enum TutorialLinkGraphMutationStatus
{
    Success,
    Invalid,
    Stale,
}