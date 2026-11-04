using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Mcp;

/// <summary>短期文件上传凭证：不暴露原密钥，且只能用于签发时指定的一条上传路径。</summary>
public static class McpHostedSiteUploadTicket
{
    public const string Prefix = "sk-mcp-upload-";
    public const string Purpose = "PrdAgent.Mcp.HostedSiteUpload.v1";
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);
    private sealed record Grant(string ApiKey, string Path, string? Deployment, DateTime ExpiresAt);

    public static (string Token, DateTime ExpiresAt) Issue(
        IDataProtectionProvider provider, string apiKey, string? siteId = null, DateTime? now = null)
    {
        if (!apiKey.StartsWith("sk-ak-", StringComparison.Ordinal))
            throw new ArgumentException("上传凭证只能由智能体密钥签发");
        if (siteId != null && (siteId.Length == 0 || siteId.IndexOfAny(['/', '\\', '?', '#']) >= 0))
            throw new ArgumentException("站点标识无效");
        var path = siteId == null ? "/api/open/web-pages/upload" : $"/api/open/web-pages/pages/{siteId}/reupload";
        var expiresAt = (now ?? DateTime.UtcNow).Add(Lifetime);
        var grant = new Grant(apiKey, path, DeploymentScope.Current, expiresAt);
        return (Prefix + provider.CreateProtector(Purpose).Protect(JsonSerializer.Serialize(grant)), expiresAt);
    }

    /// <summary>只解出原 key；随后必须继续走正常 key 查找、撤销与当前权限核验，不能把凭证当身份。</summary>
    public static bool TryRead(IDataProtectionProvider provider, string token, string method,
        string path, out string apiKey, DateTime? now = null)
    {
        apiKey = string.Empty;
        if (!token.StartsWith(Prefix, StringComparison.Ordinal) || token.Length > 8192
            || !string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)) return false;
        try
        {
            var grant = JsonSerializer.Deserialize<Grant>(provider.CreateProtector(Purpose).Unprotect(token[Prefix.Length..]));
            if (grant == null || grant.ExpiresAt <= (now ?? DateTime.UtcNow)
                || !grant.ApiKey.StartsWith("sk-ak-", StringComparison.Ordinal)
                || !string.Equals(grant.Path, path.TrimEnd('/'), StringComparison.Ordinal)
                || !string.Equals(grant.Deployment, DeploymentScope.Current, StringComparison.Ordinal)) return false;
            apiKey = grant.ApiKey;
            return true;
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException) { return false; }
    }
}
