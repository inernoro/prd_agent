namespace PrdAgent.Core.Models;

/// <summary>
/// 苹果快捷指令模板（管理 iCloud 分享链接，供用户扫码安装）
/// </summary>
public class ShortcutTemplate
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模板名称（如"收藏到 PrdAgent"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>功能说明</summary>
    public string? Description { get; set; }

    /// <summary>iCloud 快捷指令分享链接</summary>
    public string ICloudUrl { get; set; } = string.Empty;

    /// <summary>版本号</summary>
    public string Version { get; set; } = "1.0";

    /// <summary>是否系统默认模板</summary>
    public bool IsDefault { get; set; } = false;

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>创建人（null = 系统级）</summary>
    public string? CreatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
