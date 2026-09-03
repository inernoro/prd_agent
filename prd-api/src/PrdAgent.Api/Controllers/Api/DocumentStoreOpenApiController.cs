using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using DocStoreServices = PrdAgent.Infrastructure.Services.DocumentStore;

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
    private readonly DocStoreServices.MentionService _mentions;
    private readonly ILogger<DocumentStoreOpenApiController> _logger;

    public DocumentStoreOpenApiController(
        MongoDbContext db,
        ITeamService teams,
        IDocumentService documentService,
        Services.EntryContentWriteService entryContentWriter,
        DocStoreServices.MentionService mentions,
        ILogger<DocumentStoreOpenApiController> logger)
    {
        _db = db;
        _teams = teams;
        _documentService = documentService;
        _entryContentWriter = entryContentWriter;
        _mentions = mentions;
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

        // parentId 必须是**同一个库里的文件夹**。不校验的话，智能体给一个别的库的 id、
        // 或者给一篇普通文档的 id，都会插出一条挂在错地方的条目 —— 界面按文件夹展开时
        // 它既不在根上也不在任何文件夹下，用户看不见也删不掉。
        if (!string.IsNullOrWhiteSpace(req.ParentId))
        {
            var parent = await _db.DocumentEntries.Find(e => e.Id == req.ParentId).FirstOrDefaultAsync(ct);
            if (parent == null || parent.StoreId != storeId || !parent.IsFolder)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    "parentId 必须是这个知识库里的一个文件夹；不确定就别传，文档会落在根目录。"));
        }

        // 幂等：同一把密钥 + 同一个 clientRequestId 只写一次。
        // 判据走**确定性 id**（撞主键即命中），不走「先查后建」—— 后者在两次重试叠在一起时
        // 两边都查不到，各写一篇、计数各加一次，而幂等键正是为了不发生这件事。
        var idempotencyKey = BuildIdempotencyKey(req.ClientRequestId);
        // 库 id 必须进这个哈希：条目的确定性 id 是主键，而主键在整个集合里唯一，不分库。
        // 只用「密钥 + clientRequestId」的话，智能体拿同一个 clientRequestId 往两个库各写一篇
        // （批处理里每库一次、请求 id 按批取，很自然），第二篇的先查后判会因为库不同而查不到，
        // 接着插入撞主键、按库过滤又捞不回来，最后抛出去变成 500 —— 一次合法调用被幂等键坑死。
        var deterministicId = DeterministicId($"kb-entry:{storeId}", idempotencyKey);
        if (deterministicId != null)
        {
            var existed = await _db.DocumentEntries
                .Find(e => e.Id == deterministicId && e.StoreId == storeId)
                .FirstOrDefaultAsync(ct);
            if (existed != null) return DedupOrInProgress(existed);
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
            Metadata = BuildEntryMetadata(idempotencyKey, contentPending: content.Length > 0),
            CreatedBy = userId,
            CreatedByName = displayName,
            UpdatedBy = userId,
            UpdatedByName = displayName,
            LastChangedAt = DateTime.UtcNow,
        };
        if (deterministicId != null) entry.Id = deterministicId;
        try
        {
            // 这一笔不跟客户端的取消令牌走（server-authority）：它落在下面那段补偿之外，
            // 而且只接住撞主键。客户端在它在途时断开的话，Mongo 完全可能已经写进去了，
            // 而驱动抛的是取消 —— 于是留下一条空的、带着 mcpContentPending 的条目，
            // 正文没写、计数没加，此后同一个 clientRequestId 的每次重试都拿到
            // ENTRY_WRITE_IN_PROGRESS，永远。谁也救不回来的死记录，正是幂等键要避免的东西。
            await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && deterministicId != null)
        {
            var raced = await _db.DocumentEntries
                .Find(e => e.Id == deterministicId && e.StoreId == storeId)
                .FirstOrDefaultAsync(ct);
            if (raced == null) throw;
            return DedupOrInProgress(raced);
        }
        // 计数与正文一起纳入同一段补偿：计数那一步失败时若不回滚，条目会永远停在
        // mcpContentPending，此后同键的每一次重试都拿到 409 —— 一条谁也救不回来的死记录。
        var countedIn = false;
        try
        {
            await _db.DocumentStores.UpdateOneAsync(
                s => s.Id == storeId,
                Builders<DocumentStore>.Update.Inc(s => s.DocumentCount, 1).Set(s => s.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            countedIn = true;

            if (content.Length > 0)
            {
                await _entryContentWriter.WriteAsync(entry, store!, content, userId, displayName,
                    DocumentVersionSource.Edit, contentTypeOverride: "text/markdown");

                // 调用方明确给了摘要就把它写回去。写入服务无条件用正文前 200 字当摘要
                // （那是给在线编辑准备的默认行为），于是「同时给 summary 和 content」这种最自然的
                // 用法会静默丢掉 summary：接口回成功，库里存的却是另一段文字。
                // 不走写入服务的 entryFields：那条要求把标题/父级/标签/元数据整套一起给，
                // 而这里只有摘要一个字段要纠正，整套重写反而多出几处能写错的地方。
                var explicitSummary = string.IsNullOrWhiteSpace(req.Summary) ? null : req.Summary.Trim();

                // 正文落盘了，这条才算完整 —— 在此之前撞上来的重试只会拿到 409，不会拿到「成功」
                var finish = Builders<DocumentEntry>.Update.Unset(EntryContentPendingField);
                if (explicitSummary != null)
                    finish = Builders<DocumentEntry>.Update.Combine(
                        finish, Builders<DocumentEntry>.Update.Set(e => e.Summary, explicitSummary));
                await _db.DocumentEntries.UpdateOneAsync(
                    e => e.Id == entry.Id,
                    finish,
                    cancellationToken: CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            // 没走完就把条目撤回去。留着的话，条目上已经带着幂等键了 ——
            // 智能体拿同一个 clientRequestId 重试要么命中去重拿到一篇空文档，
            // 要么永远撞上「还在落正文」的 409。一次存储抖动就此变成永久的残缺数据。
            var cleaned = await CleanupRolledBackEntryAsync(entry.Id);
            if (ShouldRestoreDocumentCount(countedIn, cleaned))
                await _db.DocumentStores.UpdateOneAsync(
                    s => s.Id == storeId,
                    Builders<DocumentStore>.Update.Inc(s => s.DocumentCount, -1).Set(s => s.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            _logger.LogWarning(ex, "[mcp] 知识库建文档未走完 entryId={EntryId} storeId={StoreId} cleaned={Cleaned}",
                entry.Id, storeId, cleaned);
            return StatusCode(500, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, cleaned
                ? "这篇文档没有建成，已经撤回，请用同一个 clientRequestId 重试"
                : "这篇文档没有建成，且残留记录没能清干净；这个 clientRequestId 暂时不能复用，请换一个键重试，并让管理员看一下服务端日志"));
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

        // 两件事都是接现成的机制，不是新造：写入服务本来就支持乐观并发与「正文已提交但派生失败」，
        // 这里此前既没传条件、也没看返回值 —— 建了一半的线。
        //
        // 1) expectedUpdatedAt：两个智能体（或同一个智能体的两次重试）同时覆盖同一篇时，
        //    没有条件的话两次各写各的，最后正文、摘要、双链、版本快照可能来自不同的请求。
        // 2) derivedStateMetadataKey：不传这个键时，派生步骤（重锚评论 / 重算双链 / 版本快照）
        //    抛出的异常会一路上抛成 500 —— 而正文**早就提交了**。网关据此退还写入额度，
        //    智能体则被鼓励去重试一件已经生效的事。传了键，写入服务把它转成 DerivedFailed
        //    并在条目上留一个 failed 标记，这里就能如实回「正文写进去了，派生没刷成」。
        var write = await _entryContentWriter.WriteAsync(entry, store!, content, userId, displayName,
            DocumentVersionSource.Edit, contentTypeOverride: entry.ContentType,
            expectedUpdatedAt: entry.UpdatedAt,
            derivedStateMetadataKey: McpDerivedStateKey);

        if (write.Conflicted)
            // 与本文件里另一处 409 同风格用字面量：ErrorCodes 里没有通用的 CONFLICT，
            // 而给它新添一个通用码会牵动全站的错误码语义，不值当。
            return Conflict(ApiResponse<object>.Fail("ENTRY_CHANGED_SINCE_READ",
                "这篇文档在你读到它之后被别人改过，本次覆盖没有执行。先重新读一遍正文，再决定要不要覆盖。"));

        return Ok(ApiResponse<object>.Ok(new
        {
            entryId = entry.Id,
            title = entry.Title,
            updatedAt = write.UpdatedAt,
            // 正文是提交了的。派生没刷成只影响划词评论锚点、双链账本与版本快照，
            // 报成失败会让智能体重试一件已经生效的事，比这三样暂时不准更糟。
            derivedState = write.DerivedFailed ? "failed" : write.DerivedMarkerPersisted ? "ready" : "pending",
        }));
    }

    /// <summary>
    /// 智能体覆盖正文时的派生状态标记键。
    ///
    /// 与受控发布器那把键分开：那把键是发布器用来认它自己管的节点的，共用会让它把
    /// 智能体写的条目也算进自己的账。这里只求两件事 —— 让写入服务把派生失败转成返回值
    /// 而不是异常，以及在条目上留下一个人能查到的痕迹。
    /// </summary>
    private const string McpDerivedStateKey = "mcpDerivedState";

    /// <summary>单篇正文上限。挡住智能体一次糊一本书进来，也挡住它把上下文里的垃圾整个倒进知识库。</summary>
    private const int MaxContentChars = 200_000;

    /// <summary>
    /// 回滚时要不要把库里的文档计数减回去。
    ///
    /// 只有条目**真的删掉了**才减：清理失败时条目是被刻意留下来占住确定性 id 的，它还在列表里
    /// 看得见，这时候减计数会让库摘要少算一条，而且永远补不回来 —— 计数得跟着「条目还在不在」走。
    /// </summary>
    internal static bool ShouldRestoreDocumentCount(bool countedIn, bool entryDeleted) => countedIn && entryDeleted;

    /// <summary>
    /// 撤回一条没建成的条目。
    ///
    /// 只删 DocumentEntries 不够：WriteAsync 是分几次写落库的，抛在半路时前面几步已经提交了 ——
    /// 版本快照（DocumentEntryVersions）与双链账本（mentions）都可能已经有行，指向一个马上要
    /// 被删掉的条目。留着它们，接口却回「已经撤回」，就是说了句不算数的话。
    ///
    /// 不动 Documents：它按内容 hash 寻址、多个条目共享同一份，删了会把别人的正文一起弄没
    /// （DeleteEntry 的级联里也是先确认无人引用才删）。刚建的条目留下一份可复用的内容记录无害。
    /// 清理本身尽力而为：清不掉不能反过来把「已撤回」变成别的结论。
    /// </summary>
    /// <returns>true = 条目与派生都清干净了；false = 派生没清掉，条目被刻意保留占着 id。</returns>
    private async Task<bool> CleanupRolledBackEntryAsync(string entryId)
    {
        // 顺序要紧：**先清派生，最后删条目**。
        // 反过来的话，条目一删，那个确定性 id 就空出来了；等在旁边的重试可以立刻插入新条目
        // 并写出它自己的版本与双链，而这边接着执行的清理会按同一个 entryId 把**新那次**的
        // 派生记录删掉。条目留到最后删，这段窗口里 id 一直被占着，重试撞主键、乖乖等着。
        try
        {
            await _db.DocumentEntryVersions.DeleteManyAsync(v => v.EntryId == entryId, CancellationToken.None);
            await _mentions.CascadeDeleteAsync(MentionEntityType.Document, new[] { entryId }, CancellationToken.None);
        }
        catch (Exception ex)
        {
            // 派生没清干净就**不能把 id 让出来**。删掉条目等于释放这个确定性 id，
            // 重试会用同一个 id 建出新条目，然后继承这些残留的版本与双链 ——
            // 用户看到的是「我刚写的这篇怎么带着别的历史」，而且无从解释。
            // 宁可把这条留在库里（带着 mcpContentPending，同键重试拿 409），
            // 也不要让脏数据悄悄挂到下一篇上。
            _logger.LogError(ex,
                "[mcp] 撤回条目时派生记录没清干净，已保留条目占位以免 id 被重用 entryId={EntryId}", entryId);
            return false;
        }
        await _db.DocumentEntries.DeleteOneAsync(e => e.Id == entryId, CancellationToken.None);
        return true;
    }

    /// <summary>条目「正文还没落盘」的标记字段（Mongo 路径写法，供 Unset 用）。</summary>
    private const string EntryContentPendingField = "Metadata.mcpContentPending";

    private static Dictionary<string, string> BuildEntryMetadata(string? idempotencyKey, bool contentPending)
    {
        var meta = new Dictionary<string, string> { ["createdVia"] = "mcp" };
        if (idempotencyKey != null) meta["mcpRequestId"] = idempotencyKey;
        // 先落条目、再写正文，中间有个窗口。带同一个幂等键的重试如果正好落在这个窗口里，
        // 看到的是一条「已存在但还是空的」条目 —— 报成功等于交给它一篇空文档，
        // 而万一头一次的正文写失败、条目被撤回，它拿到的还是一个不存在的 id。
        if (contentPending) meta["mcpContentPending"] = "1";
        return meta;
    }

    /// <summary>幂等命中：已经完整的回既有条目，还在写正文的回 409 让调用方稍后重试。</summary>
    private IActionResult DedupOrInProgress(DocumentEntry existed)
    {
        if (existed.Metadata != null && existed.Metadata.ContainsKey("mcpContentPending"))
            return Conflict(ApiResponse<object>.Fail("ENTRY_WRITE_IN_PROGRESS",
                "同一个 clientRequestId 的上一次写入还在落正文，这次没有重复写。稍等一两秒用同一个键再试一次即可。"));
        return Ok(ApiResponse<object>.Ok(new { entryId = existed.Id, title = existed.Title, deduplicated = true }));
    }

    /// <summary>把幂等键压成确定性文档 id（32 位十六进制，与随机 id 同形）。没给幂等键就返回 null。</summary>
    internal static string? DeterministicId(string kind, string? idempotencyKey)
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
