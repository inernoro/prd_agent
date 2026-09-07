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

    public string? OutputContentHash { get; set; }
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
}

/// <summary>
/// 跨 adapter 的事件信封。Payload 属于内部事件流；公共只读 API 只返回信封元数据。
/// </summary>
public sealed class DesignArtifactEventEnvelope
{
    public string RunId { get; set; } = string.Empty;

    public string ArtifactType { get; set; } = string.Empty;

    public long Sequence { get; set; }

    public string Type { get; set; } = string.Empty;

    public string? Phase { get; set; }

    public int? Progress { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Payload { get; set; }

    public DateTime OccurredAt { get; set; } = DateTime.UtcNow;
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
    public const string Done = "done";
    public const string Error = "error";
    public const string Published = "published";
}
