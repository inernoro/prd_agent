using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AgentTools.Tools;
using KnowledgeStore = PrdAgent.Core.Models.DocumentStore;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// Existing ChatAgent worker tools call this bounded index/search path. No global scan,
/// model configuration, background reindex, or database index is created here.
/// </summary>
public sealed class KnowledgeRetrievalService
{
    public const int MaxCandidateChunks = 5000;
    public const int MaxIndexChunks = EmbeddingService.MaxBatchSize;
    // Operational starting point only; quality requires evaluation with the bound real model.
    public const double MinimumScore = 0.35;
    private readonly MongoDbContext _db;
    private readonly IEmbeddingService _embedding;
    private readonly ILLMRequestContextAccessor _context;

    public KnowledgeRetrievalService(MongoDbContext db, IEmbeddingService embedding,
        ILLMRequestContextAccessor context)
    {
        _db = db;
        _embedding = embedding;
        _context = context;
    }

    public async Task<AgentToolInvokeResult> IndexEntryAsync(string entryId, string userId, CancellationToken ct, string? expectedSourceHash = null)
    {
        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(entryId))
            return AgentToolInvokeResult.Fail("kb_identity_required", "索引需要明确的用户与单篇文档");
        var entry = await _db.DocumentEntries.Find(x => x.Id == entryId).FirstOrDefaultAsync(ct);
        var store = entry == null ? null : await _db.DocumentStores
            .Find(x => x.Id == entry.StoreId && x.OwnerId == userId).FirstOrDefaultAsync(ct);
        if (entry == null || store == null || entry.IsFolder)
            return AgentToolInvokeResult.Fail("kb_entry_not_found", "文档不存在或不属于当前用户");
        var content = await ReadContentAsync(entry, ct);
        if (expectedSourceHash is not null && expectedSourceHash != DocumentChunker.ComputeHash(content, string.Empty))
            return AgentToolInvokeResult.Fail("KB_INDEX_SOURCE_CHANGED", "正文已变化，本次旧保存许可未调用向量模型");
        var chunks = DocumentChunker.Split(content);
        if (chunks.Count == 0) return AgentToolInvokeResult.Fail("kb_content_empty", "该文档没有可索引正文");
        if (chunks.Count > MaxIndexChunks)
            return AgentToolInvokeResult.Fail("kb_index_scope_too_large", $"单篇最多 {MaxIndexChunks} 块，请先拆分文档；未调用模型");

        using var scope = BeginModelScope(userId, AppCallerRegistry.Admin.KnowledgeBase.Index);
        var model = await _embedding.ResolveActiveModelAsync(AppCallerRegistry.Admin.KnowledgeBase.Index, ct);
        if (string.IsNullOrWhiteSpace(model))
            return AgentToolInvokeResult.Fail("NO_EMBEDDING_MODEL", "统一模型网关未接入可用的 embedding 模型，无法验证语义效果");
        var rows = await _db.DocumentEmbeddings.Find(x => x.EntryId == entryId
            && x.StoreId == store.Id && x.DeploymentSlug == DeploymentScope.Current)
            .Limit(MaxCandidateChunks + 1).ToListAsync(ct);
        if (rows.Count > MaxCandidateChunks)
            return AgentToolInvokeResult.Fail("kb_index_scope_too_large", "该篇历史索引超过容量，请先维护索引；未调用向量化");
        var missing = chunks.Select((text, index) => (text, index, hash: DocumentChunker.ComputeHash(text, model)))
            .Where(chunk => !rows.Any(row => row.ChunkIndex == chunk.index && row.ContentHash == chunk.hash
                && row.Model == model && row.Dimension > 0 && row.Vector.Length == row.Dimension * sizeof(float)))
            .ToList();
        EmbeddingBatch? batch = null;
        if (missing.Count > 0)
        {
            batch = await _embedding.EmbedAsync(missing.Select(x => x.text).ToList(),
                AppCallerRegistry.Admin.KnowledgeBase.Index, userId, CancellationToken.None);
            if (!batch.Success) return AgentToolInvokeResult.Fail(batch.ErrorCode ?? "UPSTREAM_ERROR", batch.Error ?? "向量化失败");
            if (!string.Equals(batch.Model, model, StringComparison.Ordinal) || batch.Vectors.Count != missing.Count)
                return AgentToolInvokeResult.Fail("kb_embedding_model_changed", "建索引期间模型发生变化，未写入，请核对网关绑定");
        }
        // A long upstream call must not publish an obsolete snapshot. Immutable chunk IDs also
        // prevent a late writer from overwriting a different generation after this check.
        var current = await _db.DocumentEntries.Find(x => x.Id == entryId && x.StoreId == store.Id).FirstOrDefaultAsync(CancellationToken.None);
        var stillOwned = await _db.DocumentStores.Find(x => x.Id == store.Id && x.OwnerId == userId).AnyAsync(CancellationToken.None);
        if (current == null || current.IsFolder || !stillOwned || await ReadContentAsync(current, CancellationToken.None) != content)
            return AgentToolInvokeResult.Fail("kb_entry_changed", "文档或权限已变化，本次未发布索引，请重新索引这篇文档");
        for (var i = 0; i < missing.Count; i++)
        {
            var chunk = missing[i];
            var row = new DocumentEmbedding
            {
                Id = ChunkId(DeploymentScope.Current, store.Id, entry.Id, chunk.index, chunk.hash),
                StoreId = store.Id, EntryId = entry.Id, EntryTitle = current.Title,
                ChunkIndex = chunk.index, Text = chunk.text, ContentHash = chunk.hash,
                Model = batch!.Model, Dimension = batch.Dimension,
                Vector = EmbeddingVector.Encode(batch.Vectors[i]), DeploymentSlug = DeploymentScope.Current
            };
            await _db.DocumentEmbeddings.ReplaceOneAsync(x => x.Id == row.Id, row,
                new ReplaceOptions { IsUpsert = true }, CancellationToken.None);
        }
        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            mode = "index", entryId, total = chunks.Count, indexedChunks = missing.Count,
            reusedChunks = chunks.Count - missing.Count, model,
            source = KnowledgeBaseReadonlyToolSupport.ToSource(store, current),
            freshness = "更新和删除提交后，下一次检索回读原文并排除旧块；新增正文需要显式索引该篇文档"
        }));
    }

    public async Task<AgentToolInvokeResult> SearchAsync(string query, string? storeId, string userId,
        int limit, CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(query) || query.Length > 2000)
            return AgentToolInvokeResult.Fail("kb_query_required", "检索需要明确用户与 1 至 2000 字的问题");
        var stores = await KnowledgeBaseReadonlyToolSupport.ResolveSearchStoresAsync(_db, userId, storeId, ct);
        if (stores.Count == 0) return SearchResult(query, Array.Empty<KnowledgeRetrievalHit>(), watch.ElapsedMilliseconds);
        if (stores.Count >= 200 && string.IsNullOrWhiteSpace(storeId))
            return AgentToolInvokeResult.Fail("kb_search_scope_too_large", "可访问知识库达到作用域上限，请指定单个知识库检索");
        var storeIds = stores.Select(x => x.Id).ToList();
        // Bound the read before bringing vectors into process memory, including obsolete rows.
        var rows = await _db.DocumentEmbeddings.Find(x => storeIds.Contains(x.StoreId)
            && x.DeploymentSlug == DeploymentScope.Current).Limit(MaxCandidateChunks + 1).ToListAsync(ct);
        if (rows.Count > MaxCandidateChunks)
            return AgentToolInvokeResult.Fail("kb_search_scope_too_large", $"作用域超过 {MaxCandidateChunks} 个索引块，请缩小到单库或维护索引；未调用模型");
        if (rows.Count == 0)
            return AgentToolInvokeResult.Fail("kb_index_not_ready", "当前可访问范围没有语义索引；请明确选择自有单篇文档入库，不会自动重建全库");
        using var scope = BeginModelScope(userId, AppCallerRegistry.Admin.KnowledgeBase.Query);
        var batch = await _embedding.EmbedAsync(new[] { query }, AppCallerRegistry.Admin.KnowledgeBase.Query,
            userId, CancellationToken.None);
        if (!batch.Success) return AgentToolInvokeResult.Fail(batch.ErrorCode ?? "UPSTREAM_ERROR", batch.Error ?? "问题向量化失败");
        if (batch.Vectors.Count != 1)
            return AgentToolInvokeResult.Fail("UPSTREAM_ERROR", "问题向量返回数量错误");
        if (!rows.Any(row => EmbeddingVector.IsCompatible(row.Model, row.Dimension, batch.Model, batch.Dimension)))
            return AgentToolInvokeResult.Fail("kb_index_model_mismatch", "当前查询模型与索引不兼容，请核对网关绑定并显式重新索引选定文档");

        // Recheck ACL and current content AFTER the upstream wait, before any source text is
        // released to the answer model. Deleted and modified chunks are never answer context.
        stores = await KnowledgeBaseReadonlyToolSupport.ResolveSearchStoresAsync(_db, userId, storeId, ct);
        storeIds = stores.Select(x => x.Id).ToList();
        var entryIds = rows.Select(x => x.EntryId).Distinct().ToList();
        var entries = await _db.DocumentEntries.Find(x => entryIds.Contains(x.Id)
            && storeIds.Contains(x.StoreId) && !x.IsFolder).ToListAsync(ct);
        var documents = new List<KnowledgeRetrievalDocument>();
        var storeById = stores.ToDictionary(x => x.Id, StringComparer.Ordinal);
        foreach (var entry in entries)
            documents.Add(new KnowledgeRetrievalDocument(storeById[entry.StoreId], entry, await ReadContentAsync(entry, ct)));
        var currentHashes = documents.ToDictionary(doc => doc.Entry.Id, doc =>
            (storeId: doc.Store.Id, hashes: DocumentChunker.Split(doc.Content)
                .Select(text => DocumentChunker.ComputeHash(text, batch.Model)).ToHashSet()));
        // Only reveal counts for entries that still exist and remain accessible now.
        var staleChunks = rows.Count(row => currentHashes.TryGetValue(row.EntryId, out var current)
            && current.storeId == row.StoreId && !current.hashes.Contains(row.ContentHash));
        var hits = RankCurrent(rows, documents, userId, batch.Model, batch.Vectors[0], limit, DeploymentScope.Current);
        return SearchResult(query, hits, watch.ElapsedMilliseconds, staleChunks, batch.Model, batch.Dimension);
    }

    /// <summary>Shared runtime ranking boundary, testable without a model or database.</summary>
    public static IReadOnlyList<KnowledgeRetrievalHit> RankCurrent(IEnumerable<DocumentEmbedding> rows,
        IEnumerable<KnowledgeRetrievalDocument> documents, string userId, string model, float[] query,
        int limit, string? deploymentSlug)
    {
        var current = documents.Where(x => x.Store.Id == x.Entry.StoreId && !x.Entry.IsFolder
                && (x.Store.OwnerId == userId || x.Store.IsPublic))
            .ToDictionary(x => x.Entry.Id, StringComparer.Ordinal);
        var hashes = current.ToDictionary(x => x.Key,
            x => DocumentChunker.Split(x.Value.Content).Select(text => DocumentChunker.ComputeHash(text, model)).ToHashSet());
        return rows.Where(row => row.DeploymentSlug == deploymentSlug
                && EmbeddingVector.IsCompatible(row.Model, row.Dimension, model, query.Length)
                && row.Vector.Length == row.Dimension * sizeof(float)
                && current.TryGetValue(row.EntryId, out var doc) && doc.Entry.StoreId == row.StoreId
                && hashes[row.EntryId].Contains(row.ContentHash)
                && DocumentChunker.ComputeHash(row.Text, model) == row.ContentHash)
            .Select(row => new KnowledgeRetrievalHit(current[row.EntryId].Store, current[row.EntryId].Entry,
                row.Text, EmbeddingVector.Cosine(EmbeddingVector.Decode(row.Vector), query)))
            .Where(hit => double.IsFinite(hit.Score) && hit.Score >= MinimumScore)
            .OrderByDescending(hit => hit.Score).ThenBy(hit => hit.Entry.Id, StringComparer.Ordinal)
            .GroupBy(hit => hit.Entry.Id).Select(group => group.First()).Take(Math.Clamp(limit, 1, 50)).ToList();
    }

    private static AgentToolInvokeResult SearchResult(string query, IReadOnlyList<KnowledgeRetrievalHit> hits, long elapsed, int staleChunks = 0,
        string? embeddingModel = null, int? embeddingDimension = null)
        => AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            query, mode = "semantic", readonlyAccess = true, total = hits.Count,
            embeddingModel, embeddingDimension,
            retrievalLatencyMs = elapsed, staleChunks,
            indexWarning = staleChunks > 0 ? "已排除旧版索引块；若新正文未命中，请明确选择该篇文档重新索引，不会自动建库" : null,
            contextEntryIds = hits.Select(x => x.Entry.Id),
            minimumScore = MinimumScore, thresholdCalibrated = false,
            freshness = "每次回读权限与原文；更新和删除提交后的下一次检索排除失效块；新内容需单篇索引",
            answerInstruction = hits.Count == 0 ? "没有找到依据，请明确回答知识库中未找到答案" : "仅按命中原文作答，逐项引用 source.uri；相似度不代表答案充分，不得补写无依据事实",
            items = hits.Select(hit => new
            {
                entry = KnowledgeBaseReadonlyToolSupport.ToEntryView(hit.Store, hit.Entry),
                snippet = hit.Text, source = KnowledgeBaseReadonlyToolSupport.ToSource(hit.Store, hit.Entry), score = hit.Score
            })
        }));

    private IDisposable BeginModelScope(string userId, string caller)
    {
        var current = _context.Current;
        var next = current == null
            ? new LlmRequestContext(Guid.NewGuid().ToString("N"), null, null, userId, null, null, null, null,
                AppCallerCode: caller)
            : current with { UserId = userId, AppCallerCode = caller };
        return _context.BeginScope(next);
    }

    private async Task<string> ReadContentAsync(DocumentEntry entry, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(entry.DocumentId))
        {
            var doc = await _db.Documents.Find(x => x.Id == entry.DocumentId).FirstOrDefaultAsync(ct);
            if (!string.IsNullOrWhiteSpace(doc?.RawContent)) return doc.RawContent;
        }
        if (!string.IsNullOrWhiteSpace(entry.AttachmentId))
        {
            var attachment = await _db.Attachments.Find(x => x.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync(ct);
            if (!string.IsNullOrWhiteSpace(attachment?.ExtractedText)) return attachment.ExtractedText;
        }
        return string.Empty;
    }

    private static string ChunkId(string? scope, string storeId, string entryId, int index, string hash)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new object?[] { scope, storeId, entryId, index, hash })))).ToLowerInvariant();
}

public sealed record KnowledgeRetrievalDocument(KnowledgeStore Store, DocumentEntry Entry, string Content);
public sealed record KnowledgeRetrievalHit(KnowledgeStore Store, DocumentEntry Entry, string Text, double Score);
