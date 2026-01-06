namespace PrdAgent.Api.Models.Responses;

public class DesktopSkinsResponse
{
    public List<string> Skins { get; set; } = new();
}

public class AdminDesktopAssetSkinDto
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public bool Enabled { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class AdminDesktopAssetKeyDto
{
    public string Id { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class AdminDesktopAssetUploadResponse
{
    public string Skin { get; set; } = string.Empty; // "" 表示默认
    public string Key { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string Mime { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
}

/// <summary>
/// 资源矩阵行（带回退逻辑）：一个 key 对应多个皮肤的单元格
/// </summary>
public class AdminDesktopAssetMatrixRow
{
    public string? Id { get; set; } // DesktopAssetKey 的 ID（用于删除操作）
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty; // 显示名称
    public string Kind { get; set; } = string.Empty;
    public string? Description { get; set; }
    public bool Required { get; set; } // 是否为必需资源
    public Dictionary<string, AdminDesktopAssetCell> Cells { get; set; } = new();
}

/// <summary>
/// 单个资源单元格（某 key 在某 skin 下的资源）
/// </summary>
public class AdminDesktopAssetCell
{
    public string? Url { get; set; } // 用户会看到的 URL（可能是回退的）
    public bool Exists { get; set; } // 该 skin 下是否真实存在资源
    public bool IsFallback { get; set; } // 是否使用了回退逻辑
    public string? Mime { get; set; }
    public long? SizeBytes { get; set; }
}


