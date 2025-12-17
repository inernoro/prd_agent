namespace PrdAgent.Core.Models;

/// <summary>
/// 大模型实验室 - 某次运行中单个模型的结果
/// </summary>
public class ModelLabRunItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string OwnerAdminId { get; set; } = string.Empty;

    public string RunId { get; set; } = string.Empty;

    public string? ExperimentId { get; set; }

    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;

    public string DisplayName { get; set; } = string.Empty;
    public string ModelName { get; set; } = string.Empty;

    public long? TtftMs { get; set; }
    public long? TotalMs { get; set; }

    public bool Success { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }

    /// <summary>输出预览（避免存全量内容）</summary>
    public string? ResponsePreview { get; set; }

    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? FirstTokenAt { get; set; }
    public DateTime? EndedAt { get; set; }
}


