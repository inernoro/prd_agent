namespace PrdAgent.Core.Models;

/// <summary>
/// LLM模型实体
/// </summary>
public class LLMModel
{
    /// <summary>模型ID</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>模型显示名称 (如: GPT-4 Turbo)</summary>
    public string Name { get; set; } = string.Empty;
    
    /// <summary>模型ID/实际调用名 (如: gpt-4-turbo-preview)</summary>
    public string ModelName { get; set; } = string.Empty;
    
    /// <summary>API地址 (可继承自平台)</summary>
    public string? ApiUrl { get; set; }
    
    /// <summary>API密钥 (可继承自平台，加密存储)</summary>
    public string? ApiKeyEncrypted { get; set; }
    
    /// <summary>关联的平台ID (可选)</summary>
    public string? PlatformId { get; set; }
    
    /// <summary>分组名称 (用于界面分类展示)</summary>
    public string? Group { get; set; }
    
    /// <summary>超时时间毫秒 (默认360000=6分钟)</summary>
    public int Timeout { get; set; } = 360000;
    
    /// <summary>最大重试次数</summary>
    public int MaxRetries { get; set; } = 3;
    
    /// <summary>模型级最大并发数</summary>
    public int MaxConcurrency { get; set; } = 5;
    
    /// <summary>是否启用</summary>
    public bool Enabled { get; set; } = true;
    
    /// <summary>优先级 (数值越小越靠前)</summary>
    public int Priority { get; set; } = 100;
    
    /// <summary>是否为主模型 (全局唯一)</summary>
    public bool IsMain { get; set; } = false;
    
    /// <summary>备注</summary>
    public string? Remark { get; set; }
    
    /// <summary>调用次数</summary>
    public long CallCount { get; set; } = 0;
    
    /// <summary>总耗时(毫秒)</summary>
    public long TotalDuration { get; set; } = 0;
    
    /// <summary>成功次数</summary>
    public long SuccessCount { get; set; } = 0;
    
    /// <summary>失败次数</summary>
    public long FailCount { get; set; } = 0;
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

