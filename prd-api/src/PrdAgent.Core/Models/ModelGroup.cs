namespace PrdAgent.Core.Models;

/// <summary>
/// 模型分组 - 按模型类型组织的模型列表
/// </summary>
public class ModelGroup
{
    /// <summary>分组ID（UUID，唯一标识）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>分组名称（如：默认对话分组、快速意图分组）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>对外暴露的模型名字（允许重复，用于匹配调用方期望的模型）</summary>
    public string Code { get; set; } = string.Empty;

    /// <summary>优先级（数字越小优先级越高，默认50）</summary>
    public int Priority { get; set; } = 50;

    /// <summary>模型类型（chat/intent/vision/image-gen等）</summary>
    public string ModelType { get; set; } = string.Empty;

    /// <summary>是否为该类型的默认分组</summary>
    public bool IsDefaultForType { get; set; } = false;

    /// <summary>分组中的模型列表（按优先级排序）</summary>
    public List<ModelGroupItem> Models { get; set; } = new();

    /// <summary>分组描述</summary>
    public string? Description { get; set; }

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 分组中的模型项
/// </summary>
public class ModelGroupItem
{
    /// <summary>模型ID</summary>
    public string ModelId { get; set; } = string.Empty;
    
    /// <summary>平台ID</summary>
    public string PlatformId { get; set; } = string.Empty;
    
    /// <summary>组内优先级（越小越优先，从1开始）</summary>
    public int Priority { get; set; } = 1;
    
    /// <summary>健康状态</summary>
    public ModelHealthStatus HealthStatus { get; set; } = ModelHealthStatus.Healthy;
    
    /// <summary>最后失败时间</summary>
    public DateTime? LastFailedAt { get; set; }
    
    /// <summary>最后成功时间</summary>
    public DateTime? LastSuccessAt { get; set; }
    
    /// <summary>连续失败次数</summary>
    public int ConsecutiveFailures { get; set; } = 0;
    
    /// <summary>连续成功次数（用于恢复判断）</summary>
    public int ConsecutiveSuccesses { get; set; } = 0;

    /// <summary>
    /// 是否启用 Prompt Cache（模型池项级开关）
    /// - null: 使用全局配置（默认行为）
    /// - true: 强制启用
    /// - false: 强制禁用
    /// </summary>
    public bool? EnablePromptCache { get; set; }

    /// <summary>
    /// 最大输出 Token 数（透传到大模型请求的 max_tokens）
    /// - null: 使用服务端默认值（当前为 4096）
    /// </summary>
    public int? MaxTokens { get; set; }
}

/// <summary>
/// 模型健康状态
/// </summary>
public enum ModelHealthStatus
{
    /// <summary>健康</summary>
    Healthy = 0,
    
    /// <summary>降权（仍可用但优先级降低）</summary>
    Degraded = 1,
    
    /// <summary>不可用（暂时跳过）</summary>
    Unavailable = 2
}
