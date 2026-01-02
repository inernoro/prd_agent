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
    /// - UserSeq 先分配
    /// - AssistantSeq 后分配（= UserSeq + 1）
    /// 说明：这是历史兼容接口；新业务已改为分别调用 NextAsync 分配（User 到达服务器分配一次；AI 首字到达分配一次）。
    /// </summary>
    Task<(long UserSeq, long AssistantSeq)> AllocatePairAsync(string groupId, CancellationToken cancellationToken = default);
}


