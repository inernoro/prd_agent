using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
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
    private readonly ILogger<BookshelfController> _logger;

    private static readonly JsonSerializerOptions SseJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public BookshelfController(MongoDbContext db, ILlmGateway gateway, ILogger<BookshelfController> logger)
    {
        _db = db;
        _gateway = gateway;
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

            var better = !merged.TryGetValue(volumeId, out var prev) || incoming.Correct > prev.Correct;
            if (!better) continue;

            merged[volumeId] = new BookshelfExamResult
            {
                Correct = incoming.Correct,
                Total = incoming.Total,
                Passed = incoming.Passed,
                // 读书数是快照，越界一律按 0（即裸考）——宁可少算通关，不许凭前端一句话虚增。
                ReadAtExam = incoming.ReadAtExam < 0 ? 0 : incoming.ReadAtExam,
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

        await _db.BookshelfProgresses.UpdateOneAsync(
            x => x.UserId == userId, update, new UpdateOptions { IsUpsert = true });

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

        var doc = await _db.BookDigests.Find(x => x.BookId == id).FirstOrDefaultAsync(ct);
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
        var existing = await _db.BookDigests.Find(x => x.BookId == id).FirstOrDefaultAsync(ct);

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

        try
        {
            /*
             * 这里必须是 CancellationToken.None，不是 ct（server-authority 规则 1）。
             * 传 ct 的话，读者读到一半退出页面就会把整篇生成连根掐掉：三分钟的
             * 模型调用白烧、库里什么都没落下，下一个点进来的人从零开始再等一遍。
             * 稿子是公共内容，它该写完——写完之后谁点进来都能直接读到。
             *
             * 往断掉的连接写 SSE 不会炸：WriteDigestEventAsync 自己吞掉
             * OperationCanceledException 与 ObjectDisposedException。
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
            }
        }
        catch (OperationCanceledException)
        {
            // 走到这里只剩一种情况：网关自己中断了（进程停机）。客户端断开已经
            // 不再能取消这条流。半篇稿子不落库——下一个人点开会读到一篇断在半句话
            // 上的东西，还以为它就是全部。
            return;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "生成精读稿失败 BookId={BookId}", id);
            await WriteDigestEventAsync("error", new { code = "GEN_FAILED", message = "生成失败，稍后再试" }, ct);
            return;
        }

        var content = buffer.ToString().Trim();
        if (string.IsNullOrWhiteSpace(content))
        {
            await WriteDigestEventAsync("error", new { code = "EMPTY", message = "模型没有返回内容" }, ct);
            return;
        }

        var digest = new BookDigest
        {
            /*
             * 沿用库里那份的 _id。BookDigest 的 Id 默认是 Guid.NewGuid()，直接拿新对象去
             * ReplaceOne 一份已存在的文档，Mongo 会以 code 66 拒绝：「_id 是不可变字段」。
             *
             * 这个洞从第一版就在，而且只在「重写」时才现形——首次生成走的是 upsert 的
             * insert 分支，_id 是新的没问题；第二次起每一次都炸，异常又发生在 SSE 已经
             * 开始输出之后，ExceptionMiddleware 想改 header 再炸一次，于是前端只看到流
             * 无声断掉、库里还是旧的那篇。三次「重新生成」全部石沉大海，日志里才有真相。
             */
            Id = existing?.Id ?? Guid.NewGuid().ToString("N"),
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
        };

        // 一本书一篇，整篇替换。upsert 而不是 insert：「重新生成」走同一条路，
        // 不该在库里堆出两篇。
        // 同样用 None：读者退出页面不该让「已经写完的那一篇」写不进库（server-authority 规则 1）。
        try
        {
            await _db.BookDigests.ReplaceOneAsync(
                x => x.BookId == id,
                digest,
                new ReplaceOptions { IsUpsert = true },
                CancellationToken.None);
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
        try
        {
            var json = JsonSerializer.Serialize(data, SseJsonOptions);
            await Response.WriteAsync("event: " + eventName + "\n", ct);
            await Response.WriteAsync("data: " + json + "\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
        catch (OperationCanceledException) { /* 客户端断开 */ }
        catch (ObjectDisposedException) { /* 连接已关闭 */ }
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

/// <summary>单卷成绩。Passed 由前端按 exams.ts 的及格线算好一并送上来。</summary>
public class SaveBookshelfExamResult
{
    public int Correct { get; set; }
    public int Total { get; set; }
    public bool Passed { get; set; }
    /// <summary>交卷时该卷已读 / 总本数。旧客户端不传，默认 0 即按裸考处理。</summary>
    public int ReadAtExam { get; set; }
    public int TotalAtExam { get; set; }
}
