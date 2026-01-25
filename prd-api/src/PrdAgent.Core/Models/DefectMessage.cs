namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷对话消息（AI 审核过程中的对话记录）
/// </summary>
public class DefectMessage
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的缺陷 ID</summary>
    public string DefectId { get; set; } = string.Empty;

    /// <summary>消息序号（用于 SSE afterSeq 断线重连）</summary>
    public int Seq { get; set; }

    /// <summary>角色：user, assistant</summary>
    public string Role { get; set; } = "user";

    /// <summary>消息内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>本条消息携带的附件 ID 列表</summary>
    public List<string>? AttachmentIds { get; set; }

    /// <summary>AI 从该消息提取的字段</summary>
    public Dictionary<string, string>? ExtractedFields { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 消息角色常量
/// </summary>
public static class DefectMessageRole
{
    public const string User = "user";
    public const string Assistant = "assistant";
}
