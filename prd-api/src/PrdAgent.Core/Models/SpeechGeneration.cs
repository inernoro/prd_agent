using System.Text.Json.Serialization;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>仅保存当前环境的能力声明，凭据与地址仍由模型网关管理。</summary>
[AppOwnership("mcp-speech", "基础语音", IsPrimary = true)]
public sealed class SpeechSettings
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Environment { get; set; } = string.Empty;
    public long Revision { get; set; }
    public List<SpeechProfile> Profiles { get; set; } = new();
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class SpeechProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public bool Enabled { get; set; }
    public bool IsDefault { get; set; }
    public long Revision { get; set; }
    public string Protocol { get; set; } = "openai";
    /// <summary>网关 AppCaller 目录中的公开模型标识，不是供应商的型号或凭据。</summary>
    public string ModelPoolId { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    /// <summary>绑定具体账号/资源的网关Offering，避免同池不同资源误用音色。</summary>
    public string? OfferingId { get; set; }
    public List<SpeechVoice> Voices { get; set; } = new();
    public List<string> Formats { get; set; } = new() { "mp3" };
    public string DefaultVoiceId { get; set; } = string.Empty;
    public string DefaultFormat { get; set; } = "mp3";
    public int MaxTextChars { get; set; } = 2000;
    public double MinSpeed { get; set; } = 1;
    public double MaxSpeed { get; set; } = 1;
    public bool SupportsInstructions { get; set; }
    public bool SupportsEmotion { get; set; }
    public List<string> Emotions { get; set; } = new();
    /// <summary>平台额度按 Unicode 字符计，不等价于供应商计费量。</summary>
    public int DailyCharacterQuota { get; set; } = 20000;
    public int MaxConcurrentRuns { get; set; } = 2;
}

public sealed class SpeechVoice
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string> Languages { get; set; } = new();
    public string? PreviewUrl { get; set; }
}

public class SpeechOptions
{
    public string? ProfileId { get; set; }
    public long? ProfileRevision { get; set; }
    public string? VoiceId { get; set; }
    public string? Format { get; set; }
    public double? Speed { get; set; }
    public string? Instructions { get; set; }
    public string? Emotion { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class SpeechCreateRequest : SpeechOptions
{
    public string Text { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? PresetId { get; set; }
    public string? ClientRequestId { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class SpeechPresetRequest : SpeechOptions
{
    public string? Id { get; set; }
    public long? Revision { get; set; }
    public string Name { get; set; } = string.Empty;
}

[AppOwnership("mcp-speech", "基础语音", IsPrimary = true)]
public sealed class SpeechPreset : SpeechOptions
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    [JsonIgnore] public string OwnerUserId { get; set; } = string.Empty;
    public string Environment { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public long Revision { get; set; } = 1;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[AppOwnership("mcp-speech", "基础语音", IsPrimary = true)]
public sealed class SpeechRun : PrdAgent.Core.Interfaces.ITaskAuthorizedRun
{
    [JsonIgnore] public string? TaskPermitId { get; set; }
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    [JsonIgnore] public string OwnerUserId { get; set; } = string.Empty;
    [JsonIgnore] public string? AgentApiKeyId { get; set; }
    public string Environment { get; set; } = string.Empty;
    [JsonIgnore] public string? DeploymentSlug { get; set; }
    [JsonIgnore] public string? WorkerId { get; set; }
    [JsonIgnore] public DateTime? LeaseUntil { get; set; }
    [JsonIgnore] public string RequestFingerprint { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Text { get; set; } = string.Empty;
    public string Status { get; set; } = SpeechRunStatus.Queued;
    public string Stage { get; set; } = "排队等待生成";
    public string ProfileId { get; set; } = string.Empty;
    public string ProfileName { get; set; } = string.Empty;
    public long ProfileRevision { get; set; }
    [JsonIgnore] public SpeechProfile ProfileSnapshot { get; set; } = new();
    public string VoiceId { get; set; } = string.Empty;
    public string Format { get; set; } = "mp3";
    public double Speed { get; set; } = 1;
    public string? Instructions { get; set; }
    public string? Emotion { get; set; }
    public int CharacterCount { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
    public DateTime? UpstreamStartedAt { get; set; }
    public string? ActualModel { get; set; }
    public string? ActualPlatformName { get; set; }
    public string? OfferingId { get; set; }
    public string? LogId { get; set; }
    /// <summary>仅保存上游明确报告的用量；未提供时为null，不用本地字符数冒充。</summary>
    public Dictionary<string, long>? ProviderUsage { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public string? AssetId { get; set; }
    [JsonIgnore] public string? AssetKey { get; set; }
    [JsonIgnore] public string? AssetSha256 { get; set; }
    public string? Mime { get; set; }
    public long SizeBytes { get; set; }
    [JsonIgnore] public string? QuotaLedgerId { get; set; }
    [JsonIgnore] public bool QuotaReleased { get; set; }
    [JsonIgnore] public bool QuotaRefundRequested { get; set; }
}

public static class SpeechRunStatus
{
    public const string Queued = "queued";
    public const string Preparing = "preparing";
    public const string Generating = "generating";
    public const string Saving = "saving";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Unknown = "unknown";
    public static bool IsTerminal(string status) => status is Completed or Failed or Unknown;
}

/// <summary>每用户/环境/能力/UTC日的原子额度账本；以任务ID保证释放不会重复。</summary>
[AppOwnership("mcp-speech", "基础语音", IsPrimary = true)]
public sealed class SpeechQuotaLedger
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Day { get; set; } = string.Empty;
    public int Characters { get; set; }
    public int ActiveRuns { get; set; }
    public Dictionary<string, SpeechQuotaReservation> Reservations { get; set; } = new();
}

public sealed class SpeechQuotaReservation
{
    public string Day { get; set; } = string.Empty;
    public int Characters { get; set; }
    public bool Active { get; set; } = true;
    public bool Refunded { get; set; }
}
