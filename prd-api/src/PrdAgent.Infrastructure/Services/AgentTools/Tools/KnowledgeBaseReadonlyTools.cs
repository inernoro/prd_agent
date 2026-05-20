using System.Text.Json;
using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using KnowledgeBaseStore = PrdAgent.Core.Models.DocumentStore;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class KbListTool : IAgentTool
{
    private readonly MongoDbContext _db;

    public KbListTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_list",
        Description = "只读列出当前 Agent 会话用户可访问的知识库空间，或列出指定知识库空间内的条目。",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "storeId": { "type": "string", "description": "可选。指定后列出该知识库空间下的条目；不指定则列出知识库空间。" },
            "parentId": { "type": "string", "description": "可选。列出指定父文件夹下的条目；空值表示根级。" },
            "all": { "type": "boolean", "description": "可选。true 时忽略 parentId，列出空间内全部条目。" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "可选。返回数量上限，默认 50。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var user = await KnowledgeBaseReadonlyToolSupport.ResolveSessionUserAsync(_db, context, ct);
        if (user == null) return AgentToolInvokeResult.Fail("kb_user_context_required", "kb_list requires an infra agent session user context");

        var limit = KnowledgeBaseReadonlyToolSupport.ClampInt(input, "limit", 50, 1, 200);
        var storeId = KnowledgeBaseReadonlyToolSupport.GetString(input, "storeId");
        if (string.IsNullOrWhiteSpace(storeId))
        {
            var stores = await _db.DocumentStores.Find(KnowledgeBaseReadonlyToolSupport.AccessibleStoreFilter(user.UserId))
                .SortByDescending(x => x.UpdatedAt)
                .Limit(limit)
                .ToListAsync(ct);

            return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
            {
                mode = "stores",
                readonlyAccess = true,
                total = stores.Count,
                items = stores.Select(KnowledgeBaseReadonlyToolSupport.ToStoreView)
            }));
        }

        var store = await KnowledgeBaseReadonlyToolSupport.FindAccessibleStoreAsync(_db, storeId, user.UserId, ct);
        if (store == null) return AgentToolInvokeResult.Fail("kb_store_not_found", "knowledge base store not found or not accessible");

        var filterBuilder = Builders<DocumentEntry>.Filter;
        var filter = filterBuilder.Eq(x => x.StoreId, store.Id);
        var all = KnowledgeBaseReadonlyToolSupport.GetBool(input, "all", false);
        if (!all)
        {
            var parentId = KnowledgeBaseReadonlyToolSupport.GetString(input, "parentId");
            filter &= string.IsNullOrWhiteSpace(parentId)
                ? filterBuilder.Or(filterBuilder.Eq(x => x.ParentId, null), filterBuilder.Exists(x => x.ParentId, false))
                : filterBuilder.Eq(x => x.ParentId, parentId);
        }

        var entries = await _db.DocumentEntries.Find(filter)
            .SortByDescending(x => x.IsFolder)
            .ThenByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            mode = "entries",
            readonlyAccess = true,
            store = KnowledgeBaseReadonlyToolSupport.ToStoreView(store),
            total = entries.Count,
            items = entries.Select(entry => KnowledgeBaseReadonlyToolSupport.ToEntryView(store, entry))
        }));
    }
}

public sealed class KbSearchTool : IAgentTool
{
    private readonly MongoDbContext _db;

    public KbSearchTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_search",
        Description = "只读搜索当前 Agent 会话用户可访问的知识库条目，返回可追溯的知识库引用来源。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["query"],
          "properties": {
            "query": { "type": "string", "description": "搜索关键词，按字面量匹配标题、摘要和内容索引。" },
            "storeId": { "type": "string", "description": "可选。限制在指定知识库空间内搜索。" },
            "searchContent": { "type": "boolean", "description": "可选。是否搜索 ContentIndex，默认 true。" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "可选。返回数量上限，默认 20。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var query = KnowledgeBaseReadonlyToolSupport.GetString(input, "query");
        if (string.IsNullOrWhiteSpace(query))
            return AgentToolInvokeResult.Fail("kb_query_required", "query is required");

        var user = await KnowledgeBaseReadonlyToolSupport.ResolveSessionUserAsync(_db, context, ct);
        if (user == null) return AgentToolInvokeResult.Fail("kb_user_context_required", "kb_search requires an infra agent session user context");

        var storeId = KnowledgeBaseReadonlyToolSupport.GetString(input, "storeId");
        var stores = await KnowledgeBaseReadonlyToolSupport.ResolveSearchStoresAsync(_db, user.UserId, storeId, ct);
        if (stores.Count == 0) return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new { query, readonlyAccess = true, total = 0, items = Array.Empty<object>() }));

        var limit = KnowledgeBaseReadonlyToolSupport.ClampInt(input, "limit", 20, 1, 50);
        var escaped = Regex.Escape(query.Trim());
        var regex = new BsonRegularExpression(escaped, "i");
        var filterBuilder = Builders<DocumentEntry>.Filter;
        var searchFilters = new List<FilterDefinition<DocumentEntry>>
        {
            filterBuilder.Regex(x => x.Title, regex),
            filterBuilder.Regex(x => x.Summary, regex)
        };
        if (KnowledgeBaseReadonlyToolSupport.GetBool(input, "searchContent", true))
            searchFilters.Add(filterBuilder.Regex(x => x.ContentIndex, regex));

        var storeById = stores.ToDictionary(x => x.Id, StringComparer.OrdinalIgnoreCase);
        var filter = filterBuilder.In(x => x.StoreId, storeById.Keys)
                     & filterBuilder.Or(searchFilters);
        var entries = await _db.DocumentEntries.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .ToListAsync(ct);

        var items = entries
            .Where(x => storeById.ContainsKey(x.StoreId))
            .Select(entry =>
            {
                var store = storeById[entry.StoreId];
                return new
                {
                    entry = KnowledgeBaseReadonlyToolSupport.ToEntryView(store, entry),
                    snippet = KnowledgeBaseReadonlyToolSupport.BuildSnippet(entry, query),
                    source = KnowledgeBaseReadonlyToolSupport.ToSource(store, entry)
                };
            });

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            query,
            readonlyAccess = true,
            total = entries.Count,
            items
        }));
    }
}

public sealed class KbReadTool : IAgentTool
{
    private readonly MongoDbContext _db;

    public KbReadTool(MongoDbContext db) => _db = db;

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_read",
        Description = "只读读取当前 Agent 会话用户可访问的知识库条目正文，返回截断信息和引用来源。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["entryId"],
          "properties": {
            "entryId": { "type": "string", "description": "知识库条目 ID。" },
            "maxChars": { "type": "integer", "minimum": 1, "maximum": 60000, "description": "可选。正文最大返回字符数，默认 12000。" }
          }
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var entryId = KnowledgeBaseReadonlyToolSupport.GetString(input, "entryId");
        if (string.IsNullOrWhiteSpace(entryId))
            return AgentToolInvokeResult.Fail("kb_entry_id_required", "entryId is required");

        var user = await KnowledgeBaseReadonlyToolSupport.ResolveSessionUserAsync(_db, context, ct);
        if (user == null) return AgentToolInvokeResult.Fail("kb_user_context_required", "kb_read requires an infra agent session user context");

        var entry = await _db.DocumentEntries.Find(x => x.Id == entryId).FirstOrDefaultAsync(ct);
        if (entry == null) return AgentToolInvokeResult.Fail("kb_entry_not_found", "knowledge base entry not found or not accessible");

        var store = await KnowledgeBaseReadonlyToolSupport.FindAccessibleStoreAsync(_db, entry.StoreId, user.UserId, ct);
        if (store == null) return AgentToolInvokeResult.Fail("kb_entry_not_found", "knowledge base entry not found or not accessible");

        var maxChars = KnowledgeBaseReadonlyToolSupport.ClampInt(input, "maxChars", 12000, 1, 60000);
        string? content = null;
        string? title = null;
        int? tokenEstimate = null;
        int? charCount = null;
        string? fileUrl = null;

        if (!string.IsNullOrWhiteSpace(entry.DocumentId))
        {
            var doc = await _db.Documents.Find(x => x.Id == entry.DocumentId).FirstOrDefaultAsync(ct);
            if (doc != null)
            {
                content = doc.RawContent;
                title = doc.Title;
                tokenEstimate = doc.TokenEstimate;
                charCount = doc.CharCount;
            }
        }

        if (string.IsNullOrWhiteSpace(content) && !string.IsNullOrWhiteSpace(entry.AttachmentId))
        {
            var attachment = await _db.Attachments.Find(x => x.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync(ct);
            if (attachment != null)
            {
                content = attachment.ExtractedText;
                title = attachment.FileName;
                fileUrl = attachment.Url;
                charCount = content?.Length;
            }
        }

        var truncated = false;
        if (content != null && content.Length > maxChars)
        {
            content = content[..maxChars];
            truncated = true;
        }

        return AgentToolInvokeResult.Ok(JsonSerializer.Serialize(new
        {
            readonlyAccess = true,
            entry = KnowledgeBaseReadonlyToolSupport.ToEntryView(store, entry),
            title = title ?? entry.Title,
            content,
            hasContent = !string.IsNullOrWhiteSpace(content),
            truncated,
            maxChars,
            charCount,
            tokenEstimate,
            contentType = entry.ContentType,
            fileUrl,
            source = KnowledgeBaseReadonlyToolSupport.ToSource(store, entry)
        }));
    }
}

public static class KnowledgeBaseReadonlyToolSupport
{
    public static async Task<InfraAgentSession?> ResolveSessionUserAsync(MongoDbContext db, AgentToolInvocationContext context, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(context.InfraAgentSessionId))
            return null;
        return await db.InfraAgentSessions.Find(x => x.Id == context.InfraAgentSessionId).FirstOrDefaultAsync(ct);
    }

    public static FilterDefinition<KnowledgeBaseStore> AccessibleStoreFilter(string userId)
    {
        var filterBuilder = Builders<KnowledgeBaseStore>.Filter;
        return filterBuilder.Or(
            filterBuilder.Eq(x => x.OwnerId, userId),
            filterBuilder.Eq(x => x.IsPublic, true));
    }

    public static async Task<KnowledgeBaseStore?> FindAccessibleStoreAsync(MongoDbContext db, string storeId, string userId, CancellationToken ct)
    {
        var filter = Builders<KnowledgeBaseStore>.Filter.Eq(x => x.Id, storeId)
                     & AccessibleStoreFilter(userId);
        return await db.DocumentStores.Find(filter).FirstOrDefaultAsync(ct);
    }

    public static async Task<List<KnowledgeBaseStore>> ResolveSearchStoresAsync(MongoDbContext db, string userId, string? storeId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(storeId))
        {
            var store = await FindAccessibleStoreAsync(db, storeId, userId, ct);
            return store == null ? new List<KnowledgeBaseStore>() : new List<KnowledgeBaseStore> { store };
        }

        return await db.DocumentStores.Find(AccessibleStoreFilter(userId))
            .SortByDescending(x => x.UpdatedAt)
            .Limit(200)
            .ToListAsync(ct);
    }

    public static object ToStoreView(KnowledgeBaseStore store) => new
    {
        storeId = store.Id,
        name = store.Name,
        description = store.Description,
        isPublic = store.IsPublic,
        documentCount = store.DocumentCount,
        tags = store.Tags,
        primaryEntryId = store.PrimaryEntryId,
        updatedAt = store.UpdatedAt
    };

    public static object ToEntryView(KnowledgeBaseStore store, DocumentEntry entry) => new
    {
        entryId = entry.Id,
        storeId = store.Id,
        storeName = store.Name,
        parentId = entry.ParentId,
        isFolder = entry.IsFolder,
        title = entry.Title,
        summary = entry.Summary,
        contentType = entry.ContentType,
        sourceType = entry.SourceType,
        fileSize = entry.FileSize,
        tags = entry.Tags,
        updatedAt = entry.UpdatedAt,
        source = ToSource(store, entry)
    };

    public static object ToSource(KnowledgeBaseStore store, DocumentEntry entry) => new
    {
        kind = "knowledge_base",
        uri = $"kb://stores/{store.Id}/entries/{entry.Id}",
        storeId = store.Id,
        storeName = store.Name,
        entryId = entry.Id,
        title = entry.Title
    };

    public static string BuildSnippet(DocumentEntry entry, string query)
    {
        var text = FirstNonBlank(entry.ContentIndex, entry.Summary, entry.Title);
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;

        var index = text.IndexOf(query, StringComparison.OrdinalIgnoreCase);
        if (index < 0) return Truncate(text.Trim(), 240);

        var start = Math.Max(0, index - 80);
        var length = Math.Min(text.Length - start, query.Length + 180);
        var snippet = text.Substring(start, length).Trim();
        return (start > 0 ? "..." : "") + Truncate(snippet, 260) + (start + length < text.Length ? "..." : "");
    }

    public static string? GetString(JsonElement input, string name)
    {
        if (input.ValueKind != JsonValueKind.Object || !input.TryGetProperty(name, out var prop))
            return null;
        return prop.ValueKind == JsonValueKind.String ? prop.GetString()?.Trim() : null;
    }

    public static bool GetBool(JsonElement input, string name, bool fallback)
    {
        if (input.ValueKind != JsonValueKind.Object || !input.TryGetProperty(name, out var prop))
            return fallback;
        return prop.ValueKind == JsonValueKind.True || (prop.ValueKind != JsonValueKind.False && fallback);
    }

    public static int ClampInt(JsonElement input, string name, int fallback, int min, int max)
    {
        if (input.ValueKind == JsonValueKind.Object
            && input.TryGetProperty(name, out var prop)
            && prop.ValueKind == JsonValueKind.Number
            && prop.TryGetInt32(out var value))
            return Math.Clamp(value, min, max);
        return Math.Clamp(fallback, min, max);
    }

    private static string? FirstNonBlank(params string?[] values) =>
        values.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];
}
