namespace PrdAgent.Core.Models;

/// <summary>
/// LLM平台实体
/// </summary>
public class LLMPlatform
{
    /// <summary>平台ID</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>平台名称 (如: OpenAI官方、阿里云通义)</summary>
    public string Name { get; set; } = string.Empty;
    
    /// <summary>平台类型 (openai/anthropic/google/qwen/zhipu/baidu/other)</summary>
    public string PlatformType { get; set; } = "openai";

    /// <summary>
    /// ProviderId（用于“模型分组/能力规则”等 provider 级差异化逻辑）
    /// - 例如：silicon / aihubmix / dashscope
    /// - 为空时默认等同 PlatformType
    /// </summary>
    public string? ProviderId { get; set; }
    
    /// <summary>API基础地址</summary>
    public string ApiUrl { get; set; } = string.Empty;
    
    /// <summary>API密钥（加密存储）</summary>
    public string ApiKeyEncrypted { get; set; } = string.Empty;
    
    /// <summary>是否启用</summary>
    public bool Enabled { get; set; } = true;
    
    /// <summary>平台级最大并发数</summary>
    public int MaxConcurrency { get; set; } = 5;
    
    /// <summary>备注</summary>
    public string? Remark { get; set; }
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

