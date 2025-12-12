namespace PrdAgent.Core.Models;

/// <summary>
/// LLM配置实体
/// </summary>
public class LLMConfig
{
    /// <summary>配置ID</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>服务商名称 (Claude/OpenAI)</summary>
    public string Provider { get; set; } = "Claude";
    
    /// <summary>API Key（加密存储）</summary>
    public string ApiKeyEncrypted { get; set; } = string.Empty;
    
    /// <summary>模型名称</summary>
    public string Model { get; set; } = "claude-3-5-sonnet-20241022";
    
    /// <summary>API端点（可选，用于自定义代理）</summary>
    public string? ApiEndpoint { get; set; }
    
    /// <summary>最大输出Token数</summary>
    public int MaxTokens { get; set; } = 4096;
    
    /// <summary>温度参数</summary>
    public double Temperature { get; set; } = 0.7;
    
    /// <summary>Top P参数</summary>
    public double TopP { get; set; } = 0.95;
    
    /// <summary>每分钟请求限制</summary>
    public int RateLimitPerMinute { get; set; } = 60;
    
    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}