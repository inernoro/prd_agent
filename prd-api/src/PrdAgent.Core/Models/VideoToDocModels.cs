namespace PrdAgent.Core.Models;

/// <summary>
/// 视频转文档任务状态
/// </summary>
public static class VideoToDocRunStatus
{
    /// <summary>视频已上传，等待处理</summary>
    public const string Queued = "Queued";

    /// <summary>正在提取音频和关键帧</summary>
    public const string Extracting = "Extracting";

    /// <summary>正在语音转文字</summary>
    public const string Transcribing = "Transcribing";

    /// <summary>正在用 LLM 分析帧+文字生成文档</summary>
    public const string Analyzing = "Analyzing";

    /// <summary>处理完成</summary>
    public const string Completed = "Completed";

    /// <summary>任务失败</summary>
    public const string Failed = "Failed";

    /// <summary>用户取消</summary>
    public const string Cancelled = "Cancelled";
}

/// <summary>
/// 视频转文档任务（MongoDB 文档模型）
/// 流程：上传视频 → 提取(FFmpeg) → 转写(STT) → 分析(LLM) → 输出 Markdown
/// </summary>
public class VideoToDocRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string AppKey { get; set; } = "video-agent";
    public string Status { get; set; } = VideoToDocRunStatus.Queued;

    // ─── 输入 ───
    /// <summary>上传视频的 URL（COS 或本地）</summary>
    public string VideoUrl { get; set; } = string.Empty;

    /// <summary>视频标题（可选）</summary>
    public string? VideoTitle { get; set; }

    /// <summary>视频时长（秒），提取阶段填充</summary>
    public double DurationSeconds { get; set; }

    /// <summary>用户自定义系统提示词</summary>
    public string? SystemPrompt { get; set; }

    /// <summary>目标文档语言（默认 "auto"，自动检测）</summary>
    public string Language { get; set; } = "auto";

    // ─── 中间产物 ───
    /// <summary>语音转写结果（带时间戳的 JSON 数组）</summary>
    public string? TranscriptJson { get; set; }

    /// <summary>检测到的语言</summary>
    public string? DetectedLanguage { get; set; }

    /// <summary>提取的关键帧信息（JSON 数组：[{timestamp, frameUrl}]）</summary>
    public string? KeyFramesJson { get; set; }

    /// <summary>提取的关键帧数量</summary>
    public int KeyFrameCount { get; set; }

    // ─── 输出 ───
    /// <summary>最终生成的 Markdown 文档</summary>
    public string? OutputMarkdown { get; set; }

    /// <summary>纯文本转写稿（无结构化，仅语音内容）</summary>
    public string? PlainTranscript { get; set; }

    // ─── 进度追踪 ───
    public string CurrentPhase { get; set; } = "queued";
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
/// 创建视频转文档任务请求
/// </summary>
public class CreateVideoToDocRunRequest
{
    /// <summary>视频 URL（已上传到 COS 的地址）</summary>
    public string? VideoUrl { get; set; }

    /// <summary>视频标题（可选）</summary>
    public string? VideoTitle { get; set; }

    /// <summary>自定义系统提示词（可选）</summary>
    public string? SystemPrompt { get; set; }

    /// <summary>目标语言（auto/zh/en，默认 auto）</summary>
    public string? Language { get; set; }
}
