namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 创建水印配置请求
/// </summary>
public class CreateWatermarkRequest
{
    public string? Name { get; set; }
    public string? Text { get; set; }
    public string? FontKey { get; set; }
    public double? FontSizePx { get; set; }
    public double? Opacity { get; set; }
    public string? PositionMode { get; set; }
    public string? Anchor { get; set; }
    public double? OffsetX { get; set; }
    public double? OffsetY { get; set; }
    public bool? IconEnabled { get; set; }
    public string? IconImageRef { get; set; }
    public bool? BorderEnabled { get; set; }
    public string? BorderColor { get; set; }
    public double? BorderWidth { get; set; }
    public bool? BackgroundEnabled { get; set; }
    public bool? RoundedBackgroundEnabled { get; set; }
    public double? CornerRadius { get; set; }
    public int? BaseCanvasWidth { get; set; }
    public string? TextColor { get; set; }
    public string? BackgroundColor { get; set; }
    public string? PreviewBackgroundImageRef { get; set; }
}

/// <summary>
/// 更新水印配置请求
/// </summary>
public class UpdateWatermarkRequest
{
    public string? Name { get; set; }
    public string? Text { get; set; }
    public string? FontKey { get; set; }
    public double? FontSizePx { get; set; }
    public double? Opacity { get; set; }
    public string? PositionMode { get; set; }
    public string? Anchor { get; set; }
    public double? OffsetX { get; set; }
    public double? OffsetY { get; set; }
    public bool? IconEnabled { get; set; }
    public string? IconImageRef { get; set; }
    public bool? BorderEnabled { get; set; }
    public string? BorderColor { get; set; }
    public double? BorderWidth { get; set; }
    public bool? BackgroundEnabled { get; set; }
    public bool? RoundedBackgroundEnabled { get; set; }
    public double? CornerRadius { get; set; }
    public int? BaseCanvasWidth { get; set; }
    public string? TextColor { get; set; }
    public string? BackgroundColor { get; set; }
    public string? PreviewBackgroundImageRef { get; set; }
}
