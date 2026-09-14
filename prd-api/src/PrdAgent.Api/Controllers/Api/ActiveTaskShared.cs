using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 活动任务清单的共享读写逻辑 —— 员工侧 / 老板侧 / 匿名侧三个控制器共用同一份判定，
/// 避免同一个判断被抄成三份然后各自漂移（见 .claude/rules/predicate-and-wiring-discipline.md 形状 3）。
/// </summary>
public static class ActiveTaskShared
{
    /// <summary>读设置，没有就返回默认值（不写库，首次保存时才落盘）。</summary>
    public static async Task<ActiveTaskBoardSettings> LoadSettingsAsync(MongoDbContext db, CancellationToken ct = default)
    {
        var s = await db.ActiveTaskBoardSettingsCollection
            .Find(x => x.Id == ActiveTaskBoardSettings.SingletonId)
            .FirstOrDefaultAsync(ct);
        return s ?? new ActiveTaskBoardSettings();
    }

    /// <summary>拿显示名。查不到就退回 userId 前 8 位，不编人名。</summary>
    public static async Task<string> ResolveDisplayNameAsync(MongoDbContext db, string userId, CancellationToken ct = default)
    {
        var u = await db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        if (u == null) return userId.Length > 8 ? userId[..8] : userId;
        if (!string.IsNullOrWhiteSpace(u.DisplayName)) return u.DisplayName;
        return string.IsNullOrWhiteSpace(u.Username) ? userId : u.Username;
    }

    /// <summary>只能操作自己的任务。</summary>
    public static async Task<ActiveTaskEntry?> FindOwnedAsync(MongoDbContext db, string id, string userId, CancellationToken ct = default)
        => await db.ActiveTaskEntries.Find(x => x.Id == id && x.UserId == userId).FirstOrDefaultAsync(ct);

    /// <summary>队尾排序键（新任务排最后）。</summary>
    public static async Task<double> NextTailOrderKeyAsync(MongoDbContext db, string userId, CancellationToken ct = default)
    {
        var last = await db.ActiveTaskEntries
            .Find(x => x.UserId == userId && x.State == ActiveTaskState.Standby)
            .SortByDescending(x => x.OrderKey)
            .FirstOrDefaultAsync(ct);
        return last == null ? 1000 : last.OrderKey + 1;
    }

    /// <summary>队首排序键（置顶时取它再减 1）。</summary>
    public static async Task<double> HeadOrderKeyAsync(MongoDbContext db, string userId, CancellationToken ct = default)
    {
        var first = await db.ActiveTaskEntries
            .Find(x => x.UserId == userId && x.State == ActiveTaskState.Standby)
            .SortBy(x => x.OrderKey)
            .FirstOrDefaultAsync(ct);
        return first?.OrderKey ?? 1000;
    }

    /// <summary>
    /// 把某条设为「此刻正在做」。WIP=1：同一个人原本在做的那条先结算时长、退回备用队首。
    /// </summary>
    public static async Task MakeActiveAsync(MongoDbContext db, string userId, string id, DateTime now, CancellationToken ct = default)
    {
        var current = await db.ActiveTaskEntries
            .Find(x => x.UserId == userId && x.State == ActiveTaskState.Active && x.Id != id)
            .ToListAsync(ct);

        foreach (var old in current)
        {
            var head = await HeadOrderKeyAsync(db, userId, ct);
            await db.ActiveTaskEntries.UpdateOneAsync(
                x => x.Id == old.Id,
                Builders<ActiveTaskEntry>.Update
                    .Set(x => x.AccumulatedSeconds, old.ElapsedSecondsAt(now))
                    .Set(x => x.BlockedSeconds, old.BlockedSecondsAt(now))
                    .Set(x => x.State, ActiveTaskState.Standby)
                    .Set(x => x.StartedAt, (DateTime?)null)
                    .Set(x => x.Blocked, false)
                    .Set(x => x.BlockedSince, (DateTime?)null)
                    .Set(x => x.OrderKey, head - 1)
                    .Set(x => x.UpdatedAt, now),
                cancellationToken: ct);
        }

        await db.ActiveTaskEntries.UpdateOneAsync(
            x => x.Id == id,
            Builders<ActiveTaskEntry>.Update
                .Set(x => x.State, ActiveTaskState.Active)
                .Set(x => x.StartedAt, now)
                .Set(x => x.Blocked, false)
                .Set(x => x.BlockedSince, (DateTime?)null)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
    }

    /// <summary>结算时长并落终态（done / dropped）。</summary>
    public static Task SettleAndSetStateAsync(MongoDbContext db, ActiveTaskEntry entry, string state, DateTime now, CancellationToken ct = default)
        => db.ActiveTaskEntries.UpdateOneAsync(
            x => x.Id == entry.Id,
            Builders<ActiveTaskEntry>.Update
                .Set(x => x.AccumulatedSeconds, entry.ElapsedSecondsAt(now))
                .Set(x => x.BlockedSeconds, entry.BlockedSecondsAt(now))
                .Set(x => x.State, state)
                .Set(x => x.StartedAt, (DateTime?)null)
                .Set(x => x.Blocked, false)
                .Set(x => x.BlockedSince, (DateTime?)null)
                .Set(x => x.DoneAt, now)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

    /// <summary>
    /// 把粘贴的一段聊天记录切成任务标题。纯规则：按行切，剥掉序号 / 项目符号 / 发言人前缀，
    /// 丢掉太短或纯标点的行。最多 20 条，防止有人整段贴聊天记录进来。
    /// </summary>
    public static List<string> SplitPastedLines(string text)
    {
        var result = new List<string>();
        foreach (var raw in text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;

            // 剥前缀：1. / 1、 / - / * / • / [ ] / 【】
            line = System.Text.RegularExpressions.Regex.Replace(line, @"^[\-\*•●○]\s*", "");
            line = System.Text.RegularExpressions.Regex.Replace(line, @"^\d{1,2}\s*[\.\、\)\）]\s*", "");
            line = System.Text.RegularExpressions.Regex.Replace(line, @"^\[[ x]\]\s*", "");
            // 剥发言人前缀：「张三: 」「张三：」，但别把含冒号的正常句子切坏，所以限制在 12 字以内
            line = System.Text.RegularExpressions.Regex.Replace(line, @"^.{1,12}[:：]\s*", "");
            line = line.Trim();

            if (line.Length < 2) continue;
            if (!System.Text.RegularExpressions.Regex.IsMatch(line, @"[\w一-龥]")) continue;

            result.Add(line.Length > 120 ? line[..120] : line);
            if (result.Count >= 20) break;
        }
        return result;
    }

    /// <summary>历史摘要：交付 / 放弃 / 平均耗时 / 空转，以及估准度与损耗归因。</summary>
    public static object BuildHistorySummary(IReadOnlyList<ActiveTaskEntry> items, DateTime now)
    {
        var done = items.Where(x => x.State == ActiveTaskState.Done).ToList();
        var dropped = items.Where(x => x.State == ActiveTaskState.Dropped).ToList();
        var idleSeconds = items.Sum(x => x.BlockedSecondsAt(now));
        var avgSeconds = done.Count > 0 ? (int)done.Average(x => x.ElapsedSecondsAt(now)) : 0;

        // 估准度：只统计估过的那些（没估过就没有基准，算进去等于编数据）
        var estimated = done.Where(x => x.EstimateMinutes > 0).ToList();
        var accurate = estimated.Count(x => x.ElapsedSecondsAt(now) <= x.EstimateMinutes * 60 * 1.2);
        var overrun = estimated.Count(x => x.ElapsedSecondsAt(now) > x.EstimateMinutes * 60 * 2);

        // 时间漏在哪：按「在等谁」归并
        var leaks = items
            .Where(x => !string.IsNullOrWhiteSpace(x.BlockedOn) && x.BlockedSecondsAt(now) > 0)
            .GroupBy(x => x.BlockedOn!.Trim())
            .Select(g => new
            {
                name = g.Key,
                seconds = g.Sum(x => x.BlockedSecondsAt(now)),
                times = g.Count(),
            })
            .OrderByDescending(x => x.seconds)
            .Take(6)
            .Select(x => new
            {
                x.name,
                x.seconds,
                x.times,
                label = ActiveTaskConclusion.FormatDuration(x.seconds),
                note = $"{x.times} 次 · 平均 {ActiveTaskConclusion.FormatDuration(x.seconds / Math.Max(x.times, 1))}",
            })
            .ToList();

        var headline = done.Count == 0 && dropped.Count == 0
            ? "这段时间还没有已完成的任务，历史是空的。"
            : leaks.Count > 0
                ? $"交付 {done.Count} 件、放弃 {dropped.Count} 件，最大的一块损耗是等「{leaks[0].name}」，累计 {leaks[0].label}。"
                : $"交付 {done.Count} 件、放弃 {dropped.Count} 件，没有记录到明显的等待损耗。";

        return new
        {
            headline,
            doneCount = done.Count,
            droppedCount = dropped.Count,
            avgSeconds,
            avgLabel = ActiveTaskConclusion.FormatDuration(avgSeconds),
            idleSeconds,
            idleLabel = ActiveTaskConclusion.FormatDuration(idleSeconds),
            estimatedCount = estimated.Count,
            accurateCount = accurate,
            overrunCount = overrun,
            leaks,
        };
    }

    /// <summary>
    /// 任务 DTO。masked=true 时抹掉标题正文与备注（匿名脱敏档），只留状态、时长与来源，
    /// 让访客看得到「谁在忙 / 谁卡住 / 谁没活」而看不到项目代号和缺陷细节。
    /// </summary>
    public static object ToDto(ActiveTaskEntry e, DateTime now, bool masked = false)
    {
        var elapsed = e.ElapsedSecondsAt(now);
        var blocked = e.BlockedSecondsAt(now);
        return new
        {
            id = e.Id,
            userId = e.UserId,
            userDisplayName = e.UserDisplayName,
            title = masked ? MaskTitle(e.Title) : e.Title,
            note = masked ? null : e.Note,
            state = e.State,
            orderKey = e.OrderKey,
            estimateMinutes = e.EstimateMinutes,
            elapsedSeconds = elapsed,
            elapsedLabel = ActiveTaskConclusion.FormatDuration(elapsed),
            // 前端本地续走计时用：服务端只在 active 且未卡住时给出起点
            startedAt = e.StartedAt,
            running = e.State == ActiveTaskState.Active && !e.Blocked && e.StartedAt.HasValue,
            blocked = e.Blocked,
            blockedOn = masked ? null : e.BlockedOn,
            blockedSeconds = blocked,
            blockedLabel = ActiveTaskConclusion.FormatDuration(blocked),
            overrun = e.IsOverrun(now),
            source = e.Source,
            sourceRefType = e.SourceRefType,
            sourceRefId = e.SourceRefId,
            // 「看得见委派的是谁」：这两个字段是 #4 的落点
            assignedBy = e.AssignedBy,
            assignedByName = e.AssignedByName,
            assignedAt = e.AssignedAt,
            doneAt = e.DoneAt,
            dropReason = masked ? null : e.DropReason,
            createdAt = e.CreatedAt,
            updatedAt = e.UpdatedAt,
        };
    }

    /// <summary>脱敏标题：保留首字与长度感，其余打码。不返回空串，否则前端会渲染成空行。</summary>
    public static string MaskTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title)) return "（无标题）";
        var head = title.Length <= 2 ? title[..1] : title[..2];
        return head + new string('·', Math.Min(Math.Max(title.Length - 2, 1), 8));
    }

    /// <summary>
    /// 团队看板聚合 —— 匿名侧也复用这一份，避免两处各算一遍然后漂移。
    /// </summary>
    public static async Task<object> BuildTeamBoardAsync(
        MongoDbContext db, ActiveTaskBoardSettings settings, DateTime now, bool masked, CancellationToken ct)
    {
        var live = await db.ActiveTaskEntries
            .Find(x => x.State == ActiveTaskState.Active || x.State == ActiveTaskState.Standby)
            .ToListAsync(ct);

        var todayStart = now.Date;
        var doneToday = await db.ActiveTaskEntries
            .Find(x => x.State == ActiveTaskState.Done && x.DoneAt >= todayStart)
            .ToListAsync(ct);

        var weekStart = now.Date.AddDays(-7);
        var doneWeekCount = (int)await db.ActiveTaskEntries
            .CountDocumentsAsync(x => x.State == ActiveTaskState.Done && x.DoneAt >= weekStart, cancellationToken: ct);

        var groups = live.GroupBy(x => x.UserId).ToList();
        var people = new List<object>();
        var actions = new List<(int severity, object payload)>();
        int blockedCount = 0, lowFuelCount = 0, overrunCount = 0;

        foreach (var g in groups.OrderBy(g => g.Key))
        {
            var active = g.FirstOrDefault(x => x.State == ActiveTaskState.Active);
            var standby = g.Where(x => x.State == ActiveTaskState.Standby).OrderBy(x => x.OrderKey).ToList();
            var name = g.First().UserDisplayName ?? await ResolveDisplayNameAsync(_db, g.Key, ct);
            var standbyMinutes = standby.Sum(x => x.EstimateMinutes);
            var fuelLevel = ActiveTaskConclusion.FuelLevel(standby.Count, settings.LowFuelThreshold);

            var isBlocked = active?.Blocked == true;
            var isOverrun = active?.IsOverrun(now) == true;
            var todaySeconds = doneToday.Where(x => x.UserId == g.Key).Sum(x => x.ElapsedSecondsAt(now))
                               + (active?.ElapsedSecondsAt(now) ?? 0);

            if (isBlocked) blockedCount++;
            if (fuelLevel == "empty") lowFuelCount++;
            if (isOverrun) overrunCount++;

            var status = active == null ? "idle" : isBlocked ? "blocked" : isOverrun ? "overrun" : "running";

            people.Add(new
            {
                userId = g.Key,
                displayName = name,
                status,
                current = active == null ? null : ToDto(active, now, masked),
                standbyCount = standby.Count,
                standbyMinutes,
                fuelLevel,
                fuelLabel = ActiveTaskConclusion.BuildFuelLabel(standby.Count, standbyMinutes, settings.LowFuelThreshold),
                todaySeconds,
                todayLabel = ActiveTaskConclusion.FormatDuration(todaySeconds),
                doneTodayCount = doneToday.Count(x => x.UserId == g.Key),
                // 委派可见性：这条正在做的活是谁派的
                assignedByName = masked ? null : active?.AssignedByName,
            });

            // 需要你出手：卡住超阈值 > 备用见底 > 超期
            if (isBlocked && active!.BlockedSecondsAt(now) >= settings.BlockedEscalateMinutes * 60)
            {
                actions.Add((1, new
                {
                    kind = "催一句",
                    userId = g.Key,
                    who = $"{name} · 卡 {ActiveTaskConclusion.FormatDuration(active.BlockedSecondsAt(now))}",
                    text = masked
                        ? $"{name} 卡住超过 {settings.BlockedEscalateMinutes} 分钟了，需要你去推一下。"
                        : $"{name} 在等「{active.BlockedOn}」，已经等了 {ActiveTaskConclusion.FormatDuration(active.BlockedSecondsAt(now))}。",
                    cta = "去催",
                }));
            }
            if (fuelLevel == "empty")
            {
                actions.Add((2, new
                {
                    kind = "派活",
                    userId = g.Key,
                    who = $"{name} · 备用 0 件",
                    text = active == null
                        ? $"{name} 手上没活，备用队列也是空的。"
                        : $"{name} 手上这件做完就没活了，备用队列是空的。",
                    cta = "派任务",
                }));
            }
            if (isOverrun)
            {
                actions.Add((3, new
                {
                    kind = "问一句",
                    userId = g.Key,
                    who = $"{name} · 已投入 {ActiveTaskConclusion.FormatDuration(active!.ElapsedSecondsAt(now))}",
                    text = $"原估 {active.EstimateMinutes} 分钟的事已经做了 {ActiveTaskConclusion.FormatDuration(active.ElapsedSecondsAt(now))}，中途没报过卡住 —— 多半是范围变大了但没说。",
                    cta = "请他补一句",
                }));
            }
        }

        // 还没汇报的人：近 7 天活跃但今天没有任何在途记录
        var activeSince = now.AddDays(-7);
        var recentUsers = await db.Users
            .Find(x => x.LastActiveAt >= activeSince || x.LastLoginAt >= activeSince)
            .Limit(200)
            .ToListAsync(ct);
        var reported = groups.Select(g => g.Key).ToHashSet();
        var silent = recentUsers
            .Where(u => !reported.Contains(u.UserId))
            .Select(u => new
            {
                userId = u.UserId,
                displayName = string.IsNullOrWhiteSpace(u.DisplayName) ? u.Username : u.DisplayName,
            })
            .Take(20)
            .ToList();

        var onDuty = groups.Count;
        return new
        {
            headline = ActiveTaskConclusion.BuildTeamHeadline(onDuty, blockedCount, lowFuelCount, overrunCount),
            kpis = new
            {
                onDuty,
                blocked = blockedCount,
                lowFuel = lowFuelCount,
                overrun = overrunCount,
                doneWeek = doneWeekCount,
            },
            people,
            actions = actions.OrderBy(a => a.severity).Select(a => a.payload).ToList(),
            silentMembers = silent,
            settings = new { settings.AnonymousMode, settings.AnonymousEnabled, settings.LowFuelThreshold, settings.BlockedEscalateMinutes },
            serverNow = now,
        };
    }
}
