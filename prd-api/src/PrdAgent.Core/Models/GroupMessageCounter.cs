using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 群消息顺序号计数器（每个 groupId 一条记录，Mongo 原子自增）。
/// </summary>
[AppOwnership(AppNames.PrdAgent, AppNames.PrdAgentDisplay, IsPrimary = true)]
public class GroupMessageCounter
{
    /// <summary>群组ID（映射为 Mongo _id）</summary>
    public string GroupId { get; set; } = string.Empty;

    /// <summary>当前最大 seq</summary>
    public long Seq { get; set; }
}


