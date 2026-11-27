namespace PrdAgent.Core.Models;

/// <summary>服务端冻结的快捷创作参数，供恢复任务、追溯风格和回看资料使用。</summary>
public sealed class QuickCreationInput
{
    public string TemplateId { get; set; } = string.Empty;
    public string StyleSha256 { get; set; } = string.Empty;
    public string Ask { get; set; } = string.Empty;
    public List<string> AttachmentIds { get; set; } = new();
    public string? BriefId { get; set; }
    public int? BriefRevision { get; set; }
    public const string BriefUserRequestsPath = "brief/user-requests.txt";
    public const string WorkspaceRequestPath = "brief/creation-request.txt";
    public bool UseWorkspaceRequest { get; set; }
    public string? BriefContentSource { get; set; }
    public string? BriefUserRequests { get; set; }
    public int? FilmTimeoutSeconds { get; set; }
    public int? TargetDurationSec { get; set; }
    public int? DurationChoiceSec { get; set; }
    public int? PlannedScenes { get; set; }
    public bool BrowserFilm { get; set; }
    public bool Trial { get; set; }

    public QuickCreationInput ApproveTrial()
    {
        var resumed = (QuickCreationInput)MemberwiseClone();
        resumed.Trial = false;
        return resumed;
    }
}

public sealed class QuickCreationMedia
{
    public double DurationSec { get; set; }
    public bool HasAudio { get; set; }
    public long? BundleBytes { get; set; }
    public bool CaptionsBurnedIn { get; set; }
    public bool HasSubtitleFreePreview { get; set; }
    public List<QuickCreationCaption> Captions { get; set; } = new();
}

public sealed record QuickCreationCaption(double FromSec, double ToSec, string Text);

public sealed class QuickCreationBrowserExport
{
    public string Status { get; set; } = "queued";
    public DateTime QueuedAt { get; set; } = DateTime.UtcNow;
    public string? Lease { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public string? AssetKey { get; set; }
    public string? Error { get; set; }
}
