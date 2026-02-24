namespace PrdAgent.Infrastructure.ModelPool.Models;

/// <summary>
/// 模型池调度策略类型
/// </summary>
public enum PoolStrategyType
{
    /// <summary>
    /// 默认型：选最优模型，请求失败直接返回错误
    /// </summary>
    FailFast = 0,

    /// <summary>
    /// 演示型：一次性请求所有模型，挑最快返回的成功结果
    /// </summary>
    Race = 1,

    /// <summary>
    /// 顺序型：按优先级依次请求，失败则顺延到下一个模型
    /// </summary>
    Sequential = 2,

    /// <summary>
    /// 轮询型：在健康模型间轮转，均匀分配负载
    /// </summary>
    RoundRobin = 3,

    /// <summary>
    /// 加权随机型：按优先级权重随机选择模型
    /// </summary>
    WeightedRandom = 4,

    /// <summary>
    /// 最低延迟型：跟踪平均延迟，总是选最快的模型
    /// </summary>
    LeastLatency = 5
}
