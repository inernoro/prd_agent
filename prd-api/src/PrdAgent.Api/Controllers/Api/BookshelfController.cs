using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 公共藏书阁 —— 个人进度与团队看板。
///
/// 书目与考题是策展的静态内容，SSOT 在前端 lib/bookshelf/catalog.ts，本接口
/// 不碰它们，只管「谁读了什么、考了多少分」。所以卷 id / 书 id 一律当不透明
/// 字符串存，后端不校验它们是否还存在——内容侧删一卷不该让存量进度报错。
///
/// 团队看板只需登录即可看：这个功能存在的意义就是让「谁读到哪」对全队可见，
/// 藏起来就退回原来那个「什么都不跟我说」的状态了。
/// </summary>
[ApiController]
[Route("api/bookshelf")]
[Authorize]
public class BookshelfController : ControllerBase
{
    /// <summary>一句话心得的上限。够写一句「我打算在哪用它」，不够写读书报告——这是有意的。</summary>
    private const int NoteMaxLength = 200;

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<BookshelfController> _logger;

    /*
     * SSE 写入串行化 + 最后写入时刻。
     *
     * 心跳任务与主循环会同时往同一个 Response 写，没有锁就是两股字节交织，
     * 客户端解析出来是半行。Controller 实例每请求一个，字段不会跨请求串。
     */
    private readonly SemaphoreSlim _sseWriteLock = new(1, 1);

    /// <summary>最后一次写 SSE 的时刻（ticks）。心跳线程读、主循环写，故走 Volatile。</summary>
    private long _lastSseWriteTicks = DateTime.UtcNow.Ticks;

    /*
     * 这条连接还写得出去吗。
     *
     * 客户端关掉标签页或代理掐断之后，往 Response 写会抛 IOException。那不是错误，
     * 是「读的人走了」——但稿子是**公共内容**，生成它的钱已经花了，模型也还在吐，
     * 让这个异常冒出去会停掉对网关流的消费、连带把写库那一步一起跳过：
     * 下一个人点开这本书，又从头生成一篇，再花一次钱。
     *
     * 所以断开只关掉「写」，不关掉「生成与落库」（`server-authority` 规则 2/3）。
     * 置位之后心跳与后续事件都不再尝试写这个已经断掉的 socket。
     */
    private volatile bool _sseBroken;

    private static readonly JsonSerializerOptions SseJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public BookshelfController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<BookshelfController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    /// <summary>取我的进度。没有记录时返回空进度，不 404——首次进页面是常态不是异常。</summary>
    [HttpGet("progress")]
    public async Task<IActionResult> GetMyProgress()
    {
        var userId = this.GetRequiredUserId();
        var doc = await _db.BookshelfProgresses.Find(x => x.UserId == userId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new
        {
            readBookIds = doc?.ReadBookIds ?? new List<string>(),
            bookNotes = doc?.BookNotes ?? new Dictionary<string, string>(),
            examResults = ToResultMap(doc),
            updatedAt = doc?.UpdatedAt,
        }));
    }

    /// <summary>
    /// 覆盖保存我的进度（整包 PUT）。
    ///
    /// 考试成绩取「更好的那次」而不是直接覆盖：前端已按同样规则挡过一道，
    /// 但那道挡不住换设备后本地是空的、一交卷就把服务端的好成绩冲掉。
    /// 判据放在服务端才是真的。
    /// </summary>
    [HttpPut("progress")]
    public async Task<IActionResult> SaveMyProgress([FromBody] SaveBookshelfProgressRequest req)
    {
        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;

        var existing = await _db.BookshelfProgresses.Find(x => x.UserId == userId).FirstOrDefaultAsync();
        var merged = existing?.ExamResults ?? new Dictionary<string, BookshelfExamResult>();

        foreach (var (volumeId, incoming) in req.ExamResults ?? new Dictionary<string, SaveBookshelfExamResult>())
        {
            if (string.IsNullOrWhiteSpace(volumeId) || incoming is null) continue;
            if (incoming.Total <= 0) continue;                       // 空卷不入库
            if (incoming.Correct < 0 || incoming.Correct > incoming.Total) continue;  // 越界丢弃，不信任前端

            // 读书数是快照，越界一律按 0（即裸考）——宁可少算通关，不许凭前端一句话虚增。
            var readAtExam = incoming.ReadAtExam < 0 ? 0 : incoming.ReadAtExam;

            // 「更好的那次」的判据在 BookshelfExamScoring，前后端同一套口径，别在这里再写一遍
            merged.TryGetValue(volumeId, out var prev);
            if (!BookshelfExamScoring.IsBetter(prev, incoming.Correct, incoming.Total, readAtExam)) continue;

            merged[volumeId] = new BookshelfExamResult
            {
                Correct = incoming.Correct,
                Total = incoming.Total,
                // 及格与否服务端自己算。前端那份 passed 只管交卷那一屏的即时反馈，
                // 落库的结论不能由它说了算（frontend-architecture：前端不持有业务判定）。
                Passed = BookshelfExamScoring.IsPassed(incoming.Correct, incoming.Total),
                ReadAtExam = readAtExam,
                TotalAtExam = incoming.TotalAtExam < 0 ? 0 : incoming.TotalAtExam,
                TakenAt = now,
            };
        }

        var readIds = (req.ReadBookIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();

        // 心得整包覆盖（它就是用户手上那份，没有「取更好的那次」这种语义）。
        // 清洗三件事：去掉空白条、砍掉超长文本、丢掉没有书 id 的条目——
        // 这是自由文本入库，前端说什么都不能直接信。
        var notes = (req.BookNotes ?? new Dictionary<string, string>())
            .Where(kv => !string.IsNullOrWhiteSpace(kv.Key) && !string.IsNullOrWhiteSpace(kv.Value))
            .ToDictionary(
                kv => kv.Key.Trim(),
                kv => kv.Value.Trim().Length > NoteMaxLength
                    ? kv.Value.Trim()[..NoteMaxLength]
                    : kv.Value.Trim());

        var update = Builders<BookshelfProgress>.Update
            .Set(x => x.UserId, userId)
            .Set(x => x.ReadBookIds, readIds)
            .Set(x => x.BookNotes, notes)
            .Set(x => x.ExamResults, merged)
            .Set(x => x.UpdatedAt, now)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.CreatedAt, now);

        try
        {
            await _db.BookshelfProgresses.UpdateOneAsync(
                x => x.UserId == userId, update, new UpdateOptions { IsUpsert = true });
        }
        catch (MongoWriteException mwe) when (mwe.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            /*
             * 撞上 UserId 的唯一索引：这个人此前没有行，两个请求同时走到 insert 分支，
             * 对方先建成了。
             *
             * 这条路径是本次加索引**新造出来**的——加索引之前两行都写得进去（那正是
             * 索引要治的病），加完之后输的那一方会 E11000 冒到 ExceptionMiddleware 变成
             * 500，把这一发的快照整个丢掉。把静默的数据错换成响亮的数据丢，不算修好。
             *
             * 输的一方重跑一次：此时对方的行已经在了，走的是 update 分支，
             * 而且会重新读一次 existing 把两边的成绩按「更好的那次」合并进去。
             */
            _logger.LogInformation("藏书阁进度并发首存，另一方先建行 UserId={UserId}，重试一次合并", userId);

            var winner = await _db.BookshelfProgresses.Find(x => x.UserId == userId).FirstOrDefaultAsync();
            var remerged = winner?.ExamResults ?? new Dictionary<string, BookshelfExamResult>();
            foreach (var (volumeId, mine) in merged)
            {
                if (!BookshelfExamScoring.IsBetter(
                        remerged.TryGetValue(volumeId, out var theirs) ? theirs : null,
                        mine.Correct, mine.Total, mine.ReadAtExam))
                {
                    continue;
                }
                remerged[volumeId] = mine;
            }
            merged = remerged;

            await _db.BookshelfProgresses.UpdateOneAsync(
                x => x.UserId == userId,
                Builders<BookshelfProgress>.Update
                    .Set(x => x.UserId, userId)
                    .Set(x => x.ReadBookIds, readIds)
                    .Set(x => x.BookNotes, notes)
                    .Set(x => x.ExamResults, remerged)
                    .Set(x => x.UpdatedAt, now),
                new UpdateOptions { IsUpsert = true });
        }

        return Ok(ApiResponse<object>.Ok(
            new { readBookIds = readIds, bookNotes = notes, examResults = ToPlainMap(merged), updatedAt = now }));
    }

    /// <summary>
    /// 团队看板：谁读到哪、谁通关了几卷。
    ///
    /// 这是整个藏书阁「公共」二字的另一半——书单解决「新人不知道该会什么」，
    /// 看板解决「你不知道新人到底会不会」。
    /// </summary>
    [HttpGet("team")]
    public async Task<IActionResult> GetTeamBoard()
    {
        var all = await _db.BookshelfProgresses.Find(_ => true).ToListAsync();

        var userIds = all.Select(x => x.UserId).Distinct().ToList();
        var users = userIds.Count == 0
            ? new List<User>()
            : await _db.Users.Find(u => userIds.Contains(u.UserId)).ToListAsync();
        var nameOf = users.ToDictionary(
            u => u.UserId,
            u => string.IsNullOrWhiteSpace(u.DisplayName) ? u.Username : u.DisplayName);

        var rows = all
            .Select(p => new
            {
                userId = p.UserId,
                // 查不到用户（离职清理、脏数据）时不塞假名字，前端按 null 显示「未知成员」
                displayName = nameOf.TryGetValue(p.UserId, out var n) ? n : null,
                readCount = p.ReadBookIds.Count,
                // 写下过几条心得。「已读」是自我声明，这个数才说明真读进去了。
                noteCount = p.BookNotes.Count(kv => !string.IsNullOrWhiteSpace(kv.Value)),
                // 通关口径与前端 examContext.countsAsPassed 一致：读过 + 通过。
                // 裸考（交卷时一本没读）单独计——否则读完整卷的人和没读的人在看板上长得一样，这个数就废了。
                passedCount = p.ExamResults.Values.Count(r => r.Passed && r.ReadAtExam > 0),
                blindPassedCount = p.ExamResults.Values.Count(r => r.Passed && r.ReadAtExam <= 0),
                passedVolumeIds = p.ExamResults
                    .Where(kv => kv.Value.Passed && kv.Value.ReadAtExam > 0)
                    .Select(kv => kv.Key).ToList(),
                updatedAt = p.UpdatedAt,
            })
            .OrderByDescending(r => r.passedCount)
            .ThenByDescending(r => r.readCount)
            .ToList();

        // 每卷有多少人通关 —— 看板真正的用处：一眼看出全队哪一卷最薄弱。
        // 只计读过再考过的；裸考通过另算一份，看板分开展示。
        var perVolume = all
            .SelectMany(p => p.ExamResults
                .Where(kv => kv.Value.Passed && kv.Value.ReadAtExam > 0).Select(kv => kv.Key))
            .GroupBy(v => v)
            .ToDictionary(g => g.Key, g => g.Count());
        var perVolumeBlind = all
            .SelectMany(p => p.ExamResults
                .Where(kv => kv.Value.Passed && kv.Value.ReadAtExam <= 0).Select(kv => kv.Key))
            .GroupBy(v => v)
            .ToDictionary(g => g.Key, g => g.Count());

        return Ok(ApiResponse<object>.Ok(new
        {
            members = rows,
            memberCount = rows.Count,
            passedByVolume = perVolume,
            blindPassedByVolume = perVolumeBlind,
        }));
    }

    private static Dictionary<string, object> ToResultMap(BookshelfProgress? doc)
        => doc is null ? new Dictionary<string, object>() : ToPlainMap(doc.ExamResults);

    private static Dictionary<string, object> ToPlainMap(Dictionary<string, BookshelfExamResult> src)
        => src.ToDictionary(
            kv => kv.Key,
            kv => (object)new
            {
                volumeId = kv.Key,
                correct = kv.Value.Correct,
                total = kv.Value.Total,
                passed = kv.Value.Passed,
                // 这两个必须原样吐回去：少了它们前端读到 0，所有成绩都会退化成「裸考」，
                // 通关数一夜清零。写进库却读不回来，是典型的「链路只建一半」。
                readAtExam = kv.Value.ReadAtExam,
                totalAtExam = kv.Value.TotalAtExam,
                takenAt = kv.Value.TakenAt,
            });
    // ───────────── 精读稿 ─────────────
    //
    // 藏书阁原来只有一张书单：书名、作者、一句 takeaway，然后一个输入框让用户自己写心得。
    // 用户点两下发现没东西读是必然的 —— 里面本来就只有索引、没有内容。
    // 用户原话：「点进去就是让用户输入，什么意思？用户提供内容？」
    //
    // 这两个端点让「学习」这件事真的发生：系统产出可读的内容，用户消费它。
    // 按需生成：第一个点进这本书的人触发，生成完落库，之后所有人读同一篇。

    /// <summary>取这本书的精读稿。还没生成时返回 exists=false，不 404 —— 首次点开是常态不是异常。</summary>
    [HttpGet("books/{bookId}/digest")]
    public async Task<IActionResult> GetDigest(string bookId, CancellationToken ct)
    {
        var id = (bookId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(id))
            return Ok(ApiResponse<object>.Ok(new { exists = false }));

        // 同一个 CDS 项目下所有分支共用一个 Mongo，所以取本书全部候选再按作用域挑：
        // 自己写的优先、权威部署的兜底（新预览分支没自己生成过时照旧有东西读）。
        var candidates = await _db.BookDigests.Find(x => x.BookId == id).ToListAsync(ct);
        var doc = BookshelfDigestScope.PickVisible(candidates, BookshelfDigestScope.Current);
        if (doc == null || string.IsNullOrWhiteSpace(doc.Content))
            return Ok(ApiResponse<object>.Ok(new { exists = false }));

        return Ok(ApiResponse<object>.Ok(new
        {
            exists = true,
            content = doc.Content,
            model = doc.Model,
            platform = doc.Platform,
            citedRules = doc.CitedRules,
            generatedAt = doc.GeneratedAt,
            // 提示词升版、或这本书的材料变了（改挂规则、规则正文改了）之后，前端据此不吃缓存。
            // 判据只此一处（BookshelfDigestPrompt.IsFresh），与生成那边复用的是同一个函数。
            stale = !BookshelfDigestPrompt.IsFresh(doc, BookshelfDigestPrompt.Find(id)),
        }));
    }

    /// <summary>
    /// 流式生成这本书的精读稿。
    ///
    /// 走 SSE 而不是等生成完一次性返回：这一篇要写一两千字，等完再给就是几十秒白屏，
    /// 而本仓库对这件事有明令（规则 #6：静止的「加载中」超过 2 秒即为体验缺陷）。
    /// </summary>
    [HttpGet("books/{bookId}/digest/stream")]
    [Produces("text/event-stream")]
    public async Task StreamDigest(string bookId, [FromQuery] bool force, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = this.GetRequiredUserId();
        var id = (bookId ?? string.Empty).Trim();

        var material = BookshelfDigestPrompt.Find(id);
        if (material == null)
        {
            /*
             * 这两种情形在用户那里看起来一模一样，下一步却完全相反：
             *   - 材料整份没载进来 → 这个部署的内嵌资源坏了，51 本全打不开，去查构建
             *   - 材料好好的、就是没有这本书 → 内容侧删了它，无需处理
             * 压成同一句「书单里没有这本书」，运维只会照着后者去查，永远查不到
             * （`predicate-and-wiring-discipline` 形状 10）。
             */
            if (BookshelfDigestPrompt.IsContextUnavailable)
            {
                _logger.LogError(
                    "精读稿材料整份不可用，全部书目都会打不开：{Reason}",
                    BookshelfDigestPrompt.LoadFailureReason);
                await WriteDigestEventAsync("error", new
                {
                    code = "CONTEXT_UNAVAILABLE",
                    message = "这个部署的书目材料没有载入，所有书都打不开——这是部署问题，不是这本书的问题",
                }, ct);
                return;
            }
            await WriteDigestEventAsync("error", new { code = "NOT_FOUND", message = "书单里没有这本书" }, ct);
            return;
        }

        // 已经有稿子就直接吐出去，不重复烧一次生成。force=true 是「重新生成」那个按钮走的路径。
        //
        // 提示词改版、或这本书的材料变了（改挂 relatedRules、规则正文改了）之后，旧稿子不再复用。
        // 这两个字段如果没人读，它们就只是记下来给人看的备注，还得靠人记得「哪些该重生成」
        // ——而人不会记得。判据放在服务端是因为稿子是公共内容，只有这里能保证所有入口口径一致，
        // 且与 GetDigest 的 stale 走同一个函数（形状 3：判据不许分裂成两份各自漂移）。
        // 无论走不走复用都要先读一次：重写那一篇必须沿用库里那份的 _id（见文末保存处）。
        var scope = BookshelfDigestScope.Current;
        var existingCandidates = await _db.BookDigests.Find(x => x.BookId == id).ToListAsync(ct);
        var existing = BookshelfDigestScope.PickVisible(existingCandidates, scope);
        if (!force)
        {
            if (existing != null && BookshelfDigestPrompt.IsFresh(existing, material))
            {
                await WriteDigestEventAsync("cached", new
                {
                    content = existing.Content,
                    model = existing.Model,
                    platform = existing.Platform,
                    citedRules = existing.CitedRules,
                }, ct);
                await WriteDigestEventAsync("done", new { reused = true }, ct);
                return;
            }
        }

        /*
         * 网关执行前会读 ILLMRequestContextAccessor.Current 取 UserId（llm-gateway 规则）。
         * GatewayRequest.Context 也能兜住这件事——所以这条链路一直是通的——但请求日志的
         * requestId / requestType 归因只认这个作用域，缺了它 llmrequestlogs 里这条记录
         * 认不回是哪一次点击。补上，别让下一个查日志的人对着一条没有出处的记录发呆。
         */
        using var _llmScope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Bookshelf.Digest));

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Bookshelf.Digest,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = false,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BookshelfDigestPrompt.BuildSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = BookshelfDigestPrompt.BuildUserPrompt(material) },
                },
                ["temperature"] = 0.6,
                ["max_tokens"] = 4000,
            },
            Context = new GatewayRequestContext
            {
                UserId = userId,
                QuestionText = "精读稿：" + material.Book.Title,
            },
        };

        var buffer = new StringBuilder();
        string? model = null;
        string? platform = null;
        string? streamError = null;
        /*
         * 见过终止块没有。网关正常收尾时一定会 yield 一个 Done
         * （LlmGateway happy path 的最后一句），而 /gw/v1/stream 是
         * `JsonSerializer.Serialize(chunk)` 逐块原样转发、不做任何过滤，
         * 所以 http 模式下它一定到得了这里——这一点是读代码确认的，不是假设。
         *
         * 不认它的后果与不认 Error 块完全一样：API 与 serving 之间的 SSE
         * 若在几个 Text 之后「干净地」关掉（没有异常、也没有 Error 块），
         * await foreach 就这么正常结束了，半篇稿子会被当成写完了落库成
         * 这本书的**公共**稿子。这是本 PR 里同一个形状的第六次。
         */
        var sawTerminalChunk = false;

        /*
         * 心跳（`server-authority` 规则 4：SSE 必须每 10 秒 keepalive）。
         *
         * 这条流有两段天然的长静默：开头解析模型池、以及推理模型吐第一个字之前。
         * 静默期间一个字节都不发，nginx / CDN 按空闲超时把连接掐了——而后端拿的是
         * CancellationToken.None，它会继续烧完这几分钟、继续把稿子落库。
         * 于是用户看到「连接断了」，钱照花、稿子照写，两边对不上。
         *
         * 只在真的静默满 10 秒时才发，正文流起来之后它自然不作声。
         */
        using var heartbeatCts = new CancellationTokenSource();
        var streamStartedAt = DateTime.UtcNow;
        var heartbeatTask = Task.Run(async () =>
        {
            try
            {
                while (!heartbeatCts.IsCancellationRequested)
                {
                    try { await Task.Delay(TimeSpan.FromSeconds(2), heartbeatCts.Token); }
                    catch (OperationCanceledException) { return; }
                    if (heartbeatCts.IsCancellationRequested) return;
                    var quietFor = DateTime.UtcNow.Ticks - Volatile.Read(ref _lastSseWriteTicks);
                    if (quietFor < TimeSpan.TicksPerSecond * 10) continue;

                    // 用 ct 而不是 None：客户端真断了就该停，没必要对着空管道写
                    await WriteDigestEventAsync("heartbeat", new
                    {
                        elapsedMs = (int)(DateTime.UtcNow - streamStartedAt).TotalMilliseconds,
                    }, ct);
                }
            }
            catch { /* 心跳出任何问题都不许打断正文 */ }
        }, CancellationToken.None);

        try
        {
            /*
             * 这里必须是 CancellationToken.None，不是 ct（server-authority 规则 1）。
             * 传 ct 的话，读者读到一半退出页面就会把整篇生成连根掐掉：三分钟的
             * 模型调用白烧、库里什么都没落下，下一个点进来的人从零开始再等一遍。
             * 稿子是公共内容，它该写完——写完之后谁点进来都能直接读到。
             *
             * 往断掉的连接写 SSE 不会炸：WriteDigestEventAsync 把「读的人走了」的三种
             * 异常（取消、连接已释放、socket 被重置的 IOException）一律吞掉并置位，
             * 之后只停止写，生成与落库照常走完。少认一种，异常就会从写的那一步冒回
             * 这个循环，把「稿子该写完」这件事一起掐掉——而钱已经花了。
             */
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start)
                {
                    model = chunk.Resolution?.ActualModel;
                    platform = chunk.Resolution?.ActualPlatformName;
                    // 模型可见性（`ai-model-visibility`）：用户会因为换了模型感知到差异，得让他看得见
                    await WriteDigestEventAsync("start", new { model, platform }, ct);
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    buffer.Append(chunk.Content);
                    await WriteDigestEventAsync("text", new { content = chunk.Content }, ct);
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    sawTerminalChunk = true;
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    /*
                     * 网关的失败是**一个块**，不是一个异常：`LlmGateway` 在流中途断开时
                     * 走的是 `yield return Fail(...)` 然后 `yield break`，`await foreach`
                     * 正常结束，catch 一个都不会进。
                     *
                     * 不认这个块的后果比「这次没生成出来」严重得多：buffer 里那半篇
                     * 会被当成写完了，落库成这本书的公共稿子，此后每个点进来的人都读到
                     * 一篇断在半句话上的东西，而且判据认为它是新鲜的——除非有人想到去点
                     * 「重新生成」，否则它会一直在那里。
                     *
                     * Error 块之后不会再有 Done，所以记下来跳出即可。
                     */
                    streamError = chunk.Error;
                    _logger.LogError(
                        "精读稿生成中断 BookId={BookId} ErrorCode={Code} Error={Error} 已收到 {Len} 字，不落库",
                        id, chunk.ErrorCode, chunk.Error, buffer.Length);
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            heartbeatCts.Cancel();
            try { await heartbeatTask; } catch { /* ignore */ }
            // 走到这里只剩一种情况：网关自己中断了（进程停机）。客户端断开已经
            // 不再能取消这条流。半篇稿子不落库——下一个人点开会读到一篇断在半句话
            // 上的东西，还以为它就是全部。
            return;
        }
        catch (Exception ex)
        {
            heartbeatCts.Cancel();
            try { await heartbeatTask; } catch { /* ignore */ }
            _logger.LogError(ex, "生成精读稿失败 BookId={BookId}", id);
            await WriteDigestEventAsync("error", new { code = "GEN_FAILED", message = "生成失败，稍后再试" }, ct);
            return;
        }

        heartbeatCts.Cancel();
        try { await heartbeatTask; } catch { /* 停心跳失败不影响落库 */ }

        if (streamError != null)
        {
            // 半篇稿子不落库。库里那份（如果有）原样留着，读者下次点开读到的仍是完整的旧稿，
            // 而不是这次断掉的半篇。
            await WriteDigestEventAsync("error", new
            {
                code = "STREAM_FAILED",
                message = "生成中断了，稿子没有写完，没有保存。重试一次",
            }, ct);
            return;
        }

        if (!sawTerminalChunk)
        {
            // 流没有正常收尾（既没抛异常、也没发 Error 块，就是没了）。半篇不落库。
            _logger.LogError(
                "精读稿的上游流没有终止块就结束了 BookId={BookId}，已收到 {Len} 字，不落库",
                id, buffer.Length);
            await WriteDigestEventAsync("error", new
            {
                code = "STREAM_TRUNCATED",
                message = "生成没有正常收尾，稿子没写完，没有保存。重试一次",
            }, ct);
            return;
        }

        var content = buffer.ToString().Trim();
        if (string.IsNullOrWhiteSpace(content))
        {
            await WriteDigestEventAsync("error", new { code = "EMPTY", message = "模型没有返回内容" }, ct);
            return;
        }

        /*
         * 落库前再看一眼**本作用域**下现在有没有这一行。
         *
         * 按作用域过滤是硬要求：复用看的是「本部署看得见的那一篇」（自己的优先、权威的兜底），
         * 但**写只写自己那一行**——拿权威那份的 _id 去 Replace，就是分支预览改写了权威数据，
         * `cross-project-isolation` 通道 4 要防的正是这件事。
         *
         * 为什么放在这里而不是沿用生成前那一眼：那一眼是**三分钟以前**的，
         * 生成期间另一个读者完全可能把这本书先写进来。
         * 那时下面的 filter 会匹配上他那一行，而 digest.Id 若是新造的 Guid，Mongo 以
         * code 66 拒绝（`_id` 不可变）。它**不是**撞唯一索引，下面那个 catch 原先接不住，
         * 于是这个读者烧完一整篇之后只拿到一句 SAVE_FAILED。
         *
         * 用 None：读者退出页面不该让这一眼取消掉（server-authority 规则 1）。
         */
        var latestExisting = await _db.BookDigests
            .Find(x => x.BookId == id && x.DeploymentSlug == scope)
            .FirstOrDefaultAsync(CancellationToken.None);

        var digest = new BookDigest
        {
            /*
             * 沿用库里那份的 _id，且用的是**刚刚那一眼**（latestExisting）而不是生成前那一眼。
             * BookDigest 的 Id 默认是 Guid.NewGuid()，拿新对象去 ReplaceOne 一份已存在的
             * 文档，Mongo 以 code 66 拒绝：「_id 是不可变字段」。
             *
             * 这个洞从第一版就在，而且只在「重写」时才现形——首次生成走的是 upsert 的
             * insert 分支，_id 是新的没问题；第二次起每一次都炸，异常又发生在 SSE 已经
             * 开始输出之后，ExceptionMiddleware 想改 header 再炸一次，于是前端只看到流
             * 无声断掉、库里还是旧的那篇。三次「重新生成」全部石沉大海，日志里才有真相。
             *
             * 第二种触发方式更隐蔽：首次生成期间另一个读者先写成了，于是「本来该走 insert」
             * 的这一次也撞上一行已存在的文档。窗口收窄靠上面那一眼，收不干净的那一丝
             * 由下面的 catch 兜住——两个人同时点开一本没稿子的书，本来就该有一个人的
             * 产物被丢弃，但他不该看到报错。
             */
            Id = latestExisting?.Id ?? Guid.NewGuid().ToString("N"),
            BookId = id,
            Content = content,
            PromptVersion = BookshelfDigestPrompt.Version,
            // 不写这一笔，下一次点开又会判过期、又重烧一篇，无限循环
            MaterialFingerprint = BookshelfDigestPrompt.ComputeMaterialFingerprint(material),
            Model = model,
            Platform = platform,
            GeneratedByUserId = userId,
            GeneratedAt = DateTime.UtcNow,
            CitedRules = material.Rules.Select(r => r.Name).ToList(),
            DeploymentSlug = scope,
        };

        // 一本书一篇，整篇替换。upsert 而不是 insert：「重新生成」走同一条路，
        // 不该在库里堆出两篇。
        // 同样用 None：读者退出页面不该让「已经写完的那一篇」写不进库（server-authority 规则 1）。
        try
        {
            await _db.BookDigests.ReplaceOneAsync(
                x => x.BookId == id && x.DeploymentSlug == scope,
                digest,
                new ReplaceOptions { IsUpsert = true },
                CancellationToken.None);
        }
        // 66 = ImmutableField（`_id` 不可变）。上面那一眼把窗口收到了毫秒级，
        // 但收不干净：re-read 与 replace 之间仍可能被另一个人插进来。两种错码到这里
        // 都只意味着一件事——「有人抢在前面写了」，处置方式完全相同。
        catch (MongoWriteException mwe) when (
            mwe.WriteError?.Category == ServerErrorCategory.DuplicateKey || mwe.WriteError?.Code == 66)
        {
            var immutableId = mwe.WriteError?.Code == 66;
            /*
             * 撞上唯一索引（或撞上别人刚写下的那一行的 _id）。
             * 默认解释是「两个人同时点开这本还没有稿子的书，对方先写成了」——
             * 公共稿子本来就是一本一篇，谁先写完算谁的，不必让读者看到报错。
             *
             * 但**不许直接认定是这种情况**。还有一种撞键长得一模一样、后果却完全相反：
             * 库里若还留着只按 BookId 的旧唯一索引（本 PR 早先那一版清单建的），
             * 换一个 DeploymentSlug 插同一本书永远会 E11000。那时这一段会把
             * 「这条分支的稿子永远存不下」判成「别人写好了」，于是每次点开都重烧一篇，
             * 钱一直在花而没有任何东西报错——一个把永久失败伪装成正常的组合。
             *
             * 所以回头确认一次：本作用域下真的有一篇了才算数，没有就如实报错。
             */
            var afterConflict = await _db.BookDigests
                .Find(x => x.BookId == id && x.DeploymentSlug == scope)
                .FirstOrDefaultAsync(CancellationToken.None);

            if (afterConflict != null && !string.IsNullOrWhiteSpace(afterConflict.Content))
            {
                _logger.LogInformation("精读稿并发生成，另一方先落库 BookId={BookId}，本次不覆盖", id);
            }
            else if (immutableId)
            {
                // 匹配到了一行、又说 _id 不可变，回头却读不到——那行在这中间被删掉了。
                // 不是索引问题，别拿索引的说法去误导运维。
                _logger.LogError(
                    mwe,
                    "精读稿落库撞 _id 不可变但回读为空 BookId={BookId} Scope={Scope}",
                    id, scope ?? "(权威部署)");
                await WriteDigestEventAsync("error", new
                {
                    code = "SAVE_FAILED",
                    message = "稿子写完了但没能存下，重试一次",
                }, ct);
                return;
            }
            else
            {
                _logger.LogError(
                    mwe,
                    "精读稿撞唯一索引但本作用域下没有稿子 BookId={BookId} Scope={Scope}——"
                        + "多半是库里还留着只按 BookId 的旧唯一索引，请执行 scripts/mongodb-indexes.js 迁移",
                    id, scope ?? "(权威部署)");
                await WriteDigestEventAsync("error", new
                {
                    code = "INDEX_CONFLICT",
                    message = "稿子写完了但存不下：数据库索引与当前版本不匹配，请联系管理员执行索引迁移",
                }, ct);
                return;
            }
        }
        catch (Exception ex)
        {
            /*
             * 写库炸在 SSE 已经开始输出之后：异常一路冒到 ExceptionMiddleware，它想改
             * Content-Type 又炸一次「Headers are read-only」，最终前端看到的是流无声断掉。
             * 在这里兜住，至少让读者知道「稿子写完了但没存下」，而不是对着半截屏幕猜。
             */
            _logger.LogError(ex, "精读稿写库失败 BookId={BookId}", id);
            await WriteDigestEventAsync("error", new { code = "SAVE_FAILED", message = "稿子写完了但没能存下，重试一次" }, ct);
            return;
        }

        await WriteDigestEventAsync("done", new
        {
            reused = false,
            model,
            platform,
            citedRules = digest.CitedRules,
        }, ct);
    }

    private async Task WriteDigestEventAsync(string eventName, object data, CancellationToken ct)
    {
        if (_sseBroken) return;                 // 已经断了，别再往破 socket 上写
        await _sseWriteLock.WaitAsync(CancellationToken.None);
        try
        {
            var json = JsonSerializer.Serialize(data, SseJsonOptions);
            await Response.WriteAsync("event: " + eventName + "\n", ct);
            await Response.WriteAsync("data: " + json + "\n\n", ct);
            await Response.Body.FlushAsync(ct);
            Volatile.Write(ref _lastSseWriteTicks, DateTime.UtcNow.Ticks);
        }
        // 三种都是同一件事：读的人走了。一律吞掉并置位，让生成与落库照常走完。
        catch (OperationCanceledException) { _sseBroken = true; }   // 客户端断开
        catch (ObjectDisposedException) { _sseBroken = true; }      // 连接已关闭
        catch (IOException) { _sseBroken = true; }                  // socket 被重置（Kestrel 实际抛的就是它）
        finally
        {
            _sseWriteLock.Release();
        }
    }

}

/// <summary>整包保存进度的请求体。</summary>
public class SaveBookshelfProgressRequest
{
    public List<string>? ReadBookIds { get; set; }
    /// <summary>书 id → 一句话心得。整包覆盖，服务端会清洗空白与超长。</summary>
    public Dictionary<string, string>? BookNotes { get; set; }
    public Dictionary<string, SaveBookshelfExamResult>? ExamResults { get; set; }
}

/// <summary>单卷成绩。Passed 字段仅为兼容旧客户端保留，服务端按自己的及格线重算，不采信它。</summary>
public class SaveBookshelfExamResult
{
    public int Correct { get; set; }
    public int Total { get; set; }
    /// <summary>已废弃：服务端重算，读不读它都不影响落库结果。</summary>
    public bool Passed { get; set; }
    /// <summary>交卷时该卷已读 / 总本数。旧客户端不传，默认 0 即按裸考处理。</summary>
    public int ReadAtExam { get; set; }
    public int TotalAtExam { get; set; }
}
