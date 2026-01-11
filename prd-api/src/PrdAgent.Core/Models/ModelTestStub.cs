namespace PrdAgent.Core.Models;

/// <summary>
/// 模型测试桩配置 - 用于模拟各种故障场景
/// </summary>
public class ModelTestStub
{
    public string Id { get; set; } = string.Empty;
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public FailureMode FailureMode { get; set; } = FailureMode.None;
    public int FailureRate { get; set; } = 0; // 0-100，表示失败概率
    public int LatencyMs { get; set; } = 0; // 额外延迟（毫秒）
    public string? ErrorMessage { get; set; }
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 故障模式
/// </summary>
public enum FailureMode
{
    /// <summary>
    /// 无故障（正常模式）
    /// </summary>
    None = 0,

    /// <summary>
    /// 随机失败（按 FailureRate 概率失败）
    /// </summary>
    Random = 1,

    /// <summary>
    /// 始终失败
    /// </summary>
    AlwaysFail = 2,

    /// <summary>
    /// 超时（模拟网络超时）
    /// </summary>
    Timeout = 3,

    /// <summary>
    /// 间歇性故障（每N次请求失败一次）
    /// </summary>
    Intermittent = 4,

    /// <summary>
    /// 慢响应（正常返回但延迟很高）
    /// </summary>
    SlowResponse = 5,

    /// <summary>
    /// 断线重连（模拟连接中断）
    /// </summary>
    ConnectionReset = 6
}
