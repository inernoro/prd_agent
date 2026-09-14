namespace PrdAgent.Core.Models;

/// <summary>
/// 活动任务清单 —— 「人」维度的动态任务条目。
///
/// 与既有任务实体的分工（不要再造第五张任务表）：
/// - <see cref="PmTask"/>   项目维度，必须挂 ProjectId，服务看板/甘特/里程碑。
/// - <see cref="PaTask"/>   个人助理维度，四象限，服务个人待办。
/// - <see cref="ChannelTask"/> 外部渠道进来的 Agent 指令任务，不是人的工作。
/// - 本实体              人维度，回答老板固定问的三件事：你此刻在做什么、做完接着做什么、走过哪些。
///
/// 它是「状态机 + 指针」而不是任务本体：来自缺陷池 / PmTask / 委派时，
/// SourceRefType + SourceRefId 指回源头，Title 冗余一份（匿名视图脱敏时不必回源查询）。
/// 之所以不复用 PmTask：大量真实占用（等灰度环境、帮同事看个 bug、临时插队）不属于任何项目，
/// 强塞 ProjectId 会逼出一堆假项目，反而污染看板。
/// </summary>
public class ActiveTaskEntry
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>归属人 UserId（这条任务是谁的活）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>归属人显示名（冗余，团队视图免 N+1 查询）</summary>
    public string? UserDisplayName { get; set; }

    /// <summary>任务标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>补充说明（为什么做这件 / 做到哪了）</summary>
    public string? Note { get; set; }

    /// <summary>状态：active / standby / done / dropped，取值见 <see cref="ActiveTaskState"/></summary>
    public string State { get; set; } = ActiveTaskState.Standby;

    /// <summary>备用队列内的排序键，越小越靠前（置顶 = 取当前最小值再减 1）</summary>
    public double OrderKey { get; set; }

    /// <summary>
    /// 什么时候要（可选）。
    ///
    /// 刻意是「截止」不是「预估耗时」：预估一旦存在，下一步必然长出估准度和超期判定，
    /// 那是考核。截止只回答一件事 —— 这件事排在什么时候之前做完，帮做事的人自己排序。
    /// 过期不报警、不算准时率，只在那一行淡淡标一下。
    /// </summary>
    public DateTime? DueAt { get; set; }

    /// <summary>本轮开始计时的时刻（仅 active 且未卡住时有值）</summary>
    public DateTime? StartedAt { get; set; }

    /// <summary>已累计投入秒数（跨多次启停累加，不含当前这一轮）</summary>
    public int AccumulatedSeconds { get; set; }

    /// <summary>是否卡住（在等人 / 等外部依赖）</summary>
    public bool Blocked { get; set; }

    /// <summary>卡住起始时刻</summary>
    public DateTime? BlockedSince { get; set; }

    /// <summary>在等谁、等什么 —— 标记卡住时必填，只说「卡住了」不算汇报</summary>
    public string? BlockedOn { get; set; }

    /// <summary>卡住累计秒数（历史里「空转」那一栏的来源）</summary>
    public int BlockedSeconds { get; set; }

    /// <summary>来源：manual / assigned / im_paste / defect / pm_task，取值见 <see cref="ActiveTaskSource"/></summary>
    public string Source { get; set; } = ActiveTaskSource.Manual;

    /// <summary>源头对象类型（defect / pm_task / ...），配合 SourceRefId 回溯</summary>
    public string? SourceRefType { get; set; }

    /// <summary>源头对象 ID</summary>
    public string? SourceRefId { get; set; }

    /// <summary>委派人 UserId（老板派的活；自己加的为 null）—— 「看得见委派的是谁」靠这个字段</summary>
    public string? AssignedBy { get; set; }

    /// <summary>委派人显示名（冗余）</summary>
    public string? AssignedByName { get; set; }

    /// <summary>委派时刻</summary>
    public DateTime? AssignedAt { get; set; }

    /// <summary>完成时刻</summary>
    public DateTime? DoneAt { get; set; }

    /// <summary>
    /// 结案说明 —— 「做成了什么样」。
    ///
    /// 这是结案与打勾的唯一区别：打勾只留下一个对号，一周后翻回来什么也看不出来。
    /// 这句话是老板要看的、写周报要抄的、下个人接手要读的那一句。
    /// 不强制填（逼着填会逼出「已完成」这种废话），但界面上它是结案时唯一的输入。
    /// </summary>
    public string? ClosingNote { get; set; }

    /// <summary>放弃原因（历史里保留放弃记录，不粉饰）</summary>
    public string? DropReason { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 截至 <paramref name="now"/> 的总投入秒数 = 已累计 + 当前这一轮。
    /// 卡住期间不计入投入（卡住的时间算空转，单独记在 <see cref="BlockedSeconds"/>）。
    /// 纯函数，便于单测。
    /// </summary>
    public int ElapsedSecondsAt(DateTime now)
    {
        var live = 0;
        if (State == ActiveTaskState.Active && !Blocked && StartedAt.HasValue)
        {
            var delta = (now - StartedAt.Value).TotalSeconds;
            if (delta > 0) live = (int)delta;
        }
        return AccumulatedSeconds + live;
    }

    /// <summary>截至 <paramref name="now"/> 的卡住秒数 = 已累计 + 当前这一轮。</summary>
    public int BlockedSecondsAt(DateTime now)
    {
        var live = 0;
        if (Blocked && BlockedSince.HasValue)
        {
            var delta = (now - BlockedSince.Value).TotalSeconds;
            if (delta > 0) live = (int)delta;
        }
        return BlockedSeconds + live;
    }

}

/// <summary>活动任务状态。</summary>
public static class ActiveTaskState
{
    /// <summary>此刻正在做 —— 每人同时只允许一条（WIP=1，多线程等于没有焦点）</summary>
    public const string Active = "active";

    /// <summary>备用队列（粮草）</summary>
    public const string Standby = "standby";

    /// <summary>已完成</summary>
    public const string Done = "done";

    /// <summary>中途放弃（历史里保留，不粉饰）</summary>
    public const string Dropped = "dropped";

    public static readonly string[] All = { Active, Standby, Done, Dropped };

    public static bool IsValid(string? v) => !string.IsNullOrEmpty(v) && Array.IndexOf(All, v) >= 0;
}

/// <summary>活动任务来源。</summary>
public static class ActiveTaskSource
{
    /// <summary>自己加的</summary>
    public const string Manual = "manual";

    /// <summary>老板委派</summary>
    public const string Assigned = "assigned";

    /// <summary>从聊天记录粘贴拆出来的</summary>
    public const string ImPaste = "im_paste";

    /// <summary>来自缺陷池</summary>
    public const string Defect = "defect";

    /// <summary>来自项目任务</summary>
    public const string PmTask = "pm_task";

    public static readonly string[] All = { Manual, Assigned, ImPaste, Defect, PmTask };

    public static bool IsValid(string? v) => !string.IsNullOrEmpty(v) && Array.IndexOf(All, v) >= 0;
}

/// <summary>
/// 活动任务面板设置（全局单行，Id 固定为 <see cref="SingletonId"/>）。
/// </summary>
public class ActiveTaskBoardSettings
{
    public const string SingletonId = "active-task-board";

    public string Id { get; set; } = SingletonId;

    /// <summary>匿名可见粒度：masked / full / headline，取值见 <see cref="AnonymousVisibility"/></summary>
    public string AnonymousMode { get; set; } = AnonymousVisibility.Masked;

    /// <summary>匿名面板是否开放（关掉则公开地址直接 404）</summary>
    public bool AnonymousEnabled { get; set; } = true;

    /// <summary>卡住多久自动升到老板的「需要你出手」（分钟）</summary>
    public int BlockedEscalateMinutes { get; set; } = 120;

    /// <summary>
    /// 堆到几件算「堆太多」，需要老板考虑分担。
    /// 只有这一个阈值 —— 另一端「没活了」是 0，不需要配。
    /// </summary>
    public int HeavyStackThreshold { get; set; } = 8;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string? UpdatedBy { get; set; }
}

/// <summary>匿名可见粒度。</summary>
public static class AnonymousVisibility
{
    /// <summary>脱敏：看得到谁在忙 / 谁卡住 / 谁没活 / 投入时长，看不到任务标题正文</summary>
    public const string Masked = "masked";

    /// <summary>全文：与登录员工看到的一致</summary>
    public const string Full = "full";

    /// <summary>仅头条结论与统计数字，不列人名</summary>
    public const string Headline = "headline";

    public static readonly string[] All = { Masked, Full, Headline };

    public static bool IsValid(string? v) => !string.IsNullOrEmpty(v) && Array.IndexOf(All, v) >= 0;
}
