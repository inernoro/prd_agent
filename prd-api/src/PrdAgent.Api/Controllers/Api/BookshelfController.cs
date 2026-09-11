using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
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
    private readonly MongoDbContext _db;
    private readonly ILogger<BookshelfController> _logger;

    public BookshelfController(MongoDbContext db, ILogger<BookshelfController> logger)
    {
        _db = db;
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
                TakenAt = now,
            };
        }

        var readIds = (req.ReadBookIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();

        var update = Builders<BookshelfProgress>.Update
            .Set(x => x.UserId, userId)
            .Set(x => x.ReadBookIds, readIds)
            .Set(x => x.ExamResults, merged)
            .Set(x => x.UpdatedAt, now)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.CreatedAt, now);

        await _db.BookshelfProgresses.UpdateOneAsync(
            x => x.UserId == userId, update, new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(
            new { readBookIds = readIds, examResults = ToPlainMap(merged), updatedAt = now }));
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
                passedCount = p.ExamResults.Values.Count(r => r.Passed),
                passedVolumeIds = p.ExamResults.Where(kv => kv.Value.Passed).Select(kv => kv.Key).ToList(),
                updatedAt = p.UpdatedAt,
            })
            .OrderByDescending(r => r.passedCount)
            .ThenByDescending(r => r.readCount)
            .ToList();

        // 每卷有多少人通关 —— 看板真正的用处：一眼看出全队哪一卷最薄弱
        var perVolume = all
            .SelectMany(p => p.ExamResults.Where(kv => kv.Value.Passed).Select(kv => kv.Key))
            .GroupBy(v => v)
            .ToDictionary(g => g.Key, g => g.Count());

        return Ok(ApiResponse<object>.Ok(new
        {
            members = rows,
            memberCount = rows.Count,
            passedByVolume = perVolume,
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
                takenAt = kv.Value.TakenAt,
            });
}

/// <summary>整包保存进度的请求体。</summary>
public class SaveBookshelfProgressRequest
{
    public List<string>? ReadBookIds { get; set; }
    public Dictionary<string, SaveBookshelfExamResult>? ExamResults { get; set; }
}

/// <summary>单卷成绩。Passed 由前端按 exams.ts 的及格线算好一并送上来。</summary>
public class SaveBookshelfExamResult
{
    public int Correct { get; set; }
    public int Total { get; set; }
    public bool Passed { get; set; }
}
