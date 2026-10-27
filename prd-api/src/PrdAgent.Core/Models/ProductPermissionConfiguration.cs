namespace PrdAgent.Core.Models;

/// <summary>产品管理独立权限快照；整本工作簿一次原子替换，不写MAP角色或其它应用授权。</summary>
public sealed class ProductPermissionConfiguration
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Revision { get; set; } = Guid.NewGuid().ToString("N");
    public List<ProductPermissionRow> Users { get; set; } = new();
    public string? PreviousRevision { get; set; }
    public List<ProductPermissionRow>? PreviousUsers { get; set; }
    public string UpdatedBy { get; set; } = string.Empty;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class ProductPermissionRow
{
    public string UserId { get; set; } = string.Empty;
    public List<string> Menus { get; set; } = new();
    public List<string> Permissions { get; set; } = new();
}

public sealed class ProductPermissionWorkbook
{
    public int SchemaVersion { get; set; } = 1;
    public string ExpectedRevision { get; set; } = string.Empty;
    public List<ProductPermissionSheet> Sheets { get; set; } = new();
}

public sealed class ProductPermissionSheet
{
    public string Menu { get; set; } = string.Empty;
    public List<ProductPermissionSheetRow> Rows { get; set; } = new();
}

public sealed class ProductPermissionSheetRow
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public bool Visible { get; set; }
    public Dictionary<string, bool> Functions { get; set; } = new();
}
