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


