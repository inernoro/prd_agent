namespace PrdAgent.Core.Models;

/// <summary>
/// 一条工程债务在任务台里的落点。
///
/// 谁是 SSOT：**仓库**。债务的正文（是什么、现状、补的条件）跟代码同生共死 ——
/// 它引用文件路径、判据、事故日期，改代码的那个人顺手改它才对，git diff 是它天然的审阅面。
/// 所以正文这三个字段是仓库推过来的**快照**，每次同步整体覆盖，任务台不回写。
///
/// 那任务台存什么：仓库存不住的那一半 —— **这条债务现在归谁、什么状态、转成了哪条任务**。
/// 这半边放 Markdown 里必然过期，因为没人会为了改一个状态去提一个 commit。
///
/// 为什么不做双向同步：`doc/debt.platform.active-tasks.md` 第 6 条踩过同款坑
/// （「与 PmTask 不同步……不要提前做双向同步」）。单向推 + 一个反向链接就够了；
/// 两份都能写正文，就是 predicate-and-wiring-discipline 形状 3：同一件事两份判据，各自漂移。
/// </summary>
public class ActiveTaskDebt
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 稳定标识，形如 <c>platform.active-tasks#15</c> —— 台账文件名去掉 <c>debt.</c> 前缀和 <c>.md</c>，
    /// 加上表格里那个 <c>#</c> 号。唯一索引就建在它上面，同步靠它幂等。
    ///
    /// 用编号而不用标题做标识：标题会被改写（措辞优化、补充说明），编号不会 ——
    /// 台账里新增一条是追加一个新号，不是给旧行重新编号。
    /// </summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>台账模块，如 <c>platform.active-tasks</c>（= 文件名去掉 debt. 与 .md）</summary>
    public string Module { get; set; } = string.Empty;

    /// <summary>台账表格里的编号</summary>
    public int Num { get; set; }

    /// <summary>债务是什么（仓库快照）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>现状（仓库快照）</summary>
    public string? Status { get; set; }

    /// <summary>什么条件下该补（仓库快照）</summary>
    public string? CloseCondition { get; set; }

    /// <summary>台账文件在仓库里的路径，如 <c>doc/debt.platform.active-tasks.md</c></summary>
    public string SourcePath { get; set; } = string.Empty;

    /// <summary>归谁。null = 还没人认领 —— 这正是 Markdown 台账缺的那一格</summary>
    public string? OwnerUserId { get; set; }

    /// <summary>认领人显示名（冗余，列表免 N+1）</summary>
    public string? OwnerUserName { get; set; }

    /// <summary>open / claimed / converted / closed，取值见 <see cref="ActiveTaskDebtState"/></summary>
    public string State { get; set; } = ActiveTaskDebtState.Open;

    /// <summary>转成了哪几条任务（反向链接：从债务点得到任务，从任务查得回债务）</summary>
    public List<string> ConvertedTaskIds { get; set; } = new();

    /// <summary>最近一次被仓库同步覆盖正文的时刻。久未同步 = 台账那条可能已经被删了</summary>
    public DateTime SyncedAt { get; set; } = DateTime.UtcNow;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>债务在任务台里的状态。刻意只有四档，不做工作流。</summary>
public static class ActiveTaskDebtState
{
    /// <summary>躺在台账里，没人认领</summary>
    public const string Open = "open";

    /// <summary>有人认领了，但还没转成具体要做的事</summary>
    public const string Claimed = "claimed";

    /// <summary>已经转成任务队列里的一条或几条</summary>
    public const string Converted = "converted";

    /// <summary>补掉了 —— 但正文里那条是不是也删了，得看仓库，这里只记「任务台这侧认为它了了」</summary>
    public const string Closed = "closed";

    public static bool IsValid(string? v) => v is Open or Claimed or Converted or Closed;
}
