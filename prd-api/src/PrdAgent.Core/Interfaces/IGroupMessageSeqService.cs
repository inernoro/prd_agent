namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 群消息顺序号生成服务（每个 groupId 单调递增）。
/// </summary>
public interface IGroupMessageSeqService
{
    /// <summary>
    /// 获取并递增该群的下一个 seq（从 1 开始）。
    /// </summary>
    Task<long> NextAsync(string groupId, CancellationToken cancellationToken = default);
}


