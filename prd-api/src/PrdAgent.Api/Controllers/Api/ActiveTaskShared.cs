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
    /// 结案之后要不要把队首顶上来。
    ///
    /// 只有「正在做」那个位置被腾出来了才要。备用行上也有圆圈，勾掉一条备用任务
    /// 不该动手上那件 —— <see cref="MakeActiveAsync"/> 会把当前 active 退回队列
    /// 并清掉它的卡住状态，等于用户勾了 C，手上的 A 被换成了 B（2026-09-16 Codex 抓到）。
    /// </summary>
    public static bool ShouldAdvanceQueue(string finishedStateBefore)
        => finishedStateBefore == ActiveTaskState.Active;

    /// <summary>
    /// 把某条设为「此刻正在做」。WIP=1：同一个人原本在做的那条先结算时长、退回备用队首。
    ///
    /// 关于并发：两次切换若同时发生，各自读到的「当前在做」是同一条，于是可能各自
    /// 激活自己的目标，留下两条 active —— 之后 <c>FirstOrDefault</c> 只看得见一条，
    /// 另一条藏着继续计时，投入时长从此就是错的。这里只做一件事：降级带上
    /// 「它当时还真的是 active」这个条件（CAS），这样重复降级不会拿旧的 StartedAt
    /// 把投入二次结算。
    ///
    /// **不要再加「收尾扫一遍把除目标外的 active 全降级」**。2026-09-16 试过，它更糟：
    /// 两次切换各自激活完目标之后才轮到清扫，A 的清扫降掉 B、B 的清扫再降掉 A，
    /// 末态变成**零条正在做**——用户点了开始，手上却什么都没有，而且两条都停止计时。
    /// 两条 active 至少还有一条在显示、都在计时；零条是纯粹的损失。
    ///
    /// 真原子要么上事务、要么给 (UserId, State=active) 建唯一部分索引，而本仓库禁止
    /// 应用自建索引。残留边界（并发下可能两条 active）记在
    /// doc/debt.platform.active-tasks.md 第 19 条，不在这里用更坏的办法假装解决。
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
                // 带上 State 条件：并发下别人可能已经把它降级了，再降一次会拿旧的
                // StartedAt 重算一遍时长，把投入算多
                x => x.Id == old.Id && x.State == ActiveTaskState.Active,
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
    /// 这里曾经保留开头一到两个字（理由是「有点形状，不至于像空行」）。但匿名面板一旦
    /// <see cref="ActiveTaskBoardSettings.AnonymousEnabled"/> 被打开就是对着公网的，而任务标题
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
                // 卡住要卡够配置的时长才升到管理侧 —— 否则 BlockedEscalateMinutes（5-1440）
                // 这个旋钮转了等于没转：卡住一秒就顶到看板最上面并计进「几个人要你看一下」。
                // 「卡住了」这个状态照常显示，升不升级是另一回事。
                //
                // 量的是**这一轮**卡了多久，不是累计。用累计（BlockedSecondsAt）的话，
                // 之前卡过 110 分钟、这次刚卡 10 分钟，在 120 分钟的阈值下立刻就升级了 ——
                // 而它这一次其实才卡了十分钟。累计值留给历史那一栏。
                Escalated = active?.Blocked == true && active.BlockedSince.HasValue
                    && (now - active.BlockedSince.Value).TotalSeconds >= settings.BlockedEscalateMinutes * 60,
            });
        }

        // 要你管的排最上面。刚卡住的排在「没活」之后 —— 它还没够到升级门槛，
        // 只是需要知道，不是需要现在动手。
        var sorted = people
            .OrderBy(TeamRowRank)
            .ThenByDescending(p => Overloaded(p, settings.HeavyStackThreshold) ? 1 : 0)
            .ThenBy(p => p.DisplayName, StringComparer.Ordinal)
            .ToList();

        var closed = await db.ActiveTaskEntries
            .Find(x => x.State == ActiveTaskState.Done)
            .SortByDescending(x => x.DoneAt)
            .Limit(8)
            .ToListAsync(ct);

        // 「要你看一下」的三种人必须与这一屏标出来的三种人是同一批：卡够时长的、没活的、
        // 以及堆超阈值的。漏掉最后一种，就会出现「N 个人都在推进，没有要你管的」这句话
        // 底下明晃晃标着两个堆红了的人 —— 结论句和它总结的那些行自相矛盾。
        var needsYou = sorted.Count(p => p.Escalated || p.Status == "empty" || Overloaded(p, settings.HeavyStackThreshold));

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
    /// <summary>
    /// 堆太多 —— 排序与结论句共用这一个判定，不许各写一份。
    /// 只对正在推进的人成立：卡住和没活各有各的名目，不该再被算一遍。
    /// </summary>
    internal static bool Overloaded(TeamRow p, int heavyStackThreshold)
        => p.Status == "running" && p.StandbyCount >= heavyStackThreshold;

    private static string BuildTeamHeadline(int total, int needsYou)
    {
        if (total == 0) return "还没有人汇报在做什么。";
        return needsYou == 0
            ? $"{total} 个人都在推进，没有要你管的。"
            : $"{needsYou} 个人要你看一下，其余 {total - needsYou} 个正常。";
    }

    /// <summary>
    /// 团队视图的排序档。要你现在动手的在最前，其余按「需要知道的程度」递减。
    /// 抽成函数是因为它和 needsYou 必须对同一件事表态：卡住但没卡够时长的那档
    /// 既不计进「几个人要你看一下」，也不该顶到最上面。
    /// </summary>
    private static int TeamRowRank(TeamRow p) => p.Status switch
    {
        "blocked" => p.Escalated ? 0 : 2,   // 卡够了要你动手；刚卡住只是要你知道
        "empty" => 1,
        "running" => 3,
        _ => 4,                              // silent：还没说在做什么
    };

    private sealed class TeamRow
    {
        public string UserId { get; set; } = string.Empty;
        public string DisplayName { get; set; } = string.Empty;
        public string Status { get; set; } = string.Empty;
        public string Task { get; set; } = string.Empty;
        public int StandbyCount { get; set; }
        public string? AssignedByName { get; set; }
        public int BlockedSeconds { get; set; }

        /// <summary>卡够了配置的时长，该升到管理侧「需要你出手」了。只参与排序与计数，不上线。</summary>
        public bool Escalated { get; set; }
    }
}
