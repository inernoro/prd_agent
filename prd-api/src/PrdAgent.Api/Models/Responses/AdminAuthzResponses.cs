using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Models.Responses;

public sealed class AdminAuthzMeResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }

    public bool IsRoot { get; set; }
    public string SystemRoleKey { get; set; } = string.Empty;
    public List<string> EffectivePermissions { get; set; } = new();
}

public sealed class SystemRoleDto
{
    public string Id { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string> Permissions { get; set; } = new();
    public bool IsBuiltIn { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? UpdatedBy { get; set; }
}

public sealed class UpsertSystemRoleRequest
{
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string>? Permissions { get; set; }
}

public sealed class UpdateUserAuthzRequest
{
    public string? SystemRoleKey { get; set; }
    public List<string>? PermAllow { get; set; }
    public List<string>? PermDeny { get; set; }
}

public sealed class AdminPermissionCatalogResponse
{
    public List<AdminPermissionDef> Items { get; set; } = new();
}

