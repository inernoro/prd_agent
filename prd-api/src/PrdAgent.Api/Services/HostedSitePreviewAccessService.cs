using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

public sealed record HostedSitePreviewTicket(
    string AccessId,
    string SiteId,
    string RevisionId,
    string UserId,
    string? DeploymentScope,
    string PackageFingerprint,
    DateTime ExpiresAt);

/// <summary>Issues a short-lived, revision-bound capability for a verified web package.</summary>
public sealed class HostedSitePreviewAccessService
{
    public const string ProtectorPurpose = "PrdAgent.HostedSite.VerifiedPreview.v1";
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);
    private const int MaxTicketLength = 8192;
    private readonly IDataProtector _protector;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public HostedSitePreviewAccessService(IDataProtectionProvider protectionProvider)
    {
        _protector = protectionProvider.CreateProtector(ProtectorPurpose);
    }

    public (string Ticket, DateTime ExpiresAt) Issue(
        HostedSiteRevision revision,
        string userId,
        DateTime? now = null)
    {
        var fingerprint = ComputePackageFingerprint(revision.VerifiedFiles);
        var expiresAt = (now ?? DateTime.UtcNow).Add(Lifetime);
        var payload = new HostedSitePreviewTicket(
            Guid.NewGuid().ToString("N"),
            revision.SiteId,
            revision.Id,
            userId,
            DeploymentScope.Current,
            fingerprint,
            expiresAt);
        return (_protector.Protect(JsonSerializer.Serialize(payload, JsonOptions)), expiresAt);
    }

    public bool TryRead(string? ticket, out HostedSitePreviewTicket payload, DateTime? now = null)
    {
        payload = null!;
        if (string.IsNullOrWhiteSpace(ticket) || ticket.Length > MaxTicketLength) return false;
        try
        {
            var value = JsonSerializer.Deserialize<HostedSitePreviewTicket>(
                _protector.Unprotect(ticket),
                JsonOptions);
            if (value == null
                || value.ExpiresAt <= (now ?? DateTime.UtcNow)
                || value.AccessId.Length != 32
                || string.IsNullOrWhiteSpace(value.SiteId)
                || string.IsNullOrWhiteSpace(value.RevisionId)
                || string.IsNullOrWhiteSpace(value.UserId)
                || value.PackageFingerprint.Length != 64
                || !string.Equals(value.DeploymentScope, DeploymentScope.Current, StringComparison.Ordinal))
                return false;
            payload = value;
            return true;
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        {
            return false;
        }
    }

    public static string ComputePackageFingerprint(IReadOnlyCollection<HostedSiteRevisionFile> files)
    {
        if (files.Count == 0) throw new InvalidOperationException("该版本没有完整资源包");
        using var aggregate = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hasEntry = false;
        foreach (var file in files.OrderBy(item => item.Path, StringComparer.Ordinal))
        {
            if (!DesignArtifactPublicPath.TryNormalize(file.Path, out var path)
                || !DesignArtifactPublicPath.IsWebPageWorkspaceOutput(path, includeInternalManifest: true)
                || !paths.Add(path)
                || file.Content.Length == 0
                || string.IsNullOrWhiteSpace(file.MimeType))
                throw new InvalidOperationException("版本资源包不完整");
            var actualHashBytes = SHA256.HashData(file.Content);
            byte[] declaredHashBytes;
            try
            {
                if (file.Sha256.Length != 64) throw new FormatException();
                declaredHashBytes = Convert.FromHexString(file.Sha256);
            }
            catch (FormatException)
            {
                throw new InvalidOperationException("版本资源包校验失败");
            }
            if (!CryptographicOperations.FixedTimeEquals(actualHashBytes, declaredHashBytes))
                throw new InvalidOperationException("版本资源包校验失败");
            var actualHash = Convert.ToHexString(actualHashBytes).ToLowerInvariant();
            hasEntry |= path == "index.html";
            aggregate.AppendData(Encoding.UTF8.GetBytes(path));
            aggregate.AppendData([0]);
            aggregate.AppendData(Encoding.ASCII.GetBytes(actualHash));
            aggregate.AppendData([0]);
            aggregate.AppendData(Encoding.UTF8.GetBytes(file.MimeType.ToLowerInvariant()));
            aggregate.AppendData([0]);
        }
        if (!hasEntry) throw new InvalidOperationException("版本资源包缺少 index.html");
        return Convert.ToHexString(aggregate.GetHashAndReset()).ToLowerInvariant();
    }

    public static bool HasValidContentHash(HostedSiteRevisionFile file)
    {
        if (file.Content.Length == 0 || file.Sha256.Length != 64) return false;
        try
        {
            return CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(file.Content),
                Convert.FromHexString(file.Sha256));
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
