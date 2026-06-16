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

    public DocumentStoreOpenApiController(MongoDbContext db, ITeamService teams, IDocumentService documentService)
    {
        _db = db;
        _teams = teams;
        _documentService = documentService;
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

        // 与 DocumentStoreController.GetEntryContent 一致：优先 ParsedPrd.RawContent，兜底 Attachment.ExtractedText
        string? content = null;
        string? title = null;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc != null) { content = doc.RawContent; title = doc.Title; }
        }
        if (string.IsNullOrEmpty(content) && !string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await _db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync(ct);
            if (att != null) { content = att.ExtractedText; title = att.FileName; }
        }
        return Ok(ApiResponse<object>.Ok(new
        {
            entryId = entry.Id,
            title = title ?? entry.Title,
            content,
            contentType = entry.ContentType,
            hasContent = !string.IsNullOrEmpty(content),
        }));
    }
}
