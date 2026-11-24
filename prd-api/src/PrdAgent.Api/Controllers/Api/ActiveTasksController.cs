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
            // 撤销删除时带着原来的位置回来；正常新建一律排队尾
            OrderKey = req.OrderKey ?? await ActiveTaskShared.NextTailOrderKeyAsync(_db, userId, ct),
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
        // 结案后补写「做成了什么样」：点圆圈是一下就完成的，那句话在完成之后补，不挡在完成前面
        if (req.ClosingNote != null)
            update = update.Set(x => x.ClosingNote, string.IsNullOrWhiteSpace(req.ClosingNote) ? null : req.ClosingNote.Trim());

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

    /// <summary>
    /// 拖拽排序：把 id 挪到 beforeId 的前面（beforeId 为空 = 挪到队尾）。
    /// 「提前」只能置顶，挪不了第 5 条到第 2 条 —— 队列一长就完全失控。
    ///
    /// 用「挪到谁前面」而不是「挪到第几位」：前端拖完知道的就是落在谁上面，
    /// 传下标要前后两边各算一次索引，两边算法一旦错开，看到的顺序和存的顺序就不是一回事。
    /// </summary>
    [HttpPost("{id}/reorder")]
    public async Task<IActionResult> Reorder(string id, [FromBody] ActiveTaskReorderRequest? req = null, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (entry.State != ActiveTaskState.Standby)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只有备用队列里的任务可以排序"));

        var queue = await _db.ActiveTaskEntries
            .Find(x => x.UserId == userId && x.State == ActiveTaskState.Standby)
            .SortBy(x => x.OrderKey)
            .ToListAsync(ct);

        var moving = queue.FirstOrDefault(x => x.Id == id);
        if (moving == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不在备用队列里"));
        queue.Remove(moving);

        var beforeId = req?.BeforeId;
        var at = queue.Count;
        if (!string.IsNullOrWhiteSpace(beforeId))
        {
            var idx = queue.FindIndex(x => x.Id == beforeId);
            // 落点找不到（那条刚被别处改了状态）就放队尾，不报错 —— 拖拽是个高频动作，
            // 为了一个已经不存在的落点弹一个错误框，比放到队尾更烦人
            at = idx >= 0 ? idx : queue.Count;
        }
        queue.Insert(at, moving);

        // 整队重排成连续序号。队列本来就只有几十条，省下「算一个中间值、迟早算到
        // 浮点精度尽头」那套麻烦。
        var now = DateTime.UtcNow;
        var writes = new List<WriteModel<ActiveTaskEntry>>();
        for (var i = 0; i < queue.Count; i++)
        {
            var target = queue[i];
            if (target.OrderKey == i) continue;
            writes.Add(new UpdateOneModel<ActiveTaskEntry>(
                Builders<ActiveTaskEntry>.Filter.Eq(x => x.Id, target.Id),
                Builders<ActiveTaskEntry>.Update.Set(x => x.OrderKey, i).Set(x => x.UpdatedAt, now)));
        }
        if (writes.Count > 0) await _db.ActiveTaskEntries.BulkWriteAsync(writes, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { id, order = queue.Select(x => x.Id).ToList() }));
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

        // 判定源在 ActiveTaskShared，别在这里另写一份（理由见那边的注释）
        var wasActive = ActiveTaskShared.ShouldAdvanceQueue(entry.State);

        var now = DateTime.UtcNow;

        // 从这里往下是一段**不能被切一半**的写序列：结算 → 盖「从哪一档结案的」戳 →
        // 队首顶上来。所以一律用 CancellationToken.None，不跟着请求的 ct 走。
        //
        // 跟着 ct 走会这样断：结算已经落库（State 变成 done），用户这时关掉页面或网断了，
        // 后面两步被取消 —— FinishedFromActive 永远是 false（撤销把它还原成备用而不是正在做），
        // 队列也没人顶上来（这个人从此「没有正在做的事」）。而重试进不来：
        // 开头那句 State == Done 会直接回 alreadyDone。
        // server-authority：客户端断开不取消服务器已经开始的写入。
        await ActiveTaskShared.SettleAndSetStateAsync(_db, entry, ActiveTaskState.Done, now, CancellationToken.None);

        // 记下它从哪一档结案的 —— 撤销要照这个还原，不能一律塞回「正在做」
        var stamp = Builders<ActiveTaskEntry>.Update.Set(x => x.FinishedFromActive, wasActive);
        var note = req?.ClosingNote?.Trim();
        if (!string.IsNullOrWhiteSpace(note))
            stamp = Builders<ActiveTaskEntry>.Update.Combine(stamp, Builders<ActiveTaskEntry>.Update.Set(x => x.ClosingNote, note));
        await _db.ActiveTaskEntries.UpdateOneAsync(x => x.Id == id, stamp, cancellationToken: CancellationToken.None);

        // 队首自动顶上来 —— 只在刚才空出来的是「正在做」那个位置时
        ActiveTaskEntry? next = null;
        if (wasActive)
        {
            next = await _db.ActiveTaskEntries
                .Find(x => x.UserId == userId && x.State == ActiveTaskState.Standby)
                .SortBy(x => x.OrderKey)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (next != null) await ActiveTaskShared.MakeActiveAsync(_db, userId, next.Id, now, CancellationToken.None);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            finished = id,
            next = next == null ? null : ActiveTaskShared.ToDto(
                await _db.ActiveTaskEntries.Find(x => x.Id == next.Id).FirstOrDefaultAsync(ct) ?? next, now),
        }));
    }

    /// <summary>
    /// 撤销结案：把刚结案的那条放回「正在做」，顶替它的那条退回备用队首。
    /// 存在的理由只有一个 —— 点圆圈变成了一下就完成，那就必须能一下就反悔。
    /// </summary>
    [HttpPost("{id}/reopen")]
    public async Task<IActionResult> Reopen(string id, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var entry = await ActiveTaskShared.FindOwnedAsync(_db, id, userId, ct);
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (entry.State != ActiveTaskState.Done && entry.State != ActiveTaskState.Dropped)
            return Ok(ApiResponse<object>.Ok(new { id, reopened = false, alreadyOpen = true }));

        var now = DateTime.UtcNow;

        // 和 Finish 那段一样，从这里往下是不能被切一半的写序列，所以一律
        // CancellationToken.None。跟着请求的 ct 走会这样断：状态已经放回 standby、
        // 结案字段也清了，用户这时关掉页面 —— 那条「把它放回正在做」的激活被取消，
        // 于是撤销只撤了一半：结案说明没了，人却没回到手上那件事。
        // 而重试进不来：开头那句「不在终态就直接返回 alreadyOpen」会把它挡掉。
        // server-authority：客户端断开不取消服务器已经开始的写入。
        //
        // 先脱离结案态再决定放哪一档。顺序是有意的：MakeActiveAsync 只肯激活
        // 「还没结案」的那条（防的是并发结案把 done 复活成 active），
        // 所以撤销必须先把状态放回 standby，它才认。
        await _db.ActiveTaskEntries.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskEntry>.Update
                .Set(x => x.State, ActiveTaskState.Standby)
                .Set(x => x.DoneAt, (DateTime?)null)
                .Set(x => x.ClosingNote, (string?)null)
                .Set(x => x.DropReason, (string?)null)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: CancellationToken.None);

        // 照它结案前那一档还原。一律塞回「正在做」会把用户手上那件换走 ——
        // 那正是 Finish 刚修掉的洞，撤销这条路上同样通着（勾掉一条备用、再点撤销）。
        if (entry.FinishedFromActive)
        {
            // MakeActiveAsync 会把当前在做的那条退回备用队首，正好还原结案前的样子
            await ActiveTaskShared.MakeActiveAsync(_db, userId, id, now, CancellationToken.None);
        }
        // else 分支不用再做什么：OrderKey 结案时没被动过，上面那次更新已经把状态
        // 放回 standby，它就回到了原来那个位置，不用重排
        var saved = await _db.ActiveTaskEntries.Find(x => x.Id == id).FirstOrDefaultAsync(CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(ActiveTaskShared.ToDto(saved!, now)));
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

        // 和 Finish 一样要先取、后结算：结算会把 State 改掉，之后再判就永远是 false。
        // 放下的也能撤销，撤销同样要照它当时那一档还原。
        var wasActive = ActiveTaskShared.ShouldAdvanceQueue(entry.State);

        var now = DateTime.UtcNow;
        await ActiveTaskShared.SettleAndSetStateAsync(_db, entry, ActiveTaskState.Dropped, now, ct);
        await _db.ActiveTaskEntries.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskEntry>.Update
                .Set(x => x.DropReason, req?.Reason?.Trim())
                .Set(x => x.FinishedFromActive, wasActive),
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

        // 条件带齐再删：上面那几行是**读到的那一刻**的判断，挡不住并发。
        // 同一行上「开始」和「删除」挨着点，开始那一步先把它改成 active，
        // 只按 Id 删就会把一条已经开始计时的任务永久删掉 —— 而这个端点自己的规矩是
        // 「投入过时间的只能放下、历史要留痕」。零匹配说明它中途变了，如实回绝。
        var res = await _db.ActiveTaskEntries.DeleteOneAsync(
            x => x.Id == id
                 && x.UserId == userId
                 && x.State == ActiveTaskState.Standby
                 && x.AccumulatedSeconds == 0,
            CancellationToken.None);
        if (res.DeletedCount == 0)
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "这条刚被动过（开始做了或换了位置），没有删；刷新看一眼再决定"));

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

        // 结案的按**结案时间**落窗口，不按最后修改时间：改一句半年前那条的结案说明，
        // 它的 UpdatedAt 就是今天，于是它会出现在「近 7 天」里、还被算进那一栏的合计。
        // 正在做的那条没有结案时间，它本来就该一直在，单独放行。
        // Drop 也落 DoneAt（SettleAndSetStateAsync 统一设的），所以两种终态同一个谓词。
        var items = await _db.ActiveTaskEntries
            .Find(x => x.UserId == target
                       && (((x.State == ActiveTaskState.Done || x.State == ActiveTaskState.Dropped)
                            && x.DoneAt >= since)
                           || x.State == ActiveTaskState.Active))
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

    /// <summary>
    /// 排在队列的哪个位置。只服务一个场景：撤销删除 —— 删掉的那条要回到它原来待着的地方，
    /// 而不是排到队尾去。正常新建不传，由服务端算队尾。
    /// </summary>
    public int? OrderKey { get; set; }
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

    /// <summary>结案后补写的那句「做成了什么样」；传空串表示清掉</summary>
    public string? ClosingNote { get; set; }

    /// <summary>true = 把时间去掉（DueAt 传 null 无法与「不改」区分，所以单给一个开关）</summary>
    public bool? ClearDue { get; set; }
}

public class ActiveTaskReorderRequest
{
    /// <summary>挪到这条的前面；为空表示挪到队尾</summary>
    public string? BeforeId { get; set; }
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
