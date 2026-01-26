using PrdAgent.Core.Interfaces;

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

    /// <summary>
    /// 模型解析类型（0=直连单模型, 1=默认模型池, 2=专属模型池）
    /// </summary>
    public ModelResolutionType? ModelResolutionType { get; set; }

    /// <summary>
    /// 模型池 ID（用于日志记录）
    /// </summary>
    public string? ModelGroupId { get; set; }

    /// <summary>
    /// 模型池名称（用于日志记录）
    /// </summary>
    public string? ModelGroupName { get; set; }

    /// <summary>
    /// 是否使用默认模型池（已废弃，请使用 ModelResolutionType）
    /// </summary>
    [Obsolete("请使用 ModelResolutionType 字段")]
    public bool? IsDefaultModelGroup { get; set; }

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

    // ---------------------------
    // 扩展：与业务场景绑定（可选）
    // ---------------------------

    /// <summary>
    /// AppCallerCode（如 "visual-agent.image::generation"）。
    /// 用于 SmartModelScheduler 获取模型池绑定、日志记录。
    /// 数据库字段名: "AppCallerCode"（已从旧字段 "Purpose" 迁移）
    /// </summary>
    public string? AppCallerCode { get; set; }

    /// <summary>
    /// 应用标识（如 "visual-agent", "literary-agent"）。
    /// 用于水印等功能的隔离。是 AppCallerCode 的前缀部分。
    /// </summary>
    public string? AppKey { get; set; }

    /// <summary>
    /// 可选：若该 run 由 ImageMaster Workspace 触发，则绑定 workspaceId。
    /// </summary>
    public string? WorkspaceId { get; set; }

    /// <summary>
    /// 可选：ImageMaster 场景下，要回填的画布元素 key（用于把生成结果写回 canvas payload）。
    /// </summary>
    public string? TargetCanvasKey { get; set; }

    /// <summary>
    /// 可选：ImageMaster 场景下，用于图生图的首帧资产 sha256（服务端读取，不依赖前端长连接）。
    /// </summary>
    public string? InitImageAssetSha256 { get; set; }

    /// <summary>
    /// 可选：ImageMaster 场景下，为了在“任务创建后即使前端关闭也能恢复占位”，服务端可写入占位位置信息。
    /// </summary>
    public double? TargetX { get; set; }
    public double? TargetY { get; set; }
    public double? TargetW { get; set; }
    public double? TargetH { get; set; }
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


