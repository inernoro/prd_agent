using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 文学创作开放接口 —— 供外部智能体（MCP 连接器）开工作区、续写、改稿。
///
/// 鉴权：Bearer sk-ak-xxxx + scope literary-agent:use（签发时已与用户自己的 literary-agent.use 权限位取过交集）。
///
/// 与 LiteraryAgentWorkspaceController 的关系：同一批工作区文档（ImageMasterWorkspace，
/// scenarioType=article-illustration），内容指纹走同一个 LiteraryWorkspaceHash，不另起一套。
/// 这里只开「列 / 建 / 写正文」三件事：配图、参考图、提示词那些要在界面上看着调，不适合盲调。
/// </summary>
[ApiController]
[Route("api/open/literary")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class LiteraryOpenApiController : ControllerBase
{
    public const string ScopeUse = McpCapabilityCatalog.ScopeLiteraryUse;

    /// <summary>单篇正文上限，防止智能体把整个上下文倒进来。</summary>
    private const int MaxContentChars = 200_000;

    private const string ScenarioType = "article-illustration";

    private readonly MongoDbContext _db;

    public LiteraryOpenApiController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetBoundUserId()
    {
        var id = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(id))
            throw new UnauthorizedAccessException("Missing boundUserId claim");
        return id;
    }

    /// <summary>列出我的文学创作工作区（最近更新在前）。</summary>
    [HttpGet("workspaces")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> ListWorkspaces([FromQuery] int limit, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var resolved = limit is > 0 and <= 100 ? limit : 20;
        var items = await _db.ImageMasterWorkspaces
            .Find(x => x.OwnerUserId == userId && x.ScenarioType == ScenarioType)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(resolved)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            items = items.Select(w => new
            {
                workspaceId = w.Id,
                title = w.Title,
                contentChars = w.ArticleContent?.Length ?? 0,
                updatedAt = w.UpdatedAt,
            })
        }));
    }

    public class CreateWorkspaceRequest
    {
        public string? Title { get; set; }
        /// <summary>可选：建的同时把初稿写进去。</summary>
        public string? Content { get; set; }
        public string? ClientRequestId { get; set; }
    }

    /// <summary>新建一个创作工作区，可带初稿。</summary>
    [HttpPost("workspaces")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> CreateWorkspace([FromBody] CreateWorkspaceRequest? req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var title = (req?.Title ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(title)) title = "未命名";
        if (title.Length > 40) title = title[..40].Trim();

        var content = req?.Content ?? string.Empty;
        if (content.Length > MaxContentChars)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"正文超过 {MaxContentChars} 字上限，请分次写入"));

        var now = DateTime.UtcNow;
        var assetsHash = Guid.NewGuid().ToString("N");
        // 幂等：带了 clientRequestId 就用确定性 id，重复提交自然撞主键，不会攒出一堆同名工作区。
        // 智能体超时重试是常态，声明了幂等键就得真的兑现。
        var deterministicId = BuildDeterministicId(req?.ClientRequestId);
        var ws = new ImageMasterWorkspace
        {
            Id = deterministicId ?? Guid.NewGuid().ToString("N"),
            OwnerUserId = userId,
            Title = title,
            ScenarioType = ScenarioType,
            MemberUserIds = new List<string>(),
            AssetsHash = assetsHash,
            CanvasHash = string.Empty,
            ContentHash = LiteraryWorkspaceHash.ComputeContentHash(string.Empty, assetsHash),
            ArticleContent = string.IsNullOrEmpty(content) ? null : content,
            CreatedAt = now,
            UpdatedAt = now,
        };
        try
        {
            await _db.ImageMasterWorkspaces.InsertOneAsync(ws, cancellationToken: ct);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && deterministicId != null)
        {
            var existed = await _db.ImageMasterWorkspaces
                .Find(x => x.Id == deterministicId && x.OwnerUserId == userId)
                .FirstOrDefaultAsync(ct);
            if (existed != null)
                return Ok(ApiResponse<object>.Ok(new { workspaceId = existed.Id, title = existed.Title, deduplicated = true }));
            throw;
        }

        return Ok(ApiResponse<object>.Ok(new { workspaceId = ws.Id, title = ws.Title }));
    }

    /// <summary>把「这把密钥 + 这个 clientRequestId」压成确定性工作区 id；没给幂等键就返回 null 走随机 id。</summary>
    private string? BuildDeterministicId(string? clientRequestId)
    {
        if (string.IsNullOrWhiteSpace(clientRequestId)) return null;
        var keyId = User.FindFirst("agentApiKeyId")?.Value ?? "unknown";
        var raw = clientRequestId.Trim();
        if (raw.Length > 120) raw = raw[..120];
        return LiteraryWorkspaceHash.Sha256Hex($"literary-ws:{keyId}:{raw}")[..32];
    }

    public class WriteContentRequest
    {
        public string? Content { get; set; }
        /// <summary>replace（默认，整篇覆盖）或 append（接在末尾）。</summary>
        public string? Mode { get; set; }
    }

    /// <summary>写工作区正文：整篇覆盖或接着往下写。</summary>
    [HttpPost("workspaces/{workspaceId}/content")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> WriteContent(string workspaceId, [FromBody] WriteContentRequest? req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var ws = await _db.ImageMasterWorkspaces
            .Find(x => x.Id == workspaceId && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (ws == null)
            return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "工作区不存在或不属于你"));

        var incoming = req?.Content ?? string.Empty;
        var append = string.Equals(req?.Mode, "append", StringComparison.OrdinalIgnoreCase);
        var merged = append
            ? (string.IsNullOrEmpty(ws.ArticleContent) ? incoming : ws.ArticleContent + "\n\n" + incoming)
            : incoming;

        if (merged.Length > MaxContentChars)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"正文超过 {MaxContentChars} 字上限（追加后 {merged.Length} 字），请精简或分篇"));

        await _db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == ws.Id,
            Builders<ImageMasterWorkspace>.Update
                .Set(x => x.ArticleContent, merged)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            title = ws.Title,
            contentChars = merged.Length,
            mode = append ? "append" : "replace",
        }));
    }
}
