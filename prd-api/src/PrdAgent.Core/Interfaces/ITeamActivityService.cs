namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 团队活动日志服务（可观察原则）—— 谁在什么时候对什么做了什么。
/// 写入永不抛出（失败仅告警），绝不让日志打断主业务。
/// </summary>
public interface ITeamActivityService
{
    /// <summary>记录一条团队活动（actor 的名称/头像由实现内部按 actorUserId 解析并快照）</summary>
    Task LogAsync(
        string teamId, string appKey, string actorUserId,
        string action, string targetType, string? targetId, string? targetTitle,
        CancellationToken ct = default);

    /// <summary>把同一动作记录到多个团队（内容分享到多团队时一次写入；actor 只解析一次）</summary>
    Task LogForTeamsAsync(
        IEnumerable<string> teamIds, string appKey, string actorUserId,
        string action, string targetType, string? targetId, string? targetTitle,
        CancellationToken ct = default);
}
