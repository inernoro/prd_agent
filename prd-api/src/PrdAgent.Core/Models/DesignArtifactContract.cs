using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace PrdAgent.Core.Models;

/// <summary>设计产物逻辑工作区引用；不保存对象存储物理 key。</summary>
public sealed class DesignArtifactWorkspaceRef
{
    public string WorkspaceId { get; set; } = string.Empty;

    public string Kind { get; set; } = string.Empty;

    public string? BaseRevision { get; set; }

    public string Adapter { get; set; } = string.Empty;
}

/// <summary>一次产物提交相对父版本的乐观锁边界。</summary>
public sealed class DesignArtifactVersionBoundary
{
    public string? BaseArtifactId { get; set; }

    public string? BaseVersion { get; set; }

    public string? BaseContentHash { get; set; }

    /// <summary>入口文件字节哈希；不能代表多文件产物。</summary>
    public string? EntryContentHash { get; set; }

    /// <summary>规范化 manifest 的哈希。</summary>
    public string? CanonicalManifestHash { get; set; }

    /// <summary>覆盖全部文件路径、哈希、大小与媒体类型的产物包哈希。</summary>
    public string? PackageHash { get; set; }

    /// <summary>旧客户端兼容字段；v2 中始终与 PackageHash 相同。</summary>
    public string? OutputContentHash { get; set; }
}

/// <summary>由 Provider 能力目录冻结到 Run 的执行组合；生命周期层不按产物名称硬编码实现方式。</summary>
public sealed class DesignArtifactCapabilitySnapshot
{
    public string CapabilityId { get; set; } = string.Empty;

    public string ArtifactType { get; set; } = string.Empty;

    public string Runtime { get; set; } = string.Empty;

    public string Adapter { get; set; } = string.Empty;

    public string WorkspaceKind { get; set; } = string.Empty;

    public string SecurityProfile { get; set; } = string.Empty;

    public List<string> Operations { get; set; } = new();

    public List<string> SourceSurfaces { get; set; } = new();
}

/// <summary>不含文件正文和物理存储地址的公共产物清单。</summary>
public sealed class DesignArtifactContractManifest
{
    public string SchemaVersion { get; set; } = DesignArtifactContractVersions.ManifestV1;

    public string ArtifactType { get; set; } = string.Empty;

    public string EntryFile { get; set; } = string.Empty;

    public string SecurityProfile { get; set; } = string.Empty;

    public List<DesignArtifactContractManifestFile> Files { get; set; } = new();
}

public sealed class DesignArtifactContractManifestFile
{
    public string Path { get; set; } = string.Empty;

    public long ByteLength { get; set; }

    public string Sha256 { get; set; } = string.Empty;

    public string MediaType { get; set; } = "application/octet-stream";
}

/// <summary>
/// 受信校验器对真实工作区字节的回执。调用方不能只靠自报 manifest 进入提交态。
/// </summary>
public sealed class DesignArtifactManifestValidationReceipt
{
    public string Validator { get; set; } = string.Empty;

    public string WorkspaceId { get; set; } = string.Empty;

    public string SecurityPolicyVersion { get; set; } = string.Empty;

    public string EntryContentHash { get; set; } = string.Empty;

    public string CanonicalManifestHash { get; set; } = string.Empty;

    public string PackageHash { get; set; } = string.Empty;

    /// <summary>受信工作区提交的原始包字节哈希；remote-package 必填。</summary>
    public string? SourcePackageHash { get; set; }

    /// <summary>受信工作区内原始 manifest 文件字节哈希；remote-package 必填。</summary>
    public string? SourceManifestHash { get; set; }

    public long TotalBytes { get; set; }

    public DateTime ValidatedAt { get; set; }
}

/// <summary>规划任务的最小持久输出事实。</summary>
public sealed class DesignArtifactPlanReceipt
{
    public string StorageReference { get; set; } = string.Empty;

    public string ContentHash { get; set; } = string.Empty;

    public string InputHash { get; set; } = string.Empty;
}

/// <summary>
/// 跨 adapter 的公共事件信封。正文、凭证和任意 payload 不属于此合同。
/// </summary>
public sealed class DesignArtifactEventEnvelope
{
    public string RunId { get; set; } = string.Empty;

    public string ArtifactType { get; set; } = string.Empty;

    public long Sequence { get; set; }

    public string Type { get; set; } = string.Empty;

    public string? Phase { get; set; }

    public int? Progress { get; set; }

    public DateTime OccurredAt { get; set; } = DateTime.UtcNow;

    public bool Authoritative { get; set; }
}

public static class DesignArtifactContractVersions
{
    public const int Legacy = 1;
    public const int Current = 2;
    public const string ManifestV1 = "design-artifact-manifest-v1";
}

public static class DesignArtifactWorkspaceKinds
{
    public const string RemotePackage = "remote-package";
    public const string AdapterOwned = "adapter-owned";
}

public static class DesignArtifactSecurityProfiles
{
    public const string WebPageRestricted = "web-page-restricted";
    public const string HtmlPptInteractive = "html-ppt-interactive";
}

public static class DesignArtifactLifecycleEventTypes
{
    public const string Run = "run";
    public const string Phase = "phase";
    public const string Delta = "delta";
    public const string Thinking = "thinking";
    public const string Manifest = "manifest";
    public const string CancelRequested = "cancel-requested";
    public const string Cancelled = "cancelled";
    public const string Recovered = "recovered";
    public const string Done = "done";
    public const string Error = "error";
    public const string Published = "published";
}

/// <summary>公开设计产物 revision 的唯一规范算法；内部 manifest 文件不属于公开产物内容。</summary>
public static class DesignArtifactPublicRevision
{
    public const string InternalManifestPath = "manifest.json";

    public static string Compute(IEnumerable<DesignArtifactPublicRevisionFile> files)
    {
        ArgumentNullException.ThrowIfNull(files);
        var canonical = new StringBuilder();
        foreach (var file in files
                     .Where(file => !string.Equals(file.Path, InternalManifestPath, StringComparison.Ordinal))
                     .OrderBy(file => file.Path, StringComparer.Ordinal))
        {
            foreach (var value in new[]
                     {
                         file.Path,
                         file.Sha256,
                         file.Size.ToString(System.Globalization.CultureInfo.InvariantCulture),
                         file.MediaType,
                     })
                canonical.Append(Encoding.UTF8.GetByteCount(value)).Append(':').Append(value);
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())))
            .ToLowerInvariant();
    }
}

/// <summary>Broker 与生命周期账本共用的公开产物路径判据。</summary>
public static class DesignArtifactPublicPath
{
    public const int MaxLength = 240;

    private static readonly HashSet<string> WindowsReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    public static bool TryNormalize(string? value, out string normalized)
    {
        normalized = string.Empty;
        if (string.IsNullOrEmpty(value)
            || value.Length > MaxLength
            || !string.Equals(value, value.Trim(), StringComparison.Ordinal)
            || !value.IsNormalized(NormalizationForm.FormC)
            || value.StartsWith("/", StringComparison.Ordinal)
            || value.Contains('\\')
            || value.Contains('?')
            || value.Contains('#')
            || value.Contains('%')
            || value.Contains(':')
            || value.Any(char.IsControl))
            return false;

        foreach (var segment in value.Split('/'))
        {
            if (segment is "" or "." or ".." || segment.EndsWith(' ') || segment.EndsWith('.'))
                return false;
            if (WindowsReservedNames.Contains(segment.Split('.')[0]))
                return false;
        }

        normalized = value;
        return true;
    }

    public static bool IsWebPageWorkspaceOutput(string normalized, bool includeInternalManifest)
    {
        var segments = normalized.Split('/');
        return normalized == "index.html"
               || includeInternalManifest && normalized == DesignArtifactPublicRevision.InternalManifestPath
               || segments.Length > 1 && segments[0] == "assets";
    }
}

public sealed record DesignArtifactPublicRevisionFile(
    string Path,
    string Sha256,
    long Size,
    string MediaType);
