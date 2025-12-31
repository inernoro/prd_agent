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

    /// <summary>
    /// 一次性分配“用户+AI”一问一答所需的两个 seq：
    /// - UserSeq 为奇数
    /// - AssistantSeq 为偶数（= UserSeq + 1）
    /// 要求该分配在并发场景下原子完成（避免跨用户交错导致奇偶错配）。
    /// </summary>
    Task<(long UserSeq, long AssistantSeq)> AllocatePairAsync(string groupId, CancellationToken cancellationToken = default);
}


