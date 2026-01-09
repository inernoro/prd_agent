using System.ComponentModel.DataAnnotations;

namespace PrdAgent.Api.Models.Requests;

public sealed class CreateOpenPlatformApiKeyRequest
{
    public string? Name { get; set; }

    /// <summary>
    /// 授权群组（至少 1 个）
    /// </summary>
    [Required]
    public List<string> GroupIds { get; set; } = new();

    public (bool ok, string? error) Validate()
    {
        if (GroupIds == null || GroupIds.Count == 0) return (false, "请选择至少 1 个授权群组");
        var cleaned = GroupIds
            .Select(x => (x ?? string.Empty).Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (cleaned.Count == 0) return (false, "请选择至少 1 个授权群组");
        GroupIds = cleaned;

        if (Name != null)
        {
            var n = Name.Trim();
            Name = string.IsNullOrWhiteSpace(n) ? null : n;
            if (Name != null && Name.Length > 64) return (false, "name 过长（<=64）");
        }

        return (true, null);
    }
}

public sealed class RevokeOpenPlatformApiKeyRequest
{
    // 预留：未来可支持“原因/备注”；目前按路径参数 revoke
}

