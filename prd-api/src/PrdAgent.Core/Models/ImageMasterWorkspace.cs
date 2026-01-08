namespace PrdAgent.Core.Models;

using System.Text.Json.Serialization;

/// <summary>
/// 视觉创作 Workspace（用于“视觉创作 Agent”项目列表）。
/// - workspaceId 是该业务域稳定主键，用于替代易漂移的 sessionId。
/// - 支持最小共享：owner 或 member 可访问。
/// </summary>
public class ImageMasterWorkspace
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>创建者（OWNER，ADMIN userId）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    public string Title { get; set; } = "未命名";

    /// <summary>共享成员（ADMIN userId 列表）</summary>
    public List<string> MemberUserIds { get; set; } = new();

    /// <summary>列表封面（可选）：引用 ImageAsset.Id</summary>
    public string? CoverAssetId { get; set; }

    /// <summary>
    /// 列表封面拼贴（可选）：引用 ImageAsset.Id 列表（最多建议 6 张；前端可取前 4 张拼贴）。
    /// - 不会因编辑实时变化而变化（避免无意义刷新）
    /// - 仅在显式 refresh 时更新
    /// </summary>
    public List<string> CoverAssetIds { get; set; } = new();

    /// <summary>画布指纹（payloadJson 的稳定 hash；用于判断“画布是否真的变化”）</summary>
    public string? CanvasHash { get; set; }

    /// <summary>资产集合指纹（发生上传/删除等变化时刷新；无需扫描全量资产）</summary>
    public string? AssetsHash { get; set; }

    /// <summary>
    /// 内容指纹（CanvasHash + AssetsHash 的组合 hash）
    /// - 编辑只更新该值，不直接篡改封面
    /// </summary>
    public string? ContentHash { get; set; }

    /// <summary>封面指纹：该封面拼贴对应的 ContentHash（用于判断封面是否过期）</summary>
    public string? CoverHash { get; set; }

    public DateTime? CoverUpdatedAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? LastOpenedAt { get; set; }

    /// <summary>
    /// 视口偏好（按 ADMIN userId 存储）：用于保存"缩放比例/画布视角"等 UI 状态。
    /// - 注意：这是用户 UI 偏好，不应影响 workspace 的 UpdatedAt（避免列表排序抖动）。
    /// - 该字段不应直接下发给前端（会泄露共享成员的 UI 偏好）；由接口按当前登录用户挑选并返回。
    /// </summary>
    [JsonIgnore]
    public Dictionary<string, ImageMasterViewport> ViewportByUserId { get; set; } = new();

    /// <summary>场景类型：image-gen(原图片生成) | article-illustration(文章配图) | other(其他)</summary>
    public string ScenarioType { get; set; } = "image-gen";

    /// <summary>文章配图场景专用：原始文章内容(Markdown)</summary>
    public string? ArticleContent { get; set; }

    /// <summary>文章配图场景专用：LLM 生成的带配图标记的文章内容</summary>
    public string? ArticleContentWithMarkers { get; set; }

    /// <summary>
    /// 文章配图场景专用：服务端工作流状态（前后端一致性的唯一来源）
    /// </summary>
    public ArticleIllustrationWorkflow? ArticleWorkflow { get; set; }

    /// <summary>
    /// 文章配图场景专用：工作流历史快照（仅用于 debug/审计，不下发给前端）
    /// </summary>
    [JsonIgnore]
    public List<ArticleIllustrationWorkflow> ArticleWorkflowHistory { get; set; } = new();
}


