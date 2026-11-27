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
    public string? BriefContentSource { get; set; }
    public string? BriefUserRequests { get; set; }
    public int? FilmTimeoutSeconds { get; set; }
}

public sealed class QuickCreationMedia
{
    public double DurationSec { get; set; }
    public bool HasAudio { get; set; }
    public bool CaptionsBurnedIn { get; set; }
    public List<QuickCreationCaption> Captions { get; set; } = new();
}

public sealed record QuickCreationCaption(double FromSec, double ToSec, string Text);
