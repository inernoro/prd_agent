using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

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
    private readonly ILogger<DocumentStoreController> _logger;

    /// <summary>20 MB per file</summary>
    private const long MaxUploadBytes = 20 * 1024 * 1024;

    public DocumentStoreController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        IFileContentExtractor fileContentExtractor,
        IDocumentService documentService,
        ILogger<DocumentStoreController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _fileContentExtractor = fileContentExtractor;
        _documentService = documentService;
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

    /// <summary>创建文件夹</summary>
    [HttpPost("stores/{storeId}/folders")]
    public async Task<IActionResult> CreateFolder(string storeId, [FromBody] CreateDocStoreFolderRequest request)
    {
        var userId = GetUserId();
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
            var kw = keyword.Trim();
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
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync(ct);
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择要上传的文件"));

        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxUploadBytes / 1024 / 1024}MB"));

        // MIME 推断
        var mime = file.ContentType?.ToLowerInvariant() ?? "application/octet-stream";
        if (mime == "application/octet-stream" && !string.IsNullOrWhiteSpace(file.FileName))
        {
            var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
            mime = ext switch
            {
                ".md" or ".mdc" => "text/markdown",
                ".txt" => "text/plain",
                ".pdf" => "application/pdf",
                ".doc" => "application/msword",
                ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".json" => "application/json",
                ".yaml" or ".yml" => "text/yaml",
                ".csv" => "text/csv",
                ".xml" => "application/xml",
                ".html" or ".htm" => "text/html",
                _ => mime,
            };
        }

        // 读取文件字节
        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        // 1) 存储到 COS / 本地
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: "prd-agent", type: "doc");

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
        var title = Path.GetFileNameWithoutExtension(file.FileName);
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
            ContentIndex = contentIndex?.Trim(),
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
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        if (string.IsNullOrWhiteSpace(request.SourceUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "源地址不能为空"));

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));

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
        var userId = GetUserId();
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

        var interval = Math.Clamp(request.SyncIntervalMinutes ?? 1440, 60, 1440); // 1小时 ~ 24小时，默认每天

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
            Metadata = new Dictionary<string, string>
            {
                ["github_owner"] = owner,
                ["github_repo"] = repo,
                ["github_path"] = path,
                ["github_branch"] = branch,
            },
            Tags = request.Tags ?? new List<string>(),
        };

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
        var recentEntries = await _db.DocumentEntries
            .Find(Builders<DocumentEntry>.Filter.And(
                Builders<DocumentEntry>.Filter.In(e => e.StoreId, storeIds),
                Builders<DocumentEntry>.Filter.Eq(e => e.IsFolder, false),
                Builders<DocumentEntry>.Filter.Ne(e => e.SourceType, DocumentSourceType.GithubDirectory)))
            .SortByDescending(e => e.UpdatedAt)
            .Limit(storeIds.Count * 3) // 最多取 N*3 条
            .ToListAsync();

        var entriesByStore = recentEntries
            .GroupBy(e => e.StoreId)
            .ToDictionary(g => g.Key, g => g.Take(3).Select(e => new
            {
                id = e.Id,
                title = e.Title,
                updatedAt = e.UpdatedAt,
                contentType = e.ContentType,
            }).ToList());

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

        // 标记为同步中（BackgroundService 会拾取）
        await _db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update
                .Set(e => e.SyncStatus, DocumentSyncStatus.Syncing)
                .Set(e => e.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { triggered = true }));
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
