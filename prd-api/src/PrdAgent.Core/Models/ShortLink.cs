namespace PrdAgent.Core.Models;

/// <summary>
/// 统一短链路由表 — 将任意分享系统的资源映射成全局自增数字 ID。
/// 同一 (TargetType, TargetId) 始终对应同一个 Seq（创建时去重，并发由唯一索引兜底）。
/// </summary>
public class ShortLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>全局自增序号（唯一）。对外 URL 直接用这个数字。</summary>
    public long Seq { get; set; }

    /// <summary>目标分享系统类型，如 "web_page" / "workflow" / "defect" / "report" / "document_store"。</summary>
    public string TargetType { get; set; } = string.Empty;

    /// <summary>目标记录主键（通常是各 ShareLink 的 Token）。</summary>
    public string TargetId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 短链全局计数器 — 单条 Key="global" 文档原子 $inc。
/// </summary>
public class ShortLinkCounter
{
    /// <summary>计数器 Key（语义槽位预留：global / web_page 等）。</summary>
    public string Key { get; set; } = "global";

    /// <summary>当前最大 Seq。</summary>
    public long Seq { get; set; }
}

/// <summary>短链类型常量 — 避免硬编码字符串散落各处。</summary>
public static class ShortLinkTargetTypes
{
    public const string WebPage = "web_page";
    public const string Workflow = "workflow";
    public const string Defect = "defect";
    public const string Report = "report";
    public const string DocumentStore = "document_store";
    public const string Toolbox = "toolbox";
}
