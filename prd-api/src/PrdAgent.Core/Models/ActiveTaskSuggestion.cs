namespace PrdAgent.Core.Models;

/// <summary>
/// 给某人的一条建议 —— 和「派活」是两码事，这个区分是本功能的核心。
///
/// 派活（<see cref="ActiveTaskEntry"/> 里 Source=assigned）：别人替你决定了你要做什么，
/// 直接进你的队列。所以它需要管理权限，也所以它带着派活人的名字。
///
/// 建议（本实体）：别人觉得你也许该做点什么，但决定权在你。任何人都能提，
/// 提了**不会**变成你的任务 —— 它躺在你的收件箱里，等你自己「吸取」。
/// 吸取是一次 LLM 整理：把几条零散的建议（可选叠加知识库里的上下文）拧成
/// 一条条可以动手做的事，再由你逐条勾选建进自己的队列。
///
/// 为什么不做成「派活但可拒绝」：那仍然默认对方替你排了队，拒绝要花力气。
/// 建议的默认态是「什么都没发生」，吸取才是那个花力气的动作 —— 力气花在
/// 「我决定要做」这一侧，才是对的。
/// </summary>
public class ActiveTaskSuggestion
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>建议给谁（收件人 UserId）</summary>
    public string TargetUserId { get; set; } = string.Empty;

    /// <summary>收件人显示名（冗余，列表免 N+1 查询）</summary>
    public string? TargetUserName { get; set; }

    /// <summary>谁提的</summary>
    public string FromUserId { get; set; } = string.Empty;

    /// <summary>提建议的人的显示名（冗余，同上；也用于「看得见是谁提的」）</summary>
    public string? FromUserName { get; set; }

    /// <summary>建议正文。不限格式 —— 一句话、一段话、一份清单都行，整理是吸取那一步的事。</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>状态：pending / absorbed / dismissed，取值见 <see cref="ActiveTaskSuggestionState"/></summary>
    public string State { get; set; } = ActiveTaskSuggestionState.Pending;

    /// <summary>吸取后生成了哪几条任务（回溯用：这条任务是从哪条建议长出来的）</summary>
    public List<string> AbsorbedTaskIds { get; set; } = new();

    /// <summary>被拿去涌现时生成的那棵树（同上，回溯用）</summary>
    public string? EmergenceTreeId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>吸取或者放下的时刻</summary>
    public DateTime? ResolvedAt { get; set; }
}

/// <summary>建议的状态。</summary>
public static class ActiveTaskSuggestionState
{
    /// <summary>还没处理</summary>
    public const string Pending = "pending";

    /// <summary>已经吸取成任务</summary>
    public const string Absorbed = "absorbed";

    /// <summary>看过了，不打算做</summary>
    public const string Dismissed = "dismissed";

    public static bool IsValid(string? v) => v is Pending or Absorbed or Dismissed;
}

/// <summary>
/// 吸取建议时的个人偏好 —— 主要是「上次引用了哪几个知识库」。
///
/// 存在服务端而不是浏览器里：换台电脑还得重选一遍，那就等于没记住。
/// 一人一行，Id 就是 UserId。
/// </summary>
public class ActiveTaskAbsorbPreference
{
    /// <summary>就是 UserId —— 一人一行，不另起主键</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>上次引用的知识库 Id</summary>
    public List<string> StoreIds { get; set; } = new();

    /// <summary>上次自己补的那句额外要求（比如「都拆成半天以内能做完的」）</summary>
    public string? ExtraHint { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
