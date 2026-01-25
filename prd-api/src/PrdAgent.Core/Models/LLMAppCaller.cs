namespace PrdAgent.Core.Models;

/// <summary>
/// LLM应用调用者 - 标识每个使用LLM能力的应用
/// </summary>
public class LLMAppCaller
{
    /// <summary>应用ID</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    
    /// <summary>应用标识码（如：chat.sendMessage, prd.analyze）</summary>
    public string AppCode { get; set; } = string.Empty;
    
    /// <summary>显示名称</summary>
    public string DisplayName { get; set; } = string.Empty;
    
    /// <summary>应用描述</summary>
    public string? Description { get; set; }
    
    /// <summary>期望的模型类型需求列表</summary>
    public List<AppModelRequirement> ModelRequirements { get; set; } = new();
    
    /// <summary>是否为自动注册（首次调用时自动创建）</summary>
    public bool IsAutoRegistered { get; set; } = false;
    
    /// <summary>是否为系统默认应用（true=可被初始化重载，false=用户自定义永久保留）</summary>
    public bool IsSystemDefault { get; set; } = false;
    
    /// <summary>总调用次数</summary>
    public long TotalCalls { get; set; } = 0;
    
    /// <summary>成功调用次数</summary>
    public long SuccessCalls { get; set; } = 0;
    
    /// <summary>失败调用次数</summary>
    public long FailedCalls { get; set; } = 0;
    
    /// <summary>最后调用时间</summary>
    public DateTime? LastCalledAt { get; set; }
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 应用的模型需求
/// </summary>
public class AppModelRequirement
{
    /// <summary>模型类型（chat/intent/vision/image-gen等）</summary>
    public string ModelType { get; set; } = string.Empty;

    /// <summary>用途说明（如：理解用户意图、生成图片）</summary>
    public string Purpose { get; set; } = string.Empty;

    /// <summary>绑定的模型分组ID列表（支持多个模型池，空列表表示使用该类型的默认分组）</summary>
    public List<string> ModelGroupIds { get; set; } = new();

    /// <summary>是否必需（false表示可选）</summary>
    public bool IsRequired { get; set; } = true;

    /// <summary>
    /// 兼容旧字段：单个模型分组ID（已废弃，请使用 ModelGroupIds）
    /// 读取时：优先使用 ModelGroupIds，如果为空则从此字段迁移
    /// 写入时：不再使用此字段
    /// </summary>
    [Obsolete("请使用 ModelGroupIds")]
    public string? ModelGroupId
    {
        get => ModelGroupIds.Count > 0 ? ModelGroupIds[0] : null;
        set
        {
            if (!string.IsNullOrEmpty(value) && !ModelGroupIds.Contains(value))
            {
                ModelGroupIds.Insert(0, value);
            }
        }
    }
}

/// <summary>
/// 模型类型常量
/// </summary>
public static class ModelTypes
{
    /// <summary>通用对话</summary>
    public const string Chat = "chat";
    
    /// <summary>快速意图识别</summary>
    public const string Intent = "intent";
    
    /// <summary>图片识别</summary>
    public const string Vision = "vision";
    
    /// <summary>图片生成</summary>
    public const string ImageGen = "generation";
    
    /// <summary>代码生成（预留）</summary>
    public const string Code = "code";
    
    /// <summary>长文本处理（预留）</summary>
    public const string LongContext = "long-context";
    
    /// <summary>向量嵌入（预留）</summary>
    public const string Embedding = "embedding";
    
    /// <summary>重排序（预留）</summary>
    public const string Rerank = "rerank";
    
    /// <summary>获取所有基础类型</summary>
    public static readonly string[] BaseTypes = { Chat, Intent, Vision, ImageGen };
    
    /// <summary>获取所有类型（包括扩展）</summary>
    public static readonly string[] AllTypes = { Chat, Intent, Vision, ImageGen, Code, LongContext, Embedding, Rerank };
}
