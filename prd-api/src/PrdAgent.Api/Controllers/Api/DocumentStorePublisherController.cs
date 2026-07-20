using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using DocStoreServices = PrdAgent.Infrastructure.Services.DocumentStore;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 知识库受控发布接口。只接受绑定用户自己的通用知识库，并以 publisher + sourceId 管理节点。
/// 标题永远不作为身份；未带相同 marker 的人工内容只读投影，不能被更新或删除。
/// </summary>
[ApiController]
[Route("api/open/document-store/publisher")]
[Authorize(AuthenticationSchemes = "ApiKey")]
[RequireScope(DocumentStoreOpenApiController.ScopeWrite)]
public sealed class DocumentStorePublisherController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IDocumentService _documents;
    private readonly EntryContentWriteService _contentWriter;
    private readonly DocStoreServices.MentionService _mentions;

    public DocumentStorePublisherController(
        MongoDbContext db,
        IDocumentService documents,
        EntryContentWriteService contentWriter,
        DocStoreServices.MentionService mentions)
    {
        _db = db;
        _documents = documents;
        _contentWriter = contentWriter;
        _mentions = mentions;
    }

    [HttpGet("stores/{storeId}/snapshot")]
    public async Task<IActionResult> Snapshot(string storeId, [FromQuery] string publisher, CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(publisher))
            return Invalid("publisher 只能包含小写字母、数字、点、下划线和短横线");

        var store = await LoadOwnedGenericStoreAsync(storeId, ct);
        if (store == null) return NotFoundResult();

        var entries = await _db.DocumentEntries.Find(entry => entry.StoreId == storeId).ToListAsync(ct);
        var managedSourceIds = entries
            .Select(entry => new
            {
                Entry = entry,
                PublisherMatches = entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.PublisherKey, out var marker)
                                   && string.Equals(marker, publisher, StringComparison.Ordinal),
                SourceId = entry.Metadata.GetValueOrDefault(DocumentStorePublisherPolicy.SourceIdKey),
            })
            .Where(item => item.PublisherMatches && DocumentStorePublisherPolicy.IsSafeToken(item.SourceId))
            .ToList();
        var duplicateSourceIds = managedSourceIds
            .GroupBy(item => item.SourceId!, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToList();
        var malformedNodeIds = entries
            .Where(entry => entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.PublisherKey, out var marker)
                            && string.Equals(marker, publisher, StringComparison.Ordinal)
                            && (!entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceIdKey, out var sourceId)
                                || !DocumentStorePublisherPolicy.IsSafeToken(sourceId)))
            .Select(entry => entry.Id)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToList();
        var nodes = new List<PublisherSnapshotNode>(entries.Count);
        var missingContentNodeIds = new List<string>();
        var repairRequiredNodeIds = new List<string>();
        foreach (var entry in entries.OrderBy(item => item.Id, StringComparer.Ordinal))
        {
            entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceIdKey, out var sourceId);
            var managed = DocumentStorePublisherPolicy.IsSafeToken(sourceId)
                          && DocumentStorePublisherPolicy.IsManagedBy(entry.Metadata, publisher, sourceId!);
            var content = entry.IsFolder ? string.Empty : await ReadContentAsync(entry);
            if (managed && !entry.IsFolder && content == null)
                missingContentNodeIds.Add(entry.Id);
            if (managed
                && (!entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.DerivedStateKey, out var derivedState)
                    || !string.Equals(derivedState, "ready", StringComparison.Ordinal)))
                repairRequiredNodeIds.Add(entry.Id);
            nodes.Add(new PublisherSnapshotNode
            {
                Id = entry.Id,
                ParentId = entry.ParentId,
                IsFolder = entry.IsFolder,
                Title = entry.Title,
                Summary = entry.Summary,
                ContentType = entry.ContentType,
                Tags = entry.Tags,
                Category = entry.Category,
                SortOrder = entry.SortOrder,
                Metadata = entry.Metadata,
                MetadataSha256 = DocumentStorePublisherPolicy.MetadataSha256(entry.Metadata),
                SourceId = managed ? sourceId : null,
                UpdatedAt = entry.UpdatedAt,
                ContentSha256 = content == null ? null : DocumentStorePublisherPolicy.Sha256(content),
                Content = managed ? content : null,
                Managed = managed,
            });
        }

        var snapshotSha256 = ComputeSnapshotSha256(store, nodes);
        return Ok(ApiResponse<object>.Ok(new
        {
            store = new
            {
                store.Id,
                store.Name,
                store.OwnerId,
                store.AppKey,
                store.IsPublic,
                store.PrimaryEntryId,
                store.UpdatedAt,
            },
            publisher,
            snapshotSha256,
            applyAllowed = duplicateSourceIds.Count == 0
                           && malformedNodeIds.Count == 0
                           && repairRequiredNodeIds.Count == 0,
            conflicts = new { duplicateSourceIds, malformedNodeIds, missingContentNodeIds, repairRequiredNodeIds },
            nodes,
        }));
    }

    [HttpPut("stores/{storeId}/nodes/{sourceId}")]
    public async Task<IActionResult> PutNode(
        string storeId,
        string sourceId,
        [FromBody] PublisherPutNodeRequest request,
        CancellationToken ct)
    {
        var problem = ValidatePutRequest(sourceId, request);
        if (problem != null) return Invalid(problem);

        var store = await LoadOwnedGenericStoreAsync(storeId, ct);
        if (store == null) return NotFoundResult();

        var all = await _db.DocumentEntries.Find(entry => entry.StoreId == storeId).ToListAsync(ct);
        if (DocumentStorePublisherPolicy.HasIdentityConflicts(all, request.Publisher))
            return ConflictResult("受管节点存在重复 sourceId 或缺失合法 sourceId；请先修复快照冲突再发布");
        var unrelatedRepairRequired = all.Any(entry => entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.PublisherKey, out var marker)
                                                       && string.Equals(marker, request.Publisher, StringComparison.Ordinal)
                                                       && entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceIdKey, out var managedSourceId)
                                                       && !string.Equals(managedSourceId, sourceId, StringComparison.Ordinal)
                                                       && (!entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.DerivedStateKey, out var derivedState)
                                                           || !string.Equals(derivedState, "ready", StringComparison.Ordinal)));
        if (unrelatedRepairRequired)
            return ConflictResult("其他受管节点的派生状态未就绪；请先逐个修复后再继续发布");
        var matches = all.Where(entry => DocumentStorePublisherPolicy.IsManagedBy(
            entry.Metadata, request.Publisher, sourceId)).ToList();
        if (matches.Count > 1)
            return ConflictResult("同一 publisher + sourceId 存在多条记录，发布已停止，必须先人工消除重复项");

        var parentResult = ResolveParent(all, request.Publisher, request.ParentSourceId);
        if (parentResult.Error != null) return ConflictResult(parentResult.Error);
        var parentId = parentResult.Parent?.Id;

        var existing = matches.SingleOrDefault();
        var kind = request.Kind.Trim().ToLowerInvariant();
        var isFolder = kind == "folder";
        var targetContent = isFolder ? string.Empty : request.Content ?? string.Empty;
        var targetSha256 = DocumentStorePublisherPolicy.Sha256(targetContent);
        if (!string.Equals(targetSha256, request.SourceSha256, StringComparison.OrdinalIgnoreCase))
            return Invalid("sourceSha256 与规范化后的正文 SHA256 不一致");

        if (existing == null)
        {
            if (request.ExpectedUpdatedAt != null || !string.IsNullOrWhiteSpace(request.LastAppliedSha256))
                return ConflictResult("远端节点不存在，但计划包含旧并发令牌；请重新生成 plan");
            if (HasTitleCollision(all, null, parentId, request.Title))
                return ConflictResult("同一目录已有同名内容，发布器不会按标题认领、覆盖或制造歧义");
            return await CreateNodeAsync(store, sourceId, request, parentId, isFolder, targetContent, targetSha256);
        }

        if (existing.IsFolder != isFolder)
            return ConflictResult("受管节点类型与目标类型不同，发布器不会把文件夹和文档互相转换");
        var parentById = all.ToDictionary(entry => entry.Id, entry => entry.ParentId, StringComparer.Ordinal);
        if (DocumentStorePublisherPolicy.WouldCreateParentCycle(existing.Id, parentId, parentById))
            return ConflictResult("目标父目录会形成目录环路，发布已停止");
        if (HasTitleCollision(all, existing.Id, parentId, request.Title))
            return ConflictResult("目标目录已有同名内容，发布器不会制造同名歧义");
        if (request.ExpectedUpdatedAt == null || existing.UpdatedAt != request.ExpectedUpdatedAt.Value)
            return ConflictResult("远端节点已变化，expectedUpdatedAt 不匹配；请重新生成 plan");

        var currentContent = existing.IsFolder ? string.Empty : await ReadContentAsync(existing);
        existing.Metadata.TryGetValue(DocumentStorePublisherPolicy.LastAppliedSha256Key, out var recordedLastApplied);
        if (!string.IsNullOrWhiteSpace(request.LastAppliedSha256)
            && !string.Equals(recordedLastApplied, request.LastAppliedSha256, StringComparison.OrdinalIgnoreCase))
            return ConflictResult("plan 中的 lastAppliedSha256 与远端 marker 不一致；请重新生成 plan");

        // 正文实体缺失时允许发布器用仓库原文自愈，但必须由受管 metadata 的两份哈希同时证明
        // 目标正文就是最后一次成功发布的版本。这样不会把未知人工内容当成可覆盖对象。
        if (currentContent == null)
        {
            existing.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceSha256Key, out var recordedSourceSha256);
            if (!string.Equals(recordedSourceSha256, targetSha256, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(recordedLastApplied, targetSha256, StringComparison.OrdinalIgnoreCase))
                return ConflictResult("文档正文缺失，且发布 marker 无法证明目标版本；拒绝自动覆盖");
            var repairMetadata = BuildMetadata(existing.Metadata, request, sourceId, targetSha256, kind);
            return await UpdateDocumentAsync(existing, store, request, parentId, repairMetadata, targetContent, targetSha256);
        }

        var currentSha256 = DocumentStorePublisherPolicy.Sha256(currentContent);

        var decision = DocumentStorePublisherPolicy.Decide(true, currentSha256, recordedLastApplied, targetSha256);
        if (decision == PublisherContentDecision.Conflict)
            return ConflictResult("远端正文已被人工修改，且既不等于上次发布版本也不等于目标版本；不会覆盖");

        // lastAppliedRunId 是回滚安全 marker，不能参与内容 noop 判定。否则相同源文件
        // 第二次发布时，单凭新 runId 就会改 UpdatedAt，整书永远无法达到可验证的 noop。
        var noopMetadata = BuildMetadata(
            existing.Metadata,
            request,
            sourceId,
            targetSha256,
            kind,
            preserveLastAppliedRunId: true);
        if (EntryMatches(existing, request, parentId, noopMetadata, targetSha256, currentSha256))
        {
            // 正文、标题与源 metadata 都未变化时保持 UpdatedAt 不动，但仍原子记录“最后观察到
            // 该节点的发布批次”。这样旧批次随后尝试 rollback 时会被拒绝，不会删除已被后续
            // 成功发布确认过的节点。该内部安全 marker 不把本次响应从 noop 变成 update。
            existing.Metadata.TryGetValue(DocumentStorePublisherPolicy.LastAppliedRunIdKey, out var lastAppliedRunId);
            if (!string.Equals(lastAppliedRunId, request.RunId, StringComparison.Ordinal))
            {
                var filter = Builders<DocumentEntry>.Filter.And(
                    Builders<DocumentEntry>.Filter.Eq(item => item.Id, existing.Id),
                    Builders<DocumentEntry>.Filter.Eq(item => item.UpdatedAt, existing.UpdatedAt),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.publisher", request.Publisher),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.sourceId", sourceId),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.lastAppliedRunId", lastAppliedRunId));
                var touched = await _db.DocumentEntries.UpdateOneAsync(
                    filter,
                    Builders<DocumentEntry>.Update.Set(
                        $"Metadata.{DocumentStorePublisherPolicy.LastAppliedRunIdKey}",
                        request.RunId),
                    cancellationToken: CancellationToken.None);
                if (touched.MatchedCount != 1)
                    return ConflictResult("远端节点在 noop 确认前发生变化；请重新生成 plan");
            }
            return Ok(ApiResponse<object>.Ok(new { action = "noop", nodeId = existing.Id, updatedAt = existing.UpdatedAt, sourceSha256 = targetSha256 }));
        }

        var metadata = BuildMetadata(existing.Metadata, request, sourceId, targetSha256, kind);
        return isFolder
            ? await UpdateFolderAsync(existing, request, parentId, metadata, targetSha256)
            : await UpdateDocumentAsync(existing, store, request, parentId, metadata, targetContent, targetSha256);
    }

    [HttpDelete("stores/{storeId}/nodes/{sourceId}")]
    public async Task<IActionResult> DeleteCreatedNode(
        string storeId,
        string sourceId,
        [FromQuery] string publisher,
        [FromQuery] string runId,
        [FromQuery] DateTime expectedUpdatedAt,
        [FromQuery] string expectedSha256,
        [FromQuery] string expectedMetadataSha256,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(publisher)
            || !DocumentStorePublisherPolicy.IsSafeToken(sourceId)
            || !DocumentStorePublisherPolicy.IsSafeToken(runId)
            || !DocumentStorePublisherPolicy.IsSha256(expectedSha256)
            || !DocumentStorePublisherPolicy.IsSha256(expectedMetadataSha256))
            return Invalid("publisher、sourceId、runId 或预期 SHA256 无效");

        var store = await LoadOwnedGenericStoreAsync(storeId, ct);
        if (store == null) return NotFoundResult();

        var all = await _db.DocumentEntries.Find(entry => entry.StoreId == storeId).ToListAsync(ct);
        var matches = all.Where(entry => DocumentStorePublisherPolicy.IsManagedBy(entry.Metadata, publisher, sourceId)).ToList();
        if (matches.Count != 1)
            return matches.Count == 0 ? NotFoundResult() : ConflictResult("受管节点不唯一，拒绝回滚删除");
        var entry = matches[0];
        if (entry.UpdatedAt != expectedUpdatedAt)
            return ConflictResult("节点已变化，拒绝回滚删除");
        if (all.Any(candidate => candidate.ParentId == entry.Id))
            return ConflictResult("节点仍有子项，拒绝回滚删除");

        if (!entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.CreatedByRunIdKey, out var createdByRunId)
            || !string.Equals(createdByRunId, runId, StringComparison.Ordinal))
            return ConflictResult("节点不是本发布批次创建，拒绝回滚删除");
        if (!entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.LastAppliedRunIdKey, out var lastAppliedRunId)
            || !string.Equals(lastAppliedRunId, runId, StringComparison.Ordinal))
            return ConflictResult("节点创建后已被其他发布批次更新，拒绝按旧批次回滚删除");
        var metadataSha256 = DocumentStorePublisherPolicy.MetadataSha256(entry.Metadata);
        if (!string.Equals(metadataSha256, expectedMetadataSha256, StringComparison.OrdinalIgnoreCase))
            return ConflictResult("节点 metadata 已变化，拒绝回滚删除");

        var content = entry.IsFolder ? string.Empty : await ReadContentAsync(entry);
        if (content == null)
            return ConflictResult("文档正文缺失，拒绝回滚删除");
        var currentSha256 = DocumentStorePublisherPolicy.Sha256(content);
        if (!string.Equals(currentSha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
            return ConflictResult("节点正文已变化，拒绝回滚删除");
        if (!entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceSha256Key, out var sourceSha256)
            || !entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.LastAppliedSha256Key, out var lastAppliedSha256)
            || !string.Equals(sourceSha256, currentSha256, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(lastAppliedSha256, currentSha256, StringComparison.OrdinalIgnoreCase))
            return ConflictResult("节点发布 hash 与当前正文不一致，拒绝回滚删除");

        var hasComments = await _db.DocumentInlineComments.CountDocumentsAsync(comment => comment.EntryId == entry.Id, cancellationToken: ct) > 0;
        var hasRuns = await _db.DocumentStoreAgentRuns.CountDocumentsAsync(run => run.SourceEntryId == entry.Id, cancellationToken: ct) > 0;
        if (hasComments || hasRuns)
            return ConflictResult("节点已有人工评论或 Agent 运行记录，拒绝回滚删除");

        var filter = Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Eq(item => item.Id, entry.Id),
            Builders<DocumentEntry>.Filter.Eq(item => item.UpdatedAt, expectedUpdatedAt),
            Builders<DocumentEntry>.Filter.Eq("Metadata.publisher", publisher),
            Builders<DocumentEntry>.Filter.Eq("Metadata.sourceId", sourceId),
            Builders<DocumentEntry>.Filter.Eq("Metadata.createdByRunId", runId),
            Builders<DocumentEntry>.Filter.Eq("Metadata.lastAppliedRunId", runId),
            Builders<DocumentEntry>.Filter.Eq("Metadata.sourceSha256", sourceSha256),
            Builders<DocumentEntry>.Filter.Eq("Metadata.lastAppliedSha256", lastAppliedSha256),
            Builders<DocumentEntry>.Filter.Eq(item => item.Metadata, entry.Metadata));
        var deleted = await _db.DocumentEntries.DeleteOneAsync(filter, CancellationToken.None);
        if (deleted.DeletedCount != 1) return ConflictResult("节点在删除前发生变化，拒绝回滚删除");

        await _db.DocumentEntryVersions.DeleteManyAsync(version => version.EntryId == entry.Id, CancellationToken.None);
        await _db.DocumentSyncLogs.DeleteManyAsync(log => log.EntryId == entry.Id, CancellationToken.None);
        await _db.DocumentStoreViewEvents.DeleteManyAsync(view => view.EntryId == entry.Id, CancellationToken.None);
        await _mentions.CascadeDeleteAsync(MentionEntityType.Document, new[] { entry.Id }, CancellationToken.None);
        if (!string.IsNullOrWhiteSpace(entry.DocumentId))
        {
            var otherReferences = await _db.DocumentEntries.CountDocumentsAsync(
                candidate => candidate.DocumentId == entry.DocumentId, cancellationToken: CancellationToken.None);
            if (otherReferences == 0)
                await _db.Documents.DeleteOneAsync(document => document.Id == entry.DocumentId, CancellationToken.None);
        }
        await RefreshStoreCountAsync(storeId);
        return Ok(ApiResponse<object>.Ok(new { action = "deleted", nodeId = entry.Id }));
    }

    [HttpPut("stores/{storeId}/primary")]
    public async Task<IActionResult> SetPrimary(
        string storeId,
        [FromBody] PublisherSetPrimaryRequest request,
        CancellationToken ct)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)
            || !DocumentStorePublisherPolicy.IsSafeToken(request.SourceId))
            return Invalid("publisher 或 sourceId 无效");

        var store = await LoadOwnedGenericStoreAsync(storeId, ct);
        if (store == null) return NotFoundResult();
        if (store.UpdatedAt != request.ExpectedStoreUpdatedAt)
            return ConflictResult("知识库配置已变化，expectedStoreUpdatedAt 不匹配");

        var nodes = await _db.DocumentEntries.Find(entry => entry.StoreId == storeId).ToListAsync(ct);
        if (DocumentStorePublisherPolicy.HasIdentityConflicts(nodes, request.Publisher))
            return ConflictResult("受管节点存在身份冲突，不能设置主文档");
        foreach (var managedNode in nodes.Where(entry => entry.Metadata.TryGetValue(DocumentStorePublisherPolicy.PublisherKey, out var marker)
                                                          && string.Equals(marker, request.Publisher, StringComparison.Ordinal)))
        {
            if (!managedNode.Metadata.TryGetValue(DocumentStorePublisherPolicy.DerivedStateKey, out var nodeDerivedState)
                || !string.Equals(nodeDerivedState, "ready", StringComparison.Ordinal))
                return ConflictResult("仍有受管节点派生状态未就绪，不能设置主文档");
            if (managedNode.IsFolder) continue;
            var managedContent = await ReadContentAsync(managedNode);
            if (managedContent == null
                || !managedNode.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceSha256Key, out var managedSourceSha256)
                || !string.Equals(DocumentStorePublisherPolicy.Sha256(managedContent), managedSourceSha256, StringComparison.OrdinalIgnoreCase))
                return ConflictResult("仍有受管文档正文或发布 hash 不完整，不能设置主文档");
        }
        var matches = nodes.Where(entry => !entry.IsFolder && DocumentStorePublisherPolicy.IsManagedBy(
            entry.Metadata, request.Publisher, request.SourceId)).ToList();
        if (matches.Count != 1)
            return ConflictResult("主文档 sourceId 不存在或不唯一");
        var primary = matches[0];
        var primaryContent = await ReadContentAsync(primary);
        if (primaryContent == null
            || !primary.Metadata.TryGetValue(DocumentStorePublisherPolicy.SourceSha256Key, out var sourceSha256)
            || !string.Equals(DocumentStorePublisherPolicy.Sha256(primaryContent), sourceSha256, StringComparison.OrdinalIgnoreCase)
            || !primary.Metadata.TryGetValue(DocumentStorePublisherPolicy.DerivedStateKey, out var derivedState)
            || !string.Equals(derivedState, "ready", StringComparison.Ordinal))
            return ConflictResult("主文档正文、发布 hash 或派生状态未就绪");

        var now = DateTime.UtcNow;
        var filter = Builders<DocumentStore>.Filter.And(
            Builders<DocumentStore>.Filter.Eq(item => item.Id, storeId),
            Builders<DocumentStore>.Filter.Eq(item => item.OwnerId, GetBoundUserId()),
            Builders<DocumentStore>.Filter.Eq(item => item.UpdatedAt, request.ExpectedStoreUpdatedAt));
        var result = await _db.DocumentStores.UpdateOneAsync(
            filter,
            Builders<DocumentStore>.Update
                .Set(item => item.PrimaryEntryId, matches[0].Id)
                .Set(item => item.UpdatedAt, now),
            cancellationToken: CancellationToken.None);
        if (result.MatchedCount != 1) return ConflictResult("知识库配置在写入前发生变化");
        return Ok(ApiResponse<object>.Ok(new { primaryEntryId = matches[0].Id, updatedAt = now }));
    }

    private async Task<IActionResult> CreateNodeAsync(
        DocumentStore store,
        string sourceId,
        PublisherPutNodeRequest request,
        string? parentId,
        bool isFolder,
        string targetContent,
        string targetSha256)
    {
        var kind = isFolder ? "folder" : "document";
        var metadata = BuildMetadata(null, request, sourceId, targetSha256, kind, createdByRunId: request.RunId);
        var storedMetadata = new Dictionary<string, string>(metadata, StringComparer.Ordinal);
        if (!isFolder)
            storedMetadata[DocumentStorePublisherPolicy.DerivedStateKey] = "pending";
        var now = DateTime.UtcNow;
        var entry = new DocumentEntry
        {
            Id = DeterministicNodeId(store.Id, request.Publisher, sourceId),
            StoreId = store.Id,
            ParentId = parentId,
            IsFolder = isFolder,
            Title = request.Title.Trim(),
            Summary = request.Summary?.Trim(),
            SourceType = DocumentSourceType.Import,
            ContentType = isFolder ? "application/x-folder" : request.ContentType.Trim(),
            FileSize = isFolder ? 0 : System.Text.Encoding.UTF8.GetByteCount(targetContent),
            Tags = request.Tags ?? new List<string>(),
            Category = string.IsNullOrWhiteSpace(request.Category) ? null : request.Category.Trim(),
            SortOrder = request.SortOrder,
            Metadata = storedMetadata,
            CreatedBy = GetBoundUserId(),
            CreatedByName = "受控发布器",
            UpdatedBy = GetBoundUserId(),
            UpdatedByName = "受控发布器",
            CreatedAt = now,
            UpdatedAt = now,
        };

        try
        {
            await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        }
        catch (MongoWriteException exception) when (exception.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return ConflictResult("同一受管节点正在被其他发布运行创建；请重新生成 plan");
        }

        if (!isFolder)
        {
            try
            {
                var write = await _contentWriter.WriteAsync(
                    entry,
                    store,
                    targetContent,
                    GetBoundUserId(),
                    "受控发布器",
                    DocumentVersionSource.Import,
                    contentTypeOverride: request.ContentType.Trim(),
                    expectedUpdatedAt: entry.UpdatedAt,
                    entryFields: ToEntryFields(request, parentId, metadata, targetContent, derivedPending: true),
                    derivedStateMetadataKey: DocumentStorePublisherPolicy.DerivedStateKey);
                if (write.Conflicted)
                {
                    await DeleteUnreferencedDocumentAsync(write.DocumentId);
                    return ConflictResult("新建文档在正文提交前发生变化，未执行覆盖");
                }
                entry.UpdatedAt = write.UpdatedAt;
                metadata[DocumentStorePublisherPolicy.DerivedStateKey] = !write.DerivedMarkerPersisted
                    ? "pending"
                    : write.DerivedFailed ? "failed" : "ready";
            }
            catch
            {
                var cleanup = Builders<DocumentEntry>.Filter.And(
                    Builders<DocumentEntry>.Filter.Eq(item => item.Id, entry.Id),
                    Builders<DocumentEntry>.Filter.Eq(item => item.UpdatedAt, now),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.publisher", request.Publisher),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.sourceId", sourceId),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.createdByRunId", request.RunId),
                    Builders<DocumentEntry>.Filter.Eq("Metadata.sourceSha256", targetSha256));
                await _db.DocumentEntries.DeleteOneAsync(cleanup, CancellationToken.None);
                if (!string.IsNullOrWhiteSpace(entry.DocumentId))
                    await DeleteUnreferencedDocumentAsync(entry.DocumentId);
                throw;
            }
        }

        await RefreshStoreCountAsync(store.Id);
        return Ok(ApiResponse<object>.Ok(new
        {
            action = "created",
            nodeId = entry.Id,
            updatedAt = entry.UpdatedAt,
            sourceSha256 = targetSha256,
            derivedState = metadata[DocumentStorePublisherPolicy.DerivedStateKey],
            derivedMarkerPersisted = isFolder || !string.Equals(metadata[DocumentStorePublisherPolicy.DerivedStateKey], "pending", StringComparison.Ordinal),
        }));
    }

    private async Task<IActionResult> UpdateFolderAsync(
        DocumentEntry existing,
        PublisherPutNodeRequest request,
        string? parentId,
        Dictionary<string, string> metadata,
        string targetSha256)
    {
        var now = DateTime.UtcNow;
        var filter = Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Eq(item => item.Id, existing.Id),
            Builders<DocumentEntry>.Filter.Eq(item => item.UpdatedAt, request.ExpectedUpdatedAt!.Value),
            Builders<DocumentEntry>.Filter.Eq("Metadata.publisher", request.Publisher),
            Builders<DocumentEntry>.Filter.Eq("Metadata.sourceId", existing.Metadata[DocumentStorePublisherPolicy.SourceIdKey]));
        var result = await _db.DocumentEntries.UpdateOneAsync(
            filter,
            Builders<DocumentEntry>.Update
                .Set(item => item.Title, request.Title.Trim())
                .Set(item => item.Summary, request.Summary?.Trim())
                .Set(item => item.ParentId, parentId)
                .Set(item => item.Tags, request.Tags ?? new List<string>())
                .Set(item => item.Category, string.IsNullOrWhiteSpace(request.Category) ? null : request.Category.Trim())
                .Set(item => item.SortOrder, request.SortOrder)
                .Set(item => item.Metadata, metadata)
                .Set(item => item.UpdatedBy, GetBoundUserId())
                .Set(item => item.UpdatedByName, "受控发布器")
                .Set(item => item.UpdatedAt, now),
            cancellationToken: CancellationToken.None);
        if (result.MatchedCount != 1) return ConflictResult("文件夹在写入前发生变化");
        return Ok(ApiResponse<object>.Ok(new { action = "updated", nodeId = existing.Id, updatedAt = now, sourceSha256 = targetSha256 }));
    }

    private async Task<IActionResult> UpdateDocumentAsync(
        DocumentEntry existing,
        DocumentStore store,
        PublisherPutNodeRequest request,
        string? parentId,
        Dictionary<string, string> metadata,
        string content,
        string targetSha256)
    {
        var write = await _contentWriter.WriteAsync(
            existing,
            store,
            content,
            GetBoundUserId(),
            "受控发布器",
            DocumentVersionSource.Import,
            contentTypeOverride: request.ContentType.Trim(),
            expectedUpdatedAt: request.ExpectedUpdatedAt,
            entryFields: ToEntryFields(request, parentId, metadata, content, derivedPending: true),
            derivedStateMetadataKey: DocumentStorePublisherPolicy.DerivedStateKey);
        if (write.Conflicted) return ConflictResult("文档在写入前发生变化");
        return Ok(ApiResponse<object>.Ok(new
        {
            action = "updated",
            nodeId = existing.Id,
            updatedAt = write.UpdatedAt,
            sourceSha256 = targetSha256,
            derivedState = !write.DerivedMarkerPersisted ? "pending" : write.DerivedFailed ? "failed" : "ready",
            derivedMarkerPersisted = write.DerivedMarkerPersisted,
        }));
    }

    private EntryContentWriteService.EntryFields ToEntryFields(
        PublisherPutNodeRequest request,
        string? parentId,
        Dictionary<string, string> metadata,
        string content,
        bool derivedPending = false)
        => new(
            request.Title.Trim(),
            request.Summary?.Trim(),
            parentId,
            request.Tags ?? new List<string>(),
            string.IsNullOrWhiteSpace(request.Category) ? null : request.Category.Trim(),
            request.SortOrder,
            derivedPending
                ? metadata.ToDictionary(
                    pair => pair.Key,
                    pair => pair.Key == DocumentStorePublisherPolicy.DerivedStateKey ? "pending" : pair.Value,
                    StringComparer.Ordinal)
                : metadata,
            System.Text.Encoding.UTF8.GetByteCount(content));

    private static Dictionary<string, string> BuildMetadata(
        IReadOnlyDictionary<string, string>? current,
        PublisherPutNodeRequest request,
        string sourceId,
        string targetSha256,
        string kind,
        string? createdByRunId = null,
        bool preserveLastAppliedRunId = false)
        => DocumentStorePublisherPolicy.MergeMetadata(
            current,
            request.Metadata,
            request.Publisher,
            sourceId,
            request.SourcePath.Trim(),
            targetSha256,
            request.ManifestSha256.Trim().ToLowerInvariant(),
            request.SourceRevision.Trim(),
            kind,
            createdByRunId,
            preserveLastAppliedRunId
                ? current?.GetValueOrDefault(DocumentStorePublisherPolicy.LastAppliedRunIdKey)
                : request.RunId);

    private static bool HasTitleCollision(
        IReadOnlyList<DocumentEntry> all,
        string? currentEntryId,
        string? parentId,
        string title)
        => all.Any(entry => entry.Id != currentEntryId
                            && entry.ParentId == parentId
                            && string.Equals(entry.Title, title.Trim(), StringComparison.Ordinal));

    private static bool EntryMatches(
        DocumentEntry entry,
        PublisherPutNodeRequest request,
        string? parentId,
        IReadOnlyDictionary<string, string> metadata,
        string targetSha256,
        string currentSha256)
        => string.Equals(currentSha256, targetSha256, StringComparison.OrdinalIgnoreCase)
           && string.Equals(entry.Title, request.Title.Trim(), StringComparison.Ordinal)
           && string.Equals(entry.Summary ?? string.Empty, request.Summary?.Trim() ?? string.Empty, StringComparison.Ordinal)
           && string.Equals(entry.ParentId, parentId, StringComparison.Ordinal)
           && string.Equals(entry.ContentType, entry.IsFolder ? "application/x-folder" : request.ContentType.Trim(), StringComparison.OrdinalIgnoreCase)
           && entry.FileSize == (entry.IsFolder ? 0 : System.Text.Encoding.UTF8.GetByteCount(request.Content ?? string.Empty))
           && entry.Tags.SequenceEqual(request.Tags ?? new List<string>())
           && string.Equals(entry.Category ?? string.Empty, request.Category?.Trim() ?? string.Empty, StringComparison.Ordinal)
           && entry.SortOrder == request.SortOrder
           && entry.Metadata.Count == metadata.Count
           && metadata.All(pair => entry.Metadata.TryGetValue(pair.Key, out var value) && value == pair.Value);

    private static (DocumentEntry? Parent, string? Error) ResolveParent(
        IReadOnlyList<DocumentEntry> all,
        string publisher,
        string? parentSourceId)
    {
        if (string.IsNullOrWhiteSpace(parentSourceId)) return (null, null);
        if (!DocumentStorePublisherPolicy.IsSafeToken(parentSourceId)) return (null, "parentSourceId 无效");
        var parents = all.Where(entry => entry.IsFolder
                                         && DocumentStorePublisherPolicy.IsManagedBy(entry.Metadata, publisher, parentSourceId)).ToList();
        return parents.Count == 1
            ? (parents[0], null)
            : (null, parents.Count == 0 ? "父目录 sourceId 不存在" : "父目录 sourceId 不唯一");
    }

    private async Task<DocumentStore?> LoadOwnedGenericStoreAsync(string storeId, CancellationToken ct)
    {
        var ownerId = GetBoundUserId();
        return await _db.DocumentStores.Find(store => store.Id == storeId
                                                      && store.OwnerId == ownerId
                                                      && store.PmProjectId == null
                                                      && store.ProductKnowledgeRef == null
                                                      && store.ShituCategoryRef == null)
            .FirstOrDefaultAsync(ct);
    }

    private string GetBoundUserId()
    {
        var userId = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(userId)) throw new UnauthorizedAccessException("Missing boundUserId claim");
        return userId;
    }

    private async Task<string?> ReadContentAsync(DocumentEntry entry)
    {
        if (!string.IsNullOrWhiteSpace(entry.DocumentId))
            return (await _documents.GetByIdAsync(entry.DocumentId))?.RawContent;
        if (!string.IsNullOrWhiteSpace(entry.AttachmentId))
            return (await _db.Attachments.Find(attachment => attachment.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync())?.ExtractedText;
        return null;
    }

    private async Task RefreshStoreCountAsync(string storeId)
    {
        var count = await _db.DocumentEntries.CountDocumentsAsync(entry => entry.StoreId == storeId);
        await _db.DocumentStores.UpdateOneAsync(
            store => store.Id == storeId,
            Builders<DocumentStore>.Update
                .Set(store => store.DocumentCount, (int)count)
                .Set(store => store.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
    }

    private async Task DeleteUnreferencedDocumentAsync(string documentId)
    {
        var references = await _db.DocumentEntries.CountDocumentsAsync(
            entry => entry.DocumentId == documentId,
            cancellationToken: CancellationToken.None);
        if (references == 0)
            await _db.Documents.DeleteOneAsync(document => document.Id == documentId, CancellationToken.None);
    }

    private static string DeterministicNodeId(string storeId, string publisher, string sourceId)
        => DocumentStorePublisherPolicy.Sha256($"{storeId}\n{publisher}\n{sourceId}")[..32];

    private static string? ValidatePutRequest(string sourceId, PublisherPutNodeRequest request)
    {
        if (!DocumentStorePublisherPolicy.IsSafeToken(sourceId)) return "sourceId 无效";
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.Publisher)) return "publisher 无效";
        if (!DocumentStorePublisherPolicy.IsSafeToken(request.RunId)) return "runId 无效";
        if (request.Kind is not ("folder" or "document")) return "kind 只能是 folder 或 document";
        if (string.IsNullOrWhiteSpace(request.Title)) return "title 不能为空";
        if (string.IsNullOrWhiteSpace(request.SourcePath)) return "sourcePath 不能为空";
        if (!DocumentStorePublisherPolicy.IsSha256(request.SourceSha256)) return "sourceSha256 无效";
        if (!DocumentStorePublisherPolicy.IsSha256(request.ManifestSha256)) return "manifestSha256 无效";
        if (!string.IsNullOrWhiteSpace(request.LastAppliedSha256)
            && !DocumentStorePublisherPolicy.IsSha256(request.LastAppliedSha256)) return "lastAppliedSha256 无效";
        if (string.IsNullOrWhiteSpace(request.SourceRevision)) return "sourceRevision 不能为空";
        if (request.SourcePath.Length > 2048) return "sourcePath 过长";
        if (request.SourceRevision.Length > 256) return "sourceRevision 过长";
        if (request.Kind == "document" && string.IsNullOrWhiteSpace(request.ContentType)) return "文档 contentType 不能为空";
        if (!DocumentStorePublisherPolicy.IsSafeMetadata(request.Metadata)) return "metadata 键值、数量或长度无效";
        if (request.Kind == "document" && System.Text.Encoding.UTF8.GetByteCount(request.Content ?? string.Empty) > 4 * 1024 * 1024)
            return "文档正文不能超过 4 MiB";
        return null;
    }

    private static string ComputeSnapshotSha256(DocumentStore store, IReadOnlyList<PublisherSnapshotNode> nodes)
    {
        var canonical = new
        {
            store.Id,
            store.Name,
            store.OwnerId,
            store.AppKey,
            store.IsPublic,
            store.PrimaryEntryId,
            updatedAt = store.UpdatedAt.ToUniversalTime().ToString("O"),
            nodes = nodes.OrderBy(node => node.Id, StringComparer.Ordinal).Select(node => new
            {
                node.Id,
                node.ParentId,
                node.IsFolder,
                node.Title,
                node.Summary,
                node.ContentType,
                node.Tags,
                node.Category,
                node.SortOrder,
                metadata = node.Metadata.OrderBy(pair => pair.Key, StringComparer.Ordinal),
                updatedAt = node.UpdatedAt.ToUniversalTime().ToString("O"),
                node.ContentSha256,
            }),
        };
        return DocumentStorePublisherPolicy.Sha256(JsonSerializer.Serialize(canonical));
    }

    private BadRequestObjectResult Invalid(string message)
        => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message));

    private ObjectResult ConflictResult(string message)
        => StatusCode(StatusCodes.Status409Conflict, ApiResponse<object>.Fail(ErrorCodes.STALE_UPDATE, message));

    private NotFoundObjectResult NotFoundResult()
        => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库或受管节点不存在"));
}

public sealed class PublisherPutNodeRequest
{
    public string Publisher { get; set; } = string.Empty;
    public string RunId { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Summary { get; set; }
    public string? ParentSourceId { get; set; }
    public string SourcePath { get; set; } = string.Empty;
    public string SourceSha256 { get; set; } = string.Empty;
    public string ManifestSha256 { get; set; } = string.Empty;
    public string SourceRevision { get; set; } = string.Empty;
    public string? LastAppliedSha256 { get; set; }
    public DateTime? ExpectedUpdatedAt { get; set; }
    public string ContentType { get; set; } = "text/markdown";
    public string? Content { get; set; }
    public List<string>? Tags { get; set; }
    public string? Category { get; set; }
    public double? SortOrder { get; set; }
    public Dictionary<string, string>? Metadata { get; set; }
}

public sealed class PublisherSetPrimaryRequest
{
    public string Publisher { get; set; } = string.Empty;
    public string SourceId { get; set; } = string.Empty;
    public DateTime ExpectedStoreUpdatedAt { get; set; }
}

public sealed class PublisherSnapshotNode
{
    public string Id { get; set; } = string.Empty;
    public string? ParentId { get; set; }
    public bool IsFolder { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Summary { get; set; }
    public string ContentType { get; set; } = string.Empty;
    public List<string> Tags { get; set; } = new();
    public string? Category { get; set; }
    public double? SortOrder { get; set; }
    public Dictionary<string, string> Metadata { get; set; } = new();
    public string MetadataSha256 { get; set; } = string.Empty;
    public string? SourceId { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? ContentSha256 { get; set; }
    public string? Content { get; set; }
    public bool Managed { get; set; }
}
