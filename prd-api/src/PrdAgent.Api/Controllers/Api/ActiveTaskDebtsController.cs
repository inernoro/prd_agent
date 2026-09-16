using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 债务 —— 任务台的下半屏。
///
/// 上半屏是「我现在要做什么」，下半屏是「我们欠着什么」。两者的差别是时态：
/// 任务有人、有状态、今天就要动；债务只写在 <c>doc/debt.*.md</c> 里，没人、没状态，
/// 只有写它的那个 Agent 看得见。本控制器补的就是缺的那三样。
///
/// 权责划分（一句话）：**正文归仓库，归属与状态归这里**。
/// 同步端点只覆盖正文三件套，认领/转换端点只改归属与状态，两边不越界 ——
/// 越界就会变成两份都能写的账，也就是必然漂移的两份账。
/// 详见 <see cref="ActiveTaskDebt"/> 的类注释与 doc/debt.platform.active-tasks.md 第 15 条。
/// </summary>
[ApiController]
[Route("api/active-tasks/debts")]
[Authorize]
[AdminController("active-tasks", AdminPermissionCatalog.ActiveTasksUse)]
public class ActiveTaskDebtsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public ActiveTaskDebtsController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>
    /// 债务清单。默认只给还没了结的（open / claimed / converted）——
    /// 了结的那些不该占着这半屏，跟收件箱一个道理。
    ///
    /// 计数与结论句按**整块看板**算，不跟着 module / mineOnly 走：
    /// 跟着筛选走的结论是假结论（开「只看我的」时会说出「其余都有人管了」，
    /// 而实际上还有一百多条没人管）。筛选只决定列出哪几条。
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? state = null,
        [FromQuery] string? module = null,
        [FromQuery] bool mineOnly = false,
        CancellationToken ct = default)
    {
        var me = GetUserId();

        FilterDefinition<ActiveTaskDebt> scope;
        if (!string.IsNullOrWhiteSpace(state))
        {
            if (!ActiveTaskDebtState.IsValid(state))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "状态只能是 open / claimed / converted / closed"));
            scope = Builders<ActiveTaskDebt>.Filter.Eq(x => x.State, state);
        }
        else
        {
            scope = Builders<ActiveTaskDebt>.Filter.Ne(x => x.State, ActiveTaskDebtState.Closed);
        }

        // 500 是整块看板的上限，不是筛完之后的上限 —— 因为计数要按整块算，
        // 就必须先把整块取回来。真到 500 条以上再谈分页，那时筛选也得跟着挪回 DB 侧。
        var all = await _db.ActiveTaskDebts.Find(scope).Limit(500).ToListAsync(ct);
        await PruneDeadConversionsAsync(_db, all, ct);

        var board = BuildBoard(all, me, module, mineOnly);

        return Ok(ApiResponse<object>.Ok(new
        {
            headline = BuildHeadline(board.Total, board.Mine, board.Unclaimed),
            total = board.Total,
            mineCount = board.Mine,
            unclaimedCount = board.Unclaimed,
            shownCount = board.Items.Count,
            items = board.Items.Select(x => ToDto(x, me)).ToList(),
            modules = board.Modules,
        }));
    }

    /// <summary>
    /// 转出去的那条活可能已经被删掉了。悬空的 id 不能再充当「已转成 N 条活」的证据 ——
    /// 否则界面上点过去是空气，而且状态永远回不到 open / claimed（<see cref="StateForClaimed"/>
    /// 只数个数，不问那几条活还在不在）。所以读的时候对一遍活人名单，顺手把账本改回真值。
    /// </summary>
    internal static async Task PruneDeadConversionsAsync(
        MongoDbContext db, List<ActiveTaskDebt> debts, CancellationToken ct)
    {
        var referenced = debts.SelectMany(d => d.ConvertedTaskIds).Distinct().ToList();
        if (referenced.Count == 0) return;

        var live = (await db.ActiveTaskEntries
            .Find(Builders<ActiveTaskEntry>.Filter.In(x => x.Id, referenced))
            .Project(x => x.Id)
            .ToListAsync(ct)).ToHashSet(StringComparer.Ordinal);

        if (live.Count == referenced.Count) return;

        var now = DateTime.UtcNow;
        var writes = new List<WriteModel<ActiveTaskDebt>>();
        foreach (var d in debts)
        {
            var pruned = PruneConversions(d, live);
            if (pruned == null) continue;

            d.ConvertedTaskIds = pruned.Value.Kept;
            d.State = pruned.Value.State;
            d.UpdatedAt = now;
            writes.Add(new UpdateOneModel<ActiveTaskDebt>(
                Builders<ActiveTaskDebt>.Filter.Eq(x => x.Id, d.Id),
                Builders<ActiveTaskDebt>.Update
                    .Set(x => x.ConvertedTaskIds, d.ConvertedTaskIds)
                    .Set(x => x.State, d.State)
                    .Set(x => x.UpdatedAt, now)));
        }

        if (writes.Count > 0)
            await db.ActiveTaskDebts.BulkWriteAsync(writes, cancellationToken: ct);
    }

    /// <summary>
    /// 仓库把台账推过来 —— 幂等，按 Key 更新或新建。
    ///
    /// 只覆盖正文三件套（标题 / 现状 / 补的条件）与来源路径，**绝不碰归属与状态**：
    /// 那两样是任务台这一侧的事实，被同步覆盖掉就等于每次跑一次脚本把认领记录抹一遍。
    /// </summary>
    [HttpPost("sync")]
    public async Task<IActionResult> Sync([FromBody] DebtSyncRequest req, CancellationToken ct = default)
    {
        if (req?.Items == null || req.Items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有要同步的债务条目"));
        if (req.Items.Count > 1000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "一次最多同步 1000 条"));

        var now = DateTime.UtcNow;
        var created = 0;
        var updated = 0;
        var skipped = new List<string>();

        foreach (var item in req.Items)
        {
            var parsed = ParseKey(item.Key);
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
            var update = Builders<ActiveTaskDebt>.Update
                .Set(x => x.Module, module)
                .Set(x => x.Num, num)
                .Set(x => x.Title, Clip(item.Title.Trim(), 300)!)
                .Set(x => x.Status, Clip(item.Status?.Trim(), 2000))
                .Set(x => x.CloseCondition, Clip(item.CloseCondition?.Trim(), 2000))
                .Set(x => x.SourcePath, item.SourcePath?.Trim() ?? $"doc/debt.{module}.md")
                .Set(x => x.SyncedAt, now)
                .Set(x => x.UpdatedAt, now)
                .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
                .SetOnInsert(x => x.Key, item.Key.Trim())
                .SetOnInsert(x => x.State, ActiveTaskDebtState.Open)
                .SetOnInsert(x => x.ConvertedTaskIds, new List<string>())
                .SetOnInsert(x => x.CreatedAt, now);

            var res = await _db.ActiveTaskDebts.UpdateOneAsync(
                x => x.Key == item.Key.Trim(), update,
                new UpdateOptions { IsUpsert = true }, ct);

            if (res.UpsertedId != null) created++;
            else if (res.ModifiedCount > 0) updated++;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            created,
            updated,
            skipped,
            syncedAt = now,
            note = "只覆盖了正文；认领人与状态不受同步影响",
        }));
    }

    /// <summary>认领一条：从「没人管」变成「归我」。不创建任务 —— 那是下一步的事。</summary>
    [HttpPost("{id}/claim")]
    public async Task<IActionResult> Claim(string id, CancellationToken ct = default)
    {
        var me = GetUserId();
        var debt = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (debt == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这条债务不在"));
        if (OwnedBySomeoneElse(debt, me))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, TakenByMessage(debt)));

        var now = DateTime.UtcNow;
        // 上面那道门是顺序执行下的判断，挡不住并发：两个人同时认领同一条没人管的债务，
        // 都读到空 owner、都过了门，后写的把先写的悄悄顶掉。所以写入时把「我读到的归属」
        // 也放进过滤条件，零匹配就说明有人抢先了 —— 如实告诉后到的那个人。
        var res = await _db.ActiveTaskDebts.UpdateOneAsync(
            Builders<ActiveTaskDebt>.Filter.And(
                Builders<ActiveTaskDebt>.Filter.Eq(x => x.Id, id),
                UnownedOrMineFilter(me)),
            Builders<ActiveTaskDebt>.Update
                .Set(x => x.OwnerUserId, me)
                .Set(x => x.OwnerUserName, await ActiveTaskShared.ResolveDisplayNameAsync(_db, me, ct))
                .Set(x => x.State, StateForClaimed(debt))
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        var saved = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (res.MatchedCount == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, TakenByMessage(saved ?? debt)));

        return Ok(ApiResponse<object>.Ok(ToDto(saved!, me)));
    }

    /// <summary>
    /// 放回去：取消认领。已经转出去的任务不动 —— 那是独立的一条活了。
    ///
    /// 状态退到哪一档要看有没有转出去过：转过就退回 converted，没转过才退回 open。
    /// 无条件退回 open 会让界面出现「还没人管」和「已转成 1 条活」并排的自相矛盾
    /// （2026-09-16 真机截图当场照出来的），而且 Claim 那边本来就是按这个判的 ——
    /// 同一个判断两处不一致，就是 predicate-and-wiring-discipline 形状 3。
    /// </summary>
    [HttpPost("{id}/release")]
    public async Task<IActionResult> Release(string id, CancellationToken ct = default)
    {
        var me = GetUserId();
        var debt = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (debt == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这条债务不在"));
        if (debt.OwnerUserId != me)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "这条不是你认领的"));

        await _db.ActiveTaskDebts.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskDebt>.Update
                .Set(x => x.OwnerUserId, (string?)null)
                .Set(x => x.OwnerUserName, (string?)null)
                .Set(x => x.State, StateForUnclaimed(debt))
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        var saved = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(ToDto(saved!, me)));
    }

    /// <summary>
    /// 转成我的活 —— 这条债务从此在队列里有一条能动手做的事。
    ///
    /// 建出来的任务带着 <c>sourceRefType=debt</c> 和 Key，所以从任务查得回债务；
    /// 债务这边记 <c>ConvertedTaskIds</c>，所以从债务点得到任务。两个方向都点得通。
    /// 标题默认取债务标题，允许调用方改写（界面上就是那个输入框）。
    /// </summary>
    [HttpPost("{id}/convert")]
    public async Task<IActionResult> Convert(string id, [FromBody] DebtConvertRequest? req, CancellationToken ct = default)
    {
        var me = GetUserId();
        var debt = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (debt == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这条债务不在"));
        // 转出去顺带把归属写成自己，所以它和认领是同一道门。少这一道，别人点一下
        // 「转成我的活」就能把你认领的那条悄悄划走，而 Claim 那边明明是拦着的。
        if (OwnedBySomeoneElse(debt, me))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, TakenByMessage(debt)));

        var now = DateTime.UtcNow;
        var title = string.IsNullOrWhiteSpace(req?.Title) ? debt.Title : req!.Title!.Trim();
        var display = await ActiveTaskShared.ResolveDisplayNameAsync(_db, me, ct);

        var entry = new ActiveTaskEntry
        {
            UserId = me,
            UserDisplayName = display,
            Title = Clip(title, 300)!,
            // 备注里带上「补的条件」：接手的人点开就知道什么算补完了，不用回去翻台账
            Note = BuildNote(debt, req?.Note),
            DueAt = req?.DueAt,
            State = ActiveTaskState.Standby,
            Source = ActiveTaskSource.Manual,
            SourceRefType = "debt",
            SourceRefId = debt.Key,
            OrderKey = await ActiveTaskShared.NextTailOrderKeyAsync(_db, me, ct),
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ActiveTaskEntries.InsertOneAsync(entry, cancellationToken: ct);

        // 用追加而不是整表覆盖：两个人同时转同一条没人认领的债务时，
        // 各自手上的 ConvertedTaskIds 都是转之前的快照，谁后写谁把对方那条 id 抹掉。
        // 追加是幂等安全的，$push 由数据库自己合并。
        //
        // 归属那一半带条件：只在「还没人认领」或「本来就是我」时才改写。
        // 前面的 OwnedBySomeoneElse 是顺序执行下的门，挡不住并发窗口里两个人同时进来；
        // 这个条件让后到者改不动归属，但它转出去的那条活仍然记进 ConvertedTaskIds ——
        // 活已经建出来了，抹掉链接比归属不对更糟。
        await _db.ActiveTaskDebts.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskDebt>.Update
                .Push(x => x.ConvertedTaskIds, entry.Id)
                .Set(x => x.State, ActiveTaskDebtState.Converted)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        // 转的人就是认领的人 —— 动手了还说没人管，那是自欺
        await _db.ActiveTaskDebts.UpdateOneAsync(
            Builders<ActiveTaskDebt>.Filter.And(
                Builders<ActiveTaskDebt>.Filter.Eq(x => x.Id, id),
                UnownedOrMineFilter(me)),
            Builders<ActiveTaskDebt>.Update
                .Set(x => x.OwnerUserId, me)
                .Set(x => x.OwnerUserName, display)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        var saved = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            debt = ToDto(saved!, me),
            task = ActiveTaskShared.ToDto(entry, now),
        }));
    }

    /// <summary>
    /// 这条在任务台这侧了了。注意它不会去改仓库里的台账 ——
    /// 正文是仓库的事，这里只记「我们认为它了了」，下一次同步也不会把它翻回来。
    /// </summary>
    [HttpPost("{id}/close")]
    public async Task<IActionResult> Close(string id, CancellationToken ct = default)
    {
        var me = GetUserId();
        var debt = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (debt == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "这条债务不在"));

        await _db.ActiveTaskDebts.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskDebt>.Update
                .Set(x => x.State, ActiveTaskDebtState.Closed)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        var saved = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(ToDto(saved!, me)));
    }

    // ── 内部 ────────────────────────────────────────────────

    /// <summary>
    /// 解析稳定标识。形如 <c>platform.active-tasks#15</c>。
    ///
    /// 模块段刻意只放行小写字母、数字、点和连字符：台账文件名就长这样
    /// （<c>debt.{appname}[.{子模块}].md</c>，见 doc/rule.doc.naming.md）。
    /// 放行别的字符没有好处，只会让这个标识变成一个自由文本字段。
    /// </summary>
    internal static (string Module, int Num)? ParseKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(
            key.Trim(), @"^([a-z0-9]+(?:[.\-][a-z0-9]+)*)#(\d{1,4})$");
        if (!m.Success) return null;
        if (!int.TryParse(m.Groups[2].Value, out var num) || num <= 0) return null;
        return (m.Groups[1].Value, num);
    }

    /// <summary>
    /// 有人认领时该落哪一档：转出去过就是 converted，没转过才是 claimed。
    /// 和 <see cref="StateForUnclaimed"/> 是同一个判断的两侧，所以摆在一起 ——
    /// 分开写两份，改一处忘一处就会出现「还没人管」配「已转成 1 条活」那种自相矛盾。
    /// </summary>
    internal static string StateForClaimed(ActiveTaskDebt d)
        => d.ConvertedTaskIds.Count > 0 ? ActiveTaskDebtState.Converted : ActiveTaskDebtState.Claimed;

    /// <summary>没人认领时该落哪一档：转出去过的活还在，所以仍是 converted。</summary>
    internal static string StateForUnclaimed(ActiveTaskDebt d)
        => d.ConvertedTaskIds.Count > 0 ? ActiveTaskDebtState.Converted : ActiveTaskDebtState.Open;

    /// <summary>
    /// 这条已经归别人了吗。认领与转成任务都会改写归属，所以它们必须过同一道门 ——
    /// 只在认领那边拦、转换那边不拦，等于给了一条绕过去的路（2026-09-16 Codex 抓到）。
    /// </summary>
    internal static bool OwnedBySomeoneElse(ActiveTaskDebt d, string me)
        => !string.IsNullOrEmpty(d.OwnerUserId) && d.OwnerUserId != me;

    /// <summary>
    /// 写入时的归属条件：只在「还没人认领」或「本来就是我」时才改得动。
    /// <see cref="OwnedBySomeoneElse"/> 是读到的那一刻的判断，挡不住并发窗口里
    /// 两个人同时过门；把同一个条件放进 update 的过滤器，数据库那一侧才是唯一的裁判。
    /// </summary>
    internal static FilterDefinition<ActiveTaskDebt> UnownedOrMineFilter(string me)
        => Builders<ActiveTaskDebt>.Filter.Or(
            Builders<ActiveTaskDebt>.Filter.Eq(x => x.OwnerUserId, null),
            Builders<ActiveTaskDebt>.Filter.Eq(x => x.OwnerUserId, ""),
            Builders<ActiveTaskDebt>.Filter.Eq(x => x.OwnerUserId, me));

    /// <summary>被别人占着时说的那句话 —— 两个入口共用一份措辞。</summary>
    internal static string TakenByMessage(ActiveTaskDebt d)
        => $"这条已经归 {d.OwnerUserName ?? "别人"} 了";

    /// <summary>
    /// 一块看板：计数按全量算，列表按筛选给。两者是不同的东西，混成一个就会说谎。
    /// </summary>
    internal readonly record struct DebtBoardView(
        List<ActiveTaskDebt> Items,
        int Total,
        int Mine,
        int Unclaimed,
        List<string> Modules);

    /// <summary>
    /// 把一批债务整理成看板。<paramref name="module"/> / <paramref name="mineOnly"/> 只筛
    /// <see cref="DebtBoardView.Items"/>，不影响计数与模块下拉 —— 模块下拉要是也跟着筛，
    /// 选完一个模块就再也选不回别的了。
    /// </summary>
    internal static DebtBoardView BuildBoard(
        IReadOnlyList<ActiveTaskDebt> all, string me, string? module, bool mineOnly)
    {
        var view = all.AsEnumerable();
        if (!string.IsNullOrWhiteSpace(module))
            view = view.Where(x => x.Module == module);
        if (mineOnly)
            view = view.Where(x => x.OwnerUserId == me);

        // 排序在内存里做：先「我认领的」，再没人认领的，最后别人认领的；组内按模块 + 编号
        var items = view
            .OrderBy(x => x.OwnerUserId == me ? 0 : string.IsNullOrEmpty(x.OwnerUserId) ? 1 : 2)
            .ThenBy(x => x.Module, StringComparer.Ordinal)
            .ThenBy(x => x.Num)
            .ToList();

        return new DebtBoardView(
            items,
            all.Count,
            all.Count(x => x.OwnerUserId == me),
            all.Count(x => string.IsNullOrEmpty(x.OwnerUserId)),
            all.Select(x => x.Module).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList());
    }

    /// <summary>
    /// 对一遍活人名单，剔掉指向已删任务的 id 并把状态落回真值。
    /// 没有需要剔的就返回 null（调用方据此跳过这一条，不做无谓的写）。
    /// 已了结（closed）的那档不动状态 —— 它的了结跟转没转过没关系。
    /// </summary>
    internal static (List<string> Kept, string State)? PruneConversions(
        ActiveTaskDebt d, ISet<string> liveTaskIds)
    {
        if (d.ConvertedTaskIds.Count == 0) return null;
        var kept = d.ConvertedTaskIds.Where(liveTaskIds.Contains).ToList();
        if (kept.Count == d.ConvertedTaskIds.Count) return null;

        if (d.State == ActiveTaskDebtState.Closed) return (kept, d.State);

        // 状态回落走既有的那两个判断，不在这里另写一份（写两份就会各自漂移）
        var probe = new ActiveTaskDebt { ConvertedTaskIds = kept, OwnerUserId = d.OwnerUserId };
        var state = string.IsNullOrEmpty(d.OwnerUserId) ? StateForUnclaimed(probe) : StateForClaimed(probe);
        return (kept, state);
    }

    internal static string? Clip(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var t = s.Trim();
        return t.Length <= max ? t : t[..max];
    }

    /// <summary>
    /// 一句话结论，不是三个数字堆在那儿让人自己算
    /// （见 .claude/rules/conclusion-before-numbers.md）。
    /// </summary>
    internal static string BuildHeadline(int total, int mine, int unclaimed)
    {
        if (total == 0) return "没有欠着的账 —— 要么真没有，要么还没同步过来。";
        if (mine > 0 && unclaimed > 0) return $"你认领了 {mine} 条，另有 {unclaimed} 条还没人管。";
        if (mine > 0) return $"你认领了 {mine} 条，其余都有人管了。";
        if (unclaimed == total) return $"{total} 条都还没人管。";
        return $"{unclaimed} 条还没人管，其余 {total - unclaimed} 条有人认领了。";
    }

    private static string? BuildNote(ActiveTaskDebt debt, string? extra)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(extra)) parts.Add(extra.Trim());
        if (!string.IsNullOrWhiteSpace(debt.CloseCondition)) parts.Add($"补的条件：{debt.CloseCondition}");
        parts.Add($"来自 {debt.SourcePath} 第 {debt.Num} 条（{debt.Key}）");
        return Clip(string.Join("\n", parts), 2000);
    }

    private static object ToDto(ActiveTaskDebt d, string me) => new
    {
        id = d.Id,
        key = d.Key,
        module = d.Module,
        num = d.Num,
        title = d.Title,
        status = d.Status,
        closeCondition = d.CloseCondition,
        sourcePath = d.SourcePath,
        ownerUserId = d.OwnerUserId,
        ownerUserName = d.OwnerUserName,
        mine = d.OwnerUserId == me,
        state = d.State,
        convertedTaskIds = d.ConvertedTaskIds,
        syncedAt = d.SyncedAt,
        createdAt = d.CreatedAt,
        updatedAt = d.UpdatedAt,
    };
}

/// <summary>仓库推过来的一批债务。</summary>
public class DebtSyncRequest
{
    public List<DebtSyncItem> Items { get; set; } = new();
}

/// <summary>一条债务的正文快照。归属与状态不在这里 —— 那两样同步端点不许碰。</summary>
public class DebtSyncItem
{
    /// <summary>稳定标识，如 platform.active-tasks#15</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>债务是什么</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>现状</summary>
    public string? Status { get; set; }

    /// <summary>什么条件下该补</summary>
    public string? CloseCondition { get; set; }

    /// <summary>台账文件路径；不填按模块推 doc/debt.{module}.md</summary>
    public string? SourcePath { get; set; }
}

/// <summary>把债务转成一条任务。</summary>
public class DebtConvertRequest
{
    /// <summary>任务标题，不填就用债务标题</summary>
    public string? Title { get; set; }

    /// <summary>额外备注，会拼在「补的条件」前面</summary>
    public string? Note { get; set; }

    /// <summary>什么时候要，可选</summary>
    public DateTime? DueAt { get; set; }
}
