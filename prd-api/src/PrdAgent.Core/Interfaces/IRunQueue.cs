namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Run 队列（用于后台 worker claim）。\n
/// 生产建议 Redis list；测试可用内存实现。
/// </summary>
public interface IRunQueue
{
    Task EnqueueAsync(string kind, string runId, CancellationToken ct = default);
    Task<string?> DequeueAsync(string kind, TimeSpan timeout, CancellationToken ct = default);
}


