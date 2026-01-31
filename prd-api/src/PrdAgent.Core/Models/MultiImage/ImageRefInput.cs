namespace PrdAgent.Core.Models.MultiImage;

/// <summary>
/// 前端传递的图片引用输入（对应前端 @imgN 标记）
/// </summary>
public class ImageRefInput
{
    /// <summary>
    /// 引用 ID，对应前端的 @img1, @img2 中的数字
    /// </summary>
    public int RefId { get; set; }

    /// <summary>
    /// 图片资产 SHA256（用于从 COS 读取原图）
    /// </summary>
    public string AssetSha256 { get; set; } = string.Empty;

    /// <summary>
    /// 图片 URL（展示用，或作为 AssetSha256 的备用）
    /// </summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// 用户给图片的标签/描述
    /// </summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>
    /// 可选：图片角色（由用户指定或 AI 推断）
    /// </summary>
    public string? Role { get; set; }
}

/// <summary>
/// 解析后的图片引用（包含加载的图片数据）
/// </summary>
public class ResolvedImageRef
{
    /// <summary>
    /// 引用 ID
    /// </summary>
    public int RefId { get; set; }

    /// <summary>
    /// 图片资产 SHA256
    /// </summary>
    public string AssetSha256 { get; set; } = string.Empty;

    /// <summary>
    /// 图片 URL
    /// </summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// 用户标签
    /// </summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>
    /// 图片角色
    /// </summary>
    public string? Role { get; set; }

    /// <summary>
    /// 加载的图片 Base64（data:mime;base64,... 格式）
    /// </summary>
    public string? ImageBase64 { get; set; }

    /// <summary>
    /// 在 prompt 中出现的顺序（0-based）
    /// </summary>
    public int OccurrenceOrder { get; set; }
}
