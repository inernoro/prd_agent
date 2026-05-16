using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using DocStoreServices = PrdAgent.Infrastructure.Services.DocumentStore;

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
    private readonly IAssetStorage _assetStorage;
    private readonly IFileContentExtractor _fileContentExtractor;
    private readonly IDocumentService _documentService;
    private readonly IRunEventStore _runEventStore;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly ILogger<DocumentStoreController> _logger;

    /// <summary>20 MB per file</summary>
    private const long MaxUploadBytes = 20 * 1024 * 1024;

    /// <summary>访问去重窗口（分钟）：同一访客在此窗口内重复打开/刷新同一文档只算一次访问</summary>
    private const int ViewDedupWindowMinutes = 30;

    private static readonly System.Text.Json.JsonSerializerOptions AgentRunJsonOptions = new()
    {
        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
    };

    public DocumentStoreController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        IFileContentExtractor fileContentExtractor,
        IDocumentService documentService,
        IRunEventStore runEventStore,
        ISafeOutboundUrlValidator urlValidator,
        ILogger<DocumentStoreController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _fileContentExtractor = fileContentExtractor;
        _documentService = documentService;
        _runEventStore = runEventStore;
        _urlValidator = urlValidator;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private async Task<User?> FindUserByAnyIdAsync(string userId)
    {
        return await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
    }

    /// <summary>
    /// 推断上传文件的 MIME。浏览器对 m4a/mp4/某些 wav 经常报 application/octet-stream，
    /// 必须按扩展名兜底，否则 LocalAssetStorage 会把音频强存为 .png。
    /// </summary>
    private static string InferMime(string? contentType, string? fileName)
    {
        var mime = contentType?.ToLowerInvariant() ?? "application/octet-stream";
        if ((mime == "application/octet-stream" || string.IsNullOrWhiteSpace(mime)) && !string.IsNullOrWhiteSpace(fileName))
        {
            var ext = Path.GetExtension(fileName).ToLowerInvariant();
            mime = ext switch
            {
                ".md" or ".mdc" => "text/markdown",
                ".txt" => "text/plain",
                ".pdf" => "application/pdf",
                ".doc" => "application/msword",
                ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".ppt" => "application/vnd.ms-powerpoint",
                ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                ".xls" => "application/vnd.ms-excel",
                ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ".json" => "application/json",
                ".yaml" or ".yml" => "text/yaml",
                ".csv" => "text/csv",
                ".xml" => "application/xml",
                ".html" or ".htm" => "text/html",
                ".mp3" => "audio/mpeg",
                ".m4a" => "audio/mp4",
                ".wav" => "audio/wav",
                ".aac" => "audio/aac",
                ".ogg" or ".oga" => "audio/ogg",
                ".flac" => "audio/flac",
                ".weba" => "audio/webm",
                ".mp4" => "video/mp4",
                ".webm" => "video/webm",
                ".mov" => "video/quicktime",
                ".mkv" => "video/x-matroska",
                ".avi" => "video/x-msvideo",
                ".png" => "image/png",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".gif" => "image/gif",
                ".webp" => "image/webp",
                ".svg" => "image/svg+xml",
                _ => mime,
            };
        }
        return mime;
    }

    private async Task<(string userId, string userName)> GetActorInfoAsync()
    {
        var userId = GetUserId();
        var user = await FindUserByAnyIdAsync(userId);
        var userName = user != null && !string.IsNullOrWhiteSpace(user.DisplayName)
            ? user.DisplayName
            : (user?.Username ?? "未知用户");
        return (userId, userName);
    }

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

    /// <summary>设置/清除主文档</summary>
    [HttpPut("stores/{storeId}/primary-entry")]
    public async Task<IActionResult> SetPrimaryEntry(string storeId, [FromBody] SetPrimaryEntryRequest request)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        // 如果设置主文档，校验条目存在且属于该空间
        if (!string.IsNullOrEmpty(request.EntryId))
        {
            var entry = await _db.DocumentEntries.Find(
                e => e.Id == request.EntryId && e.StoreId == storeId).FirstOrDefaultAsync();
            if (entry == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在或不属于此空间"));
        }

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Set(s => s.PrimaryEntryId, string.IsNullOrEmpty(request.EntryId) ? null : request.EntryId)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[document-store] Primary entry set: store={StoreId} entry={EntryId} by {UserId}",
            storeId, request.EntryId ?? "(cleared)", userId);

        return Ok(ApiResponse<object>.Ok(new { primaryEntryId = request.EntryId }));
    }

    /// <summary>删除文档空间（级联清理所有关联数据）</summary>
    [HttpDelete("stores/{storeId}")]
    public async Task<IActionResult> DeleteStore(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        // 1) 先拿到所有条目，收集正文/附件 ID 列表
        var entries = await _db.DocumentEntries.Find(e => e.StoreId == storeId).ToListAsync();
        var documentIds = entries.Where(e => !string.IsNullOrEmpty(e.DocumentId)).Select(e => e.DocumentId!).ToList();
        var attachmentIds = entries.Where(e => !string.IsNullOrEmpty(e.AttachmentId)).Select(e => e.AttachmentId!).ToList();

        // 2) 级联清理关联数据（顺序不敏感，失败任何一步都不回滚——MongoDB 无事务）
        var entriesResult = await _db.DocumentEntries.DeleteManyAsync(e => e.StoreId == storeId);
        var syncLogsResult = await _db.DocumentSyncLogs.DeleteManyAsync(l => l.StoreId == storeId);
        var likesResult = await _db.DocumentStoreLikes.DeleteManyAsync(l => l.StoreId == storeId);
        var favoritesResult = await _db.DocumentStoreFavorites.DeleteManyAsync(f => f.StoreId == storeId);
        var shareLinksResult = await _db.DocumentStoreShareLinks.DeleteManyAsync(s => s.StoreId == storeId);
        var viewEventsResult = await _db.DocumentStoreViewEvents.DeleteManyAsync(v => v.StoreId == storeId);
        var inlineCommentsResult = await _db.DocumentInlineComments.DeleteManyAsync(c => c.StoreId == storeId);
        var agentRunsResult = await _db.DocumentStoreAgentRuns.DeleteManyAsync(r => r.StoreId == storeId);

        // 正文：只有通过此 Store 关联的 ParsedPrd 才删（其他模块可能也引用 documents 集合，所以按 ID 列表删）
        long documentsDeleted = 0;
        if (documentIds.Count > 0)
        {
            var res = await _db.Documents.DeleteManyAsync(d => documentIds.Contains(d.Id));
            documentsDeleted = res.DeletedCount;
        }

        // 附件
        long attachmentsDeleted = 0;
        if (attachmentIds.Count > 0)
        {
            var res = await _db.Attachments.DeleteManyAsync(a => attachmentIds.Contains(a.AttachmentId));
            attachmentsDeleted = res.DeletedCount;
        }

        // 3) 最后删 store 自身
        await _db.DocumentStores.DeleteOneAsync(s => s.Id == storeId);

        _logger.LogInformation(
            "[document-store] Store cascaded deleted: {StoreId} by {UserId} | entries={Entries} syncLogs={Logs} docs={Docs} attachments={Atts} likes={Likes} favorites={Favs} shareLinks={Links} views={Views} inlineComments={Comments} agentRuns={Runs}",
            storeId, userId, entriesResult.DeletedCount, syncLogsResult.DeletedCount,
            documentsDeleted, attachmentsDeleted,
            likesResult.DeletedCount, favoritesResult.DeletedCount, shareLinksResult.DeletedCount,
            viewEventsResult.DeletedCount, inlineCommentsResult.DeletedCount, agentRunsResult.DeletedCount);

        return Ok(ApiResponse<object>.Ok(new
        {
            deletedEntries = entriesResult.DeletedCount,
            deletedSyncLogs = syncLogsResult.DeletedCount,
            deletedDocuments = documentsDeleted,
            deletedAttachments = attachmentsDeleted,
            deletedLikes = likesResult.DeletedCount,
            deletedFavorites = favoritesResult.DeletedCount,
            deletedShareLinks = shareLinksResult.DeletedCount,
            deletedViewEvents = viewEventsResult.DeletedCount,
            deletedInlineComments = inlineCommentsResult.DeletedCount,
            deletedAgentRuns = agentRunsResult.DeletedCount,
        }));
    }

    // ─────────────────────────────────────────────
    // 文档条目 CRUD
    // ─────────────────────────────────────────────

    /// <summary>向空间添加文档条目</summary>
    [HttpPost("stores/{storeId}/entries")]
    public async Task<IActionResult> AddEntry(string storeId, [FromBody] AddDocumentEntryRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档标题不能为空"));

        var entry = new DocumentEntry
        {
            StoreId = storeId,
            ParentId = string.IsNullOrEmpty(request.ParentId) ? null : request.ParentId,
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
            CreatedBy = userId,
            UpdatedBy = userId,
            UpdatedByName = userName,
            // 新建文档立即带 NEW 徽标（前端按 24h 内判定），24h 后自动消失
            LastChangedAt = DateTime.UtcNow,
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

    /// <summary>创建文件夹</summary>
    [HttpPost("stores/{storeId}/folders")]
    public async Task<IActionResult> CreateFolder(string storeId, [FromBody] CreateDocStoreFolderRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹名称不能为空"));

        // 校验父文件夹存在且是文件夹
        if (!string.IsNullOrEmpty(request.ParentId))
        {
            var parent = await _db.DocumentEntries.Find(
                e => e.Id == request.ParentId && e.StoreId == storeId && e.IsFolder).FirstOrDefaultAsync();
            if (parent == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "父文件夹不存在"));
        }

        var folder = new DocumentEntry
        {
            StoreId = storeId,
            ParentId = string.IsNullOrEmpty(request.ParentId) ? null : request.ParentId,
            IsFolder = true,
            Title = request.Name.Trim(),
            SourceType = DocumentSourceType.Upload,
            ContentType = "application/x-folder",
            CreatedBy = userId,
            UpdatedBy = userId,
            UpdatedByName = userName,
        };

        await _db.DocumentEntries.InsertOneAsync(folder);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[document-store] Folder created: {FolderId} '{Name}' in store {StoreId}",
            folder.Id, request.Name, storeId);

        return Ok(ApiResponse<DocumentEntry>.Ok(folder));
    }

    /// <summary>获取空间内的文档条目列表（支持 parentId 过滤层级）</summary>
    [HttpGet("stores/{storeId}/entries")]
    public async Task<IActionResult> ListEntries(
        string storeId,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 200,
        [FromQuery] string? sourceType = null,
        [FromQuery] string? keyword = null,
        [FromQuery] string? parentId = null,
        [FromQuery] bool all = false,
        [FromQuery] bool searchContent = false)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (store.OwnerId != userId && !store.IsPublic)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        pageSize = Math.Clamp(pageSize, 1, 500);
        page = Math.Max(1, page);

        var filterBuilder = Builders<DocumentEntry>.Filter;
        var filter = filterBuilder.Eq(e => e.StoreId, storeId);

        // 按层级过滤：all=true 返回全部，否则按 parentId 过滤
        if (!all && string.IsNullOrWhiteSpace(keyword))
        {
            if (string.IsNullOrEmpty(parentId))
            {
                // 根级：ParentId == null 或 ParentId 字段不存在（兼容旧数据）
                filter &= filterBuilder.Or(
                    filterBuilder.Eq(e => e.ParentId, null),
                    filterBuilder.Exists(e => e.ParentId, false));
            }
            else
                filter &= filterBuilder.Eq(e => e.ParentId, parentId);
        }

        if (!string.IsNullOrWhiteSpace(sourceType))
            filter &= filterBuilder.Eq(e => e.SourceType, sourceType);

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            // 关键词按字面量处理：转义正则元字符，避免 [draft] / v1.0 / foo( 等
            // 被当作正则误匹配或非法正则导致请求失败（行为对齐原本地 includes）。
            var kw = System.Text.RegularExpressions.Regex.Escape(keyword.Trim());
            var searchFilters = new List<FilterDefinition<DocumentEntry>>
            {
                filterBuilder.Regex(e => e.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                filterBuilder.Regex(e => e.Summary, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
            };

            // 启用内容搜索时，同时搜索 ContentIndex 字段
            if (searchContent)
            {
                searchFilters.Add(
                    filterBuilder.Regex(e => e.ContentIndex, new MongoDB.Bson.BsonRegularExpression(kw, "i")));
            }

            filter &= filterBuilder.Or(searchFilters);
        }

        var total = await _db.DocumentEntries.CountDocumentsAsync(filter);
        var items = await _db.DocumentEntries.Find(filter)
            .SortByDescending(e => e.IsFolder) // 文件夹优先
            .ThenByDescending(e => e.CreatedAt)
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
        var (userId, userName) = await GetActorInfoAsync();
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
        updates.Add(Builders<DocumentEntry>.Update.Set(e => e.UpdatedBy, userId));
        updates.Add(Builders<DocumentEntry>.Update.Set(e => e.UpdatedByName, userName));

        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update.Combine(updates));

        var updated = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        return Ok(ApiResponse<DocumentEntry>.Ok(updated!));
    }

    /// <summary>删除文档条目（级联清理同步日志 + 正文 + 附件；文件夹会级联删除子条目）</summary>
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

        // 收集要级联清理的条目 ID 列表
        var idsToDelete = new List<string> { entryId };

        // 如果是文件夹，递归收集所有后代
        if (entry.IsFolder)
        {
            var all = await _db.DocumentEntries.Find(e => e.StoreId == entry.StoreId).ToListAsync();
            var childrenByParent = all.GroupBy(e => e.ParentId ?? "").ToDictionary(g => g.Key, g => g.ToList());
            var queue = new Queue<string>();
            queue.Enqueue(entryId);
            while (queue.Count > 0)
            {
                var cur = queue.Dequeue();
                if (childrenByParent.TryGetValue(cur, out var kids))
                {
                    foreach (var k in kids)
                    {
                        idsToDelete.Add(k.Id);
                        if (k.IsFolder) queue.Enqueue(k.Id);
                    }
                }
            }
        }
        // 如果是 GitHub 目录订阅，还要清理所有以它为 parent 的子条目
        else if (entry.SourceType == DocumentSourceType.GithubDirectory)
        {
            var ghChildren = await _db.DocumentEntries.Find(
                e => e.StoreId == entry.StoreId &&
                     e.Metadata.ContainsKey("github_parent_id") &&
                     e.Metadata["github_parent_id"] == entryId
            ).ToListAsync();
            idsToDelete.AddRange(ghChildren.Select(c => c.Id));
        }

        // 收集被删条目引用的 DocumentId / AttachmentId
        var targets = await _db.DocumentEntries.Find(e => idsToDelete.Contains(e.Id)).ToListAsync();
        var documentIds = targets.Where(e => !string.IsNullOrEmpty(e.DocumentId)).Select(e => e.DocumentId!).ToList();
        var attachmentIds = targets.Where(e => !string.IsNullOrEmpty(e.AttachmentId)).Select(e => e.AttachmentId!).ToList();

        // 级联清理
        var entriesResult = await _db.DocumentEntries.DeleteManyAsync(e => idsToDelete.Contains(e.Id));
        var syncLogsResult = await _db.DocumentSyncLogs.DeleteManyAsync(l => idsToDelete.Contains(l.EntryId));
        var viewEventsResult = await _db.DocumentStoreViewEvents.DeleteManyAsync(v => v.EntryId != null && idsToDelete.Contains(v.EntryId));
        var inlineCommentsResult = await _db.DocumentInlineComments.DeleteManyAsync(c => idsToDelete.Contains(c.EntryId));
        var agentRunsResult = await _db.DocumentStoreAgentRuns.DeleteManyAsync(r => idsToDelete.Contains(r.SourceEntryId));

        long documentsDeleted = 0;
        if (documentIds.Count > 0)
        {
            var r = await _db.Documents.DeleteManyAsync(d => documentIds.Contains(d.Id));
            documentsDeleted = r.DeletedCount;
        }
        long attachmentsDeleted = 0;
        if (attachmentIds.Count > 0)
        {
            var r = await _db.Attachments.DeleteManyAsync(a => attachmentIds.Contains(a.AttachmentId));
            attachmentsDeleted = r.DeletedCount;
        }

        // 更新空间文档计数（按真实剩余数重算，避免负数或偏差）
        var remaining = await _db.DocumentEntries.CountDocumentsAsync(e => e.StoreId == entry.StoreId);
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == entry.StoreId,
            Builders<DocumentStore>.Update
                .Set(s => s.DocumentCount, (int)remaining)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation(
            "[document-store] Entry cascaded deleted: {EntryId} from store {StoreId} by {UserId} | entries={Entries} syncLogs={Logs} docs={Docs} attachments={Atts} views={Views} inlineComments={Comments} agentRuns={Runs}",
            entryId, entry.StoreId, userId,
            entriesResult.DeletedCount, syncLogsResult.DeletedCount, documentsDeleted, attachmentsDeleted,
            viewEventsResult.DeletedCount, inlineCommentsResult.DeletedCount, agentRunsResult.DeletedCount);

        return Ok(ApiResponse<object>.Ok(new
        {
            deleted = true,
            deletedEntries = entriesResult.DeletedCount,
            deletedSyncLogs = syncLogsResult.DeletedCount,
            deletedDocuments = documentsDeleted,
            deletedAttachments = attachmentsDeleted,
            deletedViewEvents = viewEventsResult.DeletedCount,
            deletedInlineComments = inlineCommentsResult.DeletedCount,
            deletedAgentRuns = agentRunsResult.DeletedCount,
        }));
    }

    /// <summary>移动文档条目到其他文件夹</summary>
    [HttpPut("entries/{entryId}/move")]
    public async Task<IActionResult> MoveEntry(string entryId, [FromBody] MoveEntryRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 验证目标文件夹存在
        if (!string.IsNullOrEmpty(request.ParentId))
        {
            var folder = await _db.DocumentEntries.Find(
                e => e.Id == request.ParentId && e.StoreId == entry.StoreId && e.IsFolder).FirstOrDefaultAsync();
            if (folder == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标文件夹不存在"));
        }

        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update
                .Set(e => e.ParentId, string.IsNullOrEmpty(request.ParentId) ? null : request.ParentId)
                .Set(e => e.UpdatedBy, userId)
                .Set(e => e.UpdatedByName, userName)
                .Set(e => e.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { moved = true }));
    }

    /// <summary>更新文档内容（在线编辑）</summary>
    [HttpPut("entries/{entryId}/content")]
    public async Task<IActionResult> UpdateEntryContent(string entryId, [FromBody] UpdateEntryContentRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        if (entry.IsFolder)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹不支持编辑"));

        var content = request.Content ?? string.Empty;

        // 更新或创建 ParsedPrd
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc != null)
            {
                // 重新解析并保存
                var parsed = await _documentService.ParseAsync(content);
                parsed.Id = doc.Id;
                parsed.Title = doc.Title;
                await _documentService.SaveAsync(parsed);
            }
        }
        else
        {
            // 无关联文档时创建新的 ParsedPrd
            var parsed = await _documentService.ParseAsync(content);
            parsed.Title = entry.Title;
            await _documentService.SaveAsync(parsed);
            entry.DocumentId = parsed.Id;
        }

        // 更新 DocumentEntry 的摘要和内容索引
        var summary = content.Length > 200 ? content[..200] : content;
        var contentIndex = content.Length > 2000 ? content[..2000] : content;

        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update
                .Set(e => e.DocumentId, entry.DocumentId)
                .Set(e => e.Summary, summary.Trim())
                .Set(e => e.ContentIndex, contentIndex.Trim())
                .Set(e => e.UpdatedBy, userId)
                .Set(e => e.UpdatedByName, userName)
                .Set(e => e.UpdatedAt, DateTime.UtcNow));

        // 重锚定划词评论：正文更新后，遍历所有 active 评论，用 SelectedText + context 重新定位
        var rebindStats = await RebindInlineCommentsAsync(entryId, content);

        return Ok(ApiResponse<object>.Ok(new
        {
            updated = true,
            updatedAt = DateTime.UtcNow,
            updatedBy = userId,
            updatedByName = userName,
            inlineCommentsRebound = rebindStats.rebound,
            inlineCommentsOrphaned = rebindStats.orphaned,
        }));
    }

    /// <summary>
    /// 文档正文更新后重新锚定划词评论。
    /// 算法（按成本递增）：
    ///   1) SelectedText 在新正文中唯一出现 → 直接更新 offset
    ///   2) 多处出现 → 用 ContextBefore/ContextAfter 前后文进行消歧，取最佳匹配位置
    ///   3) 零出现 → 状态改为 orphaned，评论保留但前端不再高亮正文
    /// </summary>
    private async Task<(int rebound, int orphaned)> RebindInlineCommentsAsync(string entryId, string newContent)
    {
        // 全文评论（IsWholeDocument）无锚点，不参与正文 rebind
        var comments = await _db.DocumentInlineComments
            .Find(c => c.EntryId == entryId
                && c.Status == DocumentInlineCommentStatus.Active
                && !c.IsWholeDocument)
            .ToListAsync();

        if (comments.Count == 0) return (0, 0);

        var newHash = ComputeSha256(newContent);
        int rebound = 0, orphaned = 0;

        foreach (var c in comments)
        {
            // 哈希未变（理论上不应走到这里，但保险）
            if (c.ContentHash == newHash) { rebound++; continue; }

            // 委托给纯函数做重锚定（便于单元测试覆盖）
            var result = DocStoreServices.InlineCommentRebinder.TryRebind(
                newContent,
                c.SelectedText ?? string.Empty,
                c.ContextBefore ?? string.Empty,
                c.ContextAfter ?? string.Empty);

            if (result is null)
            {
                await MarkCommentOrphaned(c.Id, newHash);
                orphaned++;
                continue;
            }

            await _db.DocumentInlineComments.UpdateOneAsync(
                x => x.Id == c.Id,
                Builders<DocumentInlineComment>.Update
                    .Set(x => x.StartOffset, result.StartOffset)
                    .Set(x => x.EndOffset, result.EndOffset)
                    .Set(x => x.ContextBefore, result.ContextBefore)
                    .Set(x => x.ContextAfter, result.ContextAfter)
                    .Set(x => x.ContentHash, newHash)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));
            rebound++;
        }

        return (rebound, orphaned);
    }

    private async Task MarkCommentOrphaned(string commentId, string newHash)
    {
        await _db.DocumentInlineComments.UpdateOneAsync(
            x => x.Id == commentId,
            Builders<DocumentInlineComment>.Update
                .Set(x => x.Status, DocumentInlineCommentStatus.Orphaned)
                .Set(x => x.ContentHash, newHash)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
    }

    /// <summary>设置文件夹内的主文档</summary>
    [HttpPut("entries/{folderId}/primary-child")]
    public async Task<IActionResult> SetFolderPrimaryChild(string folderId, [FromBody] SetPrimaryEntryRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var folder = await _db.DocumentEntries.Find(e => e.Id == folderId && e.IsFolder).FirstOrDefaultAsync();
        if (folder == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文件夹不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == folder.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文件夹不存在"));

        if (!string.IsNullOrEmpty(request.EntryId))
        {
            var child = await _db.DocumentEntries.Find(
                e => e.Id == request.EntryId && e.ParentId == folderId).FirstOrDefaultAsync();
            if (child == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在或不在此文件夹内"));
        }

        var metadata = folder.Metadata ?? new Dictionary<string, string>();
        if (string.IsNullOrEmpty(request.EntryId))
            metadata.Remove("primaryChildId");
        else
            metadata["primaryChildId"] = request.EntryId;

        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == folderId,
            Builders<DocumentEntry>.Update
                .Set(e => e.Metadata, metadata)
                .Set(e => e.UpdatedBy, userId)
                .Set(e => e.UpdatedByName, userName)
                .Set(e => e.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { primaryChildId = request.EntryId }));
    }

    /// <summary>为空间内的文档回填内容索引（ContentIndex），供内容搜索使用</summary>
    [HttpPost("stores/{storeId}/rebuild-content-index")]
    public async Task<IActionResult> RebuildContentIndex(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        // 查找没有 ContentIndex 的条目
        var entries = await _db.DocumentEntries.Find(
            Builders<DocumentEntry>.Filter.And(
                Builders<DocumentEntry>.Filter.Eq(e => e.StoreId, storeId),
                Builders<DocumentEntry>.Filter.Eq(e => e.IsFolder, false),
                Builders<DocumentEntry>.Filter.Or(
                    Builders<DocumentEntry>.Filter.Eq(e => e.ContentIndex, null),
                    Builders<DocumentEntry>.Filter.Exists(e => e.ContentIndex, false))))
            .ToListAsync();

        var updated = 0;
        foreach (var entry in entries)
        {
            string? text = null;

            // 优先从 ParsedPrd 获取
            if (!string.IsNullOrEmpty(entry.DocumentId))
            {
                var doc = await _documentService.GetByIdAsync(entry.DocumentId);
                if (doc != null) text = doc.RawContent;
            }

            // 兜底从 Attachment.ExtractedText 获取
            if (string.IsNullOrEmpty(text) && !string.IsNullOrEmpty(entry.AttachmentId))
            {
                var att = await _db.Attachments
                    .Find(a => a.AttachmentId == entry.AttachmentId)
                    .FirstOrDefaultAsync();
                if (att != null) text = att.ExtractedText;
            }

            if (!string.IsNullOrEmpty(text))
            {
                var contentIndex = text.Length > 2000 ? text[..2000] : text;
                await _db.DocumentEntries.UpdateOneAsync(
                    e => e.Id == entry.Id,
                    Builders<DocumentEntry>.Update.Set(e => e.ContentIndex, contentIndex));
                updated++;
            }
        }

        return Ok(ApiResponse<object>.Ok(new { total = entries.Count, updated }));
    }

    // ─────────────────────────────────────────────
    // 文件上传（真实存盘）
    // ─────────────────────────────────────────────

    /// <summary>
    /// 上传文件到文档空间（multipart/form-data）。
    /// 文件存储到 IAssetStorage，文本内容提取后存到 ParsedPrd，
    /// 创建 DocumentEntry 关联 AttachmentId + DocumentId。
    /// </summary>
    [HttpPost("stores/{storeId}/upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> UploadFile(string storeId, [FromForm] IFormFile file, [FromForm] string? parentId = null, CancellationToken ct = default)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync(ct);
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择要上传的文件"));

        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxUploadBytes / 1024 / 1024}MB"));

        // MIME 推断（浏览器对 m4a/mp4 等常报 octet-stream，按扩展名兜底）
        var mime = InferMime(file.ContentType, file.FileName);

        // 读取文件字节
        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        // 1) 存储到 COS / 本地 — 传 fileName 进去，让 SaveAsync 优先用原始扩展名
        // 而不是从 mime 反推（mime 不可靠：m4a 浏览器报 octet-stream，反推到 .png）
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: "prd-agent", type: "doc", fileName: file.FileName);

        // 2) 提取文本内容
        string? extractedText = null;
        if (_fileContentExtractor.IsSupported(mime))
        {
            extractedText = _fileContentExtractor.Extract(bytes, mime, file.FileName);
        }
        else if (mime.StartsWith("text/") || mime == "application/json" || mime == "application/xml")
        {
            // 纯文本格式直接读取
            extractedText = System.Text.Encoding.UTF8.GetString(bytes);
        }

        // 3) 创建 Attachment 记录
        var attachment = new Attachment
        {
            UploaderId = userId,
            FileName = file.FileName,
            MimeType = mime,
            Size = file.Length,
            Url = stored.Url,
            Type = AttachmentType.Document,
            UploadedAt = DateTime.UtcNow,
            ExtractedText = extractedText?.Length > 50000 ? extractedText[..50000] : extractedText,
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: ct);

        // 4) 如果有提取到的文本，解析为 ParsedPrd 存储
        string? documentId = null;
        if (!string.IsNullOrWhiteSpace(extractedText))
        {
            var parsed = await _documentService.ParseAsync(extractedText);
            parsed.Title = Path.GetFileNameWithoutExtension(file.FileName);
            await _documentService.SaveAsync(parsed);
            documentId = parsed.Id;
        }

        // 5) 创建 DocumentEntry（关联 Attachment + ParsedPrd）
        // 保留完整文件名（含扩展名），便于前端按扩展名显示图标
        var title = file.FileName ?? Path.GetFileNameWithoutExtension(file.FileName);
        var summary = extractedText?.Length > 200 ? extractedText[..200] : extractedText;

        // 截取前 2000 字符作为内容索引（供内容搜索使用）
        var contentIndex = extractedText?.Length > 2000 ? extractedText[..2000] : extractedText;

        var entry = new DocumentEntry
        {
            StoreId = storeId,
            ParentId = string.IsNullOrEmpty(parentId) ? null : parentId,
            AttachmentId = attachment.AttachmentId,
            DocumentId = documentId,
            Title = title,
            Summary = summary?.Trim(),
            SourceType = DocumentSourceType.Upload,
            ContentType = mime,
            FileSize = file.Length,
            CreatedBy = userId,
            UpdatedBy = userId,
            UpdatedByName = userName,
            ContentIndex = contentIndex?.Trim(),
            // 新上传文件立即带 NEW 徽标（前端按 24h 内判定），24h 后自动消失
            LastChangedAt = DateTime.UtcNow,
        };
        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: ct);

        // 更新空间文档计数
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation("[document-store] File uploaded: {EntryId} '{FileName}' ({Size}B) to store {StoreId} by {UserId}",
            entry.Id, file.FileName, file.Length, storeId, userId);

        return Ok(ApiResponse<object>.Ok(new
        {
            entry,
            attachmentId = attachment.AttachmentId,
            documentId,
            fileUrl = stored.Url,
        }));
    }

    /// <summary>
    /// 替换已有条目的文件内容（原地替换）。保留条目 Id / 父文件夹 / 标签 /
    /// 主文档 / 置顶状态，仅更新正文、附件与标题，避免"删除再上传"丢失这些关联。
    /// </summary>
    [HttpPost("entries/{entryId}/replace")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> ReplaceEntryFile(string entryId, [FromForm] IFormFile file, CancellationToken ct = default)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync(ct);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));
        if (entry.IsFolder)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹无法替换文件"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync(ct);
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择要替换的文件"));
        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxUploadBytes / 1024 / 1024}MB"));

        // 覆盖前先捕获旧的 Attachment / ParsedPrd 引用，待替换成功后清理，
        // 否则每次替换都把上一版正文 + Attachment 记录变成永久孤儿（删条目时只按新 id 清理，清不到历史版本）
        var oldAttachmentId = entry.AttachmentId;
        var oldDocumentId = entry.DocumentId;

        var mime = InferMime(file.ContentType, file.FileName);

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: "prd-agent", type: "doc", fileName: file.FileName);

        string? extractedText = null;
        if (_fileContentExtractor.IsSupported(mime))
            extractedText = _fileContentExtractor.Extract(bytes, mime, file.FileName);
        else if (mime.StartsWith("text/") || mime == "application/json" || mime == "application/xml")
            extractedText = System.Text.Encoding.UTF8.GetString(bytes);

        var attachment = new Attachment
        {
            UploaderId = userId,
            FileName = file.FileName,
            MimeType = mime,
            Size = file.Length,
            Url = stored.Url,
            Type = AttachmentType.Document,
            UploadedAt = DateTime.UtcNow,
            ExtractedText = extractedText?.Length > 50000 ? extractedText[..50000] : extractedText,
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: ct);

        string? documentId = null;
        if (!string.IsNullOrWhiteSpace(extractedText))
        {
            var parsed = await _documentService.ParseAsync(extractedText);
            parsed.Title = Path.GetFileNameWithoutExtension(file.FileName);
            await _documentService.SaveAsync(parsed);
            documentId = parsed.Id;
        }

        var summary = extractedText?.Length > 200 ? extractedText[..200] : extractedText;
        var contentIndex = extractedText?.Length > 2000 ? extractedText[..2000] : extractedText;

        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update
                .Set(e => e.AttachmentId, attachment.AttachmentId)
                .Set(e => e.DocumentId, documentId)
                .Set(e => e.Title, file.FileName ?? entry.Title)
                .Set(e => e.Summary, summary?.Trim())
                .Set(e => e.ContentType, mime)
                .Set(e => e.FileSize, file.Length)
                .Set(e => e.ContentIndex, contentIndex?.Trim())
                .Set(e => e.UpdatedBy, userId)
                .Set(e => e.UpdatedByName, userName)
                .Set(e => e.UpdatedAt, DateTime.UtcNow)
                .Set(e => e.LastChangedAt, DateTime.UtcNow),
            cancellationToken: ct);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == entry.StoreId,
            Builders<DocumentStore>.Update.Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        // 正文已变，重新绑定/失效该条目下的划词评论
        if (!string.IsNullOrWhiteSpace(extractedText))
        {
            await RebindInlineCommentsAsync(entryId, extractedText);
        }
        else
        {
            // 新文件无可提取正文（图片/音频/扫描 PDF 等）：原有划词评论的锚点已无正文可定位，
            // 把非全文评论批量置为 Orphaned；全文评论（无锚点）保持 Active 不动。
            await _db.DocumentInlineComments.UpdateManyAsync(
                c => c.EntryId == entryId
                    && c.Status == DocumentInlineCommentStatus.Active
                    && !c.IsWholeDocument,
                Builders<DocumentInlineComment>.Update
                    .Set(x => x.Status, DocumentInlineCommentStatus.Orphaned)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));
        }

        // 替换主流程已成功，旧 Attachment / ParsedPrd 尽力而为清理（与 DeleteEntry 一致：只删 DB 记录，
        // 不动存储 blob —— blob 按 sha 去重为多条目共享，删除路径同样不调 _assetStorage）。
        // 清理失败不影响替换结果：CT.None 保证不被客户端断开打断，try/catch + 警告日志兜底。
        if (!string.IsNullOrEmpty(oldDocumentId) && oldDocumentId != documentId)
        {
            try
            {
                await _db.Documents.DeleteOneAsync(d => d.Id == oldDocumentId, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[document-store] Replace cleanup: 删除旧 ParsedPrd 失败 docId={DocId} entry={EntryId}", oldDocumentId, entryId);
            }
        }
        if (!string.IsNullOrEmpty(oldAttachmentId) && oldAttachmentId != attachment.AttachmentId)
        {
            try
            {
                await _db.Attachments.DeleteOneAsync(a => a.AttachmentId == oldAttachmentId, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[document-store] Replace cleanup: 删除旧 Attachment 失败 attId={AttId} entry={EntryId}", oldAttachmentId, entryId);
            }
        }

        _logger.LogInformation("[document-store] Entry replaced: {EntryId} -> '{FileName}' ({Size}B) by {UserId}",
            entryId, file.FileName, file.Length, userId);

        var updated = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            entry = updated,
            attachmentId = attachment.AttachmentId,
            documentId,
            fileUrl = stored.Url,
        }));
    }

    // ─────────────────────────────────────────────
    // 文档内容读取
    // ─────────────────────────────────────────────

    /// <summary>获取文档条目的文本内容（从 ParsedPrd 或 Attachment.ExtractedText）</summary>
    [HttpGet("entries/{entryId}/content")]
    public async Task<IActionResult> GetEntryContent(string entryId)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null || (store.OwnerId != userId && !store.IsPublic))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 优先从 ParsedPrd 读取完整内容
        string? content = null;
        string? title = null;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc != null)
            {
                content = doc.RawContent;
                title = doc.Title;
            }
        }

        // 兜底：从 Attachment.ExtractedText 读取
        if (string.IsNullOrEmpty(content) && !string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await _db.Attachments
                .Find(a => a.AttachmentId == entry.AttachmentId)
                .FirstOrDefaultAsync();
            if (att != null)
            {
                content = att.ExtractedText;
                title = att.FileName;
            }
        }

        // 文件下载 URL
        string? fileUrl = null;
        if (!string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await _db.Attachments
                .Find(a => a.AttachmentId == entry.AttachmentId)
                .FirstOrDefaultAsync();
            fileUrl = att?.Url;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            entryId = entry.Id,
            title = title ?? entry.Title,
            content,
            contentType = entry.ContentType,
            fileUrl,
            hasContent = !string.IsNullOrEmpty(content),
        }));
    }

    // ─────────────────────────────────────────────
    // 订阅源管理
    // ─────────────────────────────────────────────

    /// <summary>添加订阅源（定期从 URL 拉取内容更新文档）</summary>
    [HttpPost("stores/{storeId}/subscribe")]
    public async Task<IActionResult> AddSubscription(string storeId, [FromBody] AddSubscriptionRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (string.IsNullOrWhiteSpace(request.SourceUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "源地址不能为空"));

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));

        try
        {
            await _urlValidator.EnsureSafeHttpUrlAsync(request.SourceUrl, "文档订阅源", HttpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }

        var interval = Math.Clamp(request.SyncIntervalMinutes ?? 60, 5, 1440); // 5分钟 ~ 24小时

        var entry = new DocumentEntry
        {
            StoreId = storeId,
            Title = request.Title.Trim(),
            Summary = request.Description?.Trim(),
            SourceType = DocumentSourceType.Subscription,
            SourceUrl = request.SourceUrl.Trim(),
            SyncIntervalMinutes = interval,
            SyncStatus = DocumentSyncStatus.Idle,
            ContentType = "text/html",
            Tags = request.Tags ?? new List<string>(),
            CreatedBy = userId,
            UpdatedBy = userId,
            UpdatedByName = userName,
        };

        await _db.DocumentEntries.InsertOneAsync(entry);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[document-store] Subscription added: {EntryId} '{Url}' every {Interval}min to store {StoreId}",
            entry.Id, request.SourceUrl, interval, storeId);

        return Ok(ApiResponse<DocumentEntry>.Ok(entry));
    }

    /// <summary>添加 GitHub 目录订阅（自动同步 GitHub 仓库目录下所有 .md 文件）</summary>
    [HttpPost("stores/{storeId}/subscribe-github")]
    public async Task<IActionResult> AddGitHubSubscription(string storeId, [FromBody] AddGitHubSubscriptionRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (string.IsNullOrWhiteSpace(request.GithubUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "GitHub 地址不能为空"));

        // 解析 GitHub URL
        string owner, repo, path, branch;
        try
        {
            (owner, repo, path, branch) = GitHubDirectorySyncService.ParseGitHubUrl(request.GithubUrl.Trim());
        }
        catch (Exception ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"GitHub 地址格式无效: {ex.Message}"));
        }

        // 去重：检查是否已有相同仓库+路径+分支的订阅
        var existingFilter = Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Eq(e => e.StoreId, storeId),
            Builders<DocumentEntry>.Filter.Eq(e => e.SourceType, DocumentSourceType.GithubDirectory));
        var existingEntries = await _db.DocumentEntries.Find(existingFilter).ToListAsync();
        var duplicate = existingEntries.FirstOrDefault(e =>
            e.Metadata.GetValueOrDefault("github_owner") == owner &&
            e.Metadata.GetValueOrDefault("github_repo") == repo &&
            e.Metadata.GetValueOrDefault("github_path") == path &&
            e.Metadata.GetValueOrDefault("github_branch") == branch);
        if (duplicate != null)
            return BadRequest(ApiResponse<object>.Fail("ALREADY_EXISTS", $"该目录已订阅 (ID: {duplicate.Id})"));

        var interval = 1440; // GitHub 目录固定为每日同步一次，首次添加后立即同步

        var title = request.Title?.Trim();
        if (string.IsNullOrEmpty(title))
            title = string.IsNullOrEmpty(path) ? $"{owner}/{repo}" : $"{owner}/{repo}/{path}";

        var entry = new DocumentEntry
        {
            StoreId = storeId,
            Title = title,
            Summary = $"GitHub 目录同步: {owner}/{repo}/{path}@{branch}",
            SourceType = DocumentSourceType.GithubDirectory,
            SourceUrl = request.GithubUrl.Trim(),
            SyncIntervalMinutes = interval,
            SyncStatus = DocumentSyncStatus.Syncing, // 立即触发首次同步
            ContentType = "application/x-github-directory",
            CreatedBy = userId,
            UpdatedBy = userId,
            UpdatedByName = userName,
            Metadata = new Dictionary<string, string>
            {
                ["github_owner"] = owner,
                ["github_repo"] = repo,
                ["github_path"] = path,
                ["github_branch"] = branch,
            },
            Tags = request.Tags ?? new List<string>(),
        };

        if (!string.IsNullOrWhiteSpace(request.IncludeGlob))
        {
            entry.Metadata["github_include_glob"] = request.IncludeGlob.Trim();
        }

        await _db.DocumentEntries.InsertOneAsync(entry);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation(
            "[document-store] GitHub subscription added: {EntryId} {Owner}/{Repo}/{Path}@{Branch} to store {StoreId}",
            entry.Id, owner, repo, path, branch, storeId);

        return Ok(ApiResponse<DocumentEntry>.Ok(entry));
    }

    /// <summary>置顶/取消置顶文档条目（支持多个置顶）</summary>
    [HttpPut("stores/{storeId}/pinned-entries")]
    public async Task<IActionResult> TogglePinnedEntry(string storeId, [FromBody] TogglePinRequest request)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (string.IsNullOrEmpty(request.EntryId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "条目 ID 不能为空"));

        var entry = await _db.DocumentEntries.Find(
            e => e.Id == request.EntryId && e.StoreId == storeId).FirstOrDefaultAsync();
        if (entry == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在或不属于此空间"));

        var pinnedIds = store.PinnedEntryIds ?? new List<string>();
        if (request.Pin)
        {
            if (!pinnedIds.Contains(request.EntryId))
                pinnedIds.Add(request.EntryId);
        }
        else
        {
            pinnedIds.Remove(request.EntryId);
        }

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Set(s => s.PinnedEntryIds, pinnedIds)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[document-store] Entry {Action}: store={StoreId} entry={EntryId} by {UserId}",
            request.Pin ? "pinned" : "unpinned", storeId, request.EntryId, userId);

        return Ok(ApiResponse<object>.Ok(new { pinnedEntryIds = pinnedIds }));
    }

    /// <summary>获取文档空间列表（含最近文档预览，用于卡片展示）</summary>
    [HttpGet("stores/with-preview")]
    public async Task<IActionResult> ListStoresWithPreview([FromQuery] int page = 1, [FromQuery] int pageSize = 20)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var filter = Builders<DocumentStore>.Filter.Eq(s => s.OwnerId, userId);
        var total = await _db.DocumentStores.CountDocumentsAsync(filter);
        var stores = await _db.DocumentStores.Find(filter)
            .SortByDescending(s => s.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        // 批量获取每个空间的最近 3 个文档（用于卡片预览）
        var storeIds = stores.Select(s => s.Id).ToList();
        var entriesByStore = await LoadRecentEntriesByStoreAsync(storeIds);

        var items = stores.Select(s => new
        {
            s.Id,
            s.Name,
            s.Description,
            s.OwnerId,
            s.AppKey,
            s.Tags,
            s.IsPublic,
            s.PrimaryEntryId,
            s.PinnedEntryIds,
            s.DocumentCount,
            s.CreatedAt,
            s.UpdatedAt,
            recentEntries = entriesByStore.GetValueOrDefault(s.Id, new()),
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>手动触发同步</summary>
    [HttpPost("entries/{entryId}/sync")]
    public async Task<IActionResult> TriggerSync(string entryId)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        if (string.IsNullOrEmpty(entry.SourceUrl) && entry.SourceType != DocumentSourceType.GithubDirectory)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该文档不是订阅源"));

        // 暂停状态下不允许手动触发
        if (entry.IsPaused)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "订阅已暂停，请先恢复"));

        // 标记为同步中（BackgroundService 会拾取）
        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update
                .Set(e => e.SyncStatus, DocumentSyncStatus.Syncing)
                .Set(e => e.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { triggered = true }));
    }

    /// <summary>获取订阅条目的最近同步日志（只包含 change/error 事件，无变化的同步不在此列表中）</summary>
    [HttpGet("entries/{entryId}/sync-logs")]
    public async Task<IActionResult> ListSyncLogs(string entryId, [FromQuery] int limit = 20)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        limit = Math.Clamp(limit, 1, 100);

        var logs = await _db.DocumentSyncLogs
            .Find(l => l.EntryId == entryId)
            .SortByDescending(l => l.SyncedAt)
            .Limit(limit)
            .ToListAsync();

        var nextSyncAt = DocumentSyncSchedule.GetNextSyncAt(entry);

        return Ok(ApiResponse<object>.Ok(new
        {
            entry = new
            {
                id = entry.Id,
                title = entry.Title,
                sourceType = entry.SourceType,
                sourceUrl = entry.SourceUrl,
                syncIntervalMinutes = entry.SyncIntervalMinutes,
                syncStatus = entry.SyncStatus,
                syncError = entry.SyncError,
                lastSyncAt = entry.LastSyncAt,
                lastChangedAt = entry.LastChangedAt,
                isPaused = entry.IsPaused,
                contentHash = entry.ContentHash,
                metadata = entry.Metadata,
                nextSyncAt,
            },
            logs = logs.Select(l => new
            {
                id = l.Id,
                syncedAt = l.SyncedAt,
                kind = l.Kind,
                changeSummary = l.ChangeSummary,
                fileChanges = l.FileChanges,
                previousLength = l.PreviousLength,
                currentLength = l.CurrentLength,
                errorMessage = l.ErrorMessage,
                durationMs = l.DurationMs,
            }).ToList(),
        }));
    }

    /// <summary>更新订阅条目的可变状态（暂停/恢复 + 调整同步间隔）</summary>
    [HttpPatch("entries/{entryId}/subscription")]
    public async Task<IActionResult> UpdateSubscription(string entryId, [FromBody] UpdateSubscriptionRequest request)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        if (string.IsNullOrEmpty(entry.SourceUrl) && entry.SourceType != DocumentSourceType.GithubDirectory)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该文档不是订阅源"));

        var update = Builders<DocumentEntry>.Update.Set(e => e.UpdatedAt, DateTime.UtcNow);
        var changed = false;

        if (request.IsPaused.HasValue)
        {
            update = update.Set(e => e.IsPaused, request.IsPaused.Value);
            changed = true;
        }

        if (request.SyncIntervalMinutes.HasValue)
        {
            var clamped = entry.SourceType == DocumentSourceType.GithubDirectory
                ? 1440
                : Math.Clamp(request.SyncIntervalMinutes.Value, 5, 1440);
            update = update.Set(e => e.SyncIntervalMinutes, clamped);
            changed = true;
        }

        if (!changed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未提供任何可更新字段"));

        await _db.DocumentEntries.UpdateOneAsync(e => e.Id == entryId, update);

        var refreshed = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        return Ok(ApiResponse<DocumentEntry>.Ok(refreshed!));
    }

    // ─────────────────────────────────────────────
    // 知识库 Agent：字幕生成 + 文档再加工
    // ─────────────────────────────────────────────

    /// <summary>列出文档再加工的可用模板</summary>
    [HttpGet("reprocess-templates")]
    public IActionResult ListReprocessTemplates()
    {
        var items = ReprocessTemplateRegistry.Templates.Select(t => new
        {
            key = t.Key,
            label = t.Label,
            description = t.Description,
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>发起字幕生成任务（音视频 → ASR，图片 → Vision）</summary>
    [HttpPost("entries/{entryId}/generate-subtitle")]
    public async Task<IActionResult> GenerateSubtitle(string entryId)
    {
        var (entry, store, err) = await LoadOwnedEntryAsync(entryId);
        if (err != null) return err;
        if (entry!.IsFolder)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹不支持生成字幕"));

        var ct = (entry.ContentType ?? "").ToLowerInvariant();
        if (!ct.StartsWith("audio/") && !ct.StartsWith("video/") && !ct.StartsWith("image/"))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持音频 / 视频 / 图片生成字幕"));

        // 去重：同一 entry 已有 queued 或 running 的 subtitle run → 直接返回
        var existing = await _db.DocumentStoreAgentRuns.Find(r =>
            r.SourceEntryId == entryId &&
            r.Kind == DocumentStoreAgentRunKind.Subtitle &&
            (r.Status == DocumentStoreRunStatus.Queued || r.Status == DocumentStoreRunStatus.Running)
        ).FirstOrDefaultAsync();
        if (existing != null)
            return Ok(ApiResponse<object>.Ok(new { runId = existing.Id, status = existing.Status, reused = true }));

        var userId = GetUserId();
        var run = new DocumentStoreAgentRun
        {
            Kind = DocumentStoreAgentRunKind.Subtitle,
            SourceEntryId = entryId,
            StoreId = store!.Id,
            UserId = userId,
            Status = DocumentStoreRunStatus.Queued,
            Phase = "排队中",
        };
        await _db.DocumentStoreAgentRuns.InsertOneAsync(run);

        _logger.LogInformation("[doc-store-agent] Subtitle run queued: {RunId} entry={EntryId}", run.Id, entryId);
        return Ok(ApiResponse<object>.Ok(new { runId = run.Id, status = run.Status, reused = false }));
    }

    /// <summary>发起文档再加工任务（流式 LLM 改写）</summary>
    [HttpPost("entries/{entryId}/reprocess")]
    public async Task<IActionResult> Reprocess(string entryId, [FromBody] ReprocessRequest request)
    {
        var (entry, store, err) = await LoadOwnedEntryAsync(entryId);
        if (err != null) return err;
        if (entry!.IsFolder)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹不支持再加工"));

        var templateKey = (request.TemplateKey ?? "").Trim();
        if (string.IsNullOrEmpty(templateKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "templateKey 不能为空"));

        if (templateKey == "custom")
        {
            if (string.IsNullOrWhiteSpace(request.CustomPrompt))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "自定义模板需要提供 customPrompt"));
        }
        else if (ReprocessTemplateRegistry.FindByKey(templateKey) == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"未知模板: {templateKey}"));
        }

        var userId = GetUserId();
        var run = new DocumentStoreAgentRun
        {
            Kind = DocumentStoreAgentRunKind.Reprocess,
            SourceEntryId = entryId,
            StoreId = store!.Id,
            UserId = userId,
            TemplateKey = templateKey,
            CustomPrompt = request.CustomPrompt,
            Status = DocumentStoreRunStatus.Queued,
            Phase = "排队中",
        };
        await _db.DocumentStoreAgentRuns.InsertOneAsync(run);

        _logger.LogInformation(
            "[doc-store-agent] Reprocess run queued: {RunId} entry={EntryId} template={Template}",
            run.Id, entryId, templateKey);
        return Ok(ApiResponse<object>.Ok(new { runId = run.Id, status = run.Status }));
    }

    /// <summary>获取 Run 当前状态（用于 Drawer 打开时判断）</summary>
    [HttpGet("agent-runs/{runId}")]
    public async Task<IActionResult> GetAgentRun(string runId)
    {
        var userId = GetUserId();
        var run = await _db.DocumentStoreAgentRuns.Find(r => r.Id == runId && r.UserId == userId).FirstOrDefaultAsync();
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Run 不存在"));
        return Ok(ApiResponse<DocumentStoreAgentRun>.Ok(run));
    }

    /// <summary>获取某个 entry 的最近一次 agent run（某 kind，用于打开按钮时判断是否已生成过）</summary>
    [HttpGet("entries/{entryId}/agent-runs/latest")]
    public async Task<IActionResult> GetLatestAgentRun(string entryId, [FromQuery] string kind)
    {
        var (_, _, err) = await LoadOwnedEntryAsync(entryId);
        if (err != null) return err;
        if (string.IsNullOrEmpty(kind))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "kind 不能为空"));

        var run = await _db.DocumentStoreAgentRuns
            .Find(r => r.SourceEntryId == entryId && r.Kind == kind)
            .SortByDescending(r => r.CreatedAt)
            .FirstOrDefaultAsync();
        return Ok(ApiResponse<DocumentStoreAgentRun?>.Ok(run));
    }

    /// <summary>SSE 订阅 Run 事件流（支持 afterSeq 断线续传）</summary>
    [HttpGet("agent-runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamAgentRun(string runId, [FromQuery] long? afterSeq, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();
        var run = await _db.DocumentStoreAgentRuns.Find(r => r.Id == runId && r.UserId == userId).FirstOrDefaultAsync(cancellationToken);
        if (run == null)
        {
            await WriteSseEventAsync(null, "error", System.Text.Json.JsonSerializer.Serialize(
                new { code = ErrorCodes.NOT_FOUND, message = "Run 不存在" }, AgentRunJsonOptions), cancellationToken);
            return;
        }

        var kindKey = run.Kind == DocumentStoreAgentRunKind.Subtitle
            ? DocumentStoreRunKinds.Subtitle
            : DocumentStoreRunKinds.Reprocess;

        long lastSeq = afterSeq ?? 0;
        var lastKeepAliveAt = DateTime.UtcNow;

        while (!cancellationToken.IsCancellationRequested)
        {
            IReadOnlyList<RunEventRecord> events;
            try
            {
                events = await _runEventStore.GetEventsAsync(kindKey, runId, lastSeq, 100, cancellationToken);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[doc-store-agent] SSE GetEvents failed");
                events = Array.Empty<RunEventRecord>();
            }

            if (events.Count > 0)
            {
                foreach (var ev in events)
                {
                    try
                    {
                        await WriteSseEventAsync(ev.Seq.ToString(), ev.EventName, ev.PayloadJson, cancellationToken);
                    }
                    catch (OperationCanceledException) { return; }
                    catch (ObjectDisposedException) { return; }
                    lastSeq = ev.Seq;
                }
                lastKeepAliveAt = DateTime.UtcNow;
            }
            else
            {
                if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
                {
                    try
                    {
                        await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                        await Response.Body.FlushAsync(cancellationToken);
                    }
                    catch (OperationCanceledException) { return; }
                    catch (ObjectDisposedException) { return; }
                    lastKeepAliveAt = DateTime.UtcNow;
                }

                // run 已结束且事件已追完 → 关闭 SSE
                var refreshed = await _db.DocumentStoreAgentRuns.Find(r => r.Id == runId).FirstOrDefaultAsync(cancellationToken);
                if (refreshed == null) break;
                if (refreshed.Status is DocumentStoreRunStatus.Done or DocumentStoreRunStatus.Failed or DocumentStoreRunStatus.Cancelled)
                {
                    // 再跑一次 GetEvents，追最后一批
                    var tail = await _runEventStore.GetEventsAsync(kindKey, runId, lastSeq, 100, cancellationToken);
                    foreach (var ev in tail)
                    {
                        try { await WriteSseEventAsync(ev.Seq.ToString(), ev.EventName, ev.PayloadJson, cancellationToken); }
                        catch { /* ignore */ }
                        lastSeq = ev.Seq;
                    }
                    break;
                }

                try { await Task.Delay(500, cancellationToken); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    // ── 知识库 Agent 内部辅助 ──

    private async Task<(DocumentEntry? entry, DocumentStore? store, IActionResult? err)>
        LoadOwnedEntryAsync(string entryId)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在")));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在")));

        return (entry, store, null);
    }

    private async Task WriteSseEventAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
            await Response.WriteAsync($"id: {id}\n", ct);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    // ─────────────────────────────────────────────
    // 公开知识库 / 点赞 / 收藏 / 分享
    // ─────────────────────────────────────────────

    /// <summary>获取所有公开知识库列表（IsPublic=true，匿名可访问）</summary>
    [HttpGet("public/stores")]
    [AllowAnonymous]
    public async Task<IActionResult> ListPublicStores([FromQuery] int page = 1, [FromQuery] int pageSize = 24, [FromQuery] string? sort = "hot")
    {
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var filter = Builders<DocumentStore>.Filter.Eq(s => s.IsPublic, true);
        var total = await _db.DocumentStores.CountDocumentsAsync(filter);

        SortDefinition<DocumentStore> sortDef = sort switch
        {
            "new" => Builders<DocumentStore>.Sort.Descending(s => s.CreatedAt),
            "popular" => Builders<DocumentStore>.Sort.Descending(s => s.LikeCount),
            "viewed" => Builders<DocumentStore>.Sort.Descending(s => s.ViewCount),
            _ => Builders<DocumentStore>.Sort
                .Descending(s => s.LikeCount)
                .Descending(s => s.ViewCount), // hot
        };

        var stores = await _db.DocumentStores.Find(filter)
            .Sort(sortDef)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        // 获取所有店主信息（一次性加载，避免 N+1）
        var ownerIds = stores.Select(s => s.OwnerId).Distinct().ToList();
        var owners = await _db.Users.Find(u => ownerIds.Contains(u.UserId)).ToListAsync();
        var ownerMap = owners.ToDictionary(u => u.UserId, u => new { u.DisplayName, u.AvatarFileName });

        var items = stores.Select(s => new
        {
            s.Id,
            s.Name,
            s.Description,
            s.Tags,
            s.DocumentCount,
            s.LikeCount,
            s.ViewCount,
            s.FavoriteCount,
            s.CoverImageUrl,
            s.CreatedAt,
            s.UpdatedAt,
            ownerName = ownerMap.GetValueOrDefault(s.OwnerId)?.DisplayName ?? "未知用户",
            ownerAvatar = ownerMap.GetValueOrDefault(s.OwnerId)?.AvatarFileName,
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>获取公开知识库详情（匿名可访问，自动 +1 ViewCount）</summary>
    [HttpGet("public/stores/{storeId}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPublicStore(string storeId)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.IsPublic).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在或未公开"));

        // 异步累加查看数（不阻塞响应）
        _ = _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update.Inc(s => s.ViewCount, 1),
            cancellationToken: CancellationToken.None);

        var owner = await _db.Users.Find(u => u.UserId == store.OwnerId).FirstOrDefaultAsync();

        // 当前登录用户（如已登录，匿名访问时为空）
        var userId = User?.FindFirst("sub")?.Value
            ?? User?.FindFirst("userId")?.Value;
        var likedByMe = false;
        var favoritedByMe = false;
        if (!string.IsNullOrEmpty(userId))
        {
            likedByMe = await _db.DocumentStoreLikes.Find(l => l.StoreId == storeId && l.UserId == userId).AnyAsync();
            favoritedByMe = await _db.DocumentStoreFavorites.Find(f => f.StoreId == storeId && f.UserId == userId).AnyAsync();
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            store.Id,
            store.Name,
            store.Description,
            store.Tags,
            store.PrimaryEntryId,
            store.PinnedEntryIds,
            store.DocumentCount,
            store.LikeCount,
            store.ViewCount,
            store.FavoriteCount,
            store.CoverImageUrl,
            store.CreatedAt,
            store.UpdatedAt,
            ownerName = owner?.DisplayName ?? "未知用户",
            ownerAvatar = owner?.AvatarFileName,
            likedByMe,
            favoritedByMe,
        }));
    }

    /// <summary>获取公开知识库的文档列表（匿名可访问）</summary>
    [HttpGet("public/stores/{storeId}/entries")]
    [AllowAnonymous]
    public async Task<IActionResult> ListPublicStoreEntries(string storeId)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.IsPublic).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在或未公开"));

        var items = await _db.DocumentEntries.Find(e => e.StoreId == storeId)
            .SortByDescending(e => e.IsFolder)
            .ThenByDescending(e => e.CreatedAt)
            .Limit(500)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total = items.Count }));
    }

    /// <summary>获取公开知识库内单个文档的内容（匿名可访问）</summary>
    [HttpGet("public/entries/{entryId}/content")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPublicEntryContent(string entryId)
    {
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId && s.IsPublic).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档不存在或所在知识库未公开"));

        string? content = null;
        string? title = null;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc != null) { content = doc.RawContent; title = doc.Title; }
        }
        if (string.IsNullOrEmpty(content) && !string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await _db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync();
            if (att != null) { content = att.ExtractedText; title ??= att.FileName; }
        }

        string? fileUrl = null;
        if (!string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await _db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync();
            fileUrl = att?.Url;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            entryId = entry.Id,
            title = title ?? entry.Title,
            content,
            contentType = entry.ContentType,
            fileUrl,
            hasContent = !string.IsNullOrEmpty(content),
        }));
    }

    /// <summary>点赞知识库</summary>
    [HttpPost("stores/{storeId}/like")]
    public async Task<IActionResult> LikeStore(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));

        // 幂等：已点赞则跳过
        var existing = await _db.DocumentStoreLikes
            .Find(l => l.StoreId == storeId && l.UserId == userId).FirstOrDefaultAsync();
        if (existing != null)
            return Ok(ApiResponse<object>.Ok(new { liked = true, likeCount = store.LikeCount }));

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var like = new DocumentStoreLike
        {
            StoreId = storeId,
            UserId = userId,
            UserName = user?.DisplayName ?? "未知用户",
            AvatarFileName = user?.AvatarFileName,
        };
        await _db.DocumentStoreLikes.InsertOneAsync(like);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update.Inc(s => s.LikeCount, 1));

        return Ok(ApiResponse<object>.Ok(new { liked = true, likeCount = store.LikeCount + 1 }));
    }

    /// <summary>取消点赞</summary>
    [HttpDelete("stores/{storeId}/like")]
    public async Task<IActionResult> UnlikeStore(string storeId)
    {
        var userId = GetUserId();
        var del = await _db.DocumentStoreLikes.DeleteOneAsync(l => l.StoreId == storeId && l.UserId == userId);
        if (del.DeletedCount > 0)
        {
            await _db.DocumentStores.UpdateOneAsync(
                s => s.Id == storeId,
                Builders<DocumentStore>.Update.Inc(s => s.LikeCount, -1));
        }

        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { liked = false, likeCount = store?.LikeCount ?? 0 }));
    }

    /// <summary>收藏知识库</summary>
    [HttpPost("stores/{storeId}/favorite")]
    public async Task<IActionResult> FavoriteStore(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));

        var existing = await _db.DocumentStoreFavorites
            .Find(f => f.StoreId == storeId && f.UserId == userId).FirstOrDefaultAsync();
        if (existing != null)
            return Ok(ApiResponse<object>.Ok(new { favorited = true, favoriteCount = store.FavoriteCount }));

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var fav = new DocumentStoreFavorite
        {
            StoreId = storeId,
            UserId = userId,
            UserName = user?.DisplayName ?? "未知用户",
            AvatarFileName = user?.AvatarFileName,
        };
        await _db.DocumentStoreFavorites.InsertOneAsync(fav);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update.Inc(s => s.FavoriteCount, 1));

        return Ok(ApiResponse<object>.Ok(new { favorited = true, favoriteCount = store.FavoriteCount + 1 }));
    }

    /// <summary>取消收藏</summary>
    [HttpDelete("stores/{storeId}/favorite")]
    public async Task<IActionResult> UnfavoriteStore(string storeId)
    {
        var userId = GetUserId();
        var del = await _db.DocumentStoreFavorites.DeleteOneAsync(f => f.StoreId == storeId && f.UserId == userId);
        if (del.DeletedCount > 0)
        {
            await _db.DocumentStores.UpdateOneAsync(
                s => s.Id == storeId,
                Builders<DocumentStore>.Update.Inc(s => s.FavoriteCount, -1));
        }

        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { favorited = false, favoriteCount = store?.FavoriteCount ?? 0 }));
    }

    /// <summary>列出我收藏的知识库（含最近文档预览 + 店主信息，用于卡片展示）</summary>
    [HttpGet("favorites/mine")]
    public async Task<IActionResult> ListMyFavorites()
    {
        var userId = GetUserId();
        var favs = await _db.DocumentStoreFavorites
            .Find(f => f.UserId == userId)
            .SortByDescending(f => f.CreatedAt)
            .ToListAsync();

        // Distinct: 旧 like/favorite 集合无 (UserId, StoreId) 唯一索引，并发请求或重复点击可能产生重复记录；
        // 不去重会让卡片列表出现重复，并使下游按 storeId 建字典时抛 ArgumentException。
        var storeIds = favs.Select(f => f.StoreId).Distinct().ToList();
        var items = await BuildInteractionStoreCardsAsync(storeIds, userId);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>列出我点赞的知识库（含最近文档预览 + 店主信息，用于卡片展示）</summary>
    [HttpGet("likes/mine")]
    public async Task<IActionResult> ListMyLikes()
    {
        var userId = GetUserId();
        var likes = await _db.DocumentStoreLikes
            .Find(l => l.UserId == userId)
            .SortByDescending(l => l.CreatedAt)
            .ToListAsync();

        var storeIds = likes.Select(l => l.StoreId).Distinct().ToList();
        var items = await BuildInteractionStoreCardsAsync(storeIds, userId);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 批量获取每个 store 的最近 N 个文档预览。
    /// 必须按 store 维度独立查询：单次全局 sort+limit 会导致活跃度低的 store 被活跃度高的 store 抢占额度，渲染出 "知识库暂无内容" 但 documentCount 非 0 的不一致。
    /// </summary>
    private async Task<Dictionary<string, List<object>>> LoadRecentEntriesByStoreAsync(IReadOnlyList<string> storeIds, int perStore = 3)
    {
        if (storeIds.Count == 0) return new Dictionary<string, List<object>>();

        // 去重：下游 ToDictionary 不能容忍重复 key；调用方理论上已 Distinct，这里再兜一层防回归。
        var distinctIds = storeIds.Distinct().ToList();
        var tasks = distinctIds.Select(async sid =>
        {
            var entries = await _db.DocumentEntries
                .Find(Builders<DocumentEntry>.Filter.And(
                    Builders<DocumentEntry>.Filter.Eq(e => e.StoreId, sid),
                    Builders<DocumentEntry>.Filter.Eq(e => e.IsFolder, false),
                    Builders<DocumentEntry>.Filter.Ne(e => e.SourceType, DocumentSourceType.GithubDirectory)))
                .SortByDescending(e => e.UpdatedAt)
                .Limit(perStore)
                .ToListAsync();
            var list = entries.Select(e => (object)new
            {
                id = e.Id,
                title = e.Title,
                updatedAt = e.UpdatedAt,
                contentType = e.ContentType,
            }).ToList();
            return (sid, list);
        }).ToList();

        var results = await Task.WhenAll(tasks);
        return results.ToDictionary(r => r.sid, r => r.list);
    }

    /// <summary>
    /// 为我的收藏/点赞列表构造卡片数据：按传入 storeId 顺序保留 + 附加最近 3 个文档 + 店主信息。
    /// 不存在的 store（已被删除）会被静默跳过。
    /// </summary>
    private async Task<List<object>> BuildInteractionStoreCardsAsync(List<string> storeIds, string currentUserId)
    {
        if (storeIds.Count == 0) return new List<object>();

        var stores = await _db.DocumentStores.Find(s => storeIds.Contains(s.Id)).ToListAsync();
        var storeMap = stores.ToDictionary(s => s.Id, s => s);

        // 最近 3 个文档预览（每个空间）
        var entriesByStore = await LoadRecentEntriesByStoreAsync(storeIds);

        // 店主信息
        var ownerIds = stores.Select(s => s.OwnerId).Distinct().ToList();
        var owners = await _db.Users.Find(u => ownerIds.Contains(u.UserId)).ToListAsync();
        var ownerMap = owners.ToDictionary(u => u.UserId, u => new { u.DisplayName, u.AvatarFileName });

        // 保留 storeIds 传入顺序（即互动时间顺序）
        var result = new List<object>();
        foreach (var id in storeIds)
        {
            if (!storeMap.TryGetValue(id, out var s)) continue;
            result.Add(new
            {
                s.Id,
                s.Name,
                s.Description,
                s.OwnerId,
                s.AppKey,
                s.Tags,
                s.IsPublic,
                s.PrimaryEntryId,
                s.PinnedEntryIds,
                s.DocumentCount,
                s.LikeCount,
                s.ViewCount,
                s.FavoriteCount,
                s.CoverImageUrl,
                s.CreatedAt,
                s.UpdatedAt,
                ownerName = ownerMap.GetValueOrDefault(s.OwnerId)?.DisplayName ?? "未知用户",
                ownerAvatar = ownerMap.GetValueOrDefault(s.OwnerId)?.AvatarFileName,
                isOwner = s.OwnerId == currentUserId,
                recentEntries = entriesByStore.GetValueOrDefault(s.Id, new()),
            });
        }
        return result;
    }

    /// <summary>创建分享链接</summary>
    [HttpPost("stores/{storeId}/share-links")]
    public async Task<IActionResult> CreateShareLink(string storeId, [FromBody] CreateShareLinkRequest request)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var link = new DocumentStoreShareLink
        {
            StoreId = storeId,
            StoreName = store.Name,
            Title = request.Title?.Trim(),
            Description = request.Description?.Trim(),
            CreatedBy = userId,
            CreatedByName = user?.DisplayName,
            ExpiresAt = request.ExpiresInDays > 0 ? DateTime.UtcNow.AddDays(request.ExpiresInDays) : null,
        };
        await _db.DocumentStoreShareLinks.InsertOneAsync(link);

        return Ok(ApiResponse<DocumentStoreShareLink>.Ok(link));
    }

    /// <summary>列出某知识库的所有分享链接</summary>
    [HttpGet("stores/{storeId}/share-links")]
    public async Task<IActionResult> ListShareLinks(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));

        var links = await _db.DocumentStoreShareLinks
            .Find(l => l.StoreId == storeId)
            .SortByDescending(l => l.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = links }));
    }

    /// <summary>撤销分享链接</summary>
    [HttpDelete("share-links/{linkId}")]
    public async Task<IActionResult> RevokeShareLink(string linkId)
    {
        var userId = GetUserId();
        var link = await _db.DocumentStoreShareLinks.Find(l => l.Id == linkId).FirstOrDefaultAsync();
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));

        if (link.CreatedBy != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权撤销此分享"));

        await _db.DocumentStoreShareLinks.UpdateOneAsync(
            l => l.Id == linkId,
            Builders<DocumentStoreShareLink>.Update.Set(l => l.IsRevoked, true));

        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    /// <summary>通过 token 访问分享链接（匿名可访问）</summary>
    [HttpGet("public/share/{token}")]
    [AllowAnonymous]
    public async Task<IActionResult> AccessShareLink(string token)
    {
        var link = await _db.DocumentStoreShareLinks.Find(l => l.Token == token).FirstOrDefaultAsync();
        if (link == null || link.IsRevoked)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在或已撤销"));

        if (link.ExpiresAt.HasValue && link.ExpiresAt.Value < DateTime.UtcNow)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接已过期"));

        // 异步累加查看数
        _ = _db.DocumentStoreShareLinks.UpdateOneAsync(
            l => l.Id == link.Id,
            Builders<DocumentStoreShareLink>.Update
                .Inc(l => l.ViewCount, 1)
                .Set(l => l.LastViewedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        var store = await _db.DocumentStores.Find(s => s.Id == link.StoreId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "关联知识库已删除"));

        return Ok(ApiResponse<object>.Ok(new
        {
            link.Token,
            link.Title,
            link.Description,
            link.CreatedByName,
            store = new
            {
                store.Id,
                store.Name,
                store.Description,
                store.PrimaryEntryId,
                store.PinnedEntryIds,
                store.DocumentCount,
                store.LikeCount,
                store.ViewCount,
            },
        }));
    }

    // ─────────────────────────────────────────────
    // 批次 C：浏览事件埋点 + 访客统计
    // ─────────────────────────────────────────────

    /// <summary>记录一次浏览事件（进入文档时调用，返回 viewEventId 供前端补时长）</summary>
    [HttpPost("entries/{entryId}/view")]
    [AllowAnonymous]
    public async Task<IActionResult> LogEntryView(string entryId, [FromBody] LogViewRequest? request)
    {
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        // 私有知识库只允许 owner 浏览统计
        var isOwner = false;
        string? viewerId = null;
        var viewerName = "匿名访客";
        string? viewerAvatar = null;
        try
        {
            viewerId = this.GetRequiredUserId();
            isOwner = store.OwnerId == viewerId;
            var userDoc = await FindUserByAnyIdAsync(viewerId);
            if (userDoc != null)
            {
                viewerName = !string.IsNullOrWhiteSpace(userDoc.DisplayName) ? userDoc.DisplayName : userDoc.Username;
                viewerAvatar = userDoc.AvatarFileName;
            }
        }
        catch
        {
            // 匿名访问
        }

        if (!store.IsPublic && !isOwner)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var ua = Request.Headers.UserAgent.ToString();
        if (ua.Length > 200) ua = ua[..200];
        var referer = Request.Headers.Referer.ToString();
        if (referer.Length > 500) referer = referer[..500];

        // 行业通行的访问去重：同一访客（登录用户按 userId，匿名按 session token / UA 指纹）
        // 在去重窗口内重复打开/刷新同一篇文档，不计入"总访问量"，
        // 只复用上一条事件并刷新最后访问时间——避免总访问量虚高。
        var anonToken = viewerId == null ? request?.AnonSessionToken : null;
        var dedupWindow = TimeSpan.FromMinutes(ViewDedupWindowMinutes);
        var dedupSince = DateTime.UtcNow - dedupWindow;

        // 去重窗口基于"滚动的最后活动时间"：命中路径会刷新 LastSeenAt，
        // 下次判定应以 LastSeenAt 为准，而非原始 EnteredAt（否则长会话第 N 次
        // 刷新会因原始 EnteredAt 已超窗而误判为新访问，导致 ViewCount 虚增）。
        // 旧行可能没有 LastSeenAt，回退到 EnteredAt。
        var vf = Builders<DocumentStoreViewEvent>.Filter;
        var withinWindow = vf.Or(
            vf.Gte(e => e.LastSeenAt, dedupSince),
            vf.And(
                vf.Eq(e => e.LastSeenAt, (DateTime?)null),
                vf.Gte(e => e.EnteredAt, dedupSince)));

        DocumentStoreViewEvent? recent = null;
        if (!string.IsNullOrEmpty(viewerId))
        {
            recent = await _db.DocumentStoreViewEvents
                .Find(vf.And(
                    vf.Eq(e => e.StoreId, entry.StoreId),
                    vf.Eq(e => e.EntryId, entryId),
                    vf.Eq(e => e.ViewerUserId, viewerId),
                    withinWindow))
                .SortByDescending(e => e.EnteredAt)
                .FirstOrDefaultAsync();
        }
        else if (!string.IsNullOrEmpty(anonToken))
        {
            recent = await _db.DocumentStoreViewEvents
                .Find(vf.And(
                    vf.Eq(e => e.StoreId, entry.StoreId),
                    vf.Eq(e => e.EntryId, entryId),
                    vf.Eq(e => e.ViewerUserId, (string?)null),
                    vf.Eq(e => e.AnonSessionToken, anonToken),
                    withinWindow))
                .SortByDescending(e => e.EnteredAt)
                .FirstOrDefaultAsync();
        }

        if (recent != null)
        {
            // 命中去重窗口：不新建事件、不递增 ViewCount，
            // 仅刷新最后访问时间（停留时长由 leave 端点累加，不在此清零）。
            await _db.DocumentStoreViewEvents.UpdateOneAsync(
                e => e.Id == recent.Id,
                Builders<DocumentStoreViewEvent>.Update
                    .Set(e => e.LastSeenAt, DateTime.UtcNow)
                    .Inc(e => e.RevisitCount, 1));
            return Ok(ApiResponse<object>.Ok(new { viewEventId = recent.Id, deduped = true }));
        }

        var evt = new DocumentStoreViewEvent
        {
            StoreId = entry.StoreId,
            EntryId = entryId,
            ViewerUserId = viewerId,
            ViewerName = viewerName,
            ViewerAvatar = viewerAvatar,
            AnonSessionToken = anonToken,
            UserAgent = string.IsNullOrEmpty(ua) ? null : ua,
            Referer = string.IsNullOrEmpty(referer) ? null : referer,
            LastSeenAt = DateTime.UtcNow,
            // 初始化为数值 0，使 leave 端点的 $inc 累加可安全作用（避免对 null 执行 $inc 报错）
            DurationMs = 0,
        };
        await _db.DocumentStoreViewEvents.InsertOneAsync(evt);

        // 递增 store 的冗余计数（仅去重后的首次访问）
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == entry.StoreId,
            Builders<DocumentStore>.Update.Inc(s => s.ViewCount, 1));

        return Ok(ApiResponse<object>.Ok(new { viewEventId = evt.Id, deduped = false }));
    }

    /// <summary>补写浏览时长（用户离开或切换文档时调用，由 sendBeacon 发起，永远不失败）</summary>
    [HttpPost("view-events/{viewEventId}/leave")]
    [AllowAnonymous]
    public async Task<IActionResult> LeaveEntryView(string viewEventId, [FromBody] LeaveViewRequest? request)
    {
        var durationMs = request?.DurationMs ?? 0;
        if (durationMs < 0) durationMs = 0;
        if (durationMs > 24 * 60 * 60 * 1000) durationMs = 24 * 60 * 60 * 1000; // clamp 到 24 小时

        // 累加而非覆盖：去重窗口内同一访客重开同一文档会复用同一 viewEvent，
        // 每个子访问各自 flush 一次本段时长，必须 Inc 累计，否则后一次会覆盖前一次。
        // useViewTracking.flushIfAny 在每次 flush 后清空 viewEventId，
        // 同一子访问不会重复 leave，故 Inc 不会重复计时。
        await _db.DocumentStoreViewEvents.UpdateOneAsync(
            e => e.Id == viewEventId,
            Builders<DocumentStoreViewEvent>.Update
                .Set(e => e.LeftAt, DateTime.UtcNow)
                .Inc(e => e.DurationMs, durationMs));

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>获取知识库的访客列表（仅 owner 可访问）</summary>
    [HttpGet("stores/{storeId}/view-events")]
    public async Task<IActionResult> ListStoreViewEvents(
        string storeId,
        [FromQuery] int limit = 50)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        limit = Math.Clamp(limit, 1, 200);

        var events = await _db.DocumentStoreViewEvents
            .Find(e => e.StoreId == storeId)
            .SortByDescending(e => e.EnteredAt)
            .Limit(limit)
            .ToListAsync();

        // 聚合统计：总访问量、独立访客数、总停留时长
        // 经 B8 去重改造后，每条 view event 已是"去重窗口内的一次访问"，
        // 因此事件文档总数即为去重后的总访问量（不再因刷新虚高）。
        // 独立访客 / 总时长必须基于全量事件聚合——用 MongoDB 聚合管道在服务端算，
        // 不把该 store 的全量事件文档拉回应用层（store 访问量大时内存/延迟不可控）。
        //
        // BSON 元素名说明：本项目 MongoDB 没有 camelCase ConventionPack，
        // 元素名即 C# 属性名原样 PascalCase（StoreId/ViewerUserId/AnonSessionToken/DurationMs），
        // 仅 Id 属性映射为 _id（driver 默认）。
        var statsPipeline = new[]
        {
            new BsonDocument("$match", new BsonDocument("StoreId", storeId)),
            // 访客分组键：ViewerUserId ?? AnonSessionToken ?? _id（与原 LINQ 语义一致）
            new BsonDocument("$project", new BsonDocument
            {
                { "visitor", new BsonDocument("$ifNull", new BsonArray
                    {
                        "$ViewerUserId",
                        new BsonDocument("$ifNull", new BsonArray { "$AnonSessionToken", "$_id" })
                    })
                },
                { "DurationMs", 1 },
            }),
            new BsonDocument("$facet", new BsonDocument
            {
                // totals：总访问量 + 总停留时长
                { "totals", new BsonArray
                    {
                        new BsonDocument("$group", new BsonDocument
                        {
                            { "_id", BsonNull.Value },
                            { "count", new BsonDocument("$sum", 1) },
                            { "duration", new BsonDocument("$sum",
                                new BsonDocument("$ifNull", new BsonArray { "$DurationMs", 0 })) },
                        })
                    }
                },
                // uniques：独立访客数（两段 group + $count，避免大基数 $addToSet 内存压力）
                { "uniques", new BsonArray
                    {
                        new BsonDocument("$group", new BsonDocument("_id", "$visitor")),
                        new BsonDocument("$count", "count"),
                    }
                },
            }),
        };

        var statsResult = await _db.DocumentStoreViewEvents
            .Aggregate<BsonDocument>(statsPipeline)
            .FirstOrDefaultAsync();

        long totalViews = 0;
        int uniqueVisitorIds = 0;
        long totalDurationMs = 0;
        if (statsResult != null)
        {
            // facet 分支无文档时为空数组，全部兜底 0
            if (statsResult.TryGetValue("totals", out var totalsVal)
                && totalsVal is BsonArray totalsArr && totalsArr.Count > 0
                && totalsArr[0] is BsonDocument totalsDoc)
            {
                if (totalsDoc.TryGetValue("count", out var c) && !c.IsBsonNull)
                    totalViews = c.ToInt64();
                if (totalsDoc.TryGetValue("duration", out var d) && !d.IsBsonNull)
                    totalDurationMs = d.ToInt64();
            }
            if (statsResult.TryGetValue("uniques", out var uniquesVal)
                && uniquesVal is BsonArray uniquesArr && uniquesArr.Count > 0
                && uniquesArr[0] is BsonDocument uniquesDoc
                && uniquesDoc.TryGetValue("count", out var u) && !u.IsBsonNull)
            {
                uniqueVisitorIds = u.ToInt32();
            }
        }

        // 补 entry 标题供前端展示
        var entryIds = events.Where(e => e.EntryId != null).Select(e => e.EntryId!).Distinct().ToList();
        var entries = await _db.DocumentEntries
            .Find(e => entryIds.Contains(e.Id))
            .ToListAsync();
        var entryTitles = entries.ToDictionary(e => e.Id, e => e.Title);

        return Ok(ApiResponse<object>.Ok(new
        {
            stats = new
            {
                totalViews,
                uniqueVisitors = uniqueVisitorIds,
                totalDurationMs,
            },
            events = events.Select(e => new
            {
                e.Id,
                e.EntryId,
                entryTitle = e.EntryId != null && entryTitles.ContainsKey(e.EntryId) ? entryTitles[e.EntryId] : null,
                e.ViewerUserId,
                e.ViewerName,
                e.ViewerAvatar,
                e.EnteredAt,
                e.LeftAt,
                e.DurationMs,
                e.LastSeenAt,
                e.RevisitCount,
                e.UserAgent,
                e.Referer,
            }),
        }));
    }

    // ─────────────────────────────────────────────
    // 批次 D：文档划词评论
    // ─────────────────────────────────────────────

    /// <summary>创建划词评论</summary>
    [HttpPost("entries/{entryId}/inline-comments")]
    public async Task<IActionResult> CreateInlineComment(string entryId, [FromBody] CreateInlineCommentRequest request)
    {
        var userId = GetUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null || store.OwnerId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // B4：允许"不选中也能评论"——SelectedText 为空时视为对整篇文档的通用评论（无锚点）
        var isWholeDocComment = string.IsNullOrWhiteSpace(request.SelectedText);
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "评论内容不能为空"));
        // 仅有锚点评论才强制要求正文（需要正文定位）；全文评论无锚点，允许 DocumentId 为空
        // （图片/音频/扫描 PDF/被无文本文件替换过的条目 DocumentId 为空，仍应能做全文评论）
        if (!isWholeDocComment && string.IsNullOrEmpty(entry.DocumentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该条目尚未关联正文"));

        var userDoc = await FindUserByAnyIdAsync(userId);
        var authorName = userDoc != null && !string.IsNullOrWhiteSpace(userDoc.DisplayName)
            ? userDoc.DisplayName
            : (userDoc?.Username ?? "未知用户");

        // 读取当前正文计算 hash；全文评论且无正文时跳过，ContentHash 留 null
        string? contentHash = null;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var parsed = await _db.Documents.Find(d => d.Id == entry.DocumentId).FirstOrDefaultAsync();
            contentHash = parsed != null ? ComputeSha256(parsed.RawContent ?? "") : null;
        }

        var comment = new DocumentInlineComment
        {
            StoreId = entry.StoreId,
            EntryId = entryId,
            // 全文评论可能无正文，DocumentId 沿用模型非空约定存 string.Empty
            DocumentId = entry.DocumentId ?? string.Empty,
            ContentHash = contentHash,
            // 无选区时 SelectedText 留空，标记为全文评论，不参与 rebind / 正文高亮
            SelectedText = isWholeDocComment ? string.Empty : request.SelectedText,
            ContextBefore = isWholeDocComment ? string.Empty : (request.ContextBefore ?? string.Empty),
            ContextAfter = isWholeDocComment ? string.Empty : (request.ContextAfter ?? string.Empty),
            StartOffset = isWholeDocComment ? 0 : request.StartOffset,
            EndOffset = isWholeDocComment ? 0 : request.EndOffset,
            IsWholeDocument = isWholeDocComment,
            Content = request.Content.Trim(),
            AuthorUserId = userId,
            AuthorDisplayName = authorName,
            AuthorAvatar = userDoc?.AvatarFileName,
        };
        await _db.DocumentInlineComments.InsertOneAsync(comment);
        return Ok(ApiResponse<DocumentInlineComment>.Ok(comment));
    }

    /// <summary>列出文档的划词评论（owner 和公开库访客都能读）</summary>
    [HttpGet("entries/{entryId}/inline-comments")]
    [AllowAnonymous]
    public async Task<IActionResult> ListInlineComments(string entryId)
    {
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 非 owner + 非公开 → 403
        var isOwner = false;
        try
        {
            var currentUser = this.GetRequiredUserId();
            isOwner = store.OwnerId == currentUser;
        }
        catch { }
        if (!isOwner && !store.IsPublic)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var comments = await _db.DocumentInlineComments
            .Find(c => c.EntryId == entryId)
            .SortBy(c => c.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = comments, canCreate = isOwner }));
    }

    /// <summary>删除划词评论</summary>
    [HttpDelete("inline-comments/{commentId}")]
    public async Task<IActionResult> DeleteInlineComment(string commentId)
    {
        var userId = GetUserId();
        var comment = await _db.DocumentInlineComments.Find(c => c.Id == commentId).FirstOrDefaultAsync();
        if (comment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "评论不存在"));

        // 仅作者或 store owner 可删
        var store = await _db.DocumentStores.Find(s => s.Id == comment.StoreId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "评论不存在"));

        if (comment.AuthorUserId != userId && store.OwnerId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("FORBIDDEN", "无权删除此评论"));

        await _db.DocumentInlineComments.DeleteOneAsync(c => c.Id == commentId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    private static string ComputeSha256(string content)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(content);
        var hash = System.Security.Cryptography.SHA256.HashData(bytes);
        return Convert.ToHexString(hash);
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
    public string? ParentId { get; set; }
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

public class CreateDocStoreFolderRequest
{
    public string Name { get; set; } = string.Empty;
    public string? ParentId { get; set; }
}

public class UpdateDocumentEntryRequest
{
    public string? Title { get; set; }
    public string? Summary { get; set; }
    public List<string>? Tags { get; set; }
    public Dictionary<string, string>? Metadata { get; set; }
}

public class AddSubscriptionRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string SourceUrl { get; set; } = string.Empty;
    public int? SyncIntervalMinutes { get; set; }
    public List<string>? Tags { get; set; }
}

public class AddGitHubSubscriptionRequest
{
    public string GithubUrl { get; set; } = string.Empty;
    public string? Title { get; set; }
    public int? SyncIntervalMinutes { get; set; }
    public List<string>? Tags { get; set; }
    public string? IncludeGlob { get; set; }
}

public class UpdateSubscriptionRequest
{
    /// <summary>是否暂停订阅（null 表示不修改）</summary>
    public bool? IsPaused { get; set; }

    /// <summary>新的同步间隔（分钟，null 表示不修改）</summary>
    public int? SyncIntervalMinutes { get; set; }
}

public class ReprocessRequest
{
    /// <summary>模板 key（summary / minutes / blog / notes / custom）</summary>
    public string TemplateKey { get; set; } = string.Empty;

    /// <summary>自定义提示词（templateKey == custom 时必填）</summary>
    public string? CustomPrompt { get; set; }
}

public class SetPrimaryEntryRequest
{
    /// <summary>文档条目 ID，null 或空表示清除主文档</summary>
    public string? EntryId { get; set; }
}

public class TogglePinRequest
{
    /// <summary>文档条目 ID</summary>
    public string EntryId { get; set; } = string.Empty;

    /// <summary>true=置顶, false=取消置顶</summary>
    public bool Pin { get; set; }
}

public class MoveEntryRequest
{
    /// <summary>目标文件夹 ID，null 或空表示移到根级</summary>
    public string? ParentId { get; set; }
}

public class UpdateEntryContentRequest
{
    /// <summary>文档内容（Markdown/纯文本）</summary>
    public string Content { get; set; } = string.Empty;
}

public class CreateShareLinkRequest
{
    /// <summary>分享标题（可选，自定义对外展示名）</summary>
    public string? Title { get; set; }

    /// <summary>分享描述（可选）</summary>
    public string? Description { get; set; }

    /// <summary>过期天数（0 表示永不过期）</summary>
    public int ExpiresInDays { get; set; }
}

public class LogViewRequest
{
    /// <summary>匿名访客 session token（匿名访问时由前端生成存 sessionStorage）</summary>
    public string? AnonSessionToken { get; set; }
}

public class LeaveViewRequest
{
    /// <summary>停留时长（毫秒，前端用 Date.now() 差值计算）</summary>
    public long DurationMs { get; set; }
}

public class CreateInlineCommentRequest
{
    /// <summary>被选中的原文片段</summary>
    public string SelectedText { get; set; } = string.Empty;

    /// <summary>选中片段前的上下文（约 50 字符）</summary>
    public string? ContextBefore { get; set; }

    /// <summary>选中片段后的上下文（约 50 字符）</summary>
    public string? ContextAfter { get; set; }

    /// <summary>起始字符偏移量</summary>
    public int StartOffset { get; set; }

    /// <summary>结束字符偏移量</summary>
    public int EndOffset { get; set; }

    /// <summary>评论内容</summary>
    public string Content { get; set; } = string.Empty;
}
