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
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? state = null,
        [FromQuery] string? module = null,
        [FromQuery] bool mineOnly = false,
        CancellationToken ct = default)
    {
        var me = GetUserId();
        var filters = new List<FilterDefinition<ActiveTaskDebt>>();

        if (!string.IsNullOrWhiteSpace(state))
        {
            if (!ActiveTaskDebtState.IsValid(state))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "状态只能是 open / claimed / converted / closed"));
            filters.Add(Builders<ActiveTaskDebt>.Filter.Eq(x => x.State, state));
        }
        else
        {
            filters.Add(Builders<ActiveTaskDebt>.Filter.Ne(x => x.State, ActiveTaskDebtState.Closed));
        }

        if (!string.IsNullOrWhiteSpace(module))
            filters.Add(Builders<ActiveTaskDebt>.Filter.Eq(x => x.Module, module));
        if (mineOnly)
            filters.Add(Builders<ActiveTaskDebt>.Filter.Eq(x => x.OwnerUserId, me));

        var items = await _db.ActiveTaskDebts
            .Find(Builders<ActiveTaskDebt>.Filter.And(filters))
            .Limit(500)
            .ToListAsync(ct);

        // 排序在内存里做：先「我认领的」，再没人认领的，最后别人认领的；组内按模块 + 编号
        var sorted = items
            .OrderBy(x => x.OwnerUserId == me ? 0 : string.IsNullOrEmpty(x.OwnerUserId) ? 1 : 2)
            .ThenBy(x => x.Module, StringComparer.Ordinal)
            .ThenBy(x => x.Num)
            .ToList();

        var mine = sorted.Count(x => x.OwnerUserId == me);
        var unclaimed = sorted.Count(x => string.IsNullOrEmpty(x.OwnerUserId));

        return Ok(ApiResponse<object>.Ok(new
        {
            headline = BuildHeadline(sorted.Count, mine, unclaimed),
            total = sorted.Count,
            mineCount = mine,
            unclaimedCount = unclaimed,
            items = sorted.Select(x => ToDto(x, me)).ToList(),
            modules = sorted.Select(x => x.Module).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList(),
        }));
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
        if (!string.IsNullOrEmpty(debt.OwnerUserId) && debt.OwnerUserId != me)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"这条已经归 {debt.OwnerUserName ?? "别人"} 了"));

        var now = DateTime.UtcNow;
        await _db.ActiveTaskDebts.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskDebt>.Update
                .Set(x => x.OwnerUserId, me)
                .Set(x => x.OwnerUserName, await ActiveTaskShared.ResolveDisplayNameAsync(_db, me, ct))
                .Set(x => x.State, debt.ConvertedTaskIds.Count > 0 ? ActiveTaskDebtState.Converted : ActiveTaskDebtState.Claimed)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        var saved = await _db.ActiveTaskDebts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(ToDto(saved!, me)));
    }

    /// <summary>放回去：取消认领，状态退回 open。已经转出去的任务不动 —— 那是独立的一条活了。</summary>
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
                .Set(x => x.State, ActiveTaskDebtState.Open)
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

        var taskIds = new List<string>(debt.ConvertedTaskIds) { entry.Id };
        await _db.ActiveTaskDebts.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskDebt>.Update
                .Set(x => x.ConvertedTaskIds, taskIds)
                .Set(x => x.State, ActiveTaskDebtState.Converted)
                // 转的人就是认领的人 —— 动手了还说没人管，那是自欺
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
