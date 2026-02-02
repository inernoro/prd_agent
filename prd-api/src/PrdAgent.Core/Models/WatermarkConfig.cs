namespace PrdAgent.Core.Models;

/// <summary>
/// 独立的水印配置文档，每条记录是一个完整的水印配置
/// </summary>
public class WatermarkConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 所有者用户ID
    /// </summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 配置名称
    /// </summary>
    public string Name { get; set; } = "默认水印";

    /// <summary>
    /// 关联的应用标识列表，如 ["literary-agent", "another-app"]
    /// </summary>
    public List<string> AppKeys { get; set; } = new();

    /// <summary>
    /// 水印文本
    /// </summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>
    /// 字体标识
    /// </summary>
    public string FontKey { get; set; } = string.Empty;

    /// <summary>
    /// 字号（像素）
    /// </summary>
    public double FontSizePx { get; set; }

    /// <summary>
    /// 透明度 (0-1)
    /// </summary>
    public double Opacity { get; set; }

    /// <summary>
    /// 定位模式: "pixel" 或 "ratio"
    /// </summary>
    public string PositionMode { get; set; } = "pixel";

    /// <summary>
    /// 锚点位置: "top-left", "top-right", "bottom-left", "bottom-right"
    /// </summary>
    public string Anchor { get; set; } = "bottom-right";

    /// <summary>
    /// X轴偏移
    /// </summary>
    public double OffsetX { get; set; } = 24;

    /// <summary>
    /// Y轴偏移
    /// </summary>
    public double OffsetY { get; set; } = 24;

    /// <summary>
    /// 是否启用图标
    /// </summary>
    public bool IconEnabled { get; set; }

    /// <summary>
    /// 图标图片引用URL
    /// </summary>
    public string? IconImageRef { get; set; }

    /// <summary>
    /// 是否启用边框
    /// </summary>
    public bool BorderEnabled { get; set; }

    /// <summary>
    /// 边框颜色
    /// </summary>
    public string? BorderColor { get; set; }

    /// <summary>
    /// 边框宽度（像素）
    /// </summary>
    public double BorderWidth { get; set; } = 2;

    /// <summary>
    /// 是否启用背景
    /// </summary>
    public bool BackgroundEnabled { get; set; }

    /// <summary>
    /// 是否启用圆角背景
    /// </summary>
    public bool RoundedBackgroundEnabled { get; set; }

    /// <summary>
    /// 圆角半径（像素），默认为0表示无圆角
    /// </summary>
    public double CornerRadius { get; set; }

    /// <summary>
    /// 基准画布宽度（用于响应式缩放）
    /// </summary>
    public int BaseCanvasWidth { get; set; }

    /// <summary>
    /// 文字颜色
    /// </summary>
    public string? TextColor { get; set; }

    /// <summary>
    /// 背景颜色
    /// </summary>
    public string? BackgroundColor { get; set; }

    /// <summary>
    /// 预览底图URL（用于渲染预览时的背景图）
    /// </summary>
    public string? PreviewBackgroundImageRef { get; set; }

    /// <summary>
    /// 预览图URL
    /// </summary>
    public string? PreviewUrl { get; set; }

    #region 海鲜市场（配置共享）

    /// <summary>是否公开到海鲜市场</summary>
    public bool IsPublic { get; set; }

    /// <summary>被下载次数（Fork 次数）</summary>
    public int ForkCount { get; set; }

    /// <summary>来源配置ID（如果是从海鲜市场下载的）</summary>
    public string? ForkedFromId { get; set; }

    /// <summary>来源用户ID</summary>
    public string? ForkedFromUserId { get; set; }

    /// <summary>来源用户名（冗余存储，方便展示）</summary>
    public string? ForkedFromUserName { get; set; }

    /// <summary>来源用户头像URL</summary>
    public string? ForkedFromUserAvatar { get; set; }

    /// <summary>下载后是否已修改（修改后清除来源标记）</summary>
    public bool IsModifiedAfterFork { get; set; }

    #endregion

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
