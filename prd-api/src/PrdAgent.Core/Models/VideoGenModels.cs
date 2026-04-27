namespace PrdAgent.Core.Models;

/// <summary>
/// 视频生成模式
/// - "direct"     ：一段 prompt 调 OpenRouter 一镜直出
/// - "storyboard" ：上传文章/PRD → LLM 拆分镜 → 用户编辑每镜 → 逐镜调 OpenRouter → ffmpeg concat 拼成完整视频
/// </summary>
public static class VideoGenMode
{
    public const string Direct = "direct";
    public const string Storyboard = "storyboard";
}

/// <summary>
/// 视频生成任务状态
/// </summary>
public static class VideoGenRunStatus
{
    /// <summary>用户已提交，等待 worker 拾取</summary>
    public const string Queued = "Queued";

    /// <summary>storyboard 模式：LLM 正在拆分镜</summary>
    public const string Scripting = "Scripting";

    /// <summary>storyboard 模式：分镜已生成，用户编辑中（可重设/调参/选模型）</summary>
    public const string Editing = "Editing";

    /// <summary>正在调 OpenRouter（direct 单镜，或 storyboard 逐镜并行 + ffmpeg concat）</summary>
    public const string Rendering = "Rendering";

    /// <summary>视频已就绪</summary>
    public const string Completed = "Completed";

    /// <summary>任务失败</summary>
    public const string Failed = "Failed";

    /// <summary>用户取消</summary>
    public const string Cancelled = "Cancelled";
}

/// <summary>
/// 单个分镜状态（storyboard 模式专属）
/// </summary>
public static class SceneItemStatus
{
    /// <summary>初始草稿（拆分镜后）</summary>
    public const string Draft = "Draft";

    /// <summary>LLM 重新生成 prompt 中</summary>
    public const string Generating = "Generating";

    /// <summary>OpenRouter 视频生成中</summary>
    public const string Rendering = "Rendering";

    /// <summary>视频已就绪</summary>
    public const string Done = "Done";

    /// <summary>失败</summary>
    public const string Error = "Error";
}

/// <summary>
/// storyboard 模式下的单个分镜（不含 Remotion 字段，单纯 prompt + OpenRouter 参数）
/// </summary>
public class VideoGenScene
{
    public int Index { get; set; }

    /// <summary>分镜标题（可选，给用户看）</summary>
    public string Topic { get; set; } = string.Empty;

    /// <summary>视频生成 prompt（喂给 OpenRouter）</summary>
    public string Prompt { get; set; } = string.Empty;

    /// <summary>分镜状态：Draft / Generating / Rendering / Done / Error</summary>
    public string Status { get; set; } = SceneItemStatus.Draft;

    /// <summary>错误消息（失败时填）</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>本镜使用的 OpenRouter 模型 id（留空 = 跟随 Run.DirectVideoModel）</summary>
    public string? Model { get; set; }

    /// <summary>本镜时长（秒，留空 = 跟随 Run.DirectDuration）</summary>
    public int? Duration { get; set; }

    /// <summary>本镜宽高比（留空 = 跟随 Run）</summary>
    public string? AspectRatio { get; set; }

    /// <summary>本镜分辨率（留空 = 跟随 Run）</summary>
    public string? Resolution { get; set; }

    /// <summary>本镜 OpenRouter jobId</summary>
    public string? JobId { get; set; }

    /// <summary>本镜成本（美元）</summary>
    public double? Cost { get; set; }

    /// <summary>本镜单段视频 URL（已下载到 COS）</summary>
    public string? VideoUrl { get; set; }
}

/// <summary>
/// 视频生成任务（MongoDB 文档模型）
///
/// 支持两种模式：
/// 1. direct: 一段 prompt 调 OpenRouter 一镜直出 → VideoAssetUrl
/// 2. storyboard: 文章 → LLM 拆分镜 → 用户编辑 → 逐镜 OpenRouter → ffmpeg concat → VideoAssetUrl
/// </summary>
public class VideoGenRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string AppKey { get; set; } = "video-agent";
    public string Status { get; set; } = VideoGenRunStatus.Queued;

    /// <summary>创作模式：direct（一镜直出）/ storyboard（拆分镜）</summary>
    public string Mode { get; set; } = VideoGenMode.Direct;

    // ─── 输入 ───

    /// <summary>direct 模式：用户的视频描述 prompt | storyboard 模式：从文档拼出来的 prompt（可选）</summary>
    public string DirectPrompt { get; set; } = string.Empty;

    /// <summary>storyboard 模式：原始文章/PRD markdown</summary>
    public string ArticleMarkdown { get; set; } = string.Empty;

    /// <summary>storyboard 模式：风格描述（统一所有分镜的视觉风格）</summary>
    public string? StyleDescription { get; set; }

    /// <summary>任务标题（可选，列表展示用）</summary>
    public string? ArticleTitle { get; set; }

    // ─── OpenRouter 默认参数（direct 直接用；storyboard 作为分镜默认值） ───

    public string? DirectVideoModel { get; set; }
    public string? DirectAspectRatio { get; set; }
    public string? DirectResolution { get; set; }
    public int? DirectDuration { get; set; }

    // ─── 调用结果 ───

    /// <summary>direct 模式：OpenRouter jobId（storyboard 模式分镜各自的 jobId 在 Scenes 里）</summary>
    public string? DirectVideoJobId { get; set; }

    /// <summary>累计成本（美元）</summary>
    public double? DirectVideoCost { get; set; }

    /// <summary>最终视频 URL（COS 公开链接）</summary>
    public string? VideoAssetUrl { get; set; }

    // ─── storyboard 模式：分镜列表 ───

    /// <summary>分镜列表（storyboard 模式专属，direct 模式为空）</summary>
    public List<VideoGenScene> Scenes { get; set; } = new();

    // ─── 进度追踪 ───

    public string CurrentPhase { get; set; } = "queued";
    public int PhaseProgress { get; set; }

    /// <summary>总时长（秒）</summary>
    public double TotalDurationSeconds { get; set; }

    // ─── 元数据 ───

    public string OwnerAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public bool CancelRequested { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
}

/// <summary>创建视频生成任务请求</summary>
public class CreateVideoGenRunRequest
{
    /// <summary>模式：direct / storyboard（默认 direct）</summary>
    public string? Mode { get; set; }

    /// <summary>direct 模式：用户 prompt（必填）</summary>
    public string? DirectPrompt { get; set; }

    /// <summary>storyboard 模式：文章/PRD 文本（必填）</summary>
    public string? ArticleMarkdown { get; set; }

    /// <summary>storyboard 模式：风格描述（可选）</summary>
    public string? StyleDescription { get; set; }

    /// <summary>任务标题（可选）</summary>
    public string? ArticleTitle { get; set; }

    public string? DirectVideoModel { get; set; }
    public string? DirectAspectRatio { get; set; }
    public string? DirectResolution { get; set; }
    public int? DirectDuration { get; set; }
}

/// <summary>更新分镜请求（storyboard 模式编辑）</summary>
public class UpdateVideoSceneRequest
{
    public string? Topic { get; set; }
    public string? Prompt { get; set; }
    public string? Model { get; set; }
    public int? Duration { get; set; }
    public string? AspectRatio { get; set; }
    public string? Resolution { get; set; }
}
