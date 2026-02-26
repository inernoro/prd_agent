namespace PrdAgent.Core.Models;

/// <summary>
/// 视频生成任务状态
/// </summary>
public static class VideoGenRunStatus
{
    /// <summary>文章已提交，等待分镜生成</summary>
    public const string Queued = "Queued";

    /// <summary>LLM 正在生成分镜脚本</summary>
    public const string Scripting = "Scripting";

    /// <summary>分镜已生成，用户编辑中（交互阶段）</summary>
    public const string Editing = "Editing";

    /// <summary>正在渲染视频（用户点击"导出"后触发）</summary>
    public const string Rendering = "Rendering";

    /// <summary>渲染完成</summary>
    public const string Completed = "Completed";

    /// <summary>任务失败</summary>
    public const string Failed = "Failed";

    /// <summary>用户取消</summary>
    public const string Cancelled = "Cancelled";
}

/// <summary>
/// 单个分镜的生成状态
/// </summary>
public static class SceneItemStatus
{
    public const string Draft = "Draft";
    public const string Generating = "Generating";
    public const string Done = "Done";
    public const string Error = "Error";
}

/// <summary>
/// 视频生成任务（MongoDB 文档模型）
/// 交互流程：文章输入 → 分镜生成(LLM) → 分镜编辑(用户) → 导出渲染(Remotion)
/// </summary>
public class VideoGenRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string AppKey { get; set; } = "video-agent";
    public string Status { get; set; } = VideoGenRunStatus.Queued;

    // ─── 输入 ───
    public string ArticleMarkdown { get; set; } = string.Empty;
    public string? ArticleTitle { get; set; }

    // ─── 配置（借鉴文学创作：系统提示词 + 风格参考） ───
    public string? SystemPrompt { get; set; }
    public string? StyleDescription { get; set; }

    // ─── 分镜列表 ───
    public List<VideoGenScene> Scenes { get; set; } = new();
    public double TotalDurationSeconds { get; set; }

    // ─── 渲染产出 ───
    public string? VideoAssetUrl { get; set; }
    public string? SrtContent { get; set; }
    public string? NarrationDoc { get; set; }
    public string? ScriptMarkdown { get; set; }

    // ─── 进度追踪 ───
    public string CurrentPhase { get; set; } = "scripting";
    public int PhaseProgress { get; set; }

    // ─── 元数据 ───
    public string OwnerAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public bool CancelRequested { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
}

/// <summary>
/// 视频场景（分镜）定义 — 每个分镜可独立编辑和重试
/// </summary>
public class VideoGenScene
{
    public int Index { get; set; }
    public string Topic { get; set; } = string.Empty;
    public string Narration { get; set; } = string.Empty;
    public string VisualDescription { get; set; } = string.Empty;
    public double DurationSeconds { get; set; }
    public string SceneType { get; set; } = "concept";

    /// <summary>分镜状态：Draft / Generating / Done / Error</summary>
    public string Status { get; set; } = SceneItemStatus.Draft;

    /// <summary>最近一次错误信息</summary>
    public string? ErrorMessage { get; set; }
}

/// <summary>
/// 创建视频生成任务请求
/// </summary>
public class CreateVideoGenRunRequest
{
    public string? ArticleMarkdown { get; set; }
    public string? ArticleTitle { get; set; }
    public string? SystemPrompt { get; set; }
    public string? StyleDescription { get; set; }
}

/// <summary>
/// 更新单个分镜请求
/// </summary>
public class UpdateVideoSceneRequest
{
    public string? Topic { get; set; }
    public string? Narration { get; set; }
    public string? VisualDescription { get; set; }
    public string? SceneType { get; set; }
}
