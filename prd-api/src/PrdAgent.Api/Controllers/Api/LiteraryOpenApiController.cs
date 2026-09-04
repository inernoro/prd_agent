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

    /// <summary>一次最多读回多少字。默认给得比上限小得多：改稿通常只需要看一段，
    /// 而把 20 万字一口气塞进智能体的上下文，本身就是一种破坏。</summary>
    private const int DefaultReadChars = 20_000;

    /// <summary>
    /// 读一个工作区的正文。
    ///
    /// 为什么必须有它：`append` 的乐观并发在冲突时回 `WORKSPACE_CONTENT_CHANGED` 并让调用方
    /// 「重新读一遍正文再追加」—— 而在这条端点存在之前，开放层里**没有任何一条路能读到正文**，
    /// 那句指引是做不到的（no-rootless-tree：不许声明系统给不出的能力）。
    /// 改稿、续写这两件在工具描述里承诺过的事同样如此：看不见原稿就无从改起。
    ///
    /// 按段读：`offset` + `limit` 一起给出「还有没有更多」，避免一次把 20 万字灌进上下文。
    /// </summary>
    [HttpGet("workspaces/{workspaceId}")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> GetWorkspace(string workspaceId,
        [FromQuery] int offset, [FromQuery] int limit, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        // 场景与写入端点同一个判据：别的场景的工作区不该从这条路被读出来。
        var ws = await _db.ImageMasterWorkspaces
            .Find(x => x.Id == workspaceId && x.OwnerUserId == userId && x.ScenarioType == ScenarioType)
            .FirstOrDefaultAsync(ct);
        if (ws == null)
            return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND",
                "工作区不存在、不属于你，或者不是文学创作的工作区"));

        var full = ws.ArticleContent ?? string.Empty;
        var from = offset > 0 ? Math.Min(offset, full.Length) : 0;
        var take = limit is > 0 and <= MaxContentChars ? limit : DefaultReadChars;
        var slice = full.Substring(from, Math.Min(take, full.Length - from));

        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            title = ws.Title,
            content = slice,
            offset = from,
            contentChars = full.Length,
            hasMore = from + slice.Length < full.Length,
            // 版本令牌：mode=replace 覆盖时把它原样传回 expectedUpdatedAt，
            // 期间被用户在界面上改过就会 409 而不是把对方的稿子盖掉。
            updatedAt = McpRevision.Token(ws.UpdatedAt),
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
            await _db.ImageMasterWorkspaces.InsertOneAsync(ws, cancellationToken: CancellationToken.None);
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
        return McpIdempotency.Fingerprint("literary-ws", McpIdempotency.ScopedByKey(User, clientRequestId));
    }

    public class WriteContentRequest
    {
        public string? Content { get; set; }
        /// <summary>replace（默认，整篇覆盖）或 append（接在末尾）。</summary>
        public string? Mode { get; set; }

        /// <summary>
        /// 上次读到这篇正文时它的 `updatedAt`（`map_literary_get_workspace` 会回）。
        /// `mode=replace` 传了才有「期间被改过就不覆盖」这层保护；append 本来就带条件写入。
        /// </summary>
        public string? ExpectedUpdatedAt { get; set; }
    }

    /// <summary>写工作区正文：整篇覆盖或接着往下写。</summary>
    [HttpPost("workspaces/{workspaceId}/content")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> WriteContent(string workspaceId, [FromBody] WriteContentRequest? req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        // 场景必须一起判。只判 owner + id 的话，用户名下别的场景的工作区（比如智能体生图那个）
        // 也能被当成文学工作区写进正文、复位配图流程 —— 那是另一个功能的数据，
        // 用户既没要求过，也不会想到去那里找。列表端点本来就按场景过滤，写入这边要对齐。
        var ws = await _db.ImageMasterWorkspaces
            .Find(x => x.Id == workspaceId && x.OwnerUserId == userId && x.ScenarioType == ScenarioType)
            .FirstOrDefaultAsync(ct);
        if (ws == null)
            return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND",
                "工作区不存在、不属于你，或者不是文学创作的工作区"));

        // 省略 content 与显式给空串是两件事：前者是「没说要写什么」，后者是「明确要清空」。
        // 合成一件的话，直连打一个 {} 过来（mode 默认 replace）就把整篇正文清空、配图流程复位，
        // 接口还回成功 —— 一次拼错的请求造成的破坏，比这条接口能做的任何事都大。
        var contentError = McpInputBounds.RequireContent(req?.Content);
        if (contentError != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, contentError));
        var incoming = req!.Content!;

        // mode 只认三种：不给（默认整篇覆盖）、replace、append。写错一个字母不能默默走覆盖 ——
        // 智能体想追加一段、结果整篇正文被那一段替换掉，是这条接口能造成的最大破坏，
        // 而 MCP 的 inputSchema 只是描述性的，网关不拿它校验参数，直连 API 的调用方更是想传什么传什么。
        var rawMode = (req?.Mode ?? string.Empty).Trim();
        var append = string.Equals(rawMode, "append", StringComparison.OrdinalIgnoreCase);
        if (!append && rawMode.Length > 0 && !string.Equals(rawMode, "replace", StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"mode 只能是 replace 或 append，收到的是「{rawMode}」。不传 mode 默认整篇覆盖。"));
        // replace 是整篇覆盖，此前只按 workspaceId 过滤、无条件写下去：智能体 T0 读到、
        // 用户 T1 在界面上改了、智能体 T2 拿旧稿覆盖 —— 用户那次编辑就没了。
        // append 那一路本来就带「正文还是我读到的那份」这个条件，缺的一直是 replace 这一半。
        var revisionChecked = false;
        switch (McpRevision.Check(req?.ExpectedUpdatedAt, ws.UpdatedAt))
        {
            case RevisionCheck.Match:
                // 记下来：真正那条 UpdateOne 必须带上同一个条件，否则这次校验只是个说法。
                revisionChecked = true;
                break;
            case RevisionCheck.Unparsable:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    "expectedUpdatedAt 认不出来。把 map_literary_get_workspace 回的 updatedAt 原样传回来即可。"));
            case RevisionCheck.Mismatch:
                return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED",
                    "这篇正文在你读到它之后被改过，本次写入没有执行。请先用 map_literary_get_workspace 重新读一遍，再决定怎么写。"));
        }

        var merged = append
            ? (string.IsNullOrEmpty(ws.ArticleContent) ? incoming : ws.ArticleContent + "\n\n" + incoming)
            : incoming;

        if (merged.Length > MaxContentChars)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"正文超过 {MaxContentChars} 字上限（追加后 {merged.Length} 字），请精简或分篇"));

        var changed = !string.Equals(merged, ws.ArticleContent ?? string.Empty, StringComparison.Ordinal);
        var update = Builders<ImageMasterWorkspace>.Update
            .Set(x => x.ArticleContent, merged)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        if (changed)
        {
            // 正文换了，之前那轮配图的标记就不再对应这篇文章了。界面侧（ImageMasterController）
            // 在正文提交时会 version++、清标记、清带标记正文，并删掉旧配图资产。
            // 这里做同样的复位，但**不删资产** —— 删除是收不回来的动作，本期不开放给智能体；
            // 图还留在工作区里，只是不再挂在已经变了的正文上。差异记在 debt.platform.md。
            var history = ws.ArticleWorkflowHistory ?? new List<ArticleIllustrationWorkflow>();
            if (ws.ArticleWorkflow != null)
            {
                history.Insert(0, ws.ArticleWorkflow);
                if (history.Count > 10) history = history.Take(10).ToList();
            }
            update = update
                .Set(x => x.ArticleWorkflow, new ArticleIllustrationWorkflow
                {
                    Version = (ws.ArticleWorkflow?.Version ?? 0) + 1,
                    Phase = 1,
                    Markers = new List<ArticleIllustrationMarker>(),
                    ExpectedImageCount = null,
                    DoneImageCount = 0,
                    AssetIdByMarkerIndex = new Dictionary<string, string>(),
                    UpdatedAt = DateTime.UtcNow,
                })
                .Set(x => x.ArticleWorkflowHistory, history)
                .Set(x => x.ArticleContentWithMarkers, null);
        }

        // 写回一律带条件，只是条件不同：
        // - append 是「读出来 + 拼上去 + 写回去」，条件是「正文还是我读到的那份」，
        //   否则两次并发各读到同一份旧正文，后写的把先写的整段盖掉。
        // - replace 带了版本令牌时，条件是「UpdatedAt 还是我刚校验过的那个」。
        //   上一版只在**进函数时**比了一次令牌，真正那条 UpdateOne 却只按 id 过滤 ——
        //   校验和写入之间那段窗口里用户改一次，照样被盖掉。检查和写入必须是同一个条件，
        //   否则那次检查只是个说法（predicate-and-wiring-discipline 形状 2：链路只建一半）。
        var idFilter = Builders<ImageMasterWorkspace>.Filter.Eq(x => x.Id, ws.Id);
        var guarded = append || revisionChecked;
        // append 的条件此前只看正文没变。可这次写入**重置的不止正文**：它还要把
        // ArticleWorkflow 与 ArticleWorkflowHistory 按我读到的那份快照重写一遍。
        // 界面或配图 worker 完全可以在这中间只动 workflow（写标记、回填资产）而不动正文 ——
        // 那时正文条件照样成立，于是这次写入拿旧快照把新的「标记 → 资产」映射抹掉。
        // 所以条件要覆盖「我这次要改的全部东西」，而不只是我读来拼接的那一段：
        // UpdatedAt 变了就说明这条被人动过，一律让调用方重读。
        var unchanged = Builders<ImageMasterWorkspace>.Filter.Eq(x => x.UpdatedAt, ws.UpdatedAt);
        var filter = append
            ? Builders<ImageMasterWorkspace>.Filter.And(idFilter, unchanged,
                Builders<ImageMasterWorkspace>.Filter.Eq(x => x.ArticleContent, ws.ArticleContent))
            : revisionChecked
                ? Builders<ImageMasterWorkspace>.Filter.And(idFilter, unchanged)
                : idFilter;
        var result = await _db.ImageMasterWorkspaces.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        if (guarded && result.MatchedCount == 0)
            return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED",
                append
                    ? "追加期间这个工作区被另一次写入改过（正文或配图流程），这次没有写进去。请先用 map_literary_get_workspace 重新读一遍，再决定怎么写。"
                    : "这篇正文在你准备覆盖的这段时间里被改过，本次覆盖没有执行。请先用 map_literary_get_workspace 重新读一遍，再决定怎么写。"));

        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            title = ws.Title,
            contentChars = merged.Length,
            mode = append ? "append" : "replace",
        }));
    }
}
