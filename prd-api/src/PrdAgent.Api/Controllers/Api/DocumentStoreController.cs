using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 文档空间 — 文档存储与知识管理基础设施
/// </summary>
[ApiController]
[Route("api/document-store")]
[Authorize]
[AdminController("document-store", AdminPermissionCatalog.DocumentStoreRead,
    WritePermission = AdminPermissionCatalog.DocumentStoreWrite)]
public class DocumentStoreController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<DocumentStoreController> _logger;

    public DocumentStoreController(MongoDbContext db, ILogger<DocumentStoreController> logger)
    {
        _db = db;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    // ─────────────────────────────────────────────
    // 文档空间 CRUD
    // ─────────────────────────────────────────────

    /// <summary>创建文档空间</summary>
    [HttpPost("stores")]
    public async Task<IActionResult> CreateStore([FromBody] CreateDocumentStoreRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "空间名称不能为空"));

        var userId = GetUserId();

        var store = new DocumentStore
        {
            Name = request.Name.Trim(),
            Description = request.Description?.Trim(),
            OwnerId = userId,
            AppKey = request.AppKey?.Trim(),
            Tags = request.Tags ?? new List<string>(),
            IsPublic = request.IsPublic
        };

        await _db.DocumentStores.InsertOneAsync(store);

        _logger.LogInformation("[document-store] Store created: {StoreId} '{Name}' by {UserId}",
            store.Id, store.Name, userId);

        return Ok(ApiResponse<DocumentStore>.Ok(store));
    }

    /// <summary>获取当前用户的文档空间列表</summary>
    [HttpGet("stores")]
    public async Task<IActionResult> ListStores([FromQuery] int page = 1, [FromQuery] int pageSize = 20)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var filter = Builders<DocumentStore>.Filter.Eq(s => s.OwnerId, userId);
        var total = await _db.DocumentStores.CountDocumentsAsync(filter);
        var items = await _db.DocumentStores.Find(filter)
            .SortByDescending(s => s.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>获取文档空间详情</summary>
    [HttpGet("stores/{storeId}")]
    public async Task<IActionResult> GetStore(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (store.OwnerId != userId && !store.IsPublic)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        return Ok(ApiResponse<DocumentStore>.Ok(store));
    }

    /// <summary>更新文档空间信息</summary>
    [HttpPut("stores/{storeId}")]
    public async Task<IActionResult> UpdateStore(string storeId, [FromBody] UpdateDocumentStoreRequest request)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        var updates = new List<UpdateDefinition<DocumentStore>>();

        if (request.Name != null)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.Name, request.Name.Trim()));
        if (request.Description != null)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.Description, request.Description.Trim()));
        if (request.Tags != null)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.Tags, request.Tags));
        if (request.IsPublic.HasValue)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.IsPublic, request.IsPublic.Value));

        updates.Add(Builders<DocumentStore>.Update.Set(s => s.UpdatedAt, DateTime.UtcNow));

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update.Combine(updates));

        var updated = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        return Ok(ApiResponse<DocumentStore>.Ok(updated!));
    }

    /// <summary>删除文档空间（同时删除空间内所有条目）</summary>
    [HttpDelete("stores/{storeId}")]
    public async Task<IActionResult> DeleteStore(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        // 删除空间内所有条目
        var deleteResult = await _db.DocumentEntries.DeleteManyAsync(e => e.StoreId == storeId);
        await _db.DocumentStores.DeleteOneAsync(s => s.Id == storeId);

        _logger.LogInformation("[document-store] Store deleted: {StoreId} with {Count} entries by {UserId}",
            storeId, deleteResult.DeletedCount, userId);

        return Ok(ApiResponse<object>.Ok(new { deletedEntries = deleteResult.DeletedCount }));
    }

    // ─────────────────────────────────────────────
    // 文档条目 CRUD
    // ─────────────────────────────────────────────

    /// <summary>向空间添加文档条目</summary>
    [HttpPost("stores/{storeId}/entries")]
    public async Task<IActionResult> AddEntry(string storeId, [FromBody] AddDocumentEntryRequest request)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档标题不能为空"));

        var entry = new DocumentEntry
        {
            StoreId = storeId,
            DocumentId = request.DocumentId,
            AttachmentId = request.AttachmentId,
            Title = request.Title.Trim(),
            Summary = request.Summary?.Trim(),
            SourceType = DocumentSourceType.All.Contains(request.SourceType ?? "")
                ? request.SourceType!
                : DocumentSourceType.Upload,
            ContentType = request.ContentType ?? string.Empty,
            FileSize = request.FileSize,
            Tags = request.Tags ?? new List<string>(),
            Metadata = request.Metadata ?? new Dictionary<string, string>(),
            CreatedBy = userId
        };

        await _db.DocumentEntries.InsertOneAsync(entry);

        // 更新空间文档计数
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[document-store] Entry added: {EntryId} to store {StoreId} by {UserId}",
            entry.Id, storeId, userId);

        return Ok(ApiResponse<DocumentEntry>.Ok(entry));
    }

    /// <summary>获取空间内的文档条目列表</summary>
    [HttpGet("stores/{storeId}/entries")]
    public async Task<IActionResult> ListEntries(
        string storeId,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? sourceType = null,
        [FromQuery] string? keyword = null)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (store.OwnerId != userId && !store.IsPublic)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var filterBuilder = Builders<DocumentEntry>.Filter;
        var filter = filterBuilder.Eq(e => e.StoreId, storeId);

        if (!string.IsNullOrWhiteSpace(sourceType))
            filter &= filterBuilder.Eq(e => e.SourceType, sourceType);

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = keyword.Trim();
            filter &= filterBuilder.Or(
                filterBuilder.Regex(e => e.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                filterBuilder.Regex(e => e.Summary, new MongoDB.Bson.BsonRegularExpression(kw, "i")));
        }

        var total = await _db.DocumentEntries.CountDocumentsAsync(filter);
        var items = await _db.DocumentEntries.Find(filter)
            .SortByDescending(e => e.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>获取文档条目详情</summary>
    [HttpGet("entries/{entryId}")]
    public async Task<IActionResult> GetEntry(string entryId)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 校验权限：确认用户有权访问该空间
        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null || (store.OwnerId != userId && !store.IsPublic))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        return Ok(ApiResponse<DocumentEntry>.Ok(entry));
    }

    /// <summary>更新文档条目信息</summary>
    [HttpPut("entries/{entryId}")]
    public async Task<IActionResult> UpdateEntry(string entryId, [FromBody] UpdateDocumentEntryRequest request)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var updates = new List<UpdateDefinition<DocumentEntry>>();

        if (request.Title != null)
            updates.Add(Builders<DocumentEntry>.Update.Set(e => e.Title, request.Title.Trim()));
        if (request.Summary != null)
            updates.Add(Builders<DocumentEntry>.Update.Set(e => e.Summary, request.Summary.Trim()));
        if (request.Tags != null)
            updates.Add(Builders<DocumentEntry>.Update.Set(e => e.Tags, request.Tags));
        if (request.Metadata != null)
            updates.Add(Builders<DocumentEntry>.Update.Set(e => e.Metadata, request.Metadata));

        updates.Add(Builders<DocumentEntry>.Update.Set(e => e.UpdatedAt, DateTime.UtcNow));

        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update.Combine(updates));

        var updated = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        return Ok(ApiResponse<DocumentEntry>.Ok(updated!));
    }

    /// <summary>删除文档条目</summary>
    [HttpDelete("entries/{entryId}")]
    public async Task<IActionResult> DeleteEntry(string entryId)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        await _db.DocumentEntries.DeleteOneAsync(e => e.Id == entryId);

        // 更新空间文档计数
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == entry.StoreId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, -1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[document-store] Entry deleted: {EntryId} from store {StoreId} by {UserId}",
            entryId, entry.StoreId, userId);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }
}

// ─────────────────────────────────────────────
// Request DTOs
// ─────────────────────────────────────────────

public class CreateDocumentStoreRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? AppKey { get; set; }
    public List<string>? Tags { get; set; }
    public bool IsPublic { get; set; }
}

public class UpdateDocumentStoreRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }
    public bool? IsPublic { get; set; }
}

public class AddDocumentEntryRequest
{
    public string? DocumentId { get; set; }
    public string? AttachmentId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Summary { get; set; }
    public string? SourceType { get; set; }
    public string? ContentType { get; set; }
    public long FileSize { get; set; }
    public List<string>? Tags { get; set; }
    public Dictionary<string, string>? Metadata { get; set; }
}

public class UpdateDocumentEntryRequest
{
    public string? Title { get; set; }
    public string? Summary { get; set; }
    public List<string>? Tags { get; set; }
    public Dictionary<string, string>? Metadata { get; set; }
}
