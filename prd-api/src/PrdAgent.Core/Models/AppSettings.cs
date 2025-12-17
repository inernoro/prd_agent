namespace PrdAgent.Core.Models;

/// <summary>
/// 全局应用配置（单例文档）
/// </summary>
public class AppSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    /// <summary>是否启用 Prompt Caching（关闭后将强制不使用缓存相关能力）</summary>
    public bool EnablePromptCache { get; set; } = true;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


