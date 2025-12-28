namespace PrdAgent.Core.Models;

/// <summary>
/// 生图任务 - 事件日志（用于 SSE 断线续传）
/// </summary>
public class ImageGenRunEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerAdminId { get; set; } = string.Empty;

    public string RunId { get; set; } = string.Empty;

    /// <summary>
    /// 单调递增序号（afterSeq 续传）。
    /// </summary>
    public long Seq { get; set; }

    /// <summary>
    /// SSE event 名称（如 run / image）。
    /// </summary>
    public string EventName { get; set; } = "run";

    /// <summary>
    /// 事件 payload（JSON 字符串，camelCase）。
    /// </summary>
    public string PayloadJson { get; set; } = "{}";

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}


