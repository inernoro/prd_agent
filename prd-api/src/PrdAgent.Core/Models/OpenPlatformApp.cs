using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 开放平台应用代理模式
/// </summary>
public enum OpenPlatformProxyMode
{
    /// <summary>PRD 问答模式（默认）- 通过 model=prdagent 触发</summary>
    PrdAgent = 0,
    
    /// <summary>LLM 代理模式 - 直接转发到主模型</summary>
    LlmProxy = 1
}

/// <summary>
/// 开放平台应用实体
/// </summary>
[AppOwnership(AppNames.OpenPlatform, AppNames.OpenPlatformDisplay, IsPrimary = true)]
public class OpenPlatformApp
{
    /// <summary>应用唯一标识（Guid 字符串）</summary>
    public string Id { get; set; } = string.Empty;
    
    /// <summary>应用名称</summary>
    public string AppName { get; set; } = string.Empty;
    
    /// <summary>应用描述</summary>
    public string? Description { get; set; }
    
    /// <summary>绑定的用户 ID（必选）</summary>
    public string BoundUserId { get; set; } = string.Empty;
    
    /// <summary>绑定的群组 ID（可选）</summary>
    public string? BoundGroupId { get; set; }
    
    /// <summary>是否忽略外部请求中的系统提示词（role=system）。启用后将过滤外部 system 消息，强制使用内部配置的提示词（默认 true）</summary>
    public bool IgnoreUserSystemPrompt { get; set; } = true;
    
    /// <summary>是否禁用群上下文。禁用后不使用群历史对话上下文，仅使用用户传递的上下文，但保留系统提示词和 PRD（默认 true，即默认禁用群上下文）</summary>
    public bool DisableGroupContext { get; set; } = true;
    
    /// <summary>
    /// 对话系统提示词（可选）。
    /// - 非空字符串：使用该值作为系统提示词覆盖默认提示词，专门用于对话场景。
    /// - 空或 null：使用默认系统提示词（Markdown 格式输出）。
    /// 首次创建时，如果未提供，系统会自动填充默认对话提示词。
    /// </summary>
    public string? ConversationSystemPrompt { get; set; }
    
    /// <summary>API Key 哈希值（SHA256）</summary>
    public string ApiKeyHash { get; set; } = string.Empty;
    
    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>最后使用时间</summary>
    public DateTime? LastUsedAt { get; set; }
    
    /// <summary>总请求数</summary>
    public long TotalRequests { get; set; }
}
