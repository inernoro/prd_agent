using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 文档空间（知识库）开放接口 —— 专供外部 AI / Agent（含 MCP 连接器）只读访问。
///
/// 鉴权：Authorization: Bearer sk-ak-xxxx（AgentApiKey），scope document-store:read（写 scope 隐含读）。
///
/// 为什么单独建：DocumentStoreController 的 stores/entries 业务路由在
/// AdminControllerScanner.PublicRoutes 里（给 JWT 普通用户用），跳过 scope→身份注入，其
/// GetUserId()=GetRequiredUserId() 只读 sub，sk-ak 没有 sub 会 401。本控制器走与海鲜市场开放接口
/// 一致的 ApiKey + RequireScope + boundUserId 模式，不依赖中间件注入身份。
///
/// 可见性：owner ‖ public ‖ team-shared（DocumentStoreController.CanReadStoreAsync 的安全子集，
/// 绝不越权）。不覆盖 shitu/product/pmProject 专用库——那些走各自专用 Agent，不在通用 MCP 范围。
///
/// 写入（document-store:write）只允许 owner 自己的通用库：读能读到 team-shared，写不行 ——
/// 智能体替我写东西，落点必须是我自己的库，不该悄悄改到别人共享给我的库里。
/// 正文落盘复用 EntryContentWriteService（与人工编辑、版本恢复同一条路径），不另写一份。
/// </summary>
[ApiController]
[Route("api/open/document-store")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class DocumentStoreOpenApiController : ControllerBase
{
    public const string ScopeRead = "document-store:read";
    public const string ScopeWrite = "document-store:write";

    private readonly MongoDbContext _db;
    private readonly ITeamService _teams;
    private readonly IDocumentService _documentService;
    private readonly Services.EntryContentWriteService _entryContentWriter;
    private readonly ILogger<DocumentStoreOpenApiController> _logger;

    public DocumentStoreOpenApiController(
        MongoDbContext db,
        ITeamService teams,
        IDocumentService documentService,
        Services.EntryContentWriteService entryContentWriter,
        ILogger<DocumentStoreOpenApiController> logger)
    {
        _db = db;
        _teams = teams;
        _documentService = documentService;
        _entryContentWriter = entryContentWriter;
        _logger = logger;
    }

    /// <summary>从 AgentApiKey 鉴权结果取绑定用户。失败抛 401。</summary>
    private string GetBoundUserId()
    {
        var id = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(id))
            throw new UnauthorizedAccessException("Missing boundUserId claim");
        return id;
    }

    /// <summary>可读安全子集：owner ‖ public ‖ team-shared。</summary>
    private static bool CanRead(DocumentStore s, string userId, List<string> myTeamIds)
        => s.OwnerId == userId
           || s.IsPublic
           || (s.SharedTeamIds != null && s.SharedTeamIds.Any(myTeamIds.Contains));

    /// <summary>
    /// 通用库判定：排除项目库 / 产品库 / 识途库等专用库。这些走各自专用 Agent 的访问控制
    /// （IsPmProjectMember / IsProductKnowledgeMember / IsShituKnowledgeReadable），不在通用 MCP 范围。
    /// ListStores 已用该条件过滤，entries/content 也必须一致拦截，避免知道 storeId/entryId 就绕过。
    /// </summary>
    private static bool IsGenericStore(DocumentStore s)
        => string.IsNullOrEmpty(s.PmProjectId)
           && string.IsNullOrEmpty(s.ProductKnowledgeRef)
           && string.IsNullOrEmpty(s.ShituCategoryRef);

    /// <summary>列出当前密钥所属用户自己的知识库（排除项目库/产品库/识途库等专用库）。</summary>
    [HttpGet("stores")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> ListStores([FromQuery] int limit, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var resolved = limit is > 0 and <= 200 ? limit : 50;
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        var b = Builders<DocumentStore>.Filter;
        // 与 entries/content 的 CanRead 对齐：owner + team-shared 都可发现。
        // 不含全站 public（那是海量 IsPublic 库的火药桶，且不属于"用户自己的知识库"）；
        // public 库靠分享链直达，知道 id 仍可经 entries/content 读取。
        var visible = myTeamIds.Count > 0
            ? b.Or(b.Eq(s => s.OwnerId, userId), b.AnyIn(s => s.SharedTeamIds, myTeamIds))
            : b.Eq(s => s.OwnerId, userId);
        var filter = b.And(
            visible,
            b.Eq(s => s.PmProjectId, (string?)null),
            b.Eq(s => s.ProductKnowledgeRef, (string?)null),
            b.Eq(s => s.ShituCategoryRef, (string?)null));
        var items = await _db.DocumentStores.Find(filter)
            .SortByDescending(s => s.UpdatedAt)
            .Limit(resolved)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            items = items.Select(s => new
            {
                id = s.Id,
                name = s.Name,
                description = s.Description,
                tags = s.Tags ?? new List<string>(),
                isPublic = s.IsPublic,
                updatedAt = s.UpdatedAt,
            })
        }));
    }

    /// <summary>列出某知识库下的文档条目（扁平返回，含嵌套文件夹内的文档；可选关键词过滤标题）。</summary>
    [HttpGet("stores/{storeId}/entries")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> ListEntries(string storeId, [FromQuery] string? keyword, [FromQuery] int limit, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync(ct);
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        if (!IsGenericStore(store) || !CanRead(store, userId, myTeamIds))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));

        var resolved = limit is > 0 and <= 500 ? limit : 200;
        var b = Builders<DocumentEntry>.Filter;
        var filter = b.And(b.Eq(e => e.StoreId, storeId), b.Eq(e => e.IsFolder, false));
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var rx = new MongoDB.Bson.BsonRegularExpression(
                System.Text.RegularExpressions.Regex.Escape(keyword.Trim()), "i");
            filter = b.And(filter, b.Regex(e => e.Title, rx));
        }
        var entries = await _db.DocumentEntries.Find(filter).Limit(resolved).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            items = entries.Select(e => new
            {
                id = e.Id,
                title = e.Title,
                summary = e.Summary,
                contentType = e.ContentType,
                parentId = e.ParentId,
                category = e.Category,
                tags = e.Tags ?? new List<string>(),
            })
        }));
    }

    /// <summary>读取某文档条目的完整正文内容。</summary>
    [HttpGet("entries/{entryId}/content")]
    [RequireScope(ScopeRead, ScopeWrite)]
    public async Task<IActionResult> GetEntryContent(string entryId, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync(ct);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));
        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync(ct);
        if (store == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        if (!IsGenericStore(store) || !CanRead(store, userId, myTeamIds))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));

        // 与 DocumentStoreController.GetEntryContent 一致：优先 ParsedPrd.RawContent，兜底 Attachment.ExtractedText，
        // 并附带 Attachment.Url（纯附件且无可提取正文时，让客户端仍能拿到文件下载地址）。
        string? content = null;
        string? title = null;
        string? fileUrl = null;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc != null) { content = doc.RawContent; title = doc.Title; }
        }
        if (!string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await _db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync(ct);
            if (att != null)
            {
                if (string.IsNullOrEmpty(content)) { content = att.ExtractedText; title ??= att.FileName; }
                fileUrl = string.IsNullOrEmpty(att.Url) ? null : att.Url;
            }
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

    // ======================================================================
    // 写入：智能体把整理好的东西放回我的知识库
    // ======================================================================

    /// <summary>写入落点：必须是我自己的通用库。</summary>
    private async Task<(DocumentStore? store, IActionResult? error)> LoadWritableStoreAsync(string storeId, string userId, CancellationToken ct)
    {
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync(ct);
        if (store == null || !IsGenericStore(store))
            return (null, NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在")));
        if (store.OwnerId != userId)
            return (null, StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只能写入你自己的知识库；别人共享给你的库是只读的")));
        // 带结构模板的库（如验收报告库）第一期不开放给智能体写。
        // 人工那条路径会过 AcceptanceTemplateRegistry 校必填元数据与章节、并记 templateCompliant；
        // 这里没有那一层，放行等于让智能体往结构化库里塞不合规的记录，而且看不出来。
        // 与其复制一份校验（判据迟早各漂各的），不如先把门关上、说清楚为什么。补法记在 debt.platform.md。
        if (!string.IsNullOrWhiteSpace(store.TemplateKey))
            return (null, StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(
                ErrorCodes.PERMISSION_DENIED,
                $"这个知识库绑了结构模板（{store.TemplateKey}），第一期不开放给智能体写入 —— 模板的必填元数据与章节校验只在人工编辑那条路径上。请在界面里写，或换一个没有模板的库。")));
        return (store, null);
    }

    private async Task<(string userId, string? displayName)> GetActorAsync(CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        return (userId, user?.DisplayName ?? user?.Username);
    }

    public class CreateStoreRequest
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public List<string>? Tags { get; set; }
        /// <summary>幂等键：同一把密钥用同一个值重复提交只会建一个库。</summary>
        public string? ClientRequestId { get; set; }
    }

    /// <summary>新建一个知识库（归当前密钥主人所有，默认私有）。</summary>
    [HttpPost("stores")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> CreateStore([FromBody] CreateStoreRequest req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        if (string.IsNullOrWhiteSpace(req?.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "知识库名称不能为空"));

        // 幂等走确定性 id，不走「先查后建」：后者在两次重试叠在一起时两边都查不到，各建一个库。
        // 撞主键就是命中，把既有的那个回去。
        var deterministicId = DeterministicId("kb-store", BuildIdempotencyKey(req.ClientRequestId));
        var store = new DocumentStore
        {
            Name = req.Name.Trim(),
            Description = string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim(),
            OwnerId = userId,
            Tags = req.Tags ?? new List<string>(),
            IsPublic = false,
        };
        if (deterministicId != null) store.Id = deterministicId;
        try
        {
            await _db.DocumentStores.InsertOneAsync(store, cancellationToken: ct);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && deterministicId != null)
        {
            var existed = await _db.DocumentStores
                .Find(s => s.Id == deterministicId && s.OwnerId == userId)
                .FirstOrDefaultAsync(ct);
            if (existed == null) throw;
            return Ok(ApiResponse<object>.Ok(new { storeId = existed.Id, name = existed.Name, deduplicated = true }));
        }
        return Ok(ApiResponse<object>.Ok(new { storeId = store.Id, name = store.Name }));
    }

    public class CreateEntryRequest
    {
        public string? Title { get; set; }
        public string? Content { get; set; }
        public string? Summary { get; set; }
        public List<string>? Tags { get; set; }
        public string? ParentId { get; set; }
        /// <summary>幂等键：同一把密钥用同一个值重复提交只会写进去一次（智能体重试很常见）。</summary>
        public string? ClientRequestId { get; set; }
    }

    /// <summary>往我的知识库写一篇文档（标题 + Markdown 正文一次到位）。</summary>
    [HttpPost("stores/{storeId}/entries")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> CreateEntry(string storeId, [FromBody] CreateEntryRequest req, CancellationToken ct)
    {
        var (userId, displayName) = await GetActorAsync(ct);
        var (store, error) = await LoadWritableStoreAsync(storeId, userId, ct);
        if (error != null) return error;
        if (string.IsNullOrWhiteSpace(req?.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档标题不能为空"));

        var content = req.Content ?? string.Empty;
        if (content.Length > MaxContentChars)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"正文超过 {MaxContentChars} 字上限，请拆成多篇或先精简"));

        // 幂等：同一把密钥 + 同一个 clientRequestId 只写一次。
        // 判据走**确定性 id**（撞主键即命中），不走「先查后建」—— 后者在两次重试叠在一起时
        // 两边都查不到，各写一篇、计数各加一次，而幂等键正是为了不发生这件事。
        var idempotencyKey = BuildIdempotencyKey(req.ClientRequestId);
        var deterministicId = DeterministicId("kb-entry", idempotencyKey);
        if (deterministicId != null)
        {
            var existed = await _db.DocumentEntries
                .Find(e => e.Id == deterministicId && e.StoreId == storeId)
                .FirstOrDefaultAsync(ct);
            if (existed != null)
                return Ok(ApiResponse<object>.Ok(new { entryId = existed.Id, title = existed.Title, deduplicated = true }));
        }

        var entry = new DocumentEntry
        {
            StoreId = storeId,
            ParentId = string.IsNullOrWhiteSpace(req.ParentId) ? null : req.ParentId,
            Title = req.Title.Trim(),
            Summary = string.IsNullOrWhiteSpace(req.Summary) ? null : req.Summary.Trim(),
            SourceType = DocumentSourceType.Upload,
            ContentType = "text/markdown",
            Tags = req.Tags ?? new List<string>(),
            Metadata = idempotencyKey == null
                ? new Dictionary<string, string> { ["createdVia"] = "mcp" }
                : new Dictionary<string, string> { ["createdVia"] = "mcp", ["mcpRequestId"] = idempotencyKey },
            CreatedBy = userId,
            CreatedByName = displayName,
            UpdatedBy = userId,
            UpdatedByName = displayName,
            LastChangedAt = DateTime.UtcNow,
        };
        if (deterministicId != null) entry.Id = deterministicId;
        try
        {
            await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: ct);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && deterministicId != null)
        {
            var raced = await _db.DocumentEntries
                .Find(e => e.Id == deterministicId && e.StoreId == storeId)
                .FirstOrDefaultAsync(ct);
            if (raced == null) throw;
            return Ok(ApiResponse<object>.Ok(new { entryId = raced.Id, title = raced.Title, deduplicated = true }));
        }
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == storeId,
            Builders<DocumentStore>.Update.Inc(s => s.DocumentCount, 1).Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        if (content.Length > 0)
        {
            try
            {
                await _entryContentWriter.WriteAsync(entry, store!, content, userId, displayName,
                    DocumentVersionSource.Edit, contentTypeOverride: "text/markdown");
            }
            catch (Exception ex)
            {
                // 正文没落盘就把条目撤回去。留着的话，条目上已经带着幂等键了 ——
                // 智能体拿同一个 clientRequestId 重试会命中去重、拿到「成功」，
                // 而那篇文档永远是空的，计数也多了一。一次存储抖动就此变成永久的残缺数据。
                await _db.DocumentEntries.DeleteOneAsync(e => e.Id == entry.Id, CancellationToken.None);
                await _db.DocumentStores.UpdateOneAsync(
                    s => s.Id == storeId,
                    Builders<DocumentStore>.Update.Inc(s => s.DocumentCount, -1).Set(s => s.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
                _logger.LogWarning(ex, "[mcp] 知识库写入正文失败，已撤回条目 entryId={EntryId} storeId={StoreId}", entry.Id, storeId);
                return StatusCode(500, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR,
                    "正文没有写进去，这篇文档已经撤回，请用同一个 clientRequestId 重试"));
            }
        }

        return Ok(ApiResponse<object>.Ok(new { entryId = entry.Id, storeId, title = entry.Title }));
    }

    public class UpdateEntryContentRequest
    {
        public string? Content { get; set; }
    }

    /// <summary>覆盖某篇文档的正文（会留一版历史，可在界面里回滚）。</summary>
    [HttpPut("entries/{entryId}/content")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> UpdateEntryContent(string entryId, [FromBody] UpdateEntryContentRequest req, CancellationToken ct)
    {
        var (userId, displayName) = await GetActorAsync(ct);
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync(ct);
        if (entry == null || entry.IsFolder)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档条目不存在"));
        var (store, error) = await LoadWritableStoreAsync(entry.StoreId, userId, ct);
        if (error != null) return error;

        var content = req?.Content ?? string.Empty;
        if (content.Length > MaxContentChars)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"正文超过 {MaxContentChars} 字上限，请拆成多篇或先精简"));

        await _entryContentWriter.WriteAsync(entry, store!, content, userId, displayName,
            DocumentVersionSource.Edit, contentTypeOverride: entry.ContentType);
        return Ok(ApiResponse<object>.Ok(new { entryId = entry.Id, title = entry.Title }));
    }

    /// <summary>单篇正文上限。挡住智能体一次糊一本书进来，也挡住它把上下文里的垃圾整个倒进知识库。</summary>
    private const int MaxContentChars = 200_000;

    /// <summary>把幂等键压成确定性文档 id（32 位十六进制，与随机 id 同形）。没给幂等键就返回 null。</summary>
    private static string? DeterministicId(string kind, string? idempotencyKey)
        => idempotencyKey == null
            ? null
            : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes($"mcp-{kind}:{idempotencyKey}"))).ToLowerInvariant()[..32];

    /// <summary>幂等键带上密钥 id，避免两把密钥用了同一个 clientRequestId 互相吞掉对方的写入。</summary>
    private string? BuildIdempotencyKey(string? clientRequestId)
    {
        if (string.IsNullOrWhiteSpace(clientRequestId)) return null;
        var keyId = User.FindFirst("agentApiKeyId")?.Value ?? "unknown";
        var raw = clientRequestId.Trim();
        if (raw.Length > 120) raw = raw[..120];
        return $"{keyId}:{raw}";
    }
}
