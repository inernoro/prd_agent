namespace PrdAgent.Core.Models;

/// <summary>
/// 每用户「最近打开」台账（首页「继续上次」的唯一数据源）。
/// 用户打开视觉/文学工作区或工作流详情时 upsert 一条（UserId + AgentKey + EntityId 唯一）。
/// 不用实体上的全局时间戳（UpdatedAt / LastOpenedAt / LastExecutedAt）——那些字段
/// 任何成员编辑、定时任务自跑都会变，会把"别人/机器的活跃"顶进当前用户的继续上次。
/// </summary>
public class UserRecentOpen
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = string.Empty;

    /// <summary>visual-agent | literary-agent | workflow-agent</summary>
    public string AgentKey { get; set; } = string.Empty;

    /// <summary>实体 Id（工作区 / 工作流）</summary>
    public string EntityId { get; set; } = string.Empty;

    /// <summary>该用户最近一次打开时间</summary>
    public DateTime LastOpenedAt { get; set; } = DateTime.UtcNow;
}
