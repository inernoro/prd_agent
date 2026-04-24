namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库浏览事件（谁访问了知识库的哪篇文档、停留多久）。
///
/// 设计要点：
/// - 允许同一用户多次访问（每次都新建记录）
/// - 记录 EnteredAt + LeftAt + DurationMs，支持"退出时补时长"
/// - 仅 store owner 可以查看统计面板
/// - 匿名访问公开知识库时 ViewerUserId 为 null，用 SessionToken 区分不同访客
/// </summary>
public class DocumentStoreViewEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属知识库</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>被访问的条目（null 表示访问知识库首页而非某篇具体文档）</summary>
    public string? EntryId { get; set; }

    /// <summary>访问用户 ID（匿名访客为 null）</summary>
    public string? ViewerUserId { get; set; }

    /// <summary>访问用户显示名快照（匿名为 "匿名访客"）</summary>
    public string ViewerName { get; set; } = string.Empty;

    /// <summary>访问用户头像快照</summary>
    public string? ViewerAvatar { get; set; }

    /// <summary>匿名访客 session token（首次生成后存 sessionStorage，用于区分同日多次访问）</summary>
    public string? AnonSessionToken { get; set; }

    /// <summary>User-Agent（截断到 200 字符）</summary>
    public string? UserAgent { get; set; }

    /// <summary>Referer / 来源页面</summary>
    public string? Referer { get; set; }

    /// <summary>进入时间（UTC）</summary>
    public DateTime EnteredAt { get; set; } = DateTime.UtcNow;

    /// <summary>离开时间（由前端 leave 接口或心跳补写）</summary>
    public DateTime? LeftAt { get; set; }

    /// <summary>停留时长（毫秒）；未补写时为 null</summary>
    public long? DurationMs { get; set; }
}
