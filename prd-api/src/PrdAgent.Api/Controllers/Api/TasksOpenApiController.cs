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

    /// <summary>一次最多同步几条债务。台账最大的那份也就百来条，分批推不是负担。</summary>
    private const int MaxDebtSyncPerCall = 500;

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

    /// <summary>
    /// 给某人提一条建议 —— 只需要 use 档。
    ///
    /// 和 assign 的区别是这个开放接口里最值得说清的一条：assign 直接进对方队列，
    /// 所以它要管理档；建议提了**什么都不会发生**，对方自己决定要不要吸取，
    /// 所以任何智能体都能提。想让机器给人「安排活」，走 assign 并承担那份权限；
    /// 想让机器「提个醒」，走这里。
    /// </summary>
    [HttpPost("suggest")]
    [RequireScope(ScopeUse, ScopeManage)]
    public async Task<IActionResult> Suggest([FromBody] OpenTaskSuggestRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Text))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "建议内容不能为空"));
        if (string.IsNullOrWhiteSpace(req.UserId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "要提给谁"));

        var me = GetUserId();
        var target = await _db.Users.Find(x => x.UserId == req.UserId).FirstOrDefaultAsync(ct);
        if (target == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这个人不在"));

        var text = req.Text.Trim();
        if (!string.IsNullOrWhiteSpace(req.SourceUrl)) text = $"{text}\n{req.SourceUrl.Trim()}";

        var now = DateTime.UtcNow;
        var entry = new ActiveTaskSuggestion
        {
            TargetUserId = req.UserId!,
            TargetUserName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, req.UserId!, ct),
            FromUserId = me,
            FromUserName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, me, ct),
            Text = text,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ActiveTaskSuggestions.InsertOneAsync(entry, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { id = entry.Id, suggestedTo = entry.TargetUserName }));
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

    /// <summary>
    /// 把仓库里的债务台账推过来 —— 债务接进任务台的那条单向管道。
    ///
    /// 为什么是「推」不是「拉」：债务正文的 SSOT 在仓库（<c>doc/debt.*.md</c>），
    /// 它跟代码同生共死，改代码的那个人顺手改它才对。平台这一侧不该去读别人的仓库，
    /// 而是由跑在仓库里的智能体在改完之后把当前快照推上来。
    ///
    /// 幂等：按 Key（形如 <c>platform.active-tasks#15</c>）更新或新建，重复推不会长出第二条。
    /// **只覆盖正文**（标题 / 现状 / 补的条件）；谁认领了、转成了哪条任务，同步一律不碰。
    /// </summary>
    [HttpPost("debts/sync")]
    [RequireScope(ScopeUse, ScopeManage)]
    public async Task<IActionResult> SyncDebts([FromBody] DebtSyncRequest req, CancellationToken ct = default)
    {
        if (req?.Items == null || req.Items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有要同步的债务条目"));
        if (req.Items.Count > MaxDebtSyncPerCall)
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT, $"一次最多同步 {MaxDebtSyncPerCall} 条，分批推"));

        var now = DateTime.UtcNow;
        var created = 0;
        var updated = 0;
        var skipped = new List<string>();

        foreach (var item in req.Items)
        {
            var parsed = ActiveTaskDebtsController.ParseKey(item.Key);
            if (parsed == null)
            {
                skipped.Add($"{item.Key}：标识格式应为 模块#编号，如 platform.active-tasks#15");
                continue;
            }
            if (string.IsNullOrWhiteSpace(item.Title))
            {
                skipped.Add($"{item.Key}：债务标题为空");
                continue;
            }

            var (module, num) = parsed.Value;
            var key = item.Key.Trim();
            var res = await _db.ActiveTaskDebts.UpdateOneAsync(
                x => x.Key == key,
                Builders<ActiveTaskDebt>.Update
                    .Set(x => x.Module, module)
                    .Set(x => x.Num, num)
                    .Set(x => x.Title, ActiveTaskDebtsController.Clip(item.Title.Trim(), 300)!)
                    .Set(x => x.Status, ActiveTaskDebtsController.Clip(item.Status?.Trim(), 2000))
                    .Set(x => x.CloseCondition, ActiveTaskDebtsController.Clip(item.CloseCondition?.Trim(), 2000))
                    .Set(x => x.SourcePath, item.SourcePath?.Trim() ?? $"doc/debt.{module}.md")
                    .Set(x => x.SyncedAt, now)
                    .Set(x => x.UpdatedAt, now)
                    .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
                    .SetOnInsert(x => x.Key, key)
                    .SetOnInsert(x => x.State, ActiveTaskDebtState.Open)
                    .SetOnInsert(x => x.ConvertedTaskIds, new List<string>())
                    .SetOnInsert(x => x.CreatedAt, now),
                new UpdateOptions { IsUpsert = true }, ct);

            if (res.UpsertedId != null) created++;
            else if (res.ModifiedCount > 0) updated++;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            created,
            updated,
            skipped,
            note = "只覆盖了正文；认领人与状态不受同步影响",
        }));
    }

    /// <summary>
    /// 读债务清单：还欠着什么、谁认领了、哪几条已经转成任务了。
    /// 只读，任何档位都能看 —— 欠债这件事不该只有管理档看得见。
    /// </summary>
    [HttpGet("debts")]
    [RequireScope(ScopeUse, ScopeManage)]
    public async Task<IActionResult> Debts([FromQuery] bool mineOnly = false, CancellationToken ct = default)
    {
        var me = GetUserId();

        // 走界面那一侧的同一个判定源。这里曾经自己抄了一遍计数，于是同一个
        // mineOnly 在两条路上给出两句不一样的结论 —— 抄一遍就必然各自漂移。
        var all = await _db.ActiveTaskDebts
            .Find(Builders<ActiveTaskDebt>.Filter.Ne(x => x.State, ActiveTaskDebtState.Closed))
            .Limit(500)
            .ToListAsync(ct);
        await ActiveTaskDebtsController.PruneDeadConversionsAsync(_db, all, ct);

        var board = ActiveTaskDebtsController.BuildBoard(all, me, module: null, mineOnly: mineOnly);

        return Ok(ApiResponse<object>.Ok(new
        {
            headline = ActiveTaskDebtsController.BuildHeadline(board.Total, board.Mine, board.Unclaimed),
            total = board.Total,
            shownCount = board.Items.Count,
            items = board.Items.Select(x => new
            {
                key = x.Key,
                title = x.Title,
                status = x.Status,
                closeCondition = x.CloseCondition,
                sourcePath = x.SourcePath,
                owner = x.OwnerUserName,
                mine = x.OwnerUserId == me,
                state = x.State,
                convertedTaskIds = x.ConvertedTaskIds,
            }).ToList(),
        }));
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

public class OpenTaskSuggestRequest
{
    /// <summary>提给谁（取自 map_tasks_team 的 people[].userId）</summary>
    public string? UserId { get; set; }

    /// <summary>建议正文</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>来源链接（可选），会附在正文后面</summary>
    public string? SourceUrl { get; set; }
}
