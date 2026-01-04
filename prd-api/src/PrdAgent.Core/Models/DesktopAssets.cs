namespace PrdAgent.Core.Models;

/// <summary>
/// Desktop 资源皮肤（仅元数据；具体文件落 COS）
/// </summary>
public class DesktopAssetSkin
{
    public string Id { get; set; } = string.Empty; // Guid (N)
    public string Name { get; set; } = string.Empty; // 全小写（目录名）
    public bool Enabled { get; set; } = true;
    public string CreatedByAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// Desktop 资源 key（仅元数据；Desktop 内置“需要的 key 清单”，此表用于后台管理与一致性校验）
/// </summary>
public class DesktopAssetKey
{
    public string Id { get; set; } = string.Empty; // Guid (N)
    public string Key { get; set; } = string.Empty; // 全小写（文件名或相对路径，如 load.gif / login/logo.svg）
    public string Kind { get; set; } = "image"; // image/audio/video/other
    public string? Description { get; set; }
    public string CreatedByAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}


