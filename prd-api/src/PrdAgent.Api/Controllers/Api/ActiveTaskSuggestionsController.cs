using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 建议 —— 和派活是两码事。
///
/// 派活：别人替你决定了你要做什么，直接进你的队列（要管理权限）。
/// 建议：任何人都能提，提了什么都不会发生 —— 它躺在你的收件箱里，等你自己吸取。
///
/// 吸取是一次 LLM 整理：默认系统提示词 + 可选引用几个知识库（记住你上次选的）
/// + 可选你自己补的一句要求，把几条零散的建议拧成一条条能动手做的事，
/// 流式吐出来给你勾选，勾了才建。决定权全程在收件人这一侧。
/// </summary>
[ApiController]
[Route("api/active-tasks/suggestions")]
[Authorize]
[AdminController("active-tasks", AdminPermissionCatalog.ActiveTasksUse)]
public class ActiveTaskSuggestionsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<ActiveTaskSuggestionsController> _logger;

    public ActiveTaskSuggestionsController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<ActiveTaskSuggestionsController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>给某人提一条建议。任何能用任务台的人都能提，不需要管理权限。</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SuggestionCreateRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Text))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "建议内容不能为空"));
        if (string.IsNullOrWhiteSpace(req.TargetUserId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "先选给谁"));

        var me = GetUserId();
        // 注意是 UserId 不是 Id —— User 这张表两者是不同的字段，全仓的任务台代码都按 UserId 走
        var target = await _db.Users.Find(x => x.UserId == req.TargetUserId).FirstOrDefaultAsync(ct);
        if (target == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这个人不在"));

        var now = DateTime.UtcNow;
        var entry = new ActiveTaskSuggestion
        {
            TargetUserId = req.TargetUserId!,
            TargetUserName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, req.TargetUserId!, ct),
            FromUserId = me,
            FromUserName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, me, ct),
            Text = req.Text.Trim(),
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ActiveTaskSuggestions.InsertOneAsync(entry, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(ToDto(entry)));
    }

    /// <summary>我收到的建议。默认只给还没处理的 —— 处理过的不该占着收件箱。</summary>
    [HttpGet]
    public async Task<IActionResult> Inbox([FromQuery] string? state = null, CancellationToken ct = default)
    {
        var me = GetUserId();
        var want = ActiveTaskSuggestionState.IsValid(state) ? state! : ActiveTaskSuggestionState.Pending;
        var items = await _db.ActiveTaskSuggestions
            .Find(x => x.TargetUserId == me && x.State == want)
            .SortByDescending(x => x.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);

        var pref = await _db.ActiveTaskAbsorbPreferences.Find(x => x.Id == me).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            items = items.Select(ToDto).ToList(),
            // 上次引用了哪几个知识库、上次补的那句要求 —— 一起下发，前端不必再问一次
            lastStoreIds = pref?.StoreIds ?? new List<string>(),
            lastExtraHint = pref?.ExtraHint,
        }));
    }

    /// <summary>看过了，不打算做。留痕不删 —— 提建议的人该看得到自己那条的下场。</summary>
    [HttpPost("{id}/dismiss")]
    public async Task<IActionResult> Dismiss(string id, CancellationToken ct = default)
    {
        var me = GetUserId();
        var entry = await _db.ActiveTaskSuggestions.Find(x => x.Id == id && x.TargetUserId == me).FirstOrDefaultAsync(ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这条建议不在"));

        var now = DateTime.UtcNow;
        await _db.ActiveTaskSuggestions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskSuggestion>.Update
                .Set(x => x.State, ActiveTaskSuggestionState.Dismissed)
                .Set(x => x.ResolvedAt, now)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { id, dismissed = true }));
    }

    /// <summary>
    /// 可以提给谁。提建议不需要管理权限，所以不能复用管理侧那个 members 端点。
    /// 只给名字和「堆了多少」—— 提建议的人该看得到对方忙不忙，但不该看到对方在做什么的细节。
    /// </summary>
    [HttpGet("people")]
    public async Task<IActionResult> People(CancellationToken ct = default)
    {
        var me = GetUserId();
        var since = DateTime.UtcNow.AddDays(-30);
        var users = await _db.Users
            .Find(x => x.LastActiveAt >= since || x.LastLoginAt >= since)
            .Limit(200)
            .ToListAsync(ct);

        var live = await _db.ActiveTaskEntries
            .Find(x => x.State == ActiveTaskState.Standby)
            .ToListAsync(ct);
        var stackByUser = live.GroupBy(x => x.UserId).ToDictionary(g => g.Key, g => g.Count());

        return Ok(ApiResponse<object>.Ok(users
            .Where(u => u.UserId != me)
            .Select(u => new
            {
                userId = u.UserId,
                displayName = string.IsNullOrWhiteSpace(u.DisplayName) ? u.Username : u.DisplayName,
                username = u.Username,
                standbyCount = stackByUser.TryGetValue(u.UserId, out var n) ? n : 0,
            })
            .OrderBy(x => x.displayName)
            .ToList()));
    }

    /// <summary>可以引用的知识库清单（我自己的 + 我参与的）。</summary>
    [HttpGet("knowledge-stores")]
    public async Task<IActionResult> KnowledgeStores(CancellationToken ct = default)
    {
        var me = GetUserId();
        var stores = await _db.DocumentStores
            .Find(await ReadableStoreFilterAsync(me, ct))
            .SortByDescending(x => x.UpdatedAt)
            .Limit(50)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(stores.Select(x => new { id = x.Id, name = x.Name, description = x.Description }).ToList()));
    }

    /// <summary>
    /// 吸取：把选中的几条建议整理成一条条能动手做的事，流式吐出来。
    /// 不写库 —— 吐出来的东西要人勾了才建（走 POST /api/active-tasks）。
    /// </summary>
    [HttpPost("absorb-stream")]
    public async Task AbsorbStream([FromBody] SuggestionAbsorbRequest req)
    {
        var me = GetUserId();
        SetSseHeaders();
        await WriteSsePreambleAsync();
        await WriteEventAsync("start", null);

        var ids = req?.SuggestionIds?.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList() ?? new List<string>();
        if (ids.Count == 0)
        {
            await WriteEventAsync("error", new { message = "先勾几条建议" });
            return;
        }

        var suggestions = await _db.ActiveTaskSuggestions
            .Find(x => ids.Contains(x.Id) && x.TargetUserId == me)
            .SortBy(x => x.CreatedAt)
            .ToListAsync(CancellationToken.None);
        if (suggestions.Count == 0)
        {
            await WriteEventAsync("error", new { message = "这些建议不在你的收件箱里" });
            return;
        }

        // 记住这次的选择，下次默认带上（换台电脑也还在 —— 所以存服务端不存浏览器）
        var storeIds = req?.StoreIds?.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList() ?? new List<string>();
        var extraHint = req?.ExtraHint?.Trim();
        await _db.ActiveTaskAbsorbPreferences.ReplaceOneAsync(
            x => x.Id == me,
            new ActiveTaskAbsorbPreference { Id = me, StoreIds = storeIds, ExtraHint = extraHint, UpdatedAt = DateTime.UtcNow },
            new ReplaceOptions { IsUpsert = true },
            CancellationToken.None);

        var kb = await BuildKnowledgeContextAsync(me, storeIds);
        await WriteEventAsync("context", new
        {
            suggestions = suggestions.Count,
            stores = kb.StoreCount,
            entries = kb.EntryCount,
            chars = kb.Text.Length,
        });

        var now = DateTime.UtcNow + ActiveTaskConclusion.TeamUtcOffset;
        // 和一键导入同一条硬门：建议原文里一个时间词都没有，模型给的任何日期都是编的。
        // 提示词里的「不许猜」是对模型的期望，不是不变量 —— 弱一点的模型压根压不住。
        var srcText = string.Join("\n", suggestions.Select(x => x.Text));
        var textHasTime = ActiveTasksImportController.HasTimeCue(srcText);
        var systemPrompt =
            "你在帮一个人把别人给他的建议整理成他自己的待办。输出 JSONL：每行一个独立 JSON 对象，行内不得换行，输出完一行立即换行。\n" +
            "不要 markdown 围栏，不要任何前后缀解释。\n\n" +
            "每行格式：\n" +
            "{\"type\":\"task\",\"title\":\"把登录失败的提示改成能看懂的话\",\"dueAt\":\"2026-09-19\",\"from\":\"张三\",\"why\":\"张三说错误码看不懂\"}\n" +
            "全部输出完，最后一行：\n" +
            "{\"type\":\"done\",\"skipped\":\"没转成任务的建议，最多 30 字概括；不要抄原文；没有就省略\"}\n\n" +
            "规则：\n" +
            "1. 建议是别人的说法，不是任务。你要翻译成「我要做什么」：动词开头、8-25 字、有具体落点。\n" +
            "   一条建议里含两件事就拆两条；几条建议说的是同一件事就合成一条，from 写上所有提的人。\n" +
            "2. 只有建议原文真的给了时间才填 dueAt（yyyy-MM-dd），没说就省略这个字段。不许猜。\n" +
            "3. from 写提这条建议的人名；why 写「他原话里哪句让你这么整理」，一句话。两个字段都必填。\n" +
            "4. 纯情绪、纯评价、纯感谢、已经做完的事，一律不转成任务，记进最后那行的 skipped。\n" +
            "5. 引用的知识库内容只用来把话说准（术语、模块名、既有约定），不要凭它自己发明新任务。\n" +
            "6. 最多 20 条。禁止 emoji。用中文，保留专有名词与英文技术词。\n\n" +
            (textHasTime ? $"今天是 {now:yyyy-MM-dd}。\n" : "建议原文没有提到任何时间，所有条目一律不要填 dueAt。\n") +
            (string.IsNullOrWhiteSpace(extraHint) ? "" : $"\n这个人另外提了一个要求，优先满足它：{extraHint}\n");

        var userParts = new List<string>
        {
            "# 收到的建议\n\n" + string.Join("\n\n", suggestions.Select((x, i) =>
                $"{i + 1}. 【{x.FromUserName ?? "某人"}】{x.Text}")),
        };
        if (kb.Text.Length > 0) userParts.Add("# 参考：知识库里的相关内容\n\n" + kb.Text);
        var userContent = string.Join("\n\n---\n\n", userParts);

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: me,
            ViewRole: null,
            DocumentChars: userContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[ActiveTasks-Absorb]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.ActiveTasks.Absorb.Suggestions));

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ActiveTasks.Absorb.Suggestions,
            ModelType = ModelTypes.Chat,
            Stream = true,
            TimeoutSeconds = 120,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userContent },
                },
                ["temperature"] = 0.2,
                ["max_tokens"] = 2560,
            },
        };

        var lineBuf = new StringBuilder();
        var pending = new StringBuilder();
        var emitted = 0;
        var sawModel = false;

        async Task TryEmitAsync(string line)
        {
            var t = line.Trim();
            if (t.Length == 0 || t.StartsWith("```", StringComparison.Ordinal)) return;
            pending.Append(t);
            JsonDocument doc;
            try { doc = JsonDocument.Parse(pending.ToString()); }
            catch (JsonException)
            {
                if (pending.Length > 4000) pending.Clear();
                return;
            }
            using (doc)
            {
                pending.Clear();
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var tp) ? tp.GetString() : null;
                if (type == "task" && emitted < 20)
                {
                    var title = root.TryGetProperty("title", out var ti) ? ti.GetString()?.Trim() : null;
                    if (string.IsNullOrWhiteSpace(title)) return;
                    emitted++;
                    await WriteEventAsync("task", new
                    {
                        title,
                        dueAt = NormalizeDue(textHasTime ? (root.TryGetProperty("dueAt", out var d) ? d.GetString() : null) : null),
                        from = root.TryGetProperty("from", out var f) ? f.GetString() : null,
                        why = root.TryGetProperty("why", out var w) ? w.GetString() : null,
                    });
                }
                else if (type == "done")
                {
                    await WriteEventAsync("summary", new
                    {
                        count = emitted,
                        skipped = ActiveTasksImportController.Clip(root.TryGetProperty("skipped", out var sk) ? sk.GetString() : null, 80),
                    });
                }
            }
        }

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null && !sawModel)
                {
                    sawModel = true;
                    await WriteEventAsync("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName,
                    });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    foreach (var ch in chunk.Content)
                    {
                        if (ch == '\n') { await TryEmitAsync(lineBuf.ToString()); lineBuf.Clear(); }
                        else lineBuf.Append(ch);
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "吸取失败";
                    _logger.LogError("[ActiveTasks-Absorb] gateway error userId={UserId}: {Error}", me, err);
                    await WriteEventAsync("error", new { message = err });
                    return;
                }
            }
            if (lineBuf.Length > 0) await TryEmitAsync(lineBuf.ToString());

            if (emitted == 0)
            {
                await WriteEventAsync("error", new { message = "这几条建议里没读出可以动手做的事" });
                return;
            }
            await WriteEventAsync("done", new { count = emitted });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ActiveTasks-Absorb] unexpected error userId={UserId}", me);
            await WriteEventAsync("error", new { message = "吸取中断了，稍后再试" });
        }
    }

    /// <summary>
    /// 勾完之后：把这几条建议标成已吸取，并记下它们长出了哪几条任务。
    /// 任务本身由前端逐条走 POST /api/active-tasks 建 —— 那条路已经有了，不再造第二条。
    /// </summary>
    [HttpPost("mark-absorbed")]
    public async Task<IActionResult> MarkAbsorbed([FromBody] SuggestionMarkAbsorbedRequest req, CancellationToken ct = default)
    {
        var me = GetUserId();
        var ids = req?.SuggestionIds?.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList() ?? new List<string>();
        if (ids.Count == 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有要标记的建议"));

        var now = DateTime.UtcNow;
        var taskIds = req?.TaskIds ?? new List<string>();
        var result = await _db.ActiveTaskSuggestions.UpdateManyAsync(
            x => ids.Contains(x.Id) && x.TargetUserId == me && x.State == ActiveTaskSuggestionState.Pending,
            Builders<ActiveTaskSuggestion>.Update
                .Set(x => x.State, ActiveTaskSuggestionState.Absorbed)
                .Set(x => x.AbsorbedTaskIds, taskIds)
                .Set(x => x.ResolvedAt, now)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { marked = result.ModifiedCount }));
    }

    /// <summary>
    /// 记下这条建议被拿去涌现了，长出了哪棵树。
    /// 涌现树本身由前端调既有的建树接口创建 —— 这里只连回溯的那根线。
    /// </summary>
    [HttpPost("{id}/emergence")]
    public async Task<IActionResult> LinkEmergence(string id, [FromBody] SuggestionEmergenceRequest req, CancellationToken ct = default)
    {
        var me = GetUserId();
        if (req == null || string.IsNullOrWhiteSpace(req.TreeId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少涌现树 Id"));

        var entry = await _db.ActiveTaskSuggestions.Find(x => x.Id == id && x.TargetUserId == me).FirstOrDefaultAsync(ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这条建议不在"));

        await _db.ActiveTaskSuggestions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskSuggestion>.Update
                .Set(x => x.EmergenceTreeId, req.TreeId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { id, treeId = req.TreeId }));
    }

    // ── 内部 ─────────────────────────────────

    private record KbContext(string Text, int StoreCount, int EntryCount);

    /// <summary>
    /// 把选中的知识库摘成一段上下文。用条目的标题 + 摘要 + 正文索引（前 2000 字那份），
    /// 不做向量检索 —— 本仓库的 embedding 检索还没落地（见 codebase-snapshot），
    /// 假装有会变成无根之木。总量封顶，防止把上下文撑爆。
    /// </summary>
    /// <summary>
    /// 这个人读得到哪些知识库：自己的 + 分享给他所在团队的。
    ///
    /// 只按 OwnerId 过滤会漏掉团队共享库 —— 那些库在知识库页面里看得见、在这里却挑不到，
    /// 而且挑选清单与取正文两处要是各写一份，就会出现「清单里有、引用时被悄悄丢掉」。
    /// 所以判定只有这一处，两边都调它。
    /// </summary>
    private async Task<FilterDefinition<DocumentStore>> ReadableStoreFilterAsync(string userId, CancellationToken ct)
    {
        var myTeams = await _db.TeamMembers
            .Find(m => m.UserId == userId)
            .Project(m => m.TeamId)
            .ToListAsync(ct);

        var fb = Builders<DocumentStore>.Filter;
        var mine = fb.Eq(x => x.OwnerId, userId);
        return myTeams.Count == 0 ? mine : fb.Or(mine, fb.AnyIn(x => x.SharedTeamIds, myTeams));
    }

    private async Task<KbContext> BuildKnowledgeContextAsync(string userId, List<string> storeIds)
    {
        if (storeIds.Count == 0) return new KbContext(string.Empty, 0, 0);

        // 走和挑选清单同一个可读判定 —— 两处各写一份的后果是：清单里挑得到的库，
        // 到了这里被静默丢掉，用户看到的是「引用了 0 个知识库」而没有任何解释。
        var stores = await _db.DocumentStores
            .Find(Builders<DocumentStore>.Filter.And(
                Builders<DocumentStore>.Filter.In(x => x.Id, storeIds),
                await ReadableStoreFilterAsync(userId, CancellationToken.None)))
            .Limit(10)
            .ToListAsync(CancellationToken.None);
        if (stores.Count == 0) return new KbContext(string.Empty, 0, 0);

        var okIds = stores.Select(x => x.Id).ToList();
        var entries = await _db.DocumentEntries
            .Find(x => okIds.Contains(x.StoreId) && !x.IsFolder)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(40)
            .ToListAsync(CancellationToken.None);

        var sb = new StringBuilder();
        var used = 0;
        const int budget = 12000;
        foreach (var e in entries)
        {
            if (sb.Length >= budget) break;
            var body = e.ContentIndex ?? e.Summary ?? string.Empty;
            if (string.IsNullOrWhiteSpace(body) && string.IsNullOrWhiteSpace(e.Title)) continue;
            if (body.Length > 900) body = body[..900];
            sb.Append("## ").Append(e.Title).Append('\n');
            if (!string.IsNullOrWhiteSpace(body)) sb.Append(body).Append('\n');
            sb.Append('\n');
            used++;
        }
        return new KbContext(sb.ToString(), stores.Count, used);
    }

    /// <summary>
    /// 模型给的日期必须落在「今天之后 180 天内」才收 —— 一个过去的日期会让任务
    /// 刚建出来就是逾期红的，比没有时间更糟。
    /// </summary>
    private static string? NormalizeDue(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!DateTime.TryParse(raw.Trim(), out var d)) return null;
        var today = ActiveTaskConclusion.TeamDate(DateTime.UtcNow);
        if (d.Date < today || d.Date > today.AddDays(180)) return null;
        return d.Date.AddHours(18).ToString("yyyy-MM-ddTHH:mm:ss");
    }

    private static object ToDto(ActiveTaskSuggestion x) => new
    {
        id = x.Id,
        text = x.Text,
        fromUserId = x.FromUserId,
        fromUserName = x.FromUserName,
        state = x.State,
        absorbedTaskIds = x.AbsorbedTaskIds,
        emergenceTreeId = x.EmergenceTreeId,
        createdAt = x.CreatedAt,
        resolvedAt = x.ResolvedAt,
    };

    private void SetSseHeaders()
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";
        HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
    }

    private async Task WriteSsePreambleAsync()
    {
        try
        {
            await Response.WriteAsync(": " + new string(' ', 2048) + "\n\n", CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task WriteEventAsync(string eventName, object? data)
    {
        try
        {
            var dataLine = data == null
                ? "null"
                : JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            await Response.WriteAsync($"event: {eventName}\ndata: {dataLine}\n\n", CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }
}

// ===== 请求体 =====

public class SuggestionCreateRequest
{
    public string? TargetUserId { get; set; }
    public string Text { get; set; } = string.Empty;
}

public class SuggestionAbsorbRequest
{
    public List<string>? SuggestionIds { get; set; }
    /// <summary>引用哪几个知识库（可空）。会被记下来，下次默认带上。</summary>
    public List<string>? StoreIds { get; set; }
    /// <summary>自己补的一句额外要求（可空）。同样记下来。</summary>
    public string? ExtraHint { get; set; }
}

public class SuggestionMarkAbsorbedRequest
{
    public List<string>? SuggestionIds { get; set; }
    public List<string>? TaskIds { get; set; }
}

public class SuggestionEmergenceRequest
{
    public string? TreeId { get; set; }
}
