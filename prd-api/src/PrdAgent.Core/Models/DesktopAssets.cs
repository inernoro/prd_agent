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
/// Desktop 资源 key（仅元数据；Desktop 内置"需要的 key 清单"，此表用于后台管理与一致性校验）
/// </summary>
public class DesktopAssetKey
{
    public string Id { get; set; } = string.Empty; // Guid (N)
    public string Key { get; set; } = string.Empty; // 全小写（业务标识，不含扩展名，如 bg, login_icon, load）
    public string Kind { get; set; } = "image"; // image/audio/video/other
    public string? Description { get; set; }
    public string CreatedByAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// Desktop 实际资源记录（存储已上传的文件信息，包含皮肤维度）
/// </summary>
public class DesktopAsset
{
    public string Id { get; set; } = string.Empty; // Guid (N)
    public string Key { get; set; } = string.Empty; // 业务标识（不含扩展名），如 bg, login_icon
    public string? Skin { get; set; } // null=默认, "white", "dark" 等
    public string RelativePath { get; set; } = string.Empty; // 相对路径，如 icon/desktop/dark/bg.mp4
    public string Url { get; set; } = string.Empty; // 完整 URL
    public string Mime { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}


