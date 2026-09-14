using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 任务台开放接口 —— 供外部智能体（MCP 连接器）读写任务。
///
/// 谁能用什么（两档，与后台权限位同名，签发时已取过交集）：
/// - `active-tasks:use`    读自己在做什么、队列里堆着什么；往自己队列里加一件。
/// - `active-tasks:manage` 另外可以读全员在做什么、派一件给别人。
///
/// 一条刻意的边界：**智能体不能结案**。结案要填「做成了什么样」，那是人对结果的认领；
/// 让机器代签，这个字段当天就会退化成「已完成」，历史也就白留了。
/// 同理智能体不能替人标记卡住 —— 在等谁是人的判断。
/// </summary>
[ApiController]
[Route("api/open/tasks")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class TasksOpenApiController : ControllerBase
{
    public const string ScopeUse = McpCapabilityCatalog.ScopeTasksUse;
    public const string ScopeManage = McpCapabilityCatalog.ScopeTasksManage;

    /// <summary>一次最多加几件。智能体重试成本低，别让它一口气把人的队列灌满。</summary>
    private const int MaxAddPerCall = 10;

    private readonly MongoDbContext _db;

    public TasksOpenApiController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>我在做什么、队列里还堆着什么、最近结了哪些案。</summary>
    [HttpGet("mine")]
    [RequireScope(ScopeUse, ScopeManage)]
    public async Task<IActionResult> Mine(CancellationToken ct = default)
    {
        var userId = GetUserId();
        var now = DateTime.UtcNow;

        var live = await _db.ActiveTaskEntries
            .Find(x => x.UserId == userId && (x.State == ActiveTaskState.Active || x.State == ActiveTaskState.Standby))
            .ToListAsync(ct);
        var closed = await _db.ActiveTaskEntries
            .Find(x => x.UserId == userId && x.State == ActiveTaskState.Done)
            .SortByDescending(x => x.DoneAt)
            .Limit(10)
            .ToListAsync(ct);

        var active = live.FirstOrDefault(x => x.State == ActiveTaskState.Active);
        var standby = live.Where(x => x.State == ActiveTaskState.Standby).OrderBy(x => x.OrderKey).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            doing = active == null ? null : new
            {
                id = active.Id,
                title = active.Title,
                blocked = active.Blocked,
                blockedOn = active.BlockedOn,
                spent = ActiveTaskConclusion.FormatDuration(active.ElapsedSecondsAt(now)),
                due = ActiveTaskConclusion.FormatDue(active.DueAt, now),
            },
            next = standby.Select(x => new
            {
                id = x.Id,
                title = x.Title,
                source = x.Source,
                assignedByName = x.AssignedByName,
                due = ActiveTaskConclusion.FormatDue(x.DueAt, now),
            }).ToList(),
            stackCount = standby.Count,
            recentlyClosed = closed.Select(x => new
            {
                id = x.Id,
                title = x.Title,
                closingNote = x.ClosingNote,
                doneAt = x.DoneAt,
            }).ToList(),
        }));
    }

    /// <summary>往自己队列里加一件（排队尾，不打断手上那件）。</summary>
    [HttpPost("mine")]
    [RequireScope(ScopeUse, ScopeManage)]
    public async Task<IActionResult> AddMine([FromBody] OpenTaskAddRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "title 不能为空"));

        var userId = GetUserId();
        var created = await AddToQueueAsync(userId, userId, req, ActiveTaskSource.Manual, ct);
        return Ok(ApiResponse<object>.Ok(new { id = created.Id, title = created.Title }));
    }

    /// <summary>全员在做什么、各自堆了多少。需要 manage 档。</summary>
    [HttpGet("team")]
    [RequireScope(ScopeManage)]
    public async Task<IActionResult> Team(CancellationToken ct = default)
    {
        var settings = await ActiveTaskShared.LoadSettingsAsync(_db, ct);
        var board = await ActiveTaskShared.BuildTeamBoardAsync(_db, settings, DateTime.UtcNow, masked: false, ct);
        return Ok(ApiResponse<object>.Ok(board));
    }

    /// <summary>派一件给别人（排他队尾，不打断他手上那件）。需要 manage 档。</summary>
    [HttpPost("assign")]
    [RequireScope(ScopeManage)]
    public async Task<IActionResult> Assign([FromBody] OpenTaskAssignRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.UserId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空，先用 map_tasks_team 拿到要派给谁"));
        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "title 不能为空"));

        var target = await _db.Users.Find(x => x.UserId == req.UserId).FirstOrDefaultAsync(ct);
        if (target == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "找不到这个人"));

        var me = GetUserId();
        var created = await AddToQueueAsync(
            req.UserId, me,
            new OpenTaskAddRequest { Title = req.Title, Note = req.Note, SourceUrl = req.SourceUrl, DueAt = req.DueAt },
            ActiveTaskSource.Assigned, ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            id = created.Id,
            title = created.Title,
            assignedTo = created.UserDisplayName,
        }));
    }

    /// <summary>入队公共路径：永远排队尾。智能体不许插队 —— 打断谁的活是人的决定。</summary>
    private async Task<ActiveTaskEntry> AddToQueueAsync(
        string ownerId, string actorId, OpenTaskAddRequest req, string source, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var ownerName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, ownerId, ct);
        var note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim();
        if (!string.IsNullOrWhiteSpace(req.SourceUrl))
            note = string.IsNullOrWhiteSpace(note) ? req.SourceUrl.Trim() : $"{note}\n{req.SourceUrl.Trim()}";

        var entry = new ActiveTaskEntry
        {
            UserId = ownerId,
            UserDisplayName = ownerName,
            Title = req.Title.Trim(),
            Note = note,
            State = ActiveTaskState.Standby,
            Source = source,
            DueAt = req.DueAt,
            OrderKey = await ActiveTaskShared.NextTailOrderKeyAsync(_db, ownerId, ct),
            CreatedAt = now,
            UpdatedAt = now,
        };

        if (source == ActiveTaskSource.Assigned)
        {
            entry.AssignedBy = actorId;
            entry.AssignedByName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, actorId, ct);
            entry.AssignedAt = now;
        }

        await _db.ActiveTaskEntries.InsertOneAsync(entry, cancellationToken: ct);
        return entry;
    }
}

public class OpenTaskAddRequest
{
    /// <summary>要做的是什么，一句话</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>补充说明（选填）</summary>
    public string? Note { get; set; }

    /// <summary>来源链接（选填）：缺陷、PR、告警的地址，人接手时点得开</summary>
    public string? SourceUrl { get; set; }

    /// <summary>什么时候要（选填）。不确定就别填 —— 编一个时间比没有时间更坏。</summary>
    public DateTime? DueAt { get; set; }
}

public class OpenTaskAssignRequest : OpenTaskAddRequest
{
    /// <summary>派给谁的 userId，从 map_tasks_team 拿</summary>
    public string UserId { get; set; } = string.Empty;
}
