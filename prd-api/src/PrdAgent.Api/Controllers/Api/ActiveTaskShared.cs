using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 活动任务清单的共享读写逻辑 —— 本人侧 / 管理侧 / 匿名侧三个控制器共用同一份判定，
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
    /// <summary>
    /// 结案之后要不要把队首顶上来。
    ///
    /// 只有「正在做」那个位置被腾出来了才要。备用行上也有圆圈，勾掉一条备用任务
    /// 不该动手上那件 —— <see cref="MakeActiveAsync"/> 会把当前 active 退回队列
    /// 并清掉它的卡住状态，等于用户勾了 C，手上的 A 被换成了 B（2026-09-16 Codex 抓到）。
    /// </summary>
    public static bool ShouldAdvanceQueue(string finishedStateBefore)
        => finishedStateBefore == ActiveTaskState.Active;

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

    /// <summary>
    /// 历史摘要。刻意只有两个数：做成了几件、放弃了几件。
    ///
    /// 这里曾经有估准度（他估得准吗）和损耗归因（时间漏在哪）—— 都删了：
    /// 那两块在衡量人，不在帮人沟通，摆在界面上就会让下面的人开始为数字干活。
    /// </summary>
    public static object BuildHistorySummary(IReadOnlyList<ActiveTaskEntry> items, DateTime now)
    {
        var done = items.Where(x => x.State == ActiveTaskState.Done).ToList();
        var dropped = items.Where(x => x.State == ActiveTaskState.Dropped).ToList();

        var headline = done.Count == 0 && dropped.Count == 0
            ? "这段时间还没有结案的任务。"
            : dropped.Count > 0
                ? $"做成了 {done.Count} 件，放下了 {dropped.Count} 件。"
                : $"做成了 {done.Count} 件。";

        return new
        {
            headline,
            doneCount = done.Count,
            droppedCount = dropped.Count,
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
            dueAt = e.DueAt,
            dueLabel = ActiveTaskConclusion.FormatDue(e.DueAt, now),
            overdue = ActiveTaskConclusion.IsOverdue(e.DueAt, now),
            elapsedSeconds = elapsed,
            elapsedLabel = ActiveTaskConclusion.FormatDuration(elapsed),
            // 前端本地续走计时用：服务端只在 active 且未卡住时给出起点
            startedAt = e.StartedAt,
            running = e.State == ActiveTaskState.Active && !e.Blocked && e.StartedAt.HasValue,
            blocked = e.Blocked,
            blockedOn = masked ? null : e.BlockedOn,
            blockedSeconds = blocked,
            blockedLabel = ActiveTaskConclusion.FormatDuration(blocked),
            source = e.Source,
            sourceRefType = e.SourceRefType,
            sourceRefId = e.SourceRefId,
            // 「看得见委派的是谁」：这两个字段是 #4 的落点
            assignedBy = e.AssignedBy,
            assignedByName = e.AssignedByName,
            assignedAt = e.AssignedAt,
            doneAt = e.DoneAt,
            closingNote = masked ? null : e.ClosingNote,
            dropReason = masked ? null : e.DropReason,
            createdAt = e.CreatedAt,
            updatedAt = e.UpdatedAt,
        };
    }

    /// <summary>
    /// 脱敏标题：只留长度感，一个字都不留。
    ///
    /// 这里曾经保留开头一到两个字（理由是「有点形状，不至于像空行」）。但匿名面板
    /// <see cref="ActiveTaskBoardSettings.AnonymousEnabled"/> 默认就是开的，而任务标题
    /// 开头最常见的恰恰是客户名、项目代号、缺陷编号 —— 留两个字就等于把这一屏
    /// 「看不到标题正文」的承诺撕掉一角。长度感用点的个数给就够了，不需要真字符。
    /// 不返回空串，否则前端会渲染成空行。
    /// </summary>
    public static string MaskTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title)) return "（无标题）";
        return new string('·', Math.Clamp(title.Length, 2, 10));
    }

    /// <summary>
    /// 团队看板聚合 —— 就是一个排好序的人员列表。
    ///
    /// 要你管的排最上面（卡住 &gt; 没活 &gt; 堆太多），其余按名字排。
    /// 不另做「需要你出手」区块：那会让同一个人在一屏里出现两次。
    /// 每人给一个堆积量 —— 那是负载不是绩效，所以只给数字，不给完成率/准时率那类东西。
    /// </summary>
    public static async Task<object> BuildTeamBoardAsync(
        MongoDbContext db, ActiveTaskBoardSettings settings, DateTime now, bool masked, CancellationToken ct)
    {
        var live = await db.ActiveTaskEntries
            .Find(x => x.State == ActiveTaskState.Active || x.State == ActiveTaskState.Standby)
            .ToListAsync(ct);

        // 近 7 天活跃的人也列出来 —— 没汇报不代表没干活，但管理的人得看得见这一行
        var activeSince = now.AddDays(-7);
        var recentUsers = await db.Users
            .Find(x => x.LastActiveAt >= activeSince || x.LastLoginAt >= activeSince)
            .Limit(200)
            .ToListAsync(ct);

        var byUser = live.GroupBy(x => x.UserId).ToDictionary(g => g.Key, g => g.ToList());
        var userIds = new HashSet<string>(byUser.Keys);
        foreach (var u in recentUsers) userIds.Add(u.UserId);

        var nameOf = recentUsers
            .GroupBy(u => u.UserId)
            .ToDictionary(
                g => g.Key,
                g => string.IsNullOrWhiteSpace(g.First().DisplayName) ? g.First().Username : g.First().DisplayName);

        var people = new List<TeamRow>();
        foreach (var uid in userIds)
        {
            byUser.TryGetValue(uid, out var mine);
            var active = mine?.FirstOrDefault(x => x.State == ActiveTaskState.Active);
            var standby = mine?.Count(x => x.State == ActiveTaskState.Standby) ?? 0;

            var name = nameOf.TryGetValue(uid, out var n) && !string.IsNullOrWhiteSpace(n)
                ? n
                : (mine?.FirstOrDefault()?.UserDisplayName ?? await ResolveDisplayNameAsync(db, uid, ct));

            string status;
            string task;
            if (active == null && standby == 0) { status = "empty"; task = "没活了"; }
            else if (active == null) { status = "silent"; task = "还没说在做什么"; }
            else if (active.Blocked)
            {
                status = "blocked";
                task = masked || string.IsNullOrWhiteSpace(active.BlockedOn)
                    ? "卡住了"
                    : $"卡住了 · 在等{active.BlockedOn}";
            }
            else { status = "running"; task = masked ? MaskTitle(active.Title) : active.Title; }

            people.Add(new TeamRow
            {
                UserId = uid,
                DisplayName = name,
                Status = status,
                Task = task,
                StandbyCount = standby,
                AssignedByName = masked ? null : active?.AssignedByName,
                BlockedSeconds = active?.BlockedSecondsAt(now) ?? 0,
            });
        }

        // 排序：卡住 > 没活 > 堆太多 > 其余
        var order = new Dictionary<string, int> { ["blocked"] = 0, ["empty"] = 1, ["silent"] = 3, ["running"] = 2 };
        var sorted = people
            .OrderBy(p => order.TryGetValue(p.Status, out var o) ? o : 9)
            .ThenByDescending(p => p.Status == "running" && p.StandbyCount >= settings.HeavyStackThreshold ? 1 : 0)
            .ThenBy(p => p.DisplayName, StringComparer.Ordinal)
            .ToList();

        var closed = await db.ActiveTaskEntries
            .Find(x => x.State == ActiveTaskState.Done)
            .SortByDescending(x => x.DoneAt)
            .Limit(8)
            .ToListAsync(ct);

        var needsYou = sorted.Count(p => p.Status == "blocked" || p.Status == "empty");

        return new
        {
            headline = BuildTeamHeadline(sorted.Count, needsYou),
            needsYou,
            heavyStackThreshold = settings.HeavyStackThreshold,
            people = sorted.Select(p => new
            {
                userId = p.UserId,
                displayName = p.DisplayName,
                status = p.Status,
                task = p.Task,
                standbyCount = p.StandbyCount,
                assignedByName = p.AssignedByName,
                blockedSeconds = p.BlockedSeconds,
            }).ToList(),
            recentlyClosed = closed.Select(c => new
            {
                id = c.Id,
                who = c.UserDisplayName,
                title = masked ? MaskTitle(c.Title) : c.Title,
                closingNote = masked ? null : c.ClosingNote,
                doneAt = c.DoneAt,
            }).ToList(),
            serverNow = now,
        };
    }

    /// <summary>团队头条：一句话，只说有没有要他管的，不报数字堆。</summary>
    private static string BuildTeamHeadline(int total, int needsYou)
    {
        if (total == 0) return "还没有人汇报在做什么。";
        return needsYou == 0
            ? $"{total} 个人都在推进，没有要你管的。"
            : $"{needsYou} 个人要你看一下，其余 {total - needsYou} 个正常。";
    }

    private sealed class TeamRow
    {
        public string UserId { get; set; } = string.Empty;
        public string DisplayName { get; set; } = string.Empty;
        public string Status { get; set; } = string.Empty;
        public string Task { get; set; } = string.Empty;
        public int StandbyCount { get; set; }
        public string? AssignedByName { get; set; }
        public int BlockedSeconds { get; set; }
    }
}
