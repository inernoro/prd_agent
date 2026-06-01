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
    /// <summary>AgentApiKey scope：读文档空间（满足 admin 权限 document-store.read，见 AdminPermissionMiddleware.HasScopeGrant）</summary>
    public const string ScopeRead = "document-store:read";
    /// <summary>AgentApiKey scope：写文档空间（替代 AI 超级密钥，最小权限归档验收报告）</summary>
    public const string ScopeWrite = "document-store:write";

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly IFileContentExtractor _fileContentExtractor;
    private readonly IDocumentService _documentService;
    private readonly IRunEventStore _runEventStore;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly ITeamService _teams;
    private readonly ITeamActivityService _teamActivity;
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
        ITeamService teams,
        ITeamActivityService teamActivity,
        ILogger<DocumentStoreController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _fileContentExtractor = fileContentExtractor;
        _documentService = documentService;
        _runEventStore = runEventStore;
        _urlValidator = urlValidator;
        _teams = teams;
        _teamActivity = teamActivity;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private async Task<User?> FindUserByAnyIdAsync(string userId)
    {
        return await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
    }

    // ── 团队作用域辅助 ──

    private static bool IsTeamShared(DocumentStore s, List<string> myTeamIds)
        => s.SharedTeamIds != null && s.SharedTeamIds.Any(myTeamIds.Contains);

    /// <summary>可写：拥有者 或 团队成员（决策 10 全员可编辑；不含 public）</summary>
    private static bool CanWriteStore(DocumentStore s, string userId, List<string> myTeamIds)
        => s.OwnerId == userId || IsTeamShared(s, myTeamIds);

    /// <summary>可读：拥有者 或 公开 或 团队成员</summary>
    private static bool CanReadStore(DocumentStore s, string userId, List<string> myTeamIds)
        => s.OwnerId == userId || s.IsPublic || IsTeamShared(s, myTeamIds);

    /// <summary>
    /// 判定本次写入是否"机器归档"（带 kind=acceptance-report 标记）。
    /// 机器归档对模板硬卡（缺项 422），人工手写软提醒（标记不合规但放行）。
    /// </summary>
    private static bool IsMachineTemplatedWrite(IReadOnlyDictionary<string, string>? metadata)
        => metadata != null && metadata.TryGetValue("kind", out var kind)
           && string.Equals(kind, "acceptance-report", StringComparison.OrdinalIgnoreCase);

    /// <summary>构造模板校验失败的 422 响应（缺失项清单写入 message）</summary>
    private IActionResult TemplateValidationError(KbTemplate template, IReadOnlyList<string> problems)
        => StatusCode(422, ApiResponse<object>.Fail(
            ErrorCodes.TEMPLATE_VALIDATION_FAILED,
            $"不符合知识库模板「{template.Label}」要求：{string.Join("；", problems)}"));

    /// <summary>加载并校验可写空间。无权返回错误 IActionResult，调用方据此短路</summary>
    private async Task<(DocumentStore? store, IActionResult? error)> LoadWritableStoreAsync(string storeId, string userId)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return (null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在")));
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (!CanWriteStore(store, userId, myTeamIds))
            return (null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在")));
        return (store, null);
    }

    private async Task<(string userId, string userName, string? avatarFileName)> GetActorWithAvatarAsync()
    {
        var userId = GetUserId();
        var user = await FindUserByAnyIdAsync(userId);
        var userName = user != null && !string.IsNullOrWhiteSpace(user.DisplayName)
            ? user.DisplayName
            : (user?.Username ?? "未知用户");
        return (userId, userName, user?.AvatarFileName);
    }

    /// <summary>把动作记到 store 所分享的所有团队（store.SharedTeamIds 为空则 no-op）</summary>
    private async Task LogStoreActivityAsync(DocumentStore store, string userId, string action, string targetType, string? targetId, string? targetTitle)
    {
        if (store.SharedTeamIds == null || store.SharedTeamIds.Count == 0) return;
        await _teamActivity.LogForTeamsAsync(store.SharedTeamIds, TeamAppKey.DocumentStore, userId, action, targetType, targetId, targetTitle);
    }

    /// <summary>加载条目 + 其所属空间并校验可写（拥有者或团队成员）。无权返回错误 IActionResult</summary>
    private async Task<(DocumentEntry? entry, DocumentStore? store, IActionResult? error)> LoadWritableEntryAsync(string entryId, string userId)
    {
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在")));
        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null)
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在")));
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (!CanWriteStore(store, userId, myTeamIds))
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在")));
        return (entry, store, null);
    }

    /// <summary>加载条目 + 其所属空间并校验可读（拥有者/公开/团队成员）。无权返回错误 IActionResult</summary>
    private async Task<(DocumentEntry? entry, DocumentStore? store, IActionResult? error)> LoadReadableEntryAsync(string entryId, string userId)
    {
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在")));
        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null)
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在")));
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (!CanReadStore(store, userId, myTeamIds))
            return (null, null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在")));
        return (entry, store, null);
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
            IsPublic = request.IsPublic,
            TemplateKey = string.IsNullOrWhiteSpace(request.TemplateKey) ? null : request.TemplateKey.Trim()
        };

        await _db.DocumentStores.InsertOneAsync(store);

        _logger.LogInformation("[document-store] Store created: {StoreId} '{Name}' by {UserId}",
            store.Id, store.Name, userId);

        return Ok(ApiResponse<DocumentStore>.Ok(store));
    }

    /// <summary>获取文档空间列表。scope=team + teamId 时返回该团队共享的空间，默认返回我的</summary>
    [HttpGet("stores")]
    public async Task<IActionResult> ListStores(
        [FromQuery] int page = 1, [FromQuery] int pageSize = 20,
        [FromQuery] string? scope = null, [FromQuery] string? teamId = null)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        FilterDefinition<DocumentStore> filter;
        if (string.Equals(scope, "team", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(teamId))
        {
            var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
            if (!myTeamIds.Contains(teamId))
                return Ok(ApiResponse<object>.Ok(new { items = new List<DocumentStore>(), total = 0, page, pageSize }));
            filter = Builders<DocumentStore>.Filter.AnyEq(s => s.SharedTeamIds, teamId);
        }
        else
        {
            filter = Builders<DocumentStore>.Filter.Eq(s => s.OwnerId, userId);
        }

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

        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (!CanReadStore(store, userId, myTeamIds))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));

        return Ok(ApiResponse<DocumentStore>.Ok(store));
    }

    /// <summary>更新文档空间信息</summary>
    [HttpPut("stores/{storeId}")]
    public async Task<IActionResult> UpdateStore(string storeId, [FromBody] UpdateDocumentStoreRequest request)
    {
        var userId = GetUserId();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;

        var updates = new List<UpdateDefinition<DocumentStore>>();

        if (request.Name != null)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.Name, request.Name.Trim()));
        if (request.Description != null)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.Description, request.Description.Trim()));
        if (request.Tags != null)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.Tags, request.Tags));
        if (request.IsPublic.HasValue)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.IsPublic, request.IsPublic.Value));
        if (request.TemplateKey != null)
            updates.Add(Builders<DocumentStore>.Update.Set(s => s.TemplateKey,
                string.IsNullOrWhiteSpace(request.TemplateKey) ? null : request.TemplateKey.Trim()));

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
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;

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

    /// <summary>删除文档空间（级联清理所有关联数据）。
    /// 仅 owner 可删——团队成员能写条目不等于能删整个 store，
    /// 否则任何被分享团队的成员都能级联抹掉 owner 的所有条目/附件/分享/评论/点赞/收藏（codex-bot 2026-05-28 P1）。</summary>
    [HttpDelete("stores/{storeId}")]
    public async Task<IActionResult> DeleteStore(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在"));
        if (store.OwnerId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有创建者可以删除文档空间"));

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
        var (userId, userName, avatarFileName) = await GetActorWithAvatarAsync();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档标题不能为空"));

        // 模板校验：store 命中模板时校验必填 metadata。
        // 机器归档（kind=acceptance-report）缺项硬卡 422；人工手写软提醒（标记 templateCompliant=false 放行）。
        var metadata = request.Metadata ?? new Dictionary<string, string>();
        var template = AcceptanceTemplateRegistry.FindByKey(store!.TemplateKey);
        if (template != null)
        {
            var problems = AcceptanceTemplateRegistry.ValidateMetadata(template, metadata);
            if (problems.Count > 0)
            {
                if (IsMachineTemplatedWrite(metadata))
                    return TemplateValidationError(template, problems);
                metadata["templateCompliant"] = "false";
            }
        }

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
            Metadata = metadata,
            CreatedBy = userId,
            CreatedByName = userName,
            CreatedByAvatarFileName = avatarFileName,
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

        await LogStoreActivityAsync(store!, userId, TeamActivityAction.EntryCreated, "entry", entry.Id, entry.Title);

        return Ok(ApiResponse<DocumentEntry>.Ok(entry));
    }

    /// <summary>创建文件夹</summary>
    [HttpPost("stores/{storeId}/folders")]
    public async Task<IActionResult> CreateFolder(string storeId, [FromBody] CreateDocStoreFolderRequest request)
    {
        var (userId, userName, avatarFileName) = await GetActorWithAvatarAsync();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;

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
            CreatedByName = userName,
            CreatedByAvatarFileName = avatarFileName,
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

        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (!CanReadStore(store, userId, myTeamIds))
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

        // 标黄用：本批文档里哪些存在「单篇」有效分享（未撤销 + 未过期）
        // 过期判定放内存做，规避可空 DateTime 进 Mongo 表达式树
        var now = DateTime.UtcNow;
        var pageEntryIds = items.Where(e => !e.IsFolder).Select(e => e.Id).ToHashSet();
        var storeShareLinks = await _db.DocumentStoreShareLinks
            .Find(l => l.StoreId == storeId && !l.IsRevoked)
            .ToListAsync();
        var sharedEntryIds = storeShareLinks
            .Where(l => !string.IsNullOrEmpty(l.EntryId) && (l.ExpiresAt == null || l.ExpiresAt > now) && pageEntryIds.Contains(l.EntryId!))
            .Select(l => l.EntryId!)
            .Distinct()
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize, sharedEntryIds }));
    }

    /// <summary>获取文档条目详情</summary>
    [HttpGet("entries/{entryId}")]
    public async Task<IActionResult> GetEntry(string entryId)
    {
        var userId = GetUserId();
        var (entry, _, error) = await LoadReadableEntryAsync(entryId, userId);
        if (error != null) return error;

        return Ok(ApiResponse<DocumentEntry>.Ok(entry!));
    }

    /// <summary>更新文档条目信息</summary>
    [HttpPut("entries/{entryId}")]
    public async Task<IActionResult> UpdateEntry(string entryId, [FromBody] UpdateDocumentEntryRequest request)
    {
        var (userId, userName) = await GetActorInfoAsync();
        var (entry, store, error) = await LoadWritableEntryAsync(entryId, userId);
        if (error != null) return error;

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
        await LogStoreActivityAsync(store!, userId, TeamActivityAction.EntryUpdated, "entry", entryId, updated?.Title);
        return Ok(ApiResponse<DocumentEntry>.Ok(updated!));
    }

    /// <summary>删除文档条目（级联清理同步日志 + 正文 + 附件；文件夹会级联删除子条目）</summary>
    [HttpDelete("entries/{entryId}")]
    public async Task<IActionResult> DeleteEntry(string entryId)
    {
        var userId = GetUserId();
        var (entry, store, error) = await LoadWritableEntryAsync(entryId, userId);
        if (error != null) return error;
        if (entry is null || store is null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var entryTitle = entry.Title;

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

        await LogStoreActivityAsync(store, userId, TeamActivityAction.EntryDeleted, "entry", entryId, entryTitle);

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
        var (entry, store, error) = await LoadWritableEntryAsync(entryId, userId);
        if (error != null) return error;
        if (entry is null)
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
        var (entry, store, error) = await LoadWritableEntryAsync(entryId, userId);
        if (error != null) return error;
        if (entry is null || store is null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        if (entry.IsFolder)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹不支持编辑"));

        var content = request.Content ?? string.Empty;

        // 模板校验：store 命中模板时校验正文必备 section。
        // 机器归档（entry.metadata.kind=acceptance-report）缺 section 硬卡 422；人工手写软提醒放行。
        var contentTemplate = AcceptanceTemplateRegistry.FindByKey(store.TemplateKey);
        bool? contentCompliant = null;
        if (contentTemplate != null)
        {
            var sectionProblems = AcceptanceTemplateRegistry.ValidateContentSections(contentTemplate, content);
            if (sectionProblems.Count > 0 && IsMachineTemplatedWrite(entry.Metadata))
                return TemplateValidationError(contentTemplate, sectionProblems);
            // 合规 = 正文 section 齐 且 必填 metadata 齐。否则会把 AddEntry 标的 false 误覆盖成 true。
            var metaProblems = AcceptanceTemplateRegistry.ValidateMetadata(contentTemplate, entry.Metadata);
            contentCompliant = sectionProblems.Count == 0 && metaProblems.Count == 0;
        }

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

        // 模板库的人工写入：持久化合规标记，前端可据此提示「缺 需求一一对应表」
        if (contentCompliant.HasValue)
        {
            await _db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entryId,
                Builders<DocumentEntry>.Update.Set("Metadata.templateCompliant", contentCompliant.Value ? "true" : "false"));
        }

        // 重锚定划词评论：正文更新后，遍历所有 active 评论，用 SelectedText + context 重新定位
        var rebindStats = await RebindInlineCommentsAsync(entryId, content);

        await LogStoreActivityAsync(store, userId, TeamActivityAction.EntryUpdated, "entry", entryId, entry.Title);

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
        // 全文评论（IsWholeDocument）无锚点，不参与正文 rebind。
        // 用 Ne(IsWholeDocument, true) 而非 !c.IsWholeDocument：后者被 LINQ 译成
        // { IsWholeDocument: false } 会漏掉缺该字段的历史评论（IsWholeDocument 是新增字段）；
        // Ne(...,true) 在 MongoDB 下匹配 false / null / 缺字段三种，正好覆盖历史数据。
        var rebindFilter = Builders<DocumentInlineComment>.Filter.And(
            Builders<DocumentInlineComment>.Filter.Eq(c => c.EntryId, entryId),
            Builders<DocumentInlineComment>.Filter.Eq(c => c.Status, DocumentInlineCommentStatus.Active),
            Builders<DocumentInlineComment>.Filter.Ne(c => c.IsWholeDocument, true));
        var comments = await _db.DocumentInlineComments
            .Find(rebindFilter)
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

        var store = await _db.DocumentStores.Find(s => s.Id == folder.StoreId).FirstOrDefaultAsync();
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (store == null || !CanWriteStore(store, userId, myTeamIds))
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
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;

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
        var (userId, userName, avatarFileName) = await GetActorWithAvatarAsync();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync(ct);
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        if (store == null || !CanWriteStore(store, userId, myTeamIds))
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
            CreatedByName = userName,
            CreatedByAvatarFileName = avatarFileName,
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

        await LogStoreActivityAsync(store, userId, TeamActivityAction.EntryCreated, "entry", entry.Id, entry.Title);

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

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync(ct);
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        if (store == null || !CanWriteStore(store, userId, myTeamIds))
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
            // 同 RebindInlineCommentsAsync：用 Ne(IsWholeDocument, true) 而非 !c.IsWholeDocument，
            // 否则缺该字段的历史评论会被静默排除（漏置 Orphaned）。
            var orphanFilter = Builders<DocumentInlineComment>.Filter.And(
                Builders<DocumentInlineComment>.Filter.Eq(c => c.EntryId, entryId),
                Builders<DocumentInlineComment>.Filter.Eq(c => c.Status, DocumentInlineCommentStatus.Active),
                Builders<DocumentInlineComment>.Filter.Ne(c => c.IsWholeDocument, true));
            await _db.DocumentInlineComments.UpdateManyAsync(
                orphanFilter,
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
                // ParsedPrd.Id 由内容哈希派生：解析正文相同的多个条目会共享同一个 DocumentId。
                // 删除前先做引用计数守卫——仍有其它条目指向它则跳过，避免误删共享正文/预览。
                var stillReferenced = await _db.DocumentEntries
                    .Find(e => e.DocumentId == oldDocumentId && e.Id != entryId)
                    .AnyAsync(CancellationToken.None);
                if (!stillReferenced)
                {
                    await _db.Documents.DeleteOneAsync(d => d.Id == oldDocumentId, CancellationToken.None);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[document-store] Replace cleanup: 删除旧 ParsedPrd 失败 docId={DocId} entry={EntryId}", oldDocumentId, entryId);
            }
        }
        // Attachment 为条目独占：上传与替换每次都新建独立 Attachment（默认 Guid Id，
        // grep `AttachmentId =` 仅 request 传入 / 新建赋值，无复用共享场景），故直接删旧记录。
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
        var (entry, _, error) = await LoadReadableEntryAsync(entryId, userId);
        if (error != null) return error;
        if (entry is null)
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
    // 跨环境同步：导出 / 导入（design.acceptance-kb.md §5.C）
    // ─────────────────────────────────────────────

    /// <summary>
    /// 导出整库为 bundle JSON（测试↔正式环境同步用）。
    /// 文本类条目导出正文 markdown；二进制附件本期只标 skipped，不打包文件体。
    /// </summary>
    [HttpGet("stores/{storeId}/export")]
    public async Task<IActionResult> ExportStore(string storeId)
    {
        var userId = GetUserId();
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;

        var entries = await _db.DocumentEntries.Find(e => e.StoreId == storeId).ToListAsync();
        var exported = new List<object>();
        var skippedBinary = 0;

        foreach (var e in entries)
        {
            string? content = null;
            if (!e.IsFolder && !string.IsNullOrEmpty(e.DocumentId))
            {
                var doc = await _documentService.GetByIdAsync(e.DocumentId);
                content = doc?.RawContent;
            }
            var binaryOnly = !e.IsFolder && string.IsNullOrEmpty(content) && !string.IsNullOrEmpty(e.AttachmentId);
            if (binaryOnly) skippedBinary++;

            exported.Add(new
            {
                exportId = e.Id,
                parentExportId = e.ParentId,
                isFolder = e.IsFolder,
                title = e.Title,
                summary = e.Summary,
                sourceType = e.SourceType,
                contentType = e.ContentType,
                fileSize = e.FileSize,
                tags = e.Tags,
                metadata = e.Metadata,
                content,
                binarySkipped = binaryOnly,
            });
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            version = 1,
            store = new
            {
                store!.Name,
                store.Description,
                store.Tags,
                store.IsPublic,
                store.TemplateKey,
                store.CoverImageUrl,
            },
            entries = exported,
            stats = new { total = entries.Count, binarySkipped = skippedBinary },
        }));
    }

    /// <summary>
    /// 导入 bundle（跨环境同步用）。按库名 find-or-create（owner=调用方），
    /// 按 metadata.reportId 幂等去重（已存在跳过），保留文件夹层级。
    /// 导入的是已验收报告，不再过模板校验。
    /// </summary>
    [HttpPost("stores/import")]
    public async Task<IActionResult> ImportStore([FromBody] ImportStoreBundle bundle)
    {
        var (userId, userName, avatarFileName) = await GetActorWithAvatarAsync();
        if (bundle == null || bundle.Store == null || string.IsNullOrWhiteSpace(bundle.Store.Name) || bundle.Entries == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "bundle 格式不正确"));

        var meta = bundle.Store;
        var entries = bundle.Entries;
        var store = await _db.DocumentStores
            .Find(s => s.OwnerId == userId && s.Name == meta.Name).FirstOrDefaultAsync();
        if (store == null)
        {
            store = new DocumentStore
            {
                Name = meta.Name.Trim(),
                Description = meta.Description,
                OwnerId = userId,
                Tags = meta.Tags ?? new List<string>(),
                IsPublic = meta.IsPublic,
                TemplateKey = string.IsNullOrWhiteSpace(meta.TemplateKey) ? null : meta.TemplateKey.Trim(),
                CoverImageUrl = meta.CoverImageUrl,
            };
            await _db.DocumentStores.InsertOneAsync(store);
        }
        else if (!string.IsNullOrWhiteSpace(meta.TemplateKey) && store.TemplateKey != meta.TemplateKey.Trim())
        {
            // 复用已存在的同名库：补 bundle 带来的 templateKey，否则目标库 templateKey 为 null，
            // 排序/校验不生效（与归档脚本复用库补 templateKey 同理）。
            var tk = meta.TemplateKey.Trim();
            await _db.DocumentStores.UpdateOneAsync(s => s.Id == store.Id,
                Builders<DocumentStore>.Update.Set(s => s.TemplateKey, tk).Set(s => s.UpdatedAt, DateTime.UtcNow));
            store.TemplateKey = tk;
        }

        var existing = await _db.DocumentEntries.Find(e => e.StoreId == store.Id).ToListAsync();
        var existingReportIds = new HashSet<string>(existing
            .Where(e => e.Metadata != null && e.Metadata.ContainsKey("reportId"))
            .Select(e => e.Metadata["reportId"]));
        // 已存在文件夹按 (parentId, title) 索引，重复导入时复用而非重建（保证幂等）
        var existingFolders = existing.Where(e => e.IsFolder)
            .GroupBy(e => (e.ParentId ?? "", e.Title))
            .ToDictionary(g => g.Key, g => g.First().Id);

        var idMap = new Dictionary<string, string>(); // exportId -> 新 entryId
        int created = 0, skipped = 0, failed = 0;

        // 文件夹先建（按层级 parent-first，多趟扫描直到无进展）
        var pendingFolders = entries.Where(e => e.IsFolder).ToList();
        var guard = 0;
        while (pendingFolders.Count > 0 && guard++ < 1000)
        {
            var progressed = false;
            foreach (var f in pendingFolders.ToList())
            {
                string? newParent = null;
                if (!string.IsNullOrEmpty(f.ParentExportId) && !idMap.TryGetValue(f.ParentExportId, out newParent))
                    continue; // 父文件夹还没建，下一趟再来

                // 幂等：同 (parent, title) 已存在则复用，不重复建
                var folderKey = (newParent ?? "", f.Title);
                if (existingFolders.TryGetValue(folderKey, out var reuseId))
                {
                    idMap[f.ExportId] = reuseId;
                    skipped++;
                    pendingFolders.Remove(f);
                    progressed = true;
                    continue;
                }

                var folder = new DocumentEntry
                {
                    StoreId = store.Id,
                    ParentId = newParent,
                    IsFolder = true,
                    Title = f.Title,
                    SourceType = DocumentSourceType.Upload,
                    ContentType = "application/x-folder",
                    Tags = f.Tags ?? new List<string>(),
                    Metadata = f.Metadata ?? new Dictionary<string, string>(),
                    CreatedBy = userId,
                    CreatedByName = userName,
                    CreatedByAvatarFileName = avatarFileName,
                    UpdatedBy = userId,
                    UpdatedByName = userName,
                };
                await _db.DocumentEntries.InsertOneAsync(folder);
                idMap[f.ExportId] = folder.Id;
                existingFolders[folderKey] = folder.Id; // 同次导入内也复用
                created++;
                pendingFolders.Remove(f);
                progressed = true;
            }
            if (!progressed) break; // 剩下的是孤儿父引用，停止
        }

        // 文件类条目
        foreach (var fe in entries.Where(e => !e.IsFolder))
        {
            try
            {
                // 跳过无正文的非文件夹条目：本期同步只搬文本正文，无正文（含二进制 skipped、
                // 或纯标题空壳）建出来也是空壳，且无 reportId 时重复同步会重复插入，一律跳过。
                if (string.IsNullOrEmpty(fe.Content)) { skipped++; continue; }

                var reportId = fe.Metadata != null && fe.Metadata.TryGetValue("reportId", out var rid) ? rid : null;
                if (!string.IsNullOrEmpty(reportId) && existingReportIds.Contains(reportId)) { skipped++; continue; }

                string? parentId = null;
                if (!string.IsNullOrEmpty(fe.ParentExportId)) idMap.TryGetValue(fe.ParentExportId, out parentId);

                var entry = new DocumentEntry
                {
                    StoreId = store.Id,
                    ParentId = parentId,
                    IsFolder = false,
                    Title = fe.Title,
                    Summary = fe.Summary,
                    SourceType = DocumentSourceType.Import,
                    ContentType = string.IsNullOrEmpty(fe.ContentType) ? "text/markdown" : fe.ContentType,
                    FileSize = fe.FileSize,
                    Tags = fe.Tags ?? new List<string>(),
                    Metadata = fe.Metadata ?? new Dictionary<string, string>(),
                    CreatedBy = userId,
                    CreatedByName = userName,
                    CreatedByAvatarFileName = avatarFileName,
                    UpdatedBy = userId,
                    UpdatedByName = userName,
                    LastChangedAt = DateTime.UtcNow,
                };

                if (!string.IsNullOrEmpty(fe.Content))
                {
                    var parsed = await _documentService.ParseAsync(fe.Content);
                    parsed.Title = fe.Title;
                    await _documentService.SaveAsync(parsed);
                    entry.DocumentId = parsed.Id;
                    entry.ContentIndex = fe.Content.Length > 2000 ? fe.Content[..2000] : fe.Content;
                }

                await _db.DocumentEntries.InsertOneAsync(entry);
                if (!string.IsNullOrEmpty(reportId)) existingReportIds.Add(reportId);
                created++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[document-store] import entry failed: {Title}", fe.Title);
                failed++;
            }
        }

        var count = await _db.DocumentEntries.CountDocumentsAsync(e => e.StoreId == store.Id);
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<DocumentStore>.Update
                .Set(s => s.DocumentCount, (int)count)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[document-store] Imported into store {StoreId}: +{Created} ~{Skipped} skipped, {Failed} failed",
            store.Id, created, skipped, failed);

        return Ok(ApiResponse<object>.Ok(new { storeId = store.Id, created, skipped, failed }));
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
        var (store, error) = await LoadWritableStoreAsync(storeId, userId);
        if (error != null) return error;
        if (store is null)
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

    /// <summary>获取文档空间列表（含最近文档预览，用于卡片展示）。scope=team + teamId 时返回团队共享空间</summary>
    [HttpGet("stores/with-preview")]
    public async Task<IActionResult> ListStoresWithPreview(
        [FromQuery] int page = 1, [FromQuery] int pageSize = 20,
        [FromQuery] string? scope = null, [FromQuery] string? teamId = null)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var isTeamScope = string.Equals(scope, "team", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(teamId);
        FilterDefinition<DocumentStore> filter;
        if (isTeamScope)
        {
            var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
            if (!myTeamIds.Contains(teamId!))
                return Ok(ApiResponse<object>.Ok(new { items = new List<object>(), total = 0, page, pageSize }));
            filter = Builders<DocumentStore>.Filter.AnyEq(s => s.SharedTeamIds, teamId);
        }
        else
        {
            filter = Builders<DocumentStore>.Filter.Eq(s => s.OwnerId, userId);
        }
        var total = await _db.DocumentStores.CountDocumentsAsync(filter);
        var stores = await _db.DocumentStores.Find(filter)
            .SortByDescending(s => s.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        // 批量获取每个空间的最近 3 个文档（用于卡片预览）
        var storeIds = stores.Select(s => s.Id).ToList();
        var entriesByStore = await LoadRecentEntriesByStoreAsync(storeIds);

        // 标黄用：哪些库存在「整库级」有效分享（未撤销 + 未过期 + EntryId 为空）
        // 过期/为空判定放内存做，避免可空 DateTime 进 Mongo 表达式树的边界问题
        var now = DateTime.UtcNow;
        var activeStoreLinks = await _db.DocumentStoreShareLinks
            .Find(l => storeIds.Contains(l.StoreId) && !l.IsRevoked)
            .ToListAsync();
        var sharedStoreIds = activeStoreLinks
            .Where(l => string.IsNullOrEmpty(l.EntryId) && (l.ExpiresAt == null || l.ExpiresAt > now))
            .Select(l => l.StoreId)
            .ToHashSet();

        // 团队作用域：批量取创建者头像/昵称，供卡片顶部成员归属展示
        Dictionary<string, User> ownerMap = new();
        if (isTeamScope)
        {
            var ownerIds = stores.Select(s => s.OwnerId).Where(o => !string.IsNullOrWhiteSpace(o)).Distinct().ToList();
            if (ownerIds.Count > 0)
            {
                var owners = await _db.Users.Find(u => ownerIds.Contains(u.UserId)).ToListAsync();
                ownerMap = owners.ToDictionary(u => u.UserId, u => u);
            }
        }

        var items = stores.Select(s =>
        {
            ownerMap.TryGetValue(s.OwnerId, out var owner);
            return new
            {
                s.Id,
                s.Name,
                s.Description,
                s.OwnerId,
                ownerName = owner != null
                    ? (!string.IsNullOrWhiteSpace(owner.DisplayName) ? owner.DisplayName : owner.Username)
                    : null,
                ownerAvatarFileName = owner?.AvatarFileName,
                s.AppKey,
                s.Tags,
                s.IsPublic,
                s.SharedTeamIds,
                s.PrimaryEntryId,
                s.PinnedEntryIds,
                s.DocumentCount,
                s.LikeCount,
                s.ViewCount,
                s.FavoriteCount,
                s.CreatedAt,
                s.UpdatedAt,
                hasActiveShare = sharedStoreIds.Contains(s.Id),
                recentEntries = entriesByStore.GetValueOrDefault(s.Id, new()),
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>设置知识库分享到的团队（仅 owner 可调）</summary>
    [HttpPatch("stores/{storeId}/teams")]
    public async Task<IActionResult> SetStoreTeams(string storeId, [FromBody] SetStoreTeamsRequest request)
    {
        var userId = GetUserId();
        // 分享出去是所有权动作，仅 owner 可设
        var store = await _db.DocumentStores.Find(s => s.Id == storeId && s.OwnerId == userId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档空间不存在或无权限"));

        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        var sanitized = (request.TeamIds ?? new List<string>()).Where(t => myTeamIds.Contains(t)).Distinct().ToList();
        var added = sanitized.Except(store.SharedTeamIds ?? new List<string>()).ToList();

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update
                .Set(s => s.SharedTeamIds, sanitized)
                .Set(s => s.UpdatedAt, DateTime.UtcNow));

        if (added.Count > 0)
            await _teamActivity.LogForTeamsAsync(added, TeamAppKey.DocumentStore, userId,
                TeamActivityAction.StoreShared, "store", store.Id, store.Name);

        store.SharedTeamIds = sanitized;
        return Ok(ApiResponse<DocumentStore>.Ok(store));
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

    /// <summary>
    /// 列出当前用户可调用的「再加工·智能体」：系统内置 + 自己创建的个人智能体。
    /// 不包含其他用户的 personal 智能体。
    /// </summary>
    [HttpGet("reprocess-agents")]
    public async Task<IActionResult> ListReprocessAgents()
    {
        var userId = GetUserId();
        var filter = Builders<ReprocessAgent>.Filter.Or(
            Builders<ReprocessAgent>.Filter.Eq(a => a.Visibility, ReprocessAgentVisibility.System),
            Builders<ReprocessAgent>.Filter.And(
                Builders<ReprocessAgent>.Filter.Eq(a => a.Visibility, ReprocessAgentVisibility.Personal),
                Builders<ReprocessAgent>.Filter.Eq(a => a.OwnerUserId, userId)));

        var list = await _db.ReprocessAgents.Find(filter)
            .Sort(Builders<ReprocessAgent>.Sort
                .Ascending(a => a.Visibility) // system 在前（"personal" 字典序在 "system" 前，反转: 见下）
                .Ascending(a => a.SortOrder)
                .Ascending(a => a.CreatedAt))
            .ToListAsync();

        // 手动稳定排序：system 在前，再按 SortOrder / CreatedAt
        var items = list
            .OrderBy(a => a.Visibility == ReprocessAgentVisibility.System ? 0 : 1)
            .ThenBy(a => a.SortOrder)
            .ThenBy(a => a.CreatedAt)
            .Select(a => new
            {
                id = a.Id,
                key = a.Key,
                label = a.Label,
                description = a.Description,
                systemPrompt = a.SystemPrompt,
                visibility = a.Visibility,
                isOwn = a.OwnerUserId == userId,
                createdAt = a.CreatedAt,
            }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建一个个人再加工智能体（Visibility=personal）</summary>
    [HttpPost("reprocess-agents")]
    public async Task<IActionResult> CreateReprocessAgent([FromBody] CreateReprocessAgentRequest request)
    {
        var label = (request.Label ?? "").Trim();
        var systemPrompt = (request.SystemPrompt ?? "").Trim();
        var description = (request.Description ?? "").Trim();
        if (string.IsNullOrEmpty(label))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "label 不能为空"));
        if (string.IsNullOrEmpty(systemPrompt))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "systemPrompt 不能为空"));
        if (label.Length > 30)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "label 不超过 30 字"));
        if (description.Length > 200)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "description 不超过 200 字"));
        if (systemPrompt.Length > 8000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "systemPrompt 不超过 8000 字"));

        var userId = GetUserId();
        // 个人智能体 Key 自动加用户前缀避免与 system 冲突
        var rawSlug = SlugifyLabel(label);
        var key = $"u-{userId[..Math.Min(6, userId.Length)]}-{rawSlug}-{Guid.NewGuid().ToString("N")[..6]}";

        var agent = new ReprocessAgent
        {
            Key = key,
            Label = label,
            Description = description,
            SystemPrompt = systemPrompt,
            Visibility = ReprocessAgentVisibility.Personal,
            OwnerUserId = userId,
            SortOrder = 100,
            CreatedAt = DateTime.UtcNow,
        };
        await _db.ReprocessAgents.InsertOneAsync(agent);

        return Ok(ApiResponse<object>.Ok(new
        {
            id = agent.Id,
            key = agent.Key,
            label = agent.Label,
            description = agent.Description,
            systemPrompt = agent.SystemPrompt,
            visibility = agent.Visibility,
            isOwn = true,
            createdAt = agent.CreatedAt,
        }));
    }

    /// <summary>删除一个自己的个人再加工智能体（system 不允许删）</summary>
    [HttpDelete("reprocess-agents/{id}")]
    public async Task<IActionResult> DeleteReprocessAgent(string id)
    {
        var userId = GetUserId();
        var agent = await _db.ReprocessAgents.Find(a => a.Id == id).FirstOrDefaultAsync();
        if (agent == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "智能体不存在"));
        if (agent.Visibility != ReprocessAgentVisibility.Personal || agent.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只能删除自己创建的智能体"));

        await _db.ReprocessAgents.DeleteOneAsync(a => a.Id == id);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    private static string SlugifyLabel(string label)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var ch in label.ToLowerInvariant())
        {
            if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) sb.Append(ch);
            else if (sb.Length > 0 && sb[^1] != '-') sb.Append('-');
        }
        var s = sb.ToString().Trim('-');
        if (string.IsNullOrEmpty(s)) s = "agent";
        if (s.Length > 20) s = s[..20];
        return s;
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

    /// <summary>发起文档再加工任务（保留旧接口，等价于一次性发送首条 chat 消息）</summary>
    [HttpPost("entries/{entryId}/reprocess")]
    public async Task<IActionResult> Reprocess(string entryId, [FromBody] ReprocessRequest request)
    {
        var templateKey = (request.TemplateKey ?? "").Trim();
        if (string.IsNullOrEmpty(templateKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "templateKey 不能为空"));

        var content = (request.CustomPrompt ?? "").Trim();
        if (templateKey == "custom" && string.IsNullOrEmpty(content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "自定义模板需要提供 customPrompt"));

        // 模板模式下若用户没填补充指令，给一句默认的 user 消息
        if (string.IsNullOrEmpty(content))
            content = "请按所选模板处理这篇文档。";

        // 与 SendReprocessChat 同一校验：templateKey 必须存在于内置模板或可见智能体里，否则 400
        // 否则 typo / 旧 key 会静默走 generic prompt（Codex P2）
        var keyError = await ValidateReprocessTemplateKeyAsync(templateKey);
        if (keyError != null) return keyError;

        return await SendReprocessChatInternal(entryId, runId: null, content: content, templateKey: templateKey);
    }

    /// <summary>发送一条再加工对话消息（首次会自动建 Run；后续追加到同一 Run）</summary>
    [HttpPost("entries/{entryId}/reprocess/chat")]
    public async Task<IActionResult> SendReprocessChat(string entryId, [FromBody] ReprocessChatRequest request)
    {
        var content = (request.Content ?? "").Trim();
        if (string.IsNullOrEmpty(content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "content 不能为空"));

        var templateKey = string.IsNullOrWhiteSpace(request.TemplateKey) ? null : request.TemplateKey!.Trim();
        var keyError = await ValidateReprocessTemplateKeyAsync(templateKey);
        if (keyError != null) return keyError;

        return await SendReprocessChatInternal(entryId, request.RunId, content, templateKey);
    }

    /// <summary>校验 templateKey：内置模板 / custom / 当前用户可访问的智能体 → 通过；否则 400</summary>
    private async Task<IActionResult?> ValidateReprocessTemplateKeyAsync(string? templateKey)
    {
        if (templateKey == null || templateKey == "custom") return null;
        if (ReprocessTemplateRegistry.FindByKey(templateKey) != null) return null;

        var userId = GetUserId();
        var agentExists = await _db.ReprocessAgents.Find(a =>
            a.Key == templateKey
            && (a.Visibility == ReprocessAgentVisibility.System
                || (a.Visibility == ReprocessAgentVisibility.Personal && a.OwnerUserId == userId)))
            .AnyAsync();
        if (agentExists) return null;

        return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"未知模板/智能体: {templateKey}"));
    }

    private async Task<IActionResult> SendReprocessChatInternal(
        string entryId, string? runId, string content, string? templateKey)
    {
        var (entry, store, err) = await LoadOwnedEntryAsync(entryId);
        if (err != null) return err;
        if (entry!.IsFolder)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹不支持再加工"));

        var userId = GetUserId();

        DocumentStoreAgentRun? run = null;
        if (!string.IsNullOrEmpty(runId))
        {
            run = await _db.DocumentStoreAgentRuns
                .Find(r => r.Id == runId && r.UserId == userId && r.SourceEntryId == entryId)
                .FirstOrDefaultAsync();
            if (run == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Run 不存在"));
            if (run.Status == DocumentStoreRunStatus.Running || run.Status == DocumentStoreRunStatus.Queued)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "上一轮还未结束，请稍候"));
        }

        var nextSeq = run?.Messages.Count ?? 0;
        var userMsg = new ReprocessChatMessage
        {
            Seq = nextSeq,
            Role = "user",
            Content = content,
            TemplateKey = templateKey,
            CreatedAt = DateTime.UtcNow,
        };

        if (run == null)
        {
            run = new DocumentStoreAgentRun
            {
                Kind = DocumentStoreAgentRunKind.Reprocess,
                SourceEntryId = entryId,
                StoreId = store!.Id,
                UserId = userId,
                TemplateKey = templateKey,
                CustomPrompt = templateKey == "custom" ? content : null,
                Status = DocumentStoreRunStatus.Queued,
                Phase = "排队中",
                Messages = new List<ReprocessChatMessage> { userMsg },
            };
            await _db.DocumentStoreAgentRuns.InsertOneAsync(run);
        }
        else
        {
            // 已 Done 的 Run：追加 user 消息 + 重置 status=queued 让 worker 再 pick 一次
            await _db.DocumentStoreAgentRuns.UpdateOneAsync(
                r => r.Id == run.Id,
                Builders<DocumentStoreAgentRun>.Update
                    .Push(r => r.Messages, userMsg)
                    .Set(r => r.Status, DocumentStoreRunStatus.Queued)
                    .Set(r => r.Phase, "排队中")
                    .Set(r => r.Progress, 0)
                    .Set(r => r.GeneratedText, null)
                    .Set(r => r.EndedAt, (DateTime?)null)
                    .Set(r => r.ErrorMessage, null),
                cancellationToken: CancellationToken.None);
        }

        // 给 SSE 端推一条 userMessage 事件方便前端镜像（不影响处理流程）
        try
        {
            await _runEventStore.AppendEventAsync(
                DocumentStoreRunKinds.Reprocess, run.Id, "userMessage",
                new { messageSeq = userMsg.Seq, content = userMsg.Content, templateKey = userMsg.TemplateKey },
                ct: CancellationToken.None);
        }
        catch { /* ignore */ }

        _logger.LogInformation(
            "[doc-store-agent] Reprocess chat queued: run={RunId} entry={EntryId} seq={Seq}",
            run.Id, entryId, userMsg.Seq);
        return Ok(ApiResponse<object>.Ok(new { runId = run.Id, status = run.Status, messageSeq = userMsg.Seq }));
    }

    /// <summary>获取某文档的活跃再加工会话（按用户 + entry 取最近一条 Run，含完整 messages，用于打开抽屉恢复对话）</summary>
    [HttpGet("entries/{entryId}/reprocess/active-run")]
    public async Task<IActionResult> GetActiveReprocessRun(string entryId)
    {
        var (_, _, err) = await LoadOwnedEntryAsync(entryId);
        if (err != null) return err;

        var userId = GetUserId();
        var run = await _db.DocumentStoreAgentRuns
            .Find(r => r.SourceEntryId == entryId
                       && r.UserId == userId
                       && r.Kind == DocumentStoreAgentRunKind.Reprocess)
            .SortByDescending(r => r.CreatedAt)
            .FirstOrDefaultAsync();
        return Ok(ApiResponse<DocumentStoreAgentRun?>.Ok(run));
    }

    /// <summary>
    /// 写回任意一段内容到文档（replace / append / new），不依赖 reprocess Run。
    /// 用于：抽屉直接通过 /ai-toolbox/direct-chat 拿到的回复内容，前端把字符串塞进来就能落库。
    /// </summary>
    [HttpPost("entries/{entryId}/reprocess/apply-content")]
    public async Task<IActionResult> ApplyContent(
        string entryId,
        [FromBody] ApplyContentRequest request,
        [FromServices] ContentReprocessApplyService applyService)
    {
        var (entry, _, err) = await LoadOwnedEntryAsync(entryId);
        if (err != null) return err;
        if (entry!.IsFolder)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹不支持写入"));

        var mode = (request.Mode ?? "").Trim().ToLowerInvariant();
        if (mode != "replace" && mode != "append" && mode != "new")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "mode 必须是 replace/append/new"));
        var content = (request.Content ?? "").Trim();
        if (string.IsNullOrEmpty(content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "content 不能为空"));

        // 复用 ApplyService 内部逻辑：构造一个临时 Run+Message 喂给它，避免重复实现写盘细节
        var userId = GetUserId();
        var tmpRun = new DocumentStoreAgentRun
        {
            Id = Guid.NewGuid().ToString("N"),
            Kind = DocumentStoreAgentRunKind.Reprocess,
            SourceEntryId = entryId,
            StoreId = entry.StoreId,
            UserId = userId,
            Status = DocumentStoreRunStatus.Done,
            Messages = new List<ReprocessChatMessage>
            {
                new() { Seq = 0, Role = "assistant", Content = content, CreatedAt = DateTime.UtcNow },
            },
        };
        try
        {
            var result = await applyService.ApplyAsync(tmpRun, entry, messageSeq: 0, mode, request.Title, _db);
            return Ok(ApiResponse<object>.Ok(new
            {
                mode = result.Mode,
                outputEntryId = result.OutputEntryId,
                updatedEntryId = result.UpdatedEntryId,
            }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>把对话中某条 assistant 消息写回文档（replace / append / new）</summary>
    [HttpPost("agent-runs/{runId}/apply")]
    public async Task<IActionResult> ApplyReprocess(
        string runId,
        [FromBody] ReprocessApplyRequest request,
        [FromServices] ContentReprocessApplyService applyService)
    {
        var userId = GetUserId();
        var run = await _db.DocumentStoreAgentRuns
            .Find(r => r.Id == runId && r.UserId == userId && r.Kind == DocumentStoreAgentRunKind.Reprocess)
            .FirstOrDefaultAsync();
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "Run 不存在"));

        var (entry, _, err) = await LoadOwnedEntryAsync(run.SourceEntryId);
        if (err != null) return err;

        var mode = (request.Mode ?? "").Trim().ToLowerInvariant();
        if (mode != "replace" && mode != "append" && mode != "new")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "mode 必须是 replace/append/new"));

        try
        {
            var result = await applyService.ApplyAsync(run, entry!, request.MessageSeq, mode, request.Title, _db);

            // 若是新建 entry，把 outputEntryId 记到 run 里，方便后续展示
            if (result.Mode == "new" && !string.IsNullOrEmpty(result.OutputEntryId))
            {
                await _db.DocumentStoreAgentRuns.UpdateOneAsync(
                    r => r.Id == run.Id,
                    Builders<DocumentStoreAgentRun>.Update.Set(r => r.OutputEntryId, result.OutputEntryId),
                    cancellationToken: CancellationToken.None);
            }

            return Ok(ApiResponse<object>.Ok(new
            {
                mode = result.Mode,
                outputEntryId = result.OutputEntryId,
                updatedEntryId = result.UpdatedEntryId,
            }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
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

        return Ok(ApiResponse<object>.Ok(await BuildEntryContentPayloadAsync(entry)));
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
                tags = e.Tags ?? new List<string>(),
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

        // 单篇文档分享：校验 entry 属于本知识库，快照标题
        string? entryId = null;
        string? entryTitle = null;
        if (!string.IsNullOrWhiteSpace(request.EntryId))
        {
            var entry = await _db.DocumentEntries.Find(e => e.Id == request.EntryId && e.StoreId == storeId).FirstOrDefaultAsync();
            if (entry == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "要分享的文档不存在或不属于该知识库"));
            if (entry.IsFolder)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "目录不支持单独分享"));
            entryId = entry.Id;
            entryTitle = entry.Title;
        }

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var link = new DocumentStoreShareLink
        {
            StoreId = storeId,
            StoreName = store.Name,
            EntryId = entryId,
            EntryTitle = entryTitle,
            Title = request.Title?.Trim(),
            Description = request.Description?.Trim(),
            CreatedBy = userId,
            CreatedByName = user?.DisplayName,
            ExpiresAt = request.ExpiresInDays > 0 ? DateTime.UtcNow.AddDays(request.ExpiresInDays) : null,
        };
        await _db.DocumentStoreShareLinks.InsertOneAsync(link);

        // 注意：知识库分享目前没有可用的前端展示页（App.tsx 无 /library/share/:token 路由，
        // ShortLinkRouter 对 document_store 走 UnsupportedTargetError）。因此暂不注册 ShortLink
        // 数字短链，避免对外暴露打不开的 /s/{seq} 链接。待补齐 /library/share/:token 视图后
        // 再纳入短链体系（详见 doc/debt.share-link-security.md）。
        // 前端 DocumentStorePage 历史用 /library/share/{token}（自己拼），此处不返回 url 字段。

        // 返回完整 DocumentStoreShareLink，保持前端 DocumentStoreShareLink 类型契约不变
        //（前端 DocumentStorePage prepend 到 list 后会渲染 viewCount/createdAt/isRevoked，
        //  缺字段会回归；且前端自己用 token 拼 /library/share/{token}，不依赖后端 url 字段）
        // ShortLink 已通过上面 AllocateAsync 注册，分享总管理 / 体检页另行查询，不靠此返回值。
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
            // 单篇文档分享时非 null，前端据此只展示该篇而非整库
            entryId = link.EntryId,
            entryTitle = link.EntryTitle,
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

    /// <summary>列出分享链接对应知识库的文档（匿名，token 门禁；单篇分享只返回该篇）</summary>
    [HttpGet("public/share/{token}/entries")]
    [AllowAnonymous]
    public async Task<IActionResult> ListShareEntries(string token)
    {
        var link = await ResolveActiveShareLinkAsync(token);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在或已撤销"));

        List<DocumentEntry> items;
        if (!string.IsNullOrEmpty(link.EntryId))
        {
            // 单篇分享：只暴露该篇
            items = await _db.DocumentEntries.Find(e => e.Id == link.EntryId && e.StoreId == link.StoreId).ToListAsync();
        }
        else
        {
            items = await _db.DocumentEntries.Find(e => e.StoreId == link.StoreId)
                .SortByDescending(e => e.IsFolder)
                .ThenByDescending(e => e.CreatedAt)
                .Limit(500)
                .ToListAsync();
        }

        return Ok(ApiResponse<object>.Ok(new { items, total = items.Count }));
    }

    /// <summary>读取分享链接内某篇文档的正文（匿名，token 门禁 + entry 必须属于该库/单篇）</summary>
    [HttpGet("public/share/{token}/entries/{entryId}/content")]
    [AllowAnonymous]
    public async Task<IActionResult> GetShareEntryContent(string token, string entryId)
    {
        var link = await ResolveActiveShareLinkAsync(token);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在或已撤销"));

        // 单篇分享只能读那一篇；整库分享必须是该库内的条目
        if (!string.IsNullOrEmpty(link.EntryId) && entryId != link.EntryId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "该文档不在分享范围内"));

        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId && e.StoreId == link.StoreId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档不存在"));

        return Ok(ApiResponse<object>.Ok(await BuildEntryContentPayloadAsync(entry)));
    }

    /// <summary>解析有效（未撤销/未过期）的分享链接，找不到返回 null</summary>
    private async Task<DocumentStoreShareLink?> ResolveActiveShareLinkAsync(string token)
    {
        var link = await _db.DocumentStoreShareLinks.Find(l => l.Token == token).FirstOrDefaultAsync();
        if (link == null || link.IsRevoked) return null;
        if (link.ExpiresAt.HasValue && link.ExpiresAt.Value < DateTime.UtcNow) return null;
        return link;
    }

    /// <summary>构造单篇文档正文 payload（公开库 / 分享 token 两条路径共用）</summary>
    private async Task<object> BuildEntryContentPayloadAsync(DocumentEntry entry)
    {
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

        return new
        {
            entryId = entry.Id,
            title = title ?? entry.Title,
            content,
            contentType = entry.ContentType,
            fileUrl,
            hasContent = !string.IsNullOrEmpty(content),
        };
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
        // 每个子访问各自 flush 一次本段时长，必须累计，否则后一次会覆盖前一次。
        // useViewTracking.flushIfAny 在每次 flush 后清空 viewEventId，
        // 同一子访问不会重复 leave，故累加不会重复计时。
        //
        // 用聚合管道更新（$set + $add + $ifNull）而非 .Inc：本 PR 虽给新建事件
        // 初始化 DurationMs=0，但历史 view event 文档可能 DurationMs=null，
        // MongoDB $inc 作用于 null 字段会报错；leave 经 sendBeacon 调用、错误被静默吞，
        // 丢时长无声无息。$ifNull 把 null 视作 0 后再 $add，旧 null 行也能正确累加。
        // 字段名为 C# 属性名原样 PascalCase（本仓库无 camelCase ConventionPack，
        // DocumentStoreViewEvent 无自定义 BsonClassMap），故为 "$DurationMs"/"LeftAt"。
        var leaveSetStage = new BsonDocument("$set", new BsonDocument
        {
            { "LeftAt", DateTime.UtcNow },
            { "DurationMs", new BsonDocument("$add", new BsonArray
                {
                    new BsonDocument("$ifNull", new BsonArray { "$DurationMs", 0 }),
                    durationMs,
                }) },
        });
        var leaveUpdate = Builders<DocumentStoreViewEvent>.Update.Pipeline(
            new BsonDocument[] { leaveSetStage });
        await _db.DocumentStoreViewEvents.UpdateOneAsync(
            e => e.Id == viewEventId,
            leaveUpdate);

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
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 评论写权限收紧（PR #685 Cursor Bugbot / Codex High-Severity 反馈）：
        // 之前放宽到"私有库 + 有任何非撤销分享链 → 任何登录用户可写"是错误的，
        // 因为没有验证调用方是否真的通过分享 token 访问，知道 entryId 就能越权评论。
        // 现在只允许：owner 自己；公开库（IsPublic=true）的登录用户。
        // 私有库即便有分享链，第三方也不能评论 —— 评论是创作者间的协作，不是访客功能。
        var allowed = store.OwnerId == userId || store.IsPublic;
        if (!allowed)
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

    /// <summary>列出文档的划词评论（owner / 公开库 / 持有效分享 token 的访客可读）</summary>
    [HttpGet("entries/{entryId}/inline-comments")]
    [AllowAnonymous]
    public async Task<IActionResult> ListInlineComments(string entryId, [FromQuery] string? shareToken = null)
    {
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 评论读权限（PR #685 Codex P1 二次反馈后收紧到 valid share context）：
        // - owner：可读 + 可写
        // - 公开库（IsPublic=true）：登录可读写、匿名只读
        // - 私有库：仅当调用方带【有效的分享 token】（属于本 store + 未撤销 + 未过期）才可读
        //   评论气泡。不再用"存在任意分享链"放行——那会让任何知 entryId 的登录用户、
        //   甚至凭过期/无关的分享，枚举读取私有库评论。写权限始终只给 owner + 公开库。
        // - 私有库无 token / token 无效：仅 owner
        string? currentUser = null;
        try { currentUser = this.GetRequiredUserId(); } catch { }
        var isOwner = currentUser != null && store.OwnerId == currentUser;

        // 校验分享 token 是否真的授权访问本 store + 本 entry（scope 到具体 share context）
        // EntryId == null = 整库分享，能读库内任意 entry 的评论；
        // EntryId == entryId = 单篇分享，只能读本篇；
        // EntryId != entryId = 单篇分享但访问别篇 → 拒绝（PR #685 Codex P1：单文档 token 不能越权读整库评论）。
        var hasValidShareContext = false;
        if (!string.IsNullOrWhiteSpace(shareToken))
        {
            var nowUtc = DateTime.UtcNow;
            hasValidShareContext = await _db.DocumentStoreShareLinks
                .Find(s => s.Token == shareToken
                    && s.StoreId == store.Id
                    && (s.EntryId == null || s.EntryId == entryId)
                    && !s.IsRevoked
                    && (s.ExpiresAt == null || s.ExpiresAt > nowUtc))
                .AnyAsync();
        }

        var canRead = isOwner || store.IsPublic || hasValidShareContext;
        if (!canRead)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 写权限只给 owner 和公开库登录用户；分享访客仅可读评论气泡，不能写入。
        var canCreate = isOwner || (currentUser != null && store.IsPublic);

        var comments = await _db.DocumentInlineComments
            .Find(c => c.EntryId == entryId)
            .SortBy(c => c.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = comments, canCreate }));
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
    /// <summary>知识库模板键（如 acceptance-report-v2）。非空时写入条目按模板校验。</summary>
    public string? TemplateKey { get; set; }
}

public class UpdateDocumentStoreRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }
    public bool? IsPublic { get; set; }
    /// <summary>知识库模板键（传空字符串可清除约束）。</summary>
    public string? TemplateKey { get; set; }
}

public class SetStoreTeamsRequest
{
    /// <summary>知识库要分享到的团队 ID 列表（空表示取消所有团队分享）</summary>
    public List<string>? TeamIds { get; set; }
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

// ── 跨环境同步 bundle（design.acceptance-kb.md §5.C）──

public class ImportStoreBundle
{
    public int Version { get; set; }
    public ImportStoreMeta? Store { get; set; }
    public List<ImportEntry>? Entries { get; set; }
}

public class ImportStoreMeta
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }
    public bool IsPublic { get; set; }
    public string? TemplateKey { get; set; }
    public string? CoverImageUrl { get; set; }
}

public class ImportEntry
{
    /// <summary>源环境的 entry id（仅用于重建文件夹层级映射，不直接复用）</summary>
    public string ExportId { get; set; } = string.Empty;
    public string? ParentExportId { get; set; }
    public bool IsFolder { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Summary { get; set; }
    public string? SourceType { get; set; }
    public string? ContentType { get; set; }
    public long FileSize { get; set; }
    public List<string>? Tags { get; set; }
    public Dictionary<string, string>? Metadata { get; set; }
    public string? Content { get; set; }
    public bool BinarySkipped { get; set; }
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

public class ReprocessChatRequest
{
    /// <summary>已有 Run id；空表示新建会话</summary>
    public string? RunId { get; set; }

    /// <summary>user 消息内容（非空）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>若由模板 chip 触发，记录所选模板 key（仅首条消息生效，决定 system prompt）</summary>
    public string? TemplateKey { get; set; }
}

public class ReprocessApplyRequest
{
    /// <summary>要写回的 assistant 消息序号</summary>
    public int MessageSeq { get; set; }

    /// <summary>replace / append / new</summary>
    public string Mode { get; set; } = string.Empty;

    /// <summary>mode=new 时的标题（可选，默认 "{源标题}-AI 再加工.md"）</summary>
    public string? Title { get; set; }
}

public class ApplyContentRequest
{
    /// <summary>replace / append / new</summary>
    public string Mode { get; set; } = string.Empty;

    /// <summary>要写回的正文（必填）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>mode=new 时的标题（可选）</summary>
    public string? Title { get; set; }
}

public class CreateReprocessAgentRequest
{
    /// <summary>智能体展示名（必填，≤30 字）</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>简短描述（可选，≤200 字）</summary>
    public string? Description { get; set; }

    /// <summary>system prompt（必填，≤8000 字）</summary>
    public string SystemPrompt { get; set; } = string.Empty;
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

    /// <summary>单篇文档分享：DocumentEntry.Id；不传 = 分享整个知识库</summary>
    public string? EntryId { get; set; }
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
