using MongoDB.Driver;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

/// <summary>仅人工保存已明确选择索引的自有单篇文档；不扫描全库，不续用首次索引许可。</summary>
public sealed class KnowledgeIndexRefreshQueue(MongoDbContext db, IConfiguration configuration)
{
    public const int TargetSeconds = 120;

    public Task<bool> ShouldRefreshAsync(DocumentEntry entry, DocumentStore store, string userId)
        => store.OwnerId != userId || entry.IsFolder
            ? Task.FromResult(false)
            : db.DocumentEmbeddings.Find(row => row.EntryId == entry.Id && row.StoreId == store.Id
                && row.DeploymentSlug == DeploymentScope.Current).AnyAsync(CancellationToken.None);

    public async Task<KnowledgeIndexRefreshStatus> EnqueueAsync(DocumentEntry entry, string documentId,
        DateTime updatedAt, string userId, string permitId)
    {
        if (string.IsNullOrWhiteSpace(permitId))
            throw new InvalidOperationException("索引刷新缺少本次保存的新任务许可");
        // Bind the task to the saved immutable body, not the submitted text: parsing may
        // canonicalize line endings before persistence. Read this save's exact document ID
        // rather than a later entry revision that could consume the wrong save's permit.
        var savedDocument = await db.Documents.Find(document => document.Id == documentId)
            .FirstOrDefaultAsync(CancellationToken.None)
            ?? throw new KnowledgeIndexRefreshException("KB_INDEX_SOURCE_MISSING", "已保存正文未确认，未创建索引刷新任务");
        var content = savedDocument.RawContent;
        var run = new DocumentStoreAgentRun
        {
            Id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(permitId + "\0" + entry.Id)))[..32].ToLowerInvariant(),
            Kind = DocumentStoreAgentRunKind.KnowledgeIndex,
            SourceEntryId = entry.Id, StoreId = entry.StoreId, UserId = userId,
            SourceDocumentId = documentId, SourceUpdatedAt = updatedAt,
            SourceContentHash = DocumentChunker.ComputeHash(content, string.Empty),
            TaskPermitId = permitId, OwnerInstanceId = InstanceIdentity.Get(configuration),
            Phase = "正文已保存，检索索引等待刷新", Status = DocumentStoreRunStatus.Queued
        };
        var existing = await db.DocumentStoreAgentRuns.Find(row => row.Id == run.Id)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (existing is not null) return await ReuseAsync(existing, run);
        try { await db.DocumentStoreAgentRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None); }
        catch (MongoException)
        {
            // Unknown insert receipts are reconciled by exact ID, never blindly resent.
            var persisted = await db.DocumentStoreAgentRuns.Find(row => row.Id == run.Id
                && row.TaskPermitId == permitId && row.UserId == userId).FirstOrDefaultAsync(CancellationToken.None);
            if (persisted is null) throw;
            return await ReuseAsync(persisted, run);
        }
        return Describe(run, true, false, DateTime.UtcNow);
    }

    public async Task<KnowledgeIndexRefreshStatus> GetStatusAsync(DocumentEntry entry, string userId)
    {
        var ownerIds = InstanceIdentity.GetCompatibleOwnerIds(configuration);
        var run = await db.DocumentStoreAgentRuns.Find(row => row.Kind == DocumentStoreAgentRunKind.KnowledgeIndex
            && row.SourceEntryId == entry.Id && row.StoreId == entry.StoreId && row.UserId == userId
            && ownerIds.Contains(row.OwnerInstanceId!))
            .SortByDescending(row => row.CreatedAt).FirstOrDefaultAsync(CancellationToken.None);
        var rows = await db.DocumentEmbeddings.Find(row => row.EntryId == entry.Id && row.StoreId == entry.StoreId
            && row.DeploymentSlug == DeploymentScope.Current)
            .Limit(KnowledgeRetrievalService.MaxCandidateChunks + 1).ToListAsync(CancellationToken.None);
        if (rows.Count == 0)
            return new("not_indexed", null, null, TargetSeconds, null, false, null, null,
                "该文档尚未选择建立语义索引", false);
        var content = await ReadContentAsync(db, entry);
        var chunks = DocumentChunker.Split(content);
        var fresh = chunks.Count > 0 && rows.Count <= KnowledgeRetrievalService.MaxCandidateChunks
            && rows.Where(row => row.Dimension > 0 && row.Vector.Length == row.Dimension * sizeof(float))
                .GroupBy(row => (row.Model, row.Dimension)).Any(group => chunks.All(text => group.Any(row =>
                    row.ContentHash == DocumentChunker.ComputeHash(text, group.Key.Model) && row.Text == text)));
        var sameSource = run is not null && MatchesSource(run, entry, content);
        if (run is null || !sameSource)
            return new(fresh ? "ready" : "stale", null, entry.UpdatedAt, TargetSeconds, null, false, null, null,
                fresh ? "当前正文的检索索引已更新" : "当前正文的索引已过期；旧内容已排除，请由库主保存或明确重新索引该篇文档", false);
        return Describe(run!, true, fresh, DateTime.UtcNow);
    }

    private async Task<KnowledgeIndexRefreshStatus> ReuseAsync(DocumentStoreAgentRun existing, DocumentStoreAgentRun requested)
    {
        if (existing.TaskPermitId != requested.TaskPermitId || existing.UserId != requested.UserId
            || existing.SourceEntryId != requested.SourceEntryId || existing.StoreId != requested.StoreId
            || existing.SourceContentHash != requested.SourceContentHash)
            throw new KnowledgeIndexRefreshException("KB_INDEX_INTENT_MISMATCH", "同一次保存的索引任务参数发生变化，未新增收费任务");
        var current = await db.DocumentEntries.Find(row => row.Id == requested.SourceEntryId && row.StoreId == requested.StoreId)
            .FirstOrDefaultAsync(CancellationToken.None);
        return current is null ? Describe(existing, false, false, DateTime.UtcNow)
            : await GetStatusAsync(current, requested.UserId);
    }

    public static bool MatchesSource(DocumentStoreAgentRun run, DocumentEntry entry, string content)
        => run.SourceEntryId == entry.Id && run.StoreId == entry.StoreId
            && run.SourceContentHash == DocumentChunker.ComputeHash(content, string.Empty);

    public static KnowledgeIndexRefreshStatus Describe(DocumentStoreAgentRun run, bool sameSource, bool fresh, DateTime now)
    {
        var pending = sameSource && run.Status is DocumentStoreRunStatus.Queued or DocumentStoreRunStatus.Running;
        var targetAt = run.CreatedAt.AddSeconds(TargetSeconds);
        var delayed = pending && now > targetAt;
        var status = !sameSource ? "stale" : pending ? "pending"
            : fresh ? "ready"
            : run.Status is DocumentStoreRunStatus.Failed or DocumentStoreRunStatus.Cancelled ? "failed" : "stale";
        var message = status switch
        {
            "pending" when delayed => "索引刷新已超过120秒目标，任务仍在等待或处理；不会自动重复调用模型",
            "pending" => "正文已保存，正在刷新检索索引；正常目标为120秒内完成",
            "ready" => "当前正文的检索索引已更新",
            "failed" => "正文已保存，但索引刷新失败；旧内容已排除，请核对原因后明确重新索引",
            _ => "当前正文尚未完成索引，旧内容已排除"
        };
        return new(status, run.Id, run.SourceUpdatedAt, TargetSeconds, targetAt, delayed,
            status == "ready" ? null : run.FailureCode, status == "ready" ? null : run.ErrorMessage, message, pending);
    }

    internal static async Task<string> ReadContentAsync(MongoDbContext db, DocumentEntry entry)
    {
        if (!string.IsNullOrWhiteSpace(entry.DocumentId))
        {
            var doc = await db.Documents.Find(row => row.Id == entry.DocumentId).FirstOrDefaultAsync(CancellationToken.None);
            if (!string.IsNullOrWhiteSpace(doc?.RawContent)) return doc.RawContent;
        }
        if (!string.IsNullOrWhiteSpace(entry.AttachmentId))
        {
            var attachment = await db.Attachments.Find(row => row.AttachmentId == entry.AttachmentId)
                .FirstOrDefaultAsync(CancellationToken.None);
            return attachment?.ExtractedText ?? string.Empty;
        }
        return string.Empty;
    }
}

public sealed record KnowledgeIndexRefreshStatus(string Status, string? RunId, DateTime? SourceUpdatedAt,
    int TargetSeconds, DateTime? TargetAt, bool Delayed, string? FailureCode, string? ErrorMessage,
    string DisplayMessage, bool PollingRecommended);

public sealed class KnowledgeIndexRefreshException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>由已有知识库Agent Worker领取新任务许可后运行；不额外调度或自动重试模型。</summary>
public sealed class KnowledgeIndexRefreshProcessor(MongoDbContext db, KnowledgeRetrievalService retrieval,
    ILLMRequestContextAccessor context, IConfiguration configuration)
{
    public async Task ProcessAsync(DocumentStoreAgentRun run)
    {
        if (string.IsNullOrWhiteSpace(run.TaskPermitId) || TaskExecutionContext.Current is not { Lease: not null } identity
            || identity.PermitId != run.TaskPermitId || identity.RunId != run.Id)
            throw new KnowledgeIndexRefreshException("TASK_EXECUTION_LEASE_REQUIRED", "刷新缺少有效的新任务执行租约，未调用模型");
        await RequireCurrentSourceAsync(run);
        using var llmScope = context.BeginScope(new LlmRequestContext(run.Id, null, run.Id, run.UserId, null,
            null, null, "[KNOWLEDGE_INDEX_REFRESH]", AppCallerCode: AppCallerRegistry.Admin.KnowledgeBase.Index,
            RunId: run.Id, TenantId: configuration["LlmGateway:InternalTenantId"]));
        var result = await retrieval.IndexEntryAsync(run.SourceEntryId, run.UserId, CancellationToken.None,
            expectedSourceHash: run.SourceContentHash);
        if (!result.Success)
            throw new KnowledgeIndexRefreshException(result.ErrorCode ?? "KB_INDEX_REFRESH_FAILED", result.Message ?? "索引刷新失败");
        await RequireCurrentSourceAsync(run);
        await db.DocumentStoreAgentRuns.UpdateOneAsync(row => row.Id == run.Id && row.ExecutionId == run.ExecutionId
            && row.Status == DocumentStoreRunStatus.Running && row.TaskPermitId == run.TaskPermitId,
            Builders<DocumentStoreAgentRun>.Update.Set(row => row.GeneratedText, result.Content),
            cancellationToken: CancellationToken.None);
    }

    private async Task RequireCurrentSourceAsync(DocumentStoreAgentRun run)
    {
        var entry = await db.DocumentEntries.Find(row => row.Id == run.SourceEntryId && row.StoreId == run.StoreId)
            .FirstOrDefaultAsync(CancellationToken.None);
        var owned = await db.DocumentStores.Find(row => row.Id == run.StoreId && row.OwnerId == run.UserId)
            .AnyAsync(CancellationToken.None);
        if (entry is null || !owned || !KnowledgeIndexRefreshQueue.MatchesSource(run, entry,
                await KnowledgeIndexRefreshQueue.ReadContentAsync(db, entry)))
            throw new KnowledgeIndexRefreshException("KB_INDEX_SOURCE_CHANGED", "正文或归属已变化，本次旧刷新已停止；不会覆盖新版本索引");
    }
}
