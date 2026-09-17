using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 活动任务清单 —— 管理侧：全员此刻、委派任务、匿名可见粒度配置。
///
/// 这一屏不给一堆进度条让人自己读，直接给「需要你出手的几件」；
/// 节奏正常的人自动从这份清单里消失，不堆成待办
/// （见 .claude/rules/conclusion-before-numbers.md）。
/// </summary>
[ApiController]
[Route("api/active-tasks-admin")]
[Authorize]
[AdminController("active-tasks", AdminPermissionCatalog.ActiveTasksManage)]
public class ActiveTasksAdminController : ControllerBase
{
    private readonly MongoDbContext _db;

    public ActiveTasksAdminController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>团队此刻：每人一行 + 需要你出手的几件。</summary>
    [HttpGet("team")]
    public async Task<IActionResult> Team(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var settings = await ActiveTaskShared.LoadSettingsAsync(_db, ct);
        var board = await ActiveTaskShared.BuildTeamBoardAsync(_db, settings, now, masked: false, ct);
        return Ok(ApiResponse<object>.Ok(board));
    }

    /// <summary>
    /// 委派任务给某人。默认进对方的备用队列（不打断他手上那件）；
    /// startNow=true 才顶掉他正在做的 —— 打断是要有意识的动作，不是默认行为。
    /// </summary>
    [HttpPost("assign")]
    public async Task<IActionResult> Assign([FromBody] ActiveTaskAssignRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.UserId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择委派给谁"));
        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务标题不能为空"));

        var target = await _db.Users.Find(x => x.UserId == req.UserId).FirstOrDefaultAsync(ct);
        if (target == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "找不到这个人"));

        var me = GetUserId();
        var myName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, me, ct);
        var targetName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, req.UserId, ct);
        var now = DateTime.UtcNow;

        var entry = new ActiveTaskEntry
        {
            UserId = req.UserId,
            UserDisplayName = targetName,
            Title = req.Title.Trim(),
            Note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim(),
            DueAt = req.DueAt,
            State = ActiveTaskState.Standby,
            Source = ActiveTaskSource.Assigned,
            SourceRefType = req.SourceRefType,
            SourceRefId = req.SourceRefId,
            AssignedBy = me,
            AssignedByName = myName,
            AssignedAt = now,
            OrderKey = req.Urgent
                ? await ActiveTaskShared.HeadOrderKeyAsync(_db, req.UserId, ct) - 1
                : await ActiveTaskShared.NextTailOrderKeyAsync(_db, req.UserId, ct),
            CreatedAt = now,
            UpdatedAt = now,
        };

        // 插入之后还有一步「设成正在做」（勾了建完直接开始时），两步是一个整体：
        // 断在中间会留下一条建好却没被开始的任务，用户以为那个勾没生效。
        // 从这里往下一律 CancellationToken.None（server-authority）。
        await _db.ActiveTaskEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);

        if (req.StartNow)
            await ActiveTaskShared.MakeActiveAsync(_db, req.UserId, entry.Id, now, CancellationToken.None);

        var saved = await _db.ActiveTaskEntries.Find(x => x.Id == entry.Id).FirstOrDefaultAsync(CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(ActiveTaskShared.ToDto(saved ?? entry, DateTime.UtcNow)));
    }

    /// <summary>批量委派（一次派几件给同一个人）。</summary>
    [HttpPost("assign-batch")]
    public async Task<IActionResult> AssignBatch([FromBody] ActiveTaskAssignBatchRequest req, CancellationToken ct = default)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.UserId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择委派给谁"));
        var titles = (req.Titles ?? new List<string>())
            .Select(t => (t ?? string.Empty).Trim())
            .Where(t => t.Length > 0)
            .Take(20)
            .ToList();
        if (titles.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有可委派的任务"));

        var target = await _db.Users.Find(x => x.UserId == req.UserId).FirstOrDefaultAsync(ct);
        if (target == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "找不到这个人"));

        var me = GetUserId();
        var myName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, me, ct);
        var targetName = await ActiveTaskShared.ResolveDisplayNameAsync(_db, req.UserId, ct);
        var now = DateTime.UtcNow;
        var order = await ActiveTaskShared.NextTailOrderKeyAsync(_db, req.UserId, ct);

        var entries = titles.Select((t, i) => new ActiveTaskEntry
        {
            UserId = req.UserId,
            UserDisplayName = targetName,
            Title = t,
            DueAt = req.DueAt,
            State = ActiveTaskState.Standby,
            Source = ActiveTaskSource.Assigned,
            AssignedBy = me,
            AssignedByName = myName,
            AssignedAt = now,
            OrderKey = order + i,
            CreatedAt = now,
            UpdatedAt = now,
        }).ToList();

        await _db.ActiveTaskEntries.InsertManyAsync(entries, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            created = entries.Count,
            assignedTo = targetName,
            items = entries.Select(x => ActiveTaskShared.ToDto(x, now)).ToList(),
        }));
    }

    /// <summary>可委派的人员清单（近 30 天登录过的账号）。</summary>
    [HttpGet("members")]
    public async Task<IActionResult> Members(CancellationToken ct = default)
    {
        var since = DateTime.UtcNow.AddDays(-30);
        var users = await _db.Users
            .Find(x => x.LastActiveAt >= since || x.LastLoginAt >= since)
            .Limit(200)
            .ToListAsync(ct);

        var now = DateTime.UtcNow;
        var live = await _db.ActiveTaskEntries
            .Find(x => x.State == ActiveTaskState.Active || x.State == ActiveTaskState.Standby)
            .ToListAsync(ct);

        var byUser = live.GroupBy(x => x.UserId).ToDictionary(g => g.Key, g => g.ToList());

        return Ok(ApiResponse<object>.Ok(users.Select(u =>
        {
            byUser.TryGetValue(u.UserId, out var mine);
            var standby = mine?.Count(x => x.State == ActiveTaskState.Standby) ?? 0;
            var active = mine?.FirstOrDefault(x => x.State == ActiveTaskState.Active);
            return new
            {
                userId = u.UserId,
                displayName = string.IsNullOrWhiteSpace(u.DisplayName) ? u.Username : u.DisplayName,
                username = u.Username,
                standbyCount = standby,
                currentTitle = active?.Title,
                busy = active != null,
                // 派活前先看一眼他堆了多少，别往已经堆满的人身上加
                stackHint = standby == 0 ? "没活了" : $"堆 {standby} 件",
            };
        }).ToList()));
    }

    /// <summary>读匿名可见粒度等面板设置。</summary>
    [HttpGet("settings")]
    public async Task<IActionResult> GetSettings(CancellationToken ct = default)
        => Ok(ApiResponse<ActiveTaskBoardSettings>.Ok(await ActiveTaskShared.LoadSettingsAsync(_db, ct)));

    /// <summary>改面板设置（匿名开关 / 匿名粒度 / 卡住升级阈值 / 粮草偏少阈值）。</summary>
    [HttpPut("settings")]
    public async Task<IActionResult> PutSettings([FromBody] ActiveTaskSettingsRequest req, CancellationToken ct = default)
    {
        if (req == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求体不能为空"));
        if (!string.IsNullOrWhiteSpace(req.AnonymousMode) && !AnonymousVisibility.IsValid(req.AnonymousMode))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "匿名粒度只能是 masked / full / headline"));

        var current = await ActiveTaskShared.LoadSettingsAsync(_db, ct);
        current.Id = ActiveTaskBoardSettings.SingletonId;
        if (!string.IsNullOrWhiteSpace(req.AnonymousMode)) current.AnonymousMode = req.AnonymousMode!;
        if (req.AnonymousEnabled.HasValue) current.AnonymousEnabled = req.AnonymousEnabled.Value;
        if (req.BlockedEscalateMinutes.HasValue) current.BlockedEscalateMinutes = Math.Clamp(req.BlockedEscalateMinutes.Value, 5, 1440);
        if (req.HeavyStackThreshold.HasValue) current.HeavyStackThreshold = Math.Clamp(req.HeavyStackThreshold.Value, 2, 50);
        current.UpdatedAt = DateTime.UtcNow;
        current.UpdatedBy = GetUserId();

        await _db.ActiveTaskBoardSettingsCollection.ReplaceOneAsync(
            x => x.Id == ActiveTaskBoardSettings.SingletonId,
            current,
            new ReplaceOptions { IsUpsert = true },
            ct);

        return Ok(ApiResponse<ActiveTaskBoardSettings>.Ok(current));
    }
}

// ===== 请求体 =====

public class ActiveTaskAssignRequest
{
    public string UserId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Note { get; set; }
    /// <summary>什么时候要（可选）</summary>
    public DateTime? DueAt { get; set; }
    public string? SourceRefType { get; set; }
    public string? SourceRefId { get; set; }
    /// <summary>true = 插到对方备用队首（下一件就做它），但不打断他手上那件</summary>
    public bool Urgent { get; set; }
    /// <summary>true = 直接顶掉对方正在做的那件。打断要有意识，默认 false</summary>
    public bool StartNow { get; set; }
}

public class ActiveTaskAssignBatchRequest
{
    public string UserId { get; set; } = string.Empty;
    public List<string>? Titles { get; set; }
    public DateTime? DueAt { get; set; }
}

public class ActiveTaskSettingsRequest
{
    public string? AnonymousMode { get; set; }
    public bool? AnonymousEnabled { get; set; }
    public int? BlockedEscalateMinutes { get; set; }
    public int? HeavyStackThreshold { get; set; }
}
