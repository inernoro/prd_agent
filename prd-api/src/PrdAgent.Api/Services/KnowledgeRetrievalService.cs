using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.LlmGateway;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

/// <summary>仅对用户选定的一个库按需增量索引；复用持久化 Run/Worker，不启动全库扫描。</summary>
public sealed class KnowledgeRetrievalService(MongoDbContext db, IDocumentService documents,
    IEmbeddingService embeddings, DocumentStoreReadAccess access, IConfiguration configuration,
    ILLMRequestContextAccessor contexts, ILlmGateway gateway)
{
    public const int MaxEntries = 100;
    public const int MaxChunks = 3000;
    public const int MaxChars = 1_000_000;
    public const int RefreshDeadlineSeconds = 120;

    public async Task RequireReadAsync(string storeId, string userId)
    {
        var store = await db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null || !await access.CanReadAsync(store, userId))
            throw new UnauthorizedAccessException("知识库不存在或无权访问");
    }

    private async Task<List<DocumentEmbedding>> ReadCurrentAsync(string storeId, string userId, string model)
    {
        await RequireReadAsync(storeId, userId); // 先 ACL，后加载任何正文
        var entries = await db.DocumentEntries.Find(e => e.StoreId == storeId && !e.IsFolder)
            .SortBy(e => e.Id).Limit(MaxEntries + 1).ToListAsync();
        if (entries.Count > MaxEntries) throw new KnowledgeRetrievalException($"知识库超过 {MaxEntries} 篇，请缩小知识库后重试");
        var rows = new List<DocumentEmbedding>();
        var chars = 0;
        foreach (var entry in entries)
        {
            string? text = null;
            if (!string.IsNullOrEmpty(entry.DocumentId)) text = (await documents.GetByIdAsync(entry.DocumentId))?.RawContent;
            if (string.IsNullOrWhiteSpace(text) && !string.IsNullOrEmpty(entry.AttachmentId))
                text = (await db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync())?.ExtractedText;
            // ContentIndex 只是 2000 字预览，不得作为正文替代。
            if (string.IsNullOrWhiteSpace(text)) continue;
            chars += text.Length;
            if (chars > MaxChars) throw new KnowledgeRetrievalException("知识库正文超出单次检索容量，请缩小知识库");
            foreach (var (chunk, index) in DocumentChunker.Split(text).Select((t, i) => (t, i)))
            {
                if (rows.Count == MaxChunks) throw new KnowledgeRetrievalException("知识库切块超出单次检索容量");
                rows.Add(new DocumentEmbedding { StoreId = storeId, EntryId = entry.Id, EntryTitle = entry.Title,
                    ChunkIndex = index, Text = chunk, Model = model,
                    ContentHash = DocumentChunker.ComputeHash(chunk, model), DeploymentSlug = DeploymentScope.CurrentDurable });
            }
        }
        return rows;
    }

    public async Task IndexAsync(DocumentStoreAgentRun run)
    {
        var timer = Stopwatch.StartNew();
        await RequireReadAsync(run.StoreId, run.UserId);
        using var scope = contexts.BeginScope(new LlmRequestContext(Guid.NewGuid().ToString("N"), null,
            run.Id, run.UserId, null, null, null, "knowledge-index", "embedding", AppCallerRegistry.Admin.KnowledgeBase.Index));
        var model = await embeddings.ResolveActiveModelAsync(AppCallerRegistry.Admin.KnowledgeBase.Index);
        if (string.IsNullOrWhiteSpace(model)) throw new KnowledgeRetrievalException("NO_EMBEDDING_MODEL：请在统一模型网关配置知识库索引与检索的 embedding 模型");
        var rows = await ReadCurrentAsync(run.StoreId, run.UserId, model);
        var previous = await db.DocumentEmbeddings.Find(x => x.StoreId == run.StoreId
            && x.DeploymentSlug == DeploymentScope.CurrentDurable && x.Model == model).Limit(MaxChunks * 3).ToListAsync();
        var cache = previous.GroupBy(x => x.ContentHash).ToDictionary(g => g.Key, g => g.First());
        foreach (var row in rows)
        {
            row.IndexRunId = run.Id;
            if (cache.TryGetValue(row.ContentHash, out var old)) { row.Vector = old.Vector; row.Dimension = old.Dimension; }
        }
        var missing = rows.Where(x => x.Vector.Length == 0).ToArray();
        foreach (var batch in missing.Chunk(64))
        {
            await RequireReadAsync(run.StoreId, run.UserId);
            var result = await embeddings.EmbedAsync(batch.Select(x => x.Text).ToArray(),
                AppCallerRegistry.Admin.KnowledgeBase.Index, run.UserId);
            if (!result.Success) throw new KnowledgeRetrievalException($"{result.ErrorCode}：{result.Error}");
            if (result.Model != model) throw new KnowledgeRetrievalException("向量模型发生变化，请在统一网关核对索引与查询使用同一模型");
            for (var i = 0; i < batch.Length; i++)
            { batch[i].Vector = EmbeddingVector.Encode(result.Vectors[i]); batch[i].Dimension = result.Dimension; }
        }
        await RequireReadAsync(run.StoreId, run.UserId);
        if (rows.Count > 0) await db.DocumentEmbeddings.InsertManyAsync(rows, cancellationToken: CancellationToken.None);
        // 新快照已完整写入后才回收更早快照；并发读取缺行会失败关闭，不混用代次。
        await db.DocumentEmbeddings.DeleteManyAsync(x => x.StoreId == run.StoreId
            && x.DeploymentSlug == DeploymentScope.CurrentDurable && x.CreatedAt < run.CreatedAt && x.IndexRunId != run.Id,
            CancellationToken.None);
        await AnswerAsync(run, rows, (int)timer.ElapsedMilliseconds);
    }

    public async Task<KnowledgeSearchResult> SearchAsync(string storeId, string userId, string question)
    {
        try
        {
            // 等待超时只结束观察，不取消已经持久化的 Worker 或数据库写入。
            return await SearchCoreAsync(storeId, userId, question)
                .WaitAsync(TimeSpan.FromSeconds(RefreshDeadlineSeconds));
        }
        catch (TimeoutException)
        {
            throw new KnowledgeRetrievalException("知识库问答超过 120 秒，本次不使用旧结果，请稍后重试");
        }
    }

    private async Task<KnowledgeSearchResult> SearchCoreAsync(string storeId, string userId, string question)
    {
        var timer = Stopwatch.StartNew();
        await RequireReadAsync(storeId, userId);
        var run = new DocumentStoreAgentRun { Kind = DocumentStoreAgentRunKind.KnowledgeIndex,
            StoreId = storeId, UserId = userId, OwnerInstanceId = InstanceIdentity.Get(configuration),
            CustomPrompt = question,
            TaskPermitId = TaskExecutionContext.Current?.PermitId, Status = DocumentStoreRunStatus.Queued };
        await db.DocumentStoreAgentRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        while (timer.Elapsed.TotalSeconds < RefreshDeadlineSeconds)
        {
            var current = await db.DocumentStoreAgentRuns.Find(r => r.Id == run.Id).FirstOrDefaultAsync();
            if (current?.Status == DocumentStoreRunStatus.Failed) throw new KnowledgeRetrievalException(current.ErrorMessage ?? "索引失败");
            if (current?.Status == DocumentStoreRunStatus.Done)
            {
                var result = JsonSerializer.Deserialize<KnowledgeSearchResult>(current.GeneratedText ?? "null")
                    ?? throw new KnowledgeRetrievalException("检索任务没有返回结果");
                await ValidateAsync(storeId, userId, result.Hits);
                return result;
            }
            await Task.Delay(500);
        }
        throw new KnowledgeRetrievalException("知识库问答超过 120 秒，本次不使用旧结果，请稍后重试");
    }

    private async Task AnswerAsync(DocumentStoreAgentRun run, IReadOnlyList<DocumentEmbedding> rows, int refreshMs)
    {
        await RequireReadAsync(run.StoreId, run.UserId);
        var timer = Stopwatch.StartNew();
        var query = await embeddings.EmbedAsync(new[] { run.CustomPrompt ?? "" }, AppCallerRegistry.Admin.KnowledgeBase.Query, run.UserId);
        if (!query.Success) throw new KnowledgeRetrievalException($"{query.ErrorCode}：{query.Error}");
        if (rows.Any(x => !EmbeddingVector.IsCompatible(x.Model, x.Dimension, query.Model, query.Dimension)))
            throw new KnowledgeRetrievalException("索引与查询的向量模型或维度不一致，请在统一网关修正绑定");
        var hits = KnowledgeRetrieval.Rank(rows, query);
        await ValidateAsync(run.StoreId, run.UserId, hits);
        var retrievalMs = refreshMs + (int)timer.ElapsedMilliseconds;
        var selection = new StringBuilder();
        string? model = null, platform = null;
        if (hits.Count > 0)
        {
            var requestId = Guid.NewGuid().ToString("N");
            using var context = contexts.BeginScope(new LlmRequestContext(requestId, null, run.Id,
                run.UserId, null, hits.Sum(x => x.Text.Length), null, "knowledge-excerpts", "chat", AppCallerRegistry.Admin.WebHosting.Ask));
            var request = new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.Admin.WebHosting.Ask, ModelType = ModelTypes.Chat, Stream = true,
                Context = new GatewayRequestContext { RequestId = requestId, SessionId = run.Id, UserId = run.UserId },
                RequestBody = new JsonObject
                {
                    ["temperature"] = 0, ["max_tokens"] = 64,
                    ["messages"] = new JsonArray
                    {
                        new JsonObject { ["role"] = "system", ["content"] = KnowledgeRetrieval.Prompt(hits) },
                        new JsonObject { ["role"] = "user", ["content"] = run.CustomPrompt },
                    },
                },
            };
            await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                { model = chunk.Resolution.ActualModel; platform = chunk.Resolution.ActualPlatformName; }
                else if (chunk.Type == GatewayChunkType.Text) selection.Append(chunk.Content);
                else if (chunk.Type == GatewayChunkType.Error)
                    throw GatewayRouteFailureException.FromChunk(new LLMStreamChunk { Type = "error", ErrorCode = chunk.ErrorCode,
                        ErrorMessage = chunk.Error ?? chunk.Content }, "知识核对模型调用失败");
            }
            if (selection.Length == 0) throw new KnowledgeRetrievalException("知识核对模型未返回内容");
        }
        await ValidateAsync(run.StoreId, run.UserId, hits);
        var result = new KnowledgeSearchResult(hits, retrievalMs, selection.ToString(), model, platform);
        await db.DocumentStoreAgentRuns.UpdateOneAsync(r => r.Id == run.Id && r.ExecutionId == run.ExecutionId,
            Builders<DocumentStoreAgentRun>.Update.Set(r => r.GeneratedText, JsonSerializer.Serialize(result)),
            cancellationToken: CancellationToken.None);
    }

    public async Task ValidateAsync(string storeId, string userId, IReadOnlyList<KnowledgeHit> hits)
    {
        await RequireReadAsync(storeId, userId);
        if (hits.Count == 0) return;
        var current = await ReadCurrentAsync(storeId, userId, hits[0].Model);
        if (hits.Any(h => !current.Any(x => x.EntryId == h.EntryId && x.ChunkIndex == h.ChunkIndex && x.ContentHash == h.Hash)))
            throw new KnowledgeRetrievalException("引用原文已更新或删除，本次回答已停止，请重新提问");
    }
}

public sealed record KnowledgeSearchResult(IReadOnlyList<KnowledgeHit> Hits, int RetrievalMs,
    string Selection, string? Model, string? Platform);

public sealed class KnowledgeRetrievalException(string message) : Exception(message);
