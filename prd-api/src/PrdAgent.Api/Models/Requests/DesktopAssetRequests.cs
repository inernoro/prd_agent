namespace PrdAgent.Api.Models.Requests;

public class AdminCreateDesktopAssetSkinRequest
{
    public string Name { get; set; } = string.Empty;
    public bool? Enabled { get; set; }
}

public class AdminUpdateDesktopAssetSkinRequest
{
    public bool? Enabled { get; set; }
}

public class AdminCreateDesktopAssetKeyRequest
{
    public string Key { get; set; } = string.Empty;
    public string Kind { get; set; } = "image";
    public string? Description { get; set; }
}



