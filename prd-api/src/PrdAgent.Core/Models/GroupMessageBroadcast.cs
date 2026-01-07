namespace PrdAgent.Core.Models;

/// <summary>
/// 群消息广播事件（用于 SSE 实时推送）。
/// </summary>
public class GroupMessageBroadcast
{
    public string GroupId { get; set; } = string.Empty;
    public long Seq { get; set; }
    /// <summary>
    /// 事件类型：
    /// - message: 新增消息
    /// - messageUpdated: 更新（目前用于软删除广播）
    /// - delta: AI 流式输出的增量内容
    /// </summary>
    public string Type { get; set; } = "message";
    public Message? Message { get; set; }
    
    // Delta 事件专用字段
    public string? MessageId { get; set; }
    public string? DeltaContent { get; set; }
    public string? BlockId { get; set; }
    public bool IsFirstChunk { get; set; } // 标记是否为首个 chunk（用于隐藏加载动画）
}


