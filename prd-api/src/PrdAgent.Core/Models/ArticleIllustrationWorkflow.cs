namespace PrdAgent.Core.Models;

/// <summary>
/// 文章配图工作流（服务端状态机，作为前后端一致性的唯一来源）。
/// - phase 使用前端同款字符串：upload/editing/markers-generating/markers-generated/images-generating/images-generated
/// - history 仅用于 debug，不提供前端切换入口（由 ImageMasterWorkspace.ArticleWorkflowHistory 承载）
/// </summary>
public class ArticleIllustrationWorkflow
{
    /// <summary>
    /// 版本号：每次“提交型修改”（如重新上传文章、重新生成配图标记）都会 +1，并清空后续阶段数据。
    /// </summary>
    public int Version { get; set; } = 0;

    /// <summary>当前阶段（见类注释）</summary>
    public string Phase { get; set; } = "upload";

    /// <summary>标记列表（以生成/解析结果为准）</summary>
    public List<ArticleIllustrationMarker> Markers { get; set; } = new();

    /// <summary>预期图片数（一般等于 Markers.Count；在开始生图时写入）</summary>
    public int? ExpectedImageCount { get; set; }

    /// <summary>已生成图片数（服务端维护，便于前端直接展示进度）</summary>
    public int DoneImageCount { get; set; } = 0;

    /// <summary>
    /// 已完成图片映射：markerIndex(string) -> assetId
    /// - MongoDB 的 Dictionary key 以字符串存储更稳定
    /// </summary>
    public Dictionary<string, string> AssetIdByMarkerIndex { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class ArticleIllustrationMarker
{
    public int Index { get; set; }
    public string Text { get; set; } = string.Empty;
}

