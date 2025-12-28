namespace PrdAgent.Core.Models;

/// <summary>
/// 生图任务（可断线继续执行；通过 runId 查询/续订阅）
/// </summary>
public class ImageGenRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerAdminId { get; set; } = string.Empty;

    public ImageGenRunStatus Status { get; set; } = ImageGenRunStatus.Queued;

    /// <summary>
    /// 可选：内部配置模型 ID（LLMModel.Id）。
    /// </summary>
    public string? ConfigModelId { get; set; }

    /// <summary>
    /// 平台 ID（LLMPlatform.Id）。
    /// </summary>
    public string? PlatformId { get; set; }

    /// <summary>
    /// 平台侧模型 ID（业务语义 modelId）。
    /// </summary>
    public string? ModelId { get; set; }

    public string Size { get; set; } = "1024x1024";

    /// <summary>
    /// b64_json | url
    /// </summary>
    public string ResponseFormat { get; set; } = "b64_json";

    public int MaxConcurrency { get; set; } = 3;

    /// <summary>
    /// 输入计划（prompt + count + size 覆盖）。
    /// 注意：输出图片内容（base64/url）不存这里，避免超过单文档大小限制。
    /// </summary>
    public List<ImageGenRunPlanItem> Items { get; set; } = new();

    public int Total { get; set; }
    public int Done { get; set; }
    public int Failed { get; set; }

    public bool CancelRequested { get; set; }

    /// <summary>
    /// 用于 SSE afterSeq 续传的单调递增序号（由服务端原子递增）。
    /// </summary>
    public long LastSeq { get; set; }

    /// <summary>
    /// 可选：幂等键（同一 Admin 下唯一，用于“重复点击创建 run”防抖）。
    /// </summary>
    public string? IdempotencyKey { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
}

public enum ImageGenRunStatus
{
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled
}

public class ImageGenRunPlanItem
{
    public string Prompt { get; set; } = string.Empty;
    public int Count { get; set; } = 1;
    public string? Size { get; set; }
}


