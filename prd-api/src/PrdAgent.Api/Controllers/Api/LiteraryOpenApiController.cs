using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Services;
using PrdAgent.Api.Extensions;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 文学创作开放接口 —— 供外部智能体（MCP 连接器）开工作区、续写、改稿。
///
/// 鉴权：Bearer sk-ak-xxxx + scope literary-agent:use（签发时已与用户自己的 literary-agent.use 权限位取过交集）。
///
/// 与 LiteraryAgentWorkspaceController 的关系：同一批工作区文档（ImageMasterWorkspace，
/// scenarioType=article-illustration），内容指纹走同一个 LiteraryWorkspaceHash，不另起一套。
/// 配图采用明确标记、异步任务与只读查询，产物仍在同一文学工作区，默认不公开发布。
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
                folderName = w.FolderName,
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
        [FromQuery] int offset, [FromQuery] int limit, CancellationToken ct, [FromQuery] string? format = null)
    {
        var userId = GetBoundUserId();
        // 场景与写入端点同一个判据：别的场景的工作区不该从这条路被读出来。
        var ws = await _db.ImageMasterWorkspaces
            .Find(x => x.Id == workspaceId && x.OwnerUserId == userId && x.ScenarioType == ScenarioType)
            .FirstOrDefaultAsync(ct);
        if (ws == null)
            return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND",
                "工作区不存在、不属于你，或者不是文学创作的工作区"));

        if (format != null && format != "plain" && format != "illustrated" && format != "marked")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "format 只能是 plain、marked 或 illustrated。"));

        // 当前每个标记挂哪张图：与网页详情、投稿、导出同一个判定源，不再各自「按 index 取最新」。
        var allAssets = await _db.ImageAssets.Find(x => x.WorkspaceId == ws.Id).ToListAsync(ct);
        LiteraryMcpWorkflow.RecoverVersionedAssets(ws, allAssets);
        var current = LiteraryMcpWorkflow.SelectCurrent(ws, allAssets);
        var urls = current.ToDictionary(kv => kv.Key, kv => Request.ResolveAbsoluteUrl(kv.Value.Url) ?? kv.Value.Url);

        var full = ws.ArticleContent ?? string.Empty;
        var served = "plain";
        string? formatNote = null;
        var hasMarkers = ws.ArticleContentWithMarkers != null && (ws.ArticleWorkflow?.Markers.Count ?? 0) > 0;
        if (format is "illustrated" or "marked" && !hasMarkers)
            // 不静默降级：说清楚这次给的是原稿以及为什么
            formatNote = "这篇文章现在没有配图标记，返回的是原稿（plain）。要配图请用 map_literary_write_content 传 markedContent。";
        else if (format == "illustrated")
            (full, served) = (LiteraryMcpWorkflow.Render(ws.ArticleContentWithMarkers!, urls), "illustrated");
        else if (format == "marked")
            (full, served) = (LiteraryMcpWorkflow.RenderMarked(ws.ArticleContentWithMarkers!,
                ws.ArticleWorkflow!.Markers.GroupBy(m => m.Index).ToDictionary(g => g.Key, g => LiteraryMcpWorkflow.EffectivePrompt(g.First()))),
                "marked");
        var from = offset > 0 ? Math.Min(offset, full.Length) : 0;
        var take = limit is > 0 and <= MaxContentChars ? limit : DefaultReadChars;
        var slice = full.Substring(from, Math.Min(take, full.Length - from));
        var currentIds = current.Values.Select(a => a.Id).ToHashSet();

        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            title = ws.Title,
            folderName = ws.FolderName,
            workflowVersion = ws.ArticleWorkflow?.Version ?? 0,
            illustrations = ws.ArticleWorkflow?.Markers.Select(m => new
            {
                index = m.Index, prompt = LiteraryMcpWorkflow.EffectivePrompt(m),
                status = current.ContainsKey(m.Index) && m.Status != "running" ? "done" : m.Status,
                runId = m.RunId,
                errorMessage = m.ErrorMessage,
                assetId = current.TryGetValue(m.Index, out var a) ? a.Id : null,
                url = urls.TryGetValue(m.Index, out var u) ? u : null,
            }),
            // 改稿 / 重新规划后，旧版本的图不删，只是不再挂在正文上；页面「历史配图」能看到它们。
            historyImageCount = allAssets.Count(x => !currentIds.Contains(x.Id)),
            // 这篇文章记住的配图选择：生图不传 style / watermark / size 时沿用它们
            illustrationPrefs = ws.IllustrationPrefs == null ? null : new
            {
                styleId = ws.IllustrationPrefs.StyleId,
                watermarkId = ws.IllustrationPrefs.WatermarkId,
                size = ws.IllustrationPrefs.Size,
            },
            content = slice,
            format = served,
            formatNote,
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
        public string? FolderName { get; set; }
        /// <summary>可选带 [插图]: 提示词 的正文，与 Content 互斥。</summary>
        public string? MarkedContent { get; set; }
    }

    /// <summary>新建一个创作工作区，可带初稿。</summary>
    [HttpPost("workspaces")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> CreateWorkspace([FromBody] CreateWorkspaceRequest? req, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var marked = req?.MarkedContent is { } rawMarked ? LiteraryMcpWorkflow.NormalizeMarkedContent(rawMarked) : null;
        var validation = LiteraryMcpWorkflow.Validate(req?.Content, marked, req?.FolderName);
        if (validation != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, validation));
        var content = marked != null ? LiteraryMcpWorkflow.PlainContent(marked) : req?.Content ?? string.Empty;
        if (content.Length > MaxContentChars)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"正文超过 {MaxContentChars} 字上限，请分次写入"));

        var title = (req?.Title ?? string.Empty).Trim();
        // 不给标题时从正文第一行取：原来一律叫「未命名」，智能体建几篇列表里就是一排分不清的「未命名」。
        if (string.IsNullOrWhiteSpace(title)) title = TitleFromContent(content) ?? "未命名";
        if (title.Length > 40) title = title[..40].Trim();
        var folderName = string.IsNullOrWhiteSpace(req?.FolderName) ? null : req.FolderName.Trim();
        var requestFingerprint = LiteraryWorkspaceHash.Sha256Hex(
            string.Join("\u0001", (req?.Title ?? string.Empty).Trim(), req?.Content ?? string.Empty, marked ?? string.Empty, folderName ?? string.Empty));

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
            FolderName = folderName,
            ArticleContentWithMarkers = marked,
            ArticleWorkflow = marked != null ? LiteraryMcpWorkflow.Prepare(marked) : null,
            SuppressAutoSubmit = true,
            CreateRequestFingerprint = deterministicId != null ? requestFingerprint : null,
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
            if (existed == null) throw;
            // 同一个 clientRequestId 带着不同的内容再来，是「复用了幂等键」而不是「重试」。
            // 以前这里直接把旧文章当成新建结果返回，智能体随后的配图、改稿全落到错的文章上。
            if (existed.CreateRequestFingerprint != null && existed.CreateRequestFingerprint != requestFingerprint)
                return Conflict(ApiResponse<object>.Fail("IDEMPOTENCY_CONFLICT",
                    "这个 clientRequestId 已经建过另一篇内容不同的文章。新建一篇请换一个新的 clientRequestId；重试请原样提交上次的内容。"));
            return Ok(ApiResponse<object>.Ok(CreatedPayload(existed, deduplicated: true)));
        }

        return Ok(ApiResponse<object>.Ok(CreatedPayload(ws, deduplicated: false)));
    }

    /// <summary>建稿回执直接带上版本号与标记序号，省掉「建完再读一遍才能生图」那一跳。</summary>
    private static object CreatedPayload(ImageMasterWorkspace ws, bool deduplicated) => new
    {
        workspaceId = ws.Id,
        title = ws.Title,
        folderName = ws.FolderName,
        deduplicated,
        workflowVersion = ws.ArticleWorkflow?.Version ?? 0,
        illustrations = ws.ArticleWorkflow?.Markers.Select(m => new { index = m.Index, prompt = LiteraryMcpWorkflow.EffectivePrompt(m), status = m.Status })
            ?? Enumerable.Empty<object>(),
        next = ws.ArticleWorkflow?.Markers.Count > 0
            ? "用 map_literary_generate_image 传 markerIndexes（可一次传全部）与 workflowVersion 生成配图；风格/水印/尺寸可选，先用 map_literary_list_presets 看有哪些。"
            : null,
    };

    internal static string? TitleFromContent(string? content)
    {
        foreach (var line in (content ?? string.Empty).Split('\n'))
        {
            var t = line.Trim().TrimStart('#', '>', '-', '*', ' ').Trim();
            if (t.Length > 0) return t.Length > 40 ? t[..40].Trim() : t;
        }
        return null;
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

        /// <summary>
        /// 带 [插图]: 标记的整篇正文，与 Content 互斥、只能整篇覆盖。改稿后要重新配图就走这里：
        /// 正文与标记一起换成新的一版，旧版配图保留在工作区历史里，不删除。
        /// </summary>
        public string? MarkedContent { get; set; }
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
        var marked = req?.MarkedContent is { } rawMarked ? LiteraryMcpWorkflow.NormalizeMarkedContent(rawMarked) : null;
        if (marked == null)
        {
            var contentError = McpInputBounds.RequireContent(req?.Content);
            if (contentError != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, contentError));
        }
        // 标记当正文写进去，以前会被原样存成文字、配图流程却清空——智能体以为能配图，实际一张也配不了。
        var markedError = LiteraryMcpWorkflow.Validate(req?.Content, marked, null);
        if (markedError != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, markedError));
        var incoming = marked != null ? LiteraryMcpWorkflow.PlainContent(marked) : req!.Content!;

        // mode 只认三种：不给（默认整篇覆盖）、replace、append。写错一个字母不能默默走覆盖 ——
        // 智能体想追加一段、结果整篇正文被那一段替换掉，是这条接口能造成的最大破坏，
        // 而 MCP 的 inputSchema 只是描述性的，网关不拿它校验参数，直连 API 的调用方更是想传什么传什么。
        var rawMode = (req?.Mode ?? string.Empty).Trim();
        var append = string.Equals(rawMode, "append", StringComparison.OrdinalIgnoreCase);
        if (!append && rawMode.Length > 0 && !string.Equals(rawMode, "replace", StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"mode 只能是 replace 或 append，收到的是「{rawMode}」。不传 mode 默认整篇覆盖。"));
        if (append && marked != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                "markedContent 只能整篇覆盖（mode=replace）：标记的序号按全文计算，接在末尾会和已有配图对不上。"));
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

        // 带标记重写一律算「变了」：即便正文逐字相同，配图方案也换成了新的一版。
        var changed = marked != null || !string.Equals(merged, ws.ArticleContent ?? string.Empty, StringComparison.Ordinal);
        var update = Builders<ImageMasterWorkspace>.Update
            .Set(x => x.ArticleContent, merged)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var carriedOver = new List<int>();
        if (changed)
        {
            // 正文换了，之前那轮配图的标记就不再对应这篇文章了。界面侧（ImageMasterController）
            // 在正文提交时会 version++、清标记、清带标记正文，并删掉旧配图资产。
            // 这里做同样的复位，但**不删资产** —— 删除是收不回来的动作，本期不开放给智能体；
            // 图还留在工作区里，只是不再挂在已经变了的正文上。差异记在 debt.platform.md。
            var existingAssets = await _db.ImageAssets.Find(x => x.WorkspaceId == ws.Id).ToListAsync(ct);
            var history = LiteraryIllustrationArchive.ArchiveCurrent(ws, existingAssets, DateTime.UtcNow, LiteraryArchiveReason.AgentRewrite);
            var nextVersion = (ws.ArticleWorkflow?.Version ?? 0) + 1;
            ArticleIllustrationWorkflow? prepared = null;
            if (marked != null)
            {
                prepared = LiteraryMcpWorkflow.Prepare(marked, nextVersion);
                // 描述没变的标记接上原来那张图：改一节正文只需要为改动的那几节重新生成
                carriedOver = LiteraryMcpWorkflow.CarryOverUnchanged(prepared, ws, existingAssets, DateTime.UtcNow);
            }
            update = update
                .Set(x => x.ArticleWorkflow, prepared ?? new ArticleIllustrationWorkflow
                    {
                        Version = nextVersion,
                        Phase = 1,
                        Markers = new List<ArticleIllustrationMarker>(),
                        ExpectedImageCount = null,
                        DoneImageCount = 0,
                        AssetIdByMarkerIndex = new Dictionary<string, string>(),
                        UpdatedAt = DateTime.UtcNow,
                    })
                .Set(x => x.ArticleWorkflowHistory, history)
                .Set(x => x.ArticleContentWithMarkers, marked);
        }

        // 写回一律带条件，只是条件不同：
        // - append 是「读出来 + 拼上去 + 写回去」，条件是「正文还是我读到的那份」，
        //   否则两次并发各读到同一份旧正文，后写的把先写的整段盖掉。
        // - replace 带了版本令牌时，条件是「UpdatedAt 还是我刚校验过的那个」。
        //   上一版只在**进函数时**比了一次令牌，真正那条 UpdateOne 却只按 id 过滤 ——
        //   校验和写入之间那段窗口里用户改一次，照样被盖掉。检查和写入必须是同一个条件，
        //   否则那次检查只是个说法（predicate-and-wiring-discipline 形状 2：链路只建一半）。
        var idFilter = Builders<ImageMasterWorkspace>.Filter.Eq(x => x.Id, ws.Id);
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
        // 一律看写没写进去，不只在带条件时看。不带条件那次（replace 且没给 expectedUpdatedAt）
        // 的过滤器只有 id，匹配不到就只剩一种可能 —— 这个工作区在我读它与写它之间被删了。
        // 上一版在这种情形下直接回 200，等于告诉调用方「写好了」，而库里什么都没发生。
        if (result.MatchedCount == 0)
        {
            // 「没了」和「被改了」得给不同的说法：前者重读也没用，后者重读就能接着写。
            // 回读一次分清楚 —— 与知识库那条撤回路径同一个做法，不猜。
            var still = await _db.ImageMasterWorkspaces
                .Find(x => x.Id == ws.Id)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (still == null)
                return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND",
                    "这个工作区在写入过程中被删除了，内容没有写进去。"));
            return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED",
                append
                    ? "追加期间这个工作区被另一次写入改过（正文或配图流程），这次没有写进去。请先用 map_literary_get_workspace 重新读一遍，再决定怎么写。"
                    : "这篇正文在你准备覆盖的这段时间里被改过，本次覆盖没有执行。请先用 map_literary_get_workspace 重新读一遍，再决定怎么写。"));
        }

        // 盖上旧版本号，让还没盖版本的旧配图明确归入「历史」，不会被按 index 猜回新标记上。
        if (changed)
            await LiteraryIllustrationArchive.StampUnversionedAsync(_db, ws.Id, ws.ArticleWorkflow?.Version ?? 0);

        // 一律回读：正文没变时这次写入照样换了 UpdatedAt，拿进函数时那份 ws 回令牌，调用方下一次带令牌写就会被误判冲突。
        var written = await _db.ImageMasterWorkspaces.Find(x => x.Id == ws.Id).FirstOrDefaultAsync(CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            title = ws.Title,
            contentChars = merged.Length,
            mode = append ? "append" : "replace",
            workflowVersion = written?.ArticleWorkflow?.Version ?? 0,
            illustrations = written?.ArticleWorkflow?.Markers.Select(m => new { index = m.Index, prompt = LiteraryMcpWorkflow.EffectivePrompt(m), status = m.Status, url = m.Url })
                ?? Enumerable.Empty<object>(),
            // 描述没变、沿用原图的标记；其余（needsGeneration）才需要调用生图
            reusedImages = carriedOver,
            needsGeneration = written?.ArticleWorkflow?.Markers.Where(m => !carriedOver.Contains(m.Index)).Select(m => m.Index)
                ?? Enumerable.Empty<int>(),
            updatedAt = written == null ? null : McpRevision.Token(written.UpdatedAt),
        }));
    }
    /// <summary>这篇文章生成过的全部配图（含已被换下的），与网页「历史配图」同一份；放回某张旧图前先读它拿 assetId。</summary>
    [HttpGet("workspaces/{workspaceId}/history")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> GetHistory(string workspaceId, CancellationToken ct)
    {
        var ws = await FindOwnedAsync(workspaceId, ct);
        if (ws == null) return WorkspaceNotFound();
        var assets = await LiteraryIllustrationHistory.LoadAssetsAsync(_db, ws.Id, ct);
        var history = LiteraryIllustrationHistory.Build(ws, assets, u => Request.ResolveAbsoluteUrl(u) ?? u);
        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            workflowVersion = history.CurrentVersion,
            total = history.Total,
            currentCount = history.CurrentCount,
            images = history.Groups.SelectMany(g => g.Items).Select(i => new
            {
                assetId = i.Id, url = i.Url, markerIndex = i.MarkerIndex, description = i.MarkerText,
                workflowVersion = i.WorkflowVersion, isCurrent = i.IsCurrent, createdAt = i.CreatedAt,
                replacedAt = i.ReplacedAt, replacedReason = i.ReplacedReason, inLastSet = i.InLastSet,
            }),
            // 每次换稿前真正挂在正文上的那组（新到旧）。用户说「恢复成上传前的」就取第一组
            previousSets = history.PreviousSets.Select(set => new
            {
                workflowVersion = set.WorkflowVersion, archivedAt = set.ArchivedAt, reason = set.Reason,
                images = set.Images.Select(i => new { markerIndex = i.MarkerIndex, assetId = i.AssetId, url = i.Url, description = i.Description }),
            }),
        }));
    }

    public class UpdateIllustrationRequest
    {
        public string? Prompt { get; set; }
        public int? WorkflowVersion { get; set; }
        /// <summary>读稿时拿到的 updatedAt。网页上改描述不升配图版本号，只靠 workflowVersion 拦不住「改了别人刚改的描述」。</summary>
        public string? ExpectedUpdatedAt { get; set; }
    }

    /// <summary>
    /// 只改一个配图标记的画面描述，正文和其它标记都不动（与网页上改描述同一处写入）。
    /// 以前要改一张图的描述只能整篇带标记重写，智能体得自己拼回全文，拼错就冲掉别人的修改。
    /// 只改描述不重画：之后对这个标记调用生图才会出新图。
    /// </summary>
    [HttpPost("workspaces/{workspaceId}/illustrations/{markerIndex:int}/prompt")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> UpdateIllustrationPrompt(string workspaceId, int markerIndex, [FromBody] UpdateIllustrationRequest? req, CancellationToken ct)
    {
        var prompt = (req?.Prompt ?? string.Empty).Trim();
        if (prompt.Length == 0 || prompt.Length > 4000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "prompt 需为 1-4000 字的画面描述。"));
        if (req?.WorkflowVersion is not { } version)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "workflowVersion 必填：传读稿返回的 workflowVersion。"));
        var ws = await FindOwnedAsync(workspaceId, ct);
        if (ws == null) return WorkspaceNotFound();
        var marker = ws.ArticleWorkflow?.Markers.FirstOrDefault(m => m.Index == markerIndex);
        if (marker == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"配图标记 {markerIndex} 不存在（这篇共 {ws.ArticleWorkflow?.Markers.Count ?? 0} 个，从 0 开始）。"));

        switch (McpRevision.Check(req.ExpectedUpdatedAt, ws.UpdatedAt))
        {
            case RevisionCheck.NotProvided:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    "expectedUpdatedAt 必填：把 map_literary_get_workspace 回的 updatedAt 原样传回来。没有它就可能盖掉用户刚在网页上改的描述。"));
            case RevisionCheck.Unparsable:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    "expectedUpdatedAt 认不出来。把 map_literary_get_workspace 回的 updatedAt 原样传回来即可。"));
            case RevisionCheck.Mismatch:
                return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED",
                    "这篇文章在你读到之后被改过（可能是用户在网页上改了描述），这次没有改。请先用 map_literary_get_workspace 重读，再决定怎么改。"));
        }

        var planItem = new ArticleIllustrationPlanItem { Prompt = prompt, Count = marker.PlanItem?.Count ?? 1, Size = marker.PlanItem?.Size };
        // 版本令牌的条件带进真正那条更新里，否则校验与写入之间仍有空档
        var written = await LiteraryMarkerWrites.PatchMarkerAsync(_db, ws.Id, version, markerIndex,
            new Dictionary<string, object?> { ["draftText"] = prompt }, planItem, unchangedSince: ws.UpdatedAt);
        if (!written)
            return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED",
                "配图方案已经更新（正文被改过或重新规划了标记），这次没有改。请先用 map_literary_get_workspace 重读，再按新的 workflowVersion 改。"));
        var latest = await _db.ImageMasterWorkspaces.Find(x => x.Id == ws.Id).FirstOrDefaultAsync(CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new
        {
            workspaceId = ws.Id,
            markerIndex,
            prompt,
            workflowVersion = version,
            next = $"描述已更新，图还没换。要按新描述出图，对标记 {markerIndex} 调用 map_literary_generate_image。",
            updatedAt = latest == null ? null : McpRevision.Token(latest.UpdatedAt),
        }));
    }

    public class RestoreImageRequest
    {
        public string? AssetId { get; set; }
        public int? WorkflowVersion { get; set; }
    }

    /// <summary>把历史里的某张旧图放回指定配图位置，不重新生成；被换下的那张同样留在历史里。</summary>
    [HttpPost("workspaces/{workspaceId}/illustrations/{markerIndex:int}/restore")]
    [RequireScope(ScopeUse)]
    public async Task<IActionResult> RestoreImage(string workspaceId, int markerIndex, [FromBody] RestoreImageRequest? req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req?.AssetId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "assetId 必填：先用 map_literary_list_history 找到要放回的那张。"));
        if (req.WorkflowVersion is not { } version)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "workflowVersion 必填：传读稿返回的 workflowVersion。"));
        var ws = await FindOwnedAsync(workspaceId, ct);
        if (ws == null) return WorkspaceNotFound();

        var result = await LiteraryIllustrationHistory.RestoreAsync(_db, ws, req.AssetId.Trim(), markerIndex, version, ct);
        return result.Failure switch
        {
            LiteraryIllustrationHistory.RestoreFailure.None => Ok(ApiResponse<object>.Ok(new
            {
                workspaceId = ws.Id,
                markerIndex,
                url = Request.ResolveAbsoluteUrl(result.Url) ?? result.Url,
                prompt = result.Description,
                note = result.Message,
            })),
            LiteraryIllustrationHistory.RestoreFailure.AssetNotFound => NotFound(ApiResponse<object>.Fail("IMAGE_NOT_FOUND", result.Message!)),
            LiteraryIllustrationHistory.RestoreFailure.VersionChanged => Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED", result.Message!)),
            _ => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Message!)),
        };
    }

    private Task<ImageMasterWorkspace?> FindOwnedAsync(string workspaceId, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        return _db.ImageMasterWorkspaces
            .Find(x => x.Id == workspaceId && x.OwnerUserId == userId && x.ScenarioType == ScenarioType)
            .FirstOrDefaultAsync(ct)!;
    }

    private NotFoundObjectResult WorkspaceNotFound()
        => NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "工作区不存在、不属于你，或者不是文学创作的工作区"));
}
