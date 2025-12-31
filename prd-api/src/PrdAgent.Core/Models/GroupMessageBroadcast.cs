namespace PrdAgent.Core.Models;

/// <summary>
/// 群消息广播事件（用于 SSE 实时推送）。
/// </summary>
public class GroupMessageBroadcast
{
    public string GroupId { get; set; } = string.Empty;
    public long Seq { get; set; }
    public Message Message { get; set; } = new();
}


