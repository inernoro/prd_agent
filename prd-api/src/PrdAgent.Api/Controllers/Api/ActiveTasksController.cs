using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 活动任务清单 —— 员工侧：维护自己的「此刻在做什么 / 备用任务 / 走过的路」。
///
/// 设计取向（见 doc/design.platform.active-tasks.md）：
/// - 此刻正在做同时只允许一条（WIP=1）。多线程等于没有焦点，看的人一眼要看到的就是那一件。
/// - 零表单：完成一次点击，队首自动顶上来，时长自动记。用户只输入系统猜不到的两件事：
///   做完了、我卡住了在等谁。
/// </summary>
[ApiController]
[Route("api/active-tasks")]
[Authorize]
[AdminController("active-tasks", AdminPermissionCatalog.ActiveTasksUse)]
public class ActiveTasksController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAdminPermissionService _adminPermissions;

    public ActiveTasksController(MongoDbContext db, IAdminPermissionService adminPermissions)
    {
        _db = db;
        _adminPermissions = adminPermissions;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>有效管理权限：优先读中间件注入的 claims，没有就回查权限服务（同 DocumentStoreController 的处理）。</summary>
    private async Task<bool> HasManagePermissionAsync()
    {
        var fromClaims = User.FindAll("permissions").Select(c => c.Value).ToList();
        if (fromClaims.Count > 0) return fromClaims.Contains(AdminPermissionCatalog.ActiveTasksManage);
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        if (isRoot) return true;
        var perms = await _adminPermissions.GetEffectivePermissionsAsync(GetUserId(), false);
        return perms.Contains(AdminPermissionCatalog.ActiveTasksManage);
    }

    /// <summary>我的任务台：此刻 + 备用队列 + 最近走过的。</summary>
    [HttpGet("me")]
    public async Task<IActionResult> GetMine(CancellationToken ct = default)
    {
        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var display = await ActiveTaskShared.ResolveDisplayNameAsync(_db, userId, ct);

        var live = await _db.ActiveTaskEntries
            .Find(x => x.UserId == userId && (x.State == ActiveTaskState.Active || x.State == ActiveTaskState.Standby))
            .ToListAsync(ct);

        var history = await _db.ActiveTaskEntries
            .Find(x => x.UserId == userId && (x.State == ActiveTaskState.Done || x.State == ActiveTaskState.Dropped))
            .SortByDescending(x => x.DoneAt)
            .Limit(20)
            .ToListAsync(ct);

        var active = live.FirstOrDefault(x => x.State == ActiveTaskState.Active);
        var standby = live.Where(x => x.State == ActiveTaskState.Standby).OrderBy(x => x.OrderKey).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            // 界面是一个列表：实心圆那条 + 下面待做的 + 下面做完的。这里按同样的形状给。
            active = active == null ? null : ActiveTaskShared.ToDto(active, now),
            standby = standby.Select(x => ActiveTaskShared.ToDto(x, now)).ToList(),
            history = history.Select(x => ActiveTaskShared.ToDto(x, now)).ToList(),
            displayName = display,
            serverNow = now,
        }));
    }

    /// <summary>新建一条任务，默认进备用队列；startNow=true 时直接成为此刻正在做。</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] ActiveTaskCreateRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务标题不能为空"));

        var userId = GetUserId();
        var display = await ActiveTaskShared.ResolveDisplayNameAsync(_db, userId, ct);
        var now = DateTime.UtcNow;

        var entry = new ActiveTaskEntry
        {
            UserId = userId,
            UserDisplayName = display,
            Title = req.Title.Trim(),
            Note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim(),
            DueAt = req.DueAt,
            State = ActiveTaskState.Standby,
            Source = ActiveTaskSource.IsValid(req.Source) ? req.Source! : ActiveTaskSource.Manual,
            SourceRefType = req.SourceRefType,
            SourceRefId = req.SourceRefId,
            OrderKey = await ActiveTaskShared.NextTailOrderKeyAsync(_db, userId, ct),
            CreatedAt = now,
            UpdatedAt = now,
        };

        await _db.ActiveTaskEntries.InsertOneAsync(entry, cancellationToken: ct);

        if (req.StartNow)
            await ActiveTaskShared.MakeActiveAsync(_db, userId, entry.Id, now, ct);

        var saved = await _db.ActiveTaskEntries.Find(x => x.Id == entry.Id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(ActiveTaskShared.ToDto(saved ?? entry, DateTime.UtcNow)));
    }

    /// <summary>
    /// 从聊天记录粘贴建任务 —— 以前习惯在 IM 里布置任务，现在把那段话贴进来切成任务。
    /// 纯规则切分（按行 / 序号 / 项目符号），不走大模型：这一步要即时、可预期、不烧 token。
    /// </summary>
    [HttpPost("paste")]
    public async Task<IActionResult> PasteFromChat([FromBody] ActiveTaskPasteRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Text))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "粘贴内容不能为空"));

        var titles = ActiveTaskShared.SplitPastedLines(req.Text);
        if (titles.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没能从这段文字里切出任何一条任务"));

        var userId = GetUserId();
        var display = await ActiveTaskShared.ResolveDisplayNameAsync(_db, userId, ct);
        var now = DateTime.UtcNow;
        var order = await ActiveTaskShared.NextTailOrderKeyAsync(_db, userId, ct);

        var entries = titles.Select((t, i) => new ActiveTaskEntry
        {
            UserId = userId,
            UserDisplayName = display,
            Title = t,
            State = ActiveTaskState.Standby,
            Source = ActiveTaskSource.ImPaste,
            OrderKey = order + i,
            CreatedAt = now,
            UpdatedAt = now,
        }).ToList();

        await _db.ActiveTaskEntries.InsertManyAsync(entries, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            created = entries.Count,
            items = entries.Select(x => ActiveTaskShared.ToDto(x, now)).ToList(),
        }));
    }

    /// <summary>改标题 / 预估 / 备注。</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] ActiveTaskUpdateRequest req, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (req == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求体不能为空"));

        var update = Builders<ActiveTaskEntry>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(req.Title)) update = update.Set(x => x.Title, req.Title.Trim());
        if (req.Note != null) update = update.Set(x => x.Note, string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim());
        if (req.ClearDue == true) update = update.Set(x => x.DueAt, (DateTime?)null);
        else if (req.DueAt.HasValue) update = update.Set(x => x.DueAt, req.DueAt.Value);

        await _db.ActiveTaskEntries.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);
        var saved = await _db.ActiveTaskEntries.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(ActiveTaskShared.ToDto(saved!, DateTime.UtcNow)));
    }

    /// <summary>把备用队列里的某条置顶（下一件就做它）。</summary>
    [HttpPost("{id}/promote")]
    public async Task<IActionResult> Promote(string id, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (entry.State != ActiveTaskState.Standby)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只有备用队列里的任务可以置顶"));

        var head = await ActiveTaskShared.HeadOrderKeyAsync(_db, userId, ct);
        await _db.ActiveTaskEntries.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskEntry>.Update
                .Set(x => x.OrderKey, head - 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { id, promoted = true }));
    }

    /// <summary>把某条设为「此刻正在做」。原本在做的那条退回备用队首，累计时长不丢。</summary>
    [HttpPost("{id}/start")]
    public async Task<IActionResult> Start(string id, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (entry.State == ActiveTaskState.Done || entry.State == ActiveTaskState.Dropped)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已结束的任务不能重新开始"));

        await ActiveTaskShared.MakeActiveAsync(_db, userId, id, DateTime.UtcNow, ct);
        var saved = await _db.ActiveTaskEntries.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(ActiveTaskShared.ToDto(saved!, DateTime.UtcNow)));
    }

    /// <summary>
    /// 结案：做完这件，留一句「做成了什么样」，并自动把队首顶上来。
    /// 结案与接下一件是同一个动作，不是两步。
    /// </summary>
    [HttpPost("{id}/finish")]
    public async Task<IActionResult> Finish(string id, [FromBody] ActiveTaskFinishRequest? req = null, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (entry.State == ActiveTaskState.Done)
            return Ok(ApiResponse<object>.Ok(new { id, alreadyDone = true }));

        var now = DateTime.UtcNow;
        await ActiveTaskShared.SettleAndSetStateAsync(_db, entry, ActiveTaskState.Done, now, ct);

        var note = req?.ClosingNote?.Trim();
        if (!string.IsNullOrWhiteSpace(note))
        {
            await _db.ActiveTaskEntries.UpdateOneAsync(
                x => x.Id == id,
                Builders<ActiveTaskEntry>.Update.Set(x => x.ClosingNote, note),
                cancellationToken: ct);
        }

        // 队首自动顶上来
        var next = await _db.ActiveTaskEntries
            .Find(x => x.UserId == userId && x.State == ActiveTaskState.Standby)
            .SortBy(x => x.OrderKey)
            .FirstOrDefaultAsync(ct);
        if (next != null) await ActiveTaskShared.MakeActiveAsync(_db, userId, next.Id, now, ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            finished = id,
            next = next == null ? null : ActiveTaskShared.ToDto(
                await _db.ActiveTaskEntries.Find(x => x.Id == next.Id).FirstOrDefaultAsync(ct) ?? next, now),
        }));
    }

    /// <summary>标记卡住。必须写清在等谁 —— 只说「卡住了」不算汇报。</summary>
    [HttpPost("{id}/block")]
    public async Task<IActionResult> Block(string id, [FromBody] ActiveTaskBlockRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.BlockedOn))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请写清在等谁、等什么，只说「卡住了」别人没法接手"));

        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (entry.Blocked) return Ok(ApiResponse<object>.Ok(new { id, alreadyBlocked = true }));

        var now = DateTime.UtcNow;
        // 卡住期间不计入投入：先把这一轮投入结算进累计，再开始记空转
        var update = Builders<ActiveTaskEntry>.Update
            .Set(x => x.AccumulatedSeconds, entry.ElapsedSecondsAt(now))
            .Set(x => x.StartedAt, (DateTime?)null)
            .Set(x => x.Blocked, true)
            .Set(x => x.BlockedSince, now)
            .Set(x => x.BlockedOn, req.BlockedOn.Trim())
            .Set(x => x.UpdatedAt, now);

        await _db.ActiveTaskEntries.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { id, blocked = true }));
    }

    /// <summary>解除卡住，继续计时。</summary>
    [HttpPost("{id}/unblock")]
    public async Task<IActionResult> Unblock(string id, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (!entry.Blocked) return Ok(ApiResponse<object>.Ok(new { id, alreadyRunning = true }));

        var now = DateTime.UtcNow;
        var update = Builders<ActiveTaskEntry>.Update
            .Set(x => x.BlockedSeconds, entry.BlockedSecondsAt(now))
            .Set(x => x.Blocked, false)
            .Set(x => x.BlockedSince, (DateTime?)null)
            .Set(x => x.StartedAt, entry.State == ActiveTaskState.Active ? now : (DateTime?)null)
            .Set(x => x.UpdatedAt, now);

        await _db.ActiveTaskEntries.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { id, blocked = false }));
    }

    /// <summary>放弃这件。历史里保留放弃记录，不粉饰 —— 粉饰过的历史没人会回来看第二次。</summary>
    [HttpPost("{id}/drop")]
    public async Task<IActionResult> Drop(string id, [FromBody] ActiveTaskDropRequest req, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        var now = DateTime.UtcNow;
        await ActiveTaskShared.SettleAndSetStateAsync(_db, entry, ActiveTaskState.Dropped, now, ct);
        await _db.ActiveTaskEntries.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskEntry>.Update.Set(x => x.DropReason, req?.Reason?.Trim()),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { id, dropped = true }));
    }

    /// <summary>删除（仅限还没开始的备用任务；已投入时间的一律走放弃，留痕）。</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (entry.State != ActiveTaskState.Standby || entry.AccumulatedSeconds > 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已经投入过时间的任务请走「放弃」，历史要留痕"));

        await _db.ActiveTaskEntries.DeleteOneAsync(x => x.Id == id, ct);
        return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
    }

    /// <summary>走过的路：历史流水 + 估准度 + 时间漏在哪。</summary>
    [HttpGet("history")]
    public async Task<IActionResult> History([FromQuery] int days = 14, [FromQuery] string? userId = null, CancellationToken ct = default)
    {
        var self = GetUserId();
        // 看别人的历史需要管理权限；没有就只能看自己的
        var target = self;
        if (!string.IsNullOrWhiteSpace(userId) && userId != self)
        {
            if (!await HasManagePermissionAsync())
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "查看他人历史需要「活动任务清单-管理」权限"));
            target = userId!;
        }

        var span = Math.Clamp(days, 1, 180);
        var since = DateTime.UtcNow.AddDays(-span);
        var now = DateTime.UtcNow;

        var items = await _db.ActiveTaskEntries
            .Find(x => x.UserId == target && x.UpdatedAt >= since
                       && (x.State == ActiveTaskState.Done || x.State == ActiveTaskState.Dropped || x.State == ActiveTaskState.Active))
            .SortByDescending(x => x.UpdatedAt)
            .Limit(200)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            days = span,
            items = items.Select(x => ActiveTaskShared.ToDto(x, now)).ToList(),
            summary = ActiveTaskShared.BuildHistorySummary(items, now),
            serverNow = now,
        }));
    }
}

// ===== 请求体 =====

public class ActiveTaskCreateRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Note { get; set; }
    /// <summary>什么时候要（可选）。不传就是没时间要求 —— 大多数任务都不该有。</summary>
    public DateTime? DueAt { get; set; }
    public string? Source { get; set; }
    public string? SourceRefType { get; set; }
    public string? SourceRefId { get; set; }
    /// <summary>true = 建完直接开始做（原本在做的退回备用队首）</summary>
    public bool StartNow { get; set; }
}

public class ActiveTaskPasteRequest
{
    /// <summary>从聊天窗口复制的一段文字，按行切成多条任务</summary>
    public string Text { get; set; } = string.Empty;
}

public class ActiveTaskUpdateRequest
{
    public string? Title { get; set; }
    public string? Note { get; set; }
    public DateTime? DueAt { get; set; }

    /// <summary>true = 把时间去掉（DueAt 传 null 无法与「不改」区分，所以单给一个开关）</summary>
    public bool? ClearDue { get; set; }
}

public class ActiveTaskBlockRequest
{
    /// <summary>在等谁、等什么（必填）</summary>
    public string BlockedOn { get; set; } = string.Empty;
}

public class ActiveTaskFinishRequest
{
    /// <summary>做成了什么样（选填，但界面上这是结案时唯一的输入）</summary>
    public string? ClosingNote { get; set; }
}

public class ActiveTaskDropRequest
{
    public string? Reason { get; set; }
}
