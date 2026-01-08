namespace PrdAgent.Core.Models;

/// <summary>
/// 模型能力标记（用于分类/过滤/手动覆盖）
/// </summary>
public class LLMModelCapability
{
    /// <summary>能力类型：vision/embedding/rerank/function_calling/web_search/reasoning/free</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>来源：llm/user/system</summary>
    public string Source { get; set; } = string.Empty;

    /// <summary>该能力是否启用/命中</summary>
    public bool Value { get; set; }

    /// <summary>是否为用户手动选择（用于覆盖默认判断）</summary>
    public bool? IsUserSelected { get; set; }

    /// <summary>置信度（0-1，可选）</summary>
    public double? Confidence { get; set; }

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// LLM模型实体
/// </summary>
public class LLMModel
{
    /// <summary>模型ID（通过 IIdGenerator 生成）</summary>
    public string Id { get; set; } = string.Empty;
    
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

    /// <summary>
    /// 最大输出 Token 数（透传到大模型请求的 max_tokens/MaxTokens）
    /// - null 表示使用服务端默认值（当前为 4096）
    /// </summary>
    public int? MaxTokens { get; set; }
    
    /// <summary>是否启用</summary>
    public bool Enabled { get; set; } = true;
    
    /// <summary>优先级 (数值越小越靠前)</summary>
    public int Priority { get; set; } = 100;
    
    /// <summary>是否为主模型 (全局唯一)</summary>
    public bool IsMain { get; set; } = false;

    /// <summary>是否为意图模型 (全局唯一)</summary>
    public bool IsIntent { get; set; } = false;

    /// <summary>是否为图片识别模型 (全局唯一)</summary>
    public bool IsVision { get; set; } = false;

    /// <summary>是否为图片生成模型 (全局唯一)</summary>
    public bool IsImageGen { get; set; } = false;

    /// <summary>
    /// 模型能力（用于分类/过滤；可被用户覆盖）
    /// - source=llm：来自自动分类
    /// - source=user：来自人工覆盖
    /// </summary>
    public List<LLMModelCapability>? Capabilities { get; set; }

    /// <summary>
    /// 是否启用 Prompt Cache（模型级开关）
    /// - Claude: 启用后使用 anthropic prompt-caching（cache_control + beta header），可返回 cache read/create token 统计
    /// - OpenAI/兼容: 启用表示允许平台自动缓存；关闭时会注入最小 cache-bust 标记以避免命中缓存
    /// </summary>
    public bool? EnablePromptCache { get; set; } = true;
    
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

