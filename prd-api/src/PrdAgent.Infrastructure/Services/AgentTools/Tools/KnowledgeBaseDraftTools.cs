using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using KnowledgeBaseStore = PrdAgent.Core.Models.DocumentStore;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class KbDraftCreateTool : IAgentTool
{
    private readonly MongoDbContext _db;

    public KbDraftCreateTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_draft_create",
        Description = "创建知识库改写草稿。只写 knowledge_base_drafts，不覆盖正式知识库条目。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["entryId", "contentDraft"],
          "properties": {
            "entryId": { "type": "string", "description": "基于哪个知识库条目创建草稿。" },
            "titleDraft": { "type": "string", "description": "可选。草稿标题。" },
            "contentDraft": { "type": "string", "description": "草稿正文。只写草稿集合，不覆盖原文。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var user = await KnowledgeBaseReadonlyToolSupport.ResolveSessionUserAsync(_db, context, ct);
        if (user == null) return AgentToolInvokeResult.Fail("kb_user_context_required", "kb_draft_create requires an infra agent session user context");

        var entryId = KnowledgeBaseReadonlyToolSupport.GetString(input, "entryId");
        if (string.IsNullOrWhiteSpace(entryId))
            return AgentToolInvokeResult.Fail("kb_entry_id_required", "entryId is required");

        var contentDraft = KnowledgeBaseReadonlyToolSupport.GetString(input, "contentDraft");
        if (string.IsNullOrWhiteSpace(contentDraft))
            return AgentToolInvokeResult.Fail("kb_draft_content_required", "contentDraft is required");

        var entry = await _db.DocumentEntries.Find(x => x.Id == entryId).FirstOrDefaultAsync(ct);
        if (entry == null || entry.IsFolder)
            return AgentToolInvokeResult.Fail("kb_entry_not_found", "knowledge base entry not found or not draftable");

        var store = await KnowledgeBaseReadonlyToolSupport.FindAccessibleStoreAsync(_db, entry.StoreId, user.UserId, ct);
        if (store == null)
            return AgentToolInvokeResult.Fail("kb_entry_not_found", "knowledge base entry not found or not accessible");

        var baseContent = await KnowledgeBaseDraftToolSupport.ReadEntryContentAsync(_db, entry, ct);
        if (string.IsNullOrWhiteSpace(baseContent.Content))
            return AgentToolInvokeResult.Fail("kb_entry_content_missing", "entry has no readable text content to draft against");

        var now = DateTime.UtcNow;
        var draft = new KnowledgeBaseDraft
        {
            SessionId = user.Id,
            StoreId = store.Id,
            EntryId = entry.Id,
            BaseDocumentId = entry.DocumentId,
            BaseContentHash = KnowledgeBaseDraftToolSupport.ComputeContentHash(baseContent.Content),
            BaseUpdatedAt = entry.UpdatedAt,
            TitleDraft = KnowledgeBaseReadonlyToolSupport.GetString(input, "titleDraft") ?? entry.Title,
            ContentDraft = contentDraft,
            Status = KnowledgeBaseDraftStatuses.Draft,
            CreatedBy = user.UserId,
            CreatedAt = now,
            UpdatedAt = now
        };

        await _db.KnowledgeBaseDrafts.InsertOneAsync(draft, cancellationToken: ct);

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            draft = KnowledgeBaseDraftToolSupport.ToDraftView(draft, store, entry),
            baseContent = new
            {
                title = baseContent.Title ?? entry.Title,
                hash = draft.BaseContentHash,
                updatedAt = draft.BaseUpdatedAt,
                charCount = baseContent.Content.Length
            },
            readonlyOriginalPreserved = true
        }));
    }
}

public sealed class KbDraftReadTool : IAgentTool
{
    private readonly MongoDbContext _db;

    public KbDraftReadTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_draft_read",
        Description = "读取当前会话用户拥有的知识库草稿，不读取或修改正式知识库正文。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["draftId"],
          "properties": {
            "draftId": { "type": "string", "description": "知识库草稿 ID。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var loaded = await KnowledgeBaseDraftToolSupport.LoadOwnedDraftAsync(_db, input, context, ct);
        if (!loaded.Success) return loaded.Error!;

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            draft = KnowledgeBaseDraftToolSupport.ToDraftView(loaded.Draft!, loaded.Store!, loaded.Entry!),
            contentDraft = loaded.Draft!.ContentDraft,
            readonlyOriginalPreserved = true
        }));
    }
}

public sealed class KbDraftListTool : IAgentTool
{
    private readonly MongoDbContext _db;

    public KbDraftListTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_draft_list",
        Description = "列出当前会话用户创建的知识库草稿。只读草稿集合。",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "entryId": { "type": "string", "description": "可选。只列出某个知识库条目的草稿。" },
            "sessionOnly": { "type": "boolean", "description": "可选。true 时只列出当前 Agent session 创建的草稿。" },
            "status": { "type": "string", "description": "可选。draft/applied/rejected/discarded/apply_failed。" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "可选。返回数量上限，默认 50。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var user = await KnowledgeBaseReadonlyToolSupport.ResolveSessionUserAsync(_db, context, ct);
        if (user == null) return AgentToolInvokeResult.Fail("kb_user_context_required", "kb_draft_list requires an infra agent session user context");

        var filterBuilder = Builders<KnowledgeBaseDraft>.Filter;
        var filter = filterBuilder.Eq(x => x.CreatedBy, user.UserId);

        var entryId = KnowledgeBaseReadonlyToolSupport.GetString(input, "entryId");
        if (!string.IsNullOrWhiteSpace(entryId))
            filter &= filterBuilder.Eq(x => x.EntryId, entryId);

        if (KnowledgeBaseReadonlyToolSupport.GetBool(input, "sessionOnly", false))
            filter &= filterBuilder.Eq(x => x.SessionId, user.Id);

        var status = KnowledgeBaseReadonlyToolSupport.GetString(input, "status");
        if (!string.IsNullOrWhiteSpace(status))
        {
            if (!KnowledgeBaseDraftStatuses.All.Contains(status, StringComparer.OrdinalIgnoreCase))
                return AgentToolInvokeResult.Fail("kb_draft_status_invalid", "invalid draft status");
            filter &= filterBuilder.Eq(x => x.Status, status);
        }

        var limit = KnowledgeBaseReadonlyToolSupport.ClampInt(input, "limit", 50, 1, 100);
        var drafts = await _db.KnowledgeBaseDrafts.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            total = drafts.Count,
            items = drafts.Select(KnowledgeBaseDraftToolSupport.ToDraftView)
        }));
    }
}

public sealed class KbDraftDiscardTool : IAgentTool
{
    private readonly MongoDbContext _db;

    public KbDraftDiscardTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_draft_discard",
        Description = "丢弃当前会话用户拥有的知识库草稿。只更新草稿状态，不修改正式知识库。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["draftId"],
          "properties": {
            "draftId": { "type": "string", "description": "知识库草稿 ID。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var loaded = await KnowledgeBaseDraftToolSupport.LoadOwnedDraftAsync(_db, input, context, ct);
        if (!loaded.Success) return loaded.Error!;

        var draft = loaded.Draft!;
        if (!string.Equals(draft.Status, KnowledgeBaseDraftStatuses.Draft, StringComparison.OrdinalIgnoreCase))
            return AgentToolInvokeResult.Fail("kb_draft_not_active", "only active drafts can be discarded");

        var now = DateTime.UtcNow;
        var result = await _db.KnowledgeBaseDrafts.UpdateOneAsync(
            x => x.Id == draft.Id && x.CreatedBy == draft.CreatedBy && x.Status == KnowledgeBaseDraftStatuses.Draft,
            Builders<KnowledgeBaseDraft>.Update
                .Set(x => x.Status, KnowledgeBaseDraftStatuses.Discarded)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        if (result.ModifiedCount == 0)
            return AgentToolInvokeResult.Fail("kb_draft_discard_failed", "draft was not discarded");

        draft.Status = KnowledgeBaseDraftStatuses.Discarded;
        draft.UpdatedAt = now;
        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            draft = KnowledgeBaseDraftToolSupport.ToDraftView(draft, loaded.Store!, loaded.Entry!),
            readonlyOriginalPreserved = true
        }));
    }
}

public static class KnowledgeBaseDraftToolSupport
{
    public static string ComputeContentHash(string content)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public static async Task<EntryContentSnapshot> ReadEntryContentAsync(MongoDbContext db, DocumentEntry entry, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(entry.DocumentId))
        {
            var doc = await db.Documents.Find(x => x.Id == entry.DocumentId).FirstOrDefaultAsync(ct);
            if (doc != null)
                return new EntryContentSnapshot(doc.RawContent, doc.Title);
        }

        if (!string.IsNullOrWhiteSpace(entry.AttachmentId))
        {
            var attachment = await db.Attachments.Find(x => x.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync(ct);
            if (attachment != null)
                return new EntryContentSnapshot(attachment.ExtractedText ?? string.Empty, attachment.FileName);
        }

        return new EntryContentSnapshot(string.Empty, entry.Title);
    }

    public static async Task<LoadedDraft> LoadOwnedDraftAsync(MongoDbContext db, JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var user = await KnowledgeBaseReadonlyToolSupport.ResolveSessionUserAsync(db, context, ct);
        if (user == null)
            return LoadedDraft.Fail(AgentToolInvokeResult.Fail("kb_user_context_required", "draft tool requires an infra agent session user context"));

        var draftId = KnowledgeBaseReadonlyToolSupport.GetString(input, "draftId");
        if (string.IsNullOrWhiteSpace(draftId))
            return LoadedDraft.Fail(AgentToolInvokeResult.Fail("kb_draft_id_required", "draftId is required"));

        var draft = await db.KnowledgeBaseDrafts.Find(x => x.Id == draftId && x.CreatedBy == user.UserId).FirstOrDefaultAsync(ct);
        if (draft == null)
            return LoadedDraft.Fail(AgentToolInvokeResult.Fail("kb_draft_not_found", "knowledge base draft not found or not accessible"));

        var entry = await db.DocumentEntries.Find(x => x.Id == draft.EntryId).FirstOrDefaultAsync(ct);
        var store = await KnowledgeBaseReadonlyToolSupport.FindAccessibleStoreAsync(db, draft.StoreId, user.UserId, ct);
        if (entry == null || store == null)
            return LoadedDraft.Fail(AgentToolInvokeResult.Fail("kb_draft_source_missing", "draft source entry or store is missing"));

        return LoadedDraft.Ok(draft, store, entry);
    }

    public static object ToDraftView(KnowledgeBaseDraft draft) => new
    {
        draftId = draft.Id,
        sessionId = draft.SessionId,
        storeId = draft.StoreId,
        entryId = draft.EntryId,
        baseDocumentId = draft.BaseDocumentId,
        baseContentHash = draft.BaseContentHash,
        baseUpdatedAt = draft.BaseUpdatedAt,
        titleDraft = draft.TitleDraft,
        status = draft.Status,
        createdBy = draft.CreatedBy,
        applyApprovalId = draft.ApplyApprovalId,
        createdAt = draft.CreatedAt,
        updatedAt = draft.UpdatedAt,
        appliedAt = draft.AppliedAt
    };

    public static object ToDraftView(KnowledgeBaseDraft draft, KnowledgeBaseStore store, DocumentEntry entry) => new
    {
        draftId = draft.Id,
        sessionId = draft.SessionId,
        storeId = draft.StoreId,
        storeName = store.Name,
        entryId = draft.EntryId,
        entryTitle = entry.Title,
        baseDocumentId = draft.BaseDocumentId,
        baseContentHash = draft.BaseContentHash,
        baseUpdatedAt = draft.BaseUpdatedAt,
        titleDraft = draft.TitleDraft,
        status = draft.Status,
        createdBy = draft.CreatedBy,
        applyApprovalId = draft.ApplyApprovalId,
        createdAt = draft.CreatedAt,
        updatedAt = draft.UpdatedAt,
        appliedAt = draft.AppliedAt,
        source = new
        {
            kind = "knowledge_base_draft",
            uri = $"kb://stores/{draft.StoreId}/entries/{draft.EntryId}/drafts/{draft.Id}",
            storeId = draft.StoreId,
            storeName = store.Name,
            entryId = draft.EntryId,
            title = draft.TitleDraft ?? entry.Title
        }
    };

    public sealed record EntryContentSnapshot(string Content, string? Title);

    public sealed class LoadedDraft
    {
        public bool Success { get; private init; }
        public KnowledgeBaseDraft? Draft { get; private init; }
        public KnowledgeBaseStore? Store { get; private init; }
        public DocumentEntry? Entry { get; private init; }
        public AgentToolInvokeResult? Error { get; private init; }

        public static LoadedDraft Ok(KnowledgeBaseDraft draft, KnowledgeBaseStore store, DocumentEntry entry) =>
            new() { Success = true, Draft = draft, Store = store, Entry = entry };

        public static LoadedDraft Fail(AgentToolInvokeResult error) =>
            new() { Success = false, Error = error };
    }
}
