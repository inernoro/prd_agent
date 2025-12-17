namespace PrdAgent.Core.Models;

/// <summary>
/// 大模型实验室 - 实验定义（Admin 侧）
/// </summary>
public class ModelLabExperiment
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    /// <summary>所属管理员（UserId）</summary>
    public string OwnerAdminId { get; set; } = string.Empty;

    public string Name { get; set; } = "未命名实验";

    public ModelLabSuite Suite { get; set; } = ModelLabSuite.Speed;

    /// <summary>本实验选择的模型（可含 platform 分组/自定义集合导入）</summary>
    public List<ModelLabSelectedModel> SelectedModels { get; set; } = new();

    /// <summary>内置模板 ID（可选）</summary>
    public string? PromptTemplateId { get; set; }

    /// <summary>本次实验默认 prompt（可选）</summary>
    public string? PromptText { get; set; }

    public ModelLabParams Params { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public enum ModelLabSuite
{
    /// <summary>速度/延迟（TTFT、总耗时）</summary>
    Speed,
    /// <summary>意图识别（固定 schema 输出）</summary>
    Intent,
    /// <summary>自定义</summary>
    Custom
}

public class ModelLabSelectedModel
{
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;

    /// <summary>管理后台里配置的展示名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>真实调用的模型名（如 gpt-5-fast / deepseek-v3.2）</summary>
    public string ModelName { get; set; } = string.Empty;

    /// <summary>平台可用模型列表的分组字段（如 qwen / deepseek）</summary>
    public string? Group { get; set; }
}

public class ModelLabParams
{
    public double Temperature { get; set; } = 0.2;
    public int? MaxTokens { get; set; }
    public int TimeoutMs { get; set; } = 60000;
    public int MaxConcurrency { get; set; } = 3;
    public int RepeatN { get; set; } = 1;
}


