namespace PrdAgent.Core.Models;

/// <summary>
/// 模型调度器系统配置 - 单例配置
/// </summary>
public class ModelSchedulerConfig
{
    /// <summary>配置ID（固定为singleton）</summary>
    public string Id { get; set; } = "singleton";
    
    // ==================== 降权策略 ====================
    
    /// <summary>连续失败多少次标记为Degraded（默认1次）</summary>
    public int ConsecutiveFailuresToDegrade { get; set; } = 1;
    
    /// <summary>连续失败多少次标记为Unavailable（默认3次）</summary>
    public int ConsecutiveFailuresToUnavailable { get; set; } = 3;
    
    // ==================== 健康检查 ====================
    
    /// <summary>健康检查间隔（分钟，默认5分钟）</summary>
    public int HealthCheckIntervalMinutes { get; set; } = 5;
    
    /// <summary>健康检查超时（秒，默认10秒）</summary>
    public int HealthCheckTimeoutSeconds { get; set; } = 10;
    
    /// <summary>健康检查探测消息（默认"ping"）</summary>
    public string HealthCheckPrompt { get; set; } = "ping";
    
    // ==================== 恢复策略 ====================
    
    /// <summary>是否启用自动恢复（默认true）</summary>
    public bool AutoRecoveryEnabled { get; set; } = true;
    
    /// <summary>连续成功多少次才完全恢复（默认2次）</summary>
    public int RecoverySuccessThreshold { get; set; } = 2;
    
    // ==================== 统计配置 ====================
    
    /// <summary>统计窗口（分钟，用于计算成功率，默认60分钟）</summary>
    public int StatsWindowMinutes { get; set; } = 60;
    
    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
