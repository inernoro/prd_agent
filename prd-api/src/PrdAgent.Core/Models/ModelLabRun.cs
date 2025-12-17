namespace PrdAgent.Core.Models;

/// <summary>
/// 大模型实验室 - 一次运行（对比/压测）
/// </summary>
public class ModelLabRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string OwnerAdminId { get; set; } = string.Empty;

    public string? ExperimentId { get; set; }

    public ModelLabSuite Suite { get; set; } = ModelLabSuite.Speed;

    public ModelLabRunStatus Status { get; set; } = ModelLabRunStatus.Running;

    public int RepeatN { get; set; } = 1;

    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? EndedAt { get; set; }
}

public enum ModelLabRunStatus
{
    Running,
    Completed,
    Failed,
    Cancelled
}


