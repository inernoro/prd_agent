namespace PrdAgent.Core.Models;

/// <summary>
/// 视频渲染模式
/// - "remotion"（默认）：走现有分镜 → Remotion 合成的完整流程
/// - "videogen"：跳过分镜，直接走外部视频大模型（如 OpenRouter Seedance/Wan/Veo）
/// </summary>
public static class VideoRenderMode
{
    public const string Remotion = "remotion";
    public const string VideoGen = "videogen";
}

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

    // ─── 自动化控制 ───
    /// <summary>跳过 Editing 阶段，分镜生成后直接渲染（工作流胶囊使用）</summary>
    public bool AutoRender { get; set; }

    /// <summary>输出格式：mp4（默认）或 html</summary>
    public string OutputFormat { get; set; } = "mp4";

    // ─── TTS 配置 ───
    /// <summary>是否启用 TTS 语音生成</summary>
    public bool EnableTts { get; set; }

    /// <summary>TTS 声音 ID（用户可选，由平台决定可用值）</summary>
    public string? VoiceId { get; set; }

    // ─── 元数据 ───
    public string OwnerAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public bool CancelRequested { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }

    // ─── 渲染模式切换（2026-04 新增：支持直接走视频大模型） ───

    /// <summary>渲染模式：remotion（默认，分镜 + Remotion 合成）或 videogen（直接调 OpenRouter 视频模型）</summary>
    public string RenderMode { get; set; } = VideoRenderMode.Remotion;

    /// <summary>videogen 模式下的用户 prompt（取代 ArticleMarkdown）</summary>
    public string? DirectPrompt { get; set; }

    /// <summary>videogen 模式下选择的模型 id（如 alibaba/wan-2.6、bytedance/seedance-2.0）</summary>
    public string? DirectVideoModel { get; set; }

    /// <summary>videogen 模式下的宽高比：16:9 / 9:16 / 1:1 等</summary>
    public string? DirectAspectRatio { get; set; }

    /// <summary>videogen 模式下的时长（秒）</summary>
    public int? DirectDuration { get; set; }

    /// <summary>videogen 模式下的分辨率：480p/720p/1080p 等</summary>
    public string? DirectResolution { get; set; }

    /// <summary>OpenRouter 返回的 job id（用于轮询状态）</summary>
    public string? DirectVideoJobId { get; set; }

    /// <summary>videogen 任务生成成本（美元）</summary>
    public double? DirectVideoCost { get; set; }

    // ─── 分镜输入来源（2026-04 新增：支持 PRD 文档上传） ───

    /// <summary>输入来源类型：article（默认，技术文章）/ prd（PRD 文档，使用专用拆分镜 prompt）</summary>
    public string InputSourceType { get; set; } = VideoInputSourceType.Article;

    /// <summary>关联的附件 id 列表（PRD 模式下由附件 ExtractedText 拼接成 ArticleMarkdown）</summary>
    public List<string> AttachmentIds { get; set; } = new();
}

/// <summary>
/// 分镜输入来源类型
/// </summary>
public static class VideoInputSourceType
{
    /// <summary>技术文章 Markdown（默认，通用拆分镜 prompt）</summary>
    public const string Article = "article";

    /// <summary>PRD 文档（使用 PRD 专用拆分镜 prompt，强调产品价值 → 功能演示 → 用户体验）</summary>
    public const string Prd = "prd";
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

    // ─── 预览图（借鉴文学创作的 marker → image 模式） ───

    /// <summary>关联的 ImageGenRun ID</summary>
    public string? ImageGenRunId { get; set; }

    /// <summary>生成的预览视频 URL（Remotion 单场景渲染产物）</summary>
    public string? ImageUrl { get; set; }

    /// <summary>预览视频渲染状态：idle / running / done / error</summary>
    public string ImageStatus { get; set; } = "idle";

    // ─── AI 背景图（图生模型根据 VisualDescription 生成） ───

    /// <summary>AI 生成的背景图 URL</summary>
    public string? BackgroundImageUrl { get; set; }

    /// <summary>背景图生成状态：idle / running / done / error</summary>
    public string BackgroundImageStatus { get; set; } = "idle";

    // ─── TTS 语音（火山引擎 TTS 生成旁白音频） ───

    /// <summary>TTS 生成的音频文件 URL</summary>
    public string? AudioUrl { get; set; }

    /// <summary>TTS 音频生成状态：idle / running / done / error</summary>
    public string AudioStatus { get; set; } = "idle";

    /// <summary>TTS 音频生成错误信息</summary>
    public string? AudioErrorMessage { get; set; }

    // ─── LLM 场景代码生成（基于 Remotion 组件库为分镜生成定制化视觉代码） ───

    /// <summary>LLM 生成的 Remotion 场景代码（完整 .tsx 组件代码）</summary>
    public string? SceneCode { get; set; }

    /// <summary>场景代码生成状态：idle / running / done / error</summary>
    public string CodeStatus { get; set; } = "idle";

    // ─── 分镜级渲染模式覆盖（2026-04-26 新增：支持每个分镜独立选择 Remotion 或 直出） ───

    /// <summary>
    /// 单个分镜的渲染模式覆盖，null = 跟随 Run 的 RenderMode（默认）
    /// "remotion" = 走 Remotion 单场景渲染；"videogen" = 调 OpenRouter 视频大模型直接生成
    /// </summary>
    public string? RenderMode { get; set; }

    /// <summary>videogen 模式下的分镜专用 prompt（留空则用 VisualDescription + Narration 拼接）</summary>
    public string? DirectPrompt { get; set; }

    /// <summary>videogen 模式下选择的模型 id（留空 = 跟随 Run.DirectVideoModel）</summary>
    public string? DirectVideoModel { get; set; }

    /// <summary>videogen 模式下的宽高比（留空 = 跟随 Run）</summary>
    public string? DirectAspectRatio { get; set; }

    /// <summary>videogen 模式下的分辨率（留空 = 跟随 Run）</summary>
    public string? DirectResolution { get; set; }

    /// <summary>videogen 模式下的时长（秒，留空 = 跟随 Run，再留空 = 由场景 DurationSeconds 推导）</summary>
    public int? DirectDuration { get; set; }

    /// <summary>本次直出任务的 OpenRouter jobId（用于轮询和复盘）</summary>
    public string? DirectVideoJobId { get; set; }

    /// <summary>本次直出任务的成本（美元，OpenRouter 返回）</summary>
    public double? DirectVideoCost { get; set; }
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

    /// <summary>跳过 Editing 阶段，分镜生成后直接渲染（工作流胶囊使用）</summary>
    public bool AutoRender { get; set; }

    /// <summary>输出格式：mp4（默认）或 html</summary>
    public string OutputFormat { get; set; } = "mp4";

    /// <summary>是否启用 TTS 语音生成</summary>
    public bool EnableTts { get; set; }

    /// <summary>TTS 声音 ID</summary>
    public string? VoiceId { get; set; }

    // ─── 渲染模式切换（2026-04 新增：videogen 直出） ───

    /// <summary>渲染模式：remotion（默认）或 videogen（直接调外部视频模型）</summary>
    public string? RenderMode { get; set; }

    /// <summary>videogen 模式专用：用户 prompt</summary>
    public string? DirectPrompt { get; set; }

    /// <summary>videogen 模式专用：模型 id（默认 alibaba/wan-2.6，按秒计费最便宜）</summary>
    public string? DirectVideoModel { get; set; }

    /// <summary>videogen 模式专用：宽高比（16:9/9:16/1:1，默认 16:9）</summary>
    public string? DirectAspectRatio { get; set; }

    /// <summary>videogen 模式专用：时长（秒，默认 5）</summary>
    public int? DirectDuration { get; set; }

    /// <summary>videogen 模式专用：分辨率（720p/1080p，默认 720p）</summary>
    public string? DirectResolution { get; set; }

    // ─── 分镜输入来源（2026-04 新增：支持 PRD 文档上传） ───

    /// <summary>输入来源类型：article（默认）/ prd；prd 时允许仅传 attachmentIds，后端自动拼接 ExtractedText</summary>
    public string? InputSourceType { get; set; }

    /// <summary>关联的附件 id 列表（PRD 模式使用；PDF/Word/Markdown 等上传后 ExtractedText 已落库）</summary>
    public List<string>? AttachmentIds { get; set; }
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

    // ─── 分镜级渲染模式（2026-04-26 新增） ───

    /// <summary>渲染模式覆盖（"remotion" / "videogen" / 空字符串 = 清除覆盖跟随 Run）</summary>
    public string? RenderMode { get; set; }

    /// <summary>videogen 模式专用：分镜 prompt</summary>
    public string? DirectPrompt { get; set; }

    /// <summary>videogen 模式专用：模型 id</summary>
    public string? DirectVideoModel { get; set; }

    /// <summary>videogen 模式专用：宽高比</summary>
    public string? DirectAspectRatio { get; set; }

    /// <summary>videogen 模式专用：分辨率</summary>
    public string? DirectResolution { get; set; }

    /// <summary>videogen 模式专用：时长（秒）</summary>
    public int? DirectDuration { get; set; }
}

/// <summary>
/// 任务级渲染模式切换请求（影响所有"未明确覆盖"的分镜）
/// </summary>
public class UpdateRunRenderModeRequest
{
    /// <summary>新默认模式："remotion" 或 "videogen"</summary>
    public string Mode { get; set; } = VideoRenderMode.Remotion;

    /// <summary>true = 同时把所有分镜的 RenderMode 显式设为该模式（覆盖现有覆盖）；false = 只改默认，已覆盖的分镜保持不变</summary>
    public bool ApplyToAllScenes { get; set; }
}

/// <summary>
/// 更新分镜预览图 URL 请求
/// </summary>
public class UpdateScenePreviewRequest
{
    public string? ImageUrl { get; set; }
}
