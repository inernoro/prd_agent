using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 作品投稿记录（用户公开展示的作品）
/// - 视觉创作：投稿单张图片（引用 ImageAsset）
/// - 文学创作：投稿文章配图作品（引用 Workspace）
/// </summary>
[AppOwnership(AppNames.VisualAgent, AppNames.VisualAgentDisplay)]
[AppOwnership(AppNames.LiteraryAgent, AppNames.LiteraryAgentDisplay)]
public class Submission
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>作品标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>作品类型：visual / literary</summary>
    public string ContentType { get; set; } = string.Empty;

    /// <summary>封面图 URL（用于展示卡片）</summary>
    public string CoverUrl { get; set; } = string.Empty;

    /// <summary>封面图宽度（用于瀑布流布局计算）</summary>
    public int CoverWidth { get; set; }

    /// <summary>封面图高度（用于瀑布流布局计算）</summary>
    public int CoverHeight { get; set; }

    /// <summary>来源 Workspace ID</summary>
    public string? WorkspaceId { get; set; }

    /// <summary>来源 ImageAsset ID（视觉创作场景）</summary>
    public string? ImageAssetId { get; set; }

    /// <summary>生成提示词（可选展示）</summary>
    public string? Prompt { get; set; }

    /// <summary>生成快照（完整输入配方：模型、提示词、参考图、水印等）</summary>
    public GenerationSnapshot? GenerationSnapshot { get; set; }

    /// <summary>作者用户 ID</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>作者显示名快照</summary>
    public string OwnerUserName { get; set; } = string.Empty;

    /// <summary>作者头像文件名快照</summary>
    public string? OwnerAvatarFileName { get; set; }

    /// <summary>点赞数（冗余计数，避免每次聚合查询）</summary>
    public int LikeCount { get; set; }

    /// <summary>浏览数</summary>
    public int ViewCount { get; set; }

    /// <summary>是否公开（用户可随时关闭）</summary>
    public bool IsPublic { get; set; } = true;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 作品点赞记录（一个用户对同一作品最多一条）
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay)]
/// <summary>
/// 生成快照 — 投稿创建时一次性采集的完整"配方"，用于详情展示和"做同款"复刻。
/// 设计原则：存储所有可能变或被删的输入源快照，不存二进制大数据。
/// </summary>
public class GenerationSnapshot
{
    // ── 模型 & 尺寸 ──
    /// <summary>LLM 配置模型 ID（内部，用于做同款时定位模型）</summary>
    public string? ConfigModelId { get; set; }
    /// <summary>模型显示名快照（如 "Nano Banana Pro"）</summary>
    public string? ModelName { get; set; }
    /// <summary>生成尺寸（如 "1024x1024"）</summary>
    public string? Size { get; set; }

    // ── 正文 Tab：提示词 ──
    /// <summary>用户输入的 prompt 文本</summary>
    public string? PromptText { get; set; }
    /// <summary>风格统一提示词（Workspace.StylePrompt）</summary>
    public string? StylePrompt { get; set; }

    // ── 提示词 Tab：系统提示词配置 ──
    /// <summary>系统提示词 ID（LiteraryPrompt.Id）</summary>
    public string? SystemPromptId { get; set; }
    /// <summary>系统提示词标题快照</summary>
    public string? SystemPromptTitle { get; set; }
    /// <summary>系统提示词内容快照（完整文本）</summary>
    public string? SystemPromptContent { get; set; }

    // ── 参考图 Tab ──
    /// <summary>是否使用了图生图（单图初始化）</summary>
    public bool HasReferenceImage { get; set; }
    /// <summary>参考图数量（含单图 + 多图）</summary>
    public int ReferenceImageCount { get; set; }
    /// <summary>单图初始化的参考图 URL</summary>
    public string? InitImageUrl { get; set; }
    /// <summary>多图参考列表（RefId, Url, Label, Role）</summary>
    public List<ImageRefSnapshot>? ImageRefs { get; set; }
    /// <summary>是否使用了涂抹（Inpainting）</summary>
    public bool HasInpainting { get; set; }
    /// <summary>参考图配置 ID（ReferenceImageConfig.Id）</summary>
    public string? ReferenceImageConfigId { get; set; }
    /// <summary>参考图配置名称快照</summary>
    public string? ReferenceImageConfigName { get; set; }

    // ── 水印 Tab ──
    /// <summary>水印配置 ID</summary>
    public string? WatermarkConfigId { get; set; }
    /// <summary>水印配置名称快照</summary>
    public string? WatermarkName { get; set; }
    /// <summary>水印文本快照</summary>
    public string? WatermarkText { get; set; }
    /// <summary>水印字体快照</summary>
    public string? WatermarkFontKey { get; set; }
    /// <summary>字体大小 (px)</summary>
    public double? WatermarkFontSizePx { get; set; }
    /// <summary>透明度 (0~1)</summary>
    public double? WatermarkOpacity { get; set; }
    /// <summary>锚点位置 (top-left / top-right / bottom-left / bottom-right)</summary>
    public string? WatermarkAnchor { get; set; }
    /// <summary>X 偏移</summary>
    public double? WatermarkOffsetX { get; set; }
    /// <summary>Y 偏移</summary>
    public double? WatermarkOffsetY { get; set; }
    /// <summary>定位模式 (pixel / ratio)</summary>
    public string? WatermarkPositionMode { get; set; }
    /// <summary>是否启用图标</summary>
    public bool? WatermarkIconEnabled { get; set; }
    /// <summary>是否启用边框</summary>
    public bool? WatermarkBorderEnabled { get; set; }
    /// <summary>是否启用背景</summary>
    public bool? WatermarkBackgroundEnabled { get; set; }
    /// <summary>是否启用圆角背景</summary>
    public bool? WatermarkRoundedBackgroundEnabled { get; set; }

    // ── 溯源 ──
    /// <summary>源 ImageGenRun.Id（内部追踪，不对外展示）</summary>
    public string? ImageGenRunId { get; set; }
    /// <summary>应用标识（如 visual-agent）</summary>
    public string? AppKey { get; set; }
    /// <summary>快照采集时间</summary>
    public DateTime? SnapshotAt { get; set; }
}

/// <summary>
/// 多图参考快照（从 ImageRefInput 提取的展示字段）
/// </summary>
public class ImageRefSnapshot
{
    public int RefId { get; set; }
    public string? Url { get; set; }
    public string? Label { get; set; }
    public string? Role { get; set; }
}

/// <summary>
/// 作品点赞记录（一个用户对同一作品最多一条）
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay)]
public class SubmissionLike
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的投稿作品 ID</summary>
    public string SubmissionId { get; set; } = string.Empty;

    /// <summary>点赞用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>点赞用户显示名快照</summary>
    public string UserName { get; set; } = string.Empty;

    /// <summary>点赞用户头像文件名快照</summary>
    public string? AvatarFileName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
