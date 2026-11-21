using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.WebUtilities;

namespace PrdAgent.Api.Services;

public sealed record CdsDesignShareGrant(string Purpose, string Issuer, string AudienceOrigin, string ProjectId,
    string DesignId, string PreparationId, int Version, string SourceCommit, string PackageSha256, string PrototypeSha256,
    int ExpiresInHours, string Access, string SiteId, string RevisionId, string ApproverId, long Iat, long Exp)
{
    public string ApprovalId => "cds_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        JsonSerializer.Serialize(new[] { Issuer, ProjectId, DesignId, PreparationId })))).ToLowerInvariant();
}

public static class CdsDesignShareHandoff
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly Regex Digest = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex Commit = new("^[a-f0-9]{40}(?:[a-f0-9]{24})?$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex Id = new(@"\A[a-zA-Z0-9_.:-]+\z", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public static CdsDesignShareGrant? Read(string? grant, string mapUserId, IConfiguration config, DateTimeOffset now)
    {
        var issuer = config["CDS_DESIGN_MAP_HANDOFF_ISSUER"];
        var audience = config["CDS_DESIGN_MAP_HANDOFF_AUDIENCE"];
        var rawKey = config["CDS_DESIGN_MAP_HANDOFF_KEY"];
        if (grant == null || grant.Length is < 45 or > 4096 || rawKey?.Length != 43
            || !IsTrustedOrigin(issuer) || !IsTrustedOrigin(audience)) return null;
        var parts = grant.Split('.');
        if (parts.Length != 2 || parts[1].Length != 43) return null;
        try
        {
            var key = WebEncoders.Base64UrlDecode(rawKey);
            if (key.Length != 32 || WebEncoders.Base64UrlEncode(key) != rawKey) return null;
            var calculated = HMACSHA256.HashData(key, Encoding.ASCII.GetBytes(parts[0]));
            if (!CryptographicOperations.FixedTimeEquals(calculated, WebEncoders.Base64UrlDecode(parts[1]))) return null;
            var value = JsonSerializer.Deserialize<CdsDesignShareGrant>(WebEncoders.Base64UrlDecode(parts[0]), Json);
            var seconds = now.ToUnixTimeSeconds();
            if (value == null || value.Purpose != "cds-fixed-design-share" || value.Issuer != issuer || value.AudienceOrigin != audience
                || value.ApproverId != mapUserId || value.Iat < seconds - 300 || value.Iat > seconds + 15
                || value.Exp != value.Iat + 300 || value.Exp <= seconds || value.Version < 1
                || value.Access is not ("public" or "password") || value.ExpiresInHours is < 1 or > 8760
                || !Commit.IsMatch(value.SourceCommit ?? "") || !Digest.IsMatch(value.PackageSha256 ?? "")
                || !Digest.IsMatch(value.PrototypeSha256 ?? "") || !new[] { value.ProjectId, value.DesignId, value.PreparationId,
                    value.RevisionId, value.SiteId, value.ApproverId }.All(id => id is { Length: >= 1 and <= 200 }
                        && Id.IsMatch(id) && id is not ("." or "..")))
                return null;
            return value;
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException or JsonException)
        {
            return null;
        }
    }

    private static bool IsTrustedOrigin(string? value) => Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback))
        && uri.UserInfo.Length == 0 && uri.GetLeftPart(UriPartial.Authority) == value;
}
