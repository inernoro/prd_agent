using System.Text.Json;
using System.Text.Json.Serialization;

namespace PrdAgent.Core.Models;

public class WritingTeaching
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string EntryId { get; set; } = "";
    public string StoreId { get; set; } = "";
    public string OwnerId { get; set; } = "";
    public string AuthorId { get; set; } = "";
    public string RequestFingerprint { get; set; } = "";
    public WritingPublication Source { get; set; } = new();
    public string SourceFingerprint { get; set; } = "";
    public string Instructions { get; set; } = "";
    public string ProfileId { get; set; } = "";
    public long ProfileRevision { get; set; }
    public string VoiceId { get; set; } = "";
    public string Status { get; set; } = "queued";
    public string Phase { get; set; } = "等待制作";
    public int Progress { get; set; }
    public long Revision { get; set; } = 1;
    public string ActiveRunId { get; set; } = "";
    [JsonIgnore] public string ExecutionId { get; set; } = "";
    public List<WritingTeachingScene> Scenes { get; set; } = new();
    public string? Failure { get; set; }
    public string ArtifactFingerprint { get; set; } = "";
    [JsonIgnore] public string LandscapeKey { get; set; } = "";
    [JsonIgnore] public string PortraitKey { get; set; } = "";
    [JsonIgnore] public string LandscapeSha256 { get; set; } = "";
    [JsonIgnore] public string PortraitSha256 { get; set; } = "";
    [JsonIgnore] public List<WritingTeachingAssetReceipt> AssetReceipts { get; set; } = new();
    public double Duration { get; set; }
    public string? ApprovedBy { get; set; }
    public DateTime? ApprovedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class WritingTeachingAssetReceipt
{
    public string Key { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public bool Portrait { get; set; }
}

public class WritingTeachingScene
{
    public string Id { get; set; } = "";
    public string SectionId { get; set; } = "";
    public List<string> ParagraphIds { get; set; } = new();
    public List<int> IntentIndexes { get; set; } = new();
    public string Title { get; set; } = "";
    public List<string> Highlights { get; set; } = new();
    public string Narration { get; set; } = "";
    public string Pace { get; set; } = "normal";
    public string? SpeechRunId { get; set; }
    public double Start { get; set; }
    public double Duration { get; set; }
}

public static class WritingTeachingPolicy
{
    public const string RunKind = "template-writing-teaching";
    public const int MaxScenes = 12;
    public const int FramesPerSecond = 30;
    public static string SourceFingerprint(WritingPublication source) => WritingDeliveryPolicy.Hash(new {
        source.Version, source.Title, source.Summary, source.TemplateId, source.TemplateVersion, source.TemplateSnapshot,
        source.IntentPoints, source.IntentCoverage, source.Conclusions, source.ScopeIn, source.ScopeOut, source.Roles,
        source.Sections, source.OpenQuestions, source.AuthorName, source.ReviewerId, source.ReviewerName,
        Sources = source.Sources.Select(s => new { s.Id, s.EntryId, s.Title, s.Content, s.Hash, s.Status, s.ReviewedHash })
    });
    public static WritingPublication Freeze(WritingPublication source) => JsonSerializer.Deserialize<WritingPublication>(JsonSerializer.Serialize(source, WritingDocumentPolicy.JsonOptions), WritingDocumentPolicy.JsonOptions)!;

    public static List<WritingTeachingScene> PrepareGeneratedScript(WritingPublication source, List<WritingTeachingScene> suggestions)
    {
        if (suggestions == null || suggestions.Any(s => s == null || s.ParagraphIds == null || s.IntentIndexes == null || s.Highlights == null))
            throw new InvalidOperationException("教学编排格式不完整，请恢复任务重新编排");
        var scenes = suggestions.Select(s => new WritingTeachingScene { Id = s.Id, SectionId = s.SectionId,
            ParagraphIds = s.ParagraphIds, IntentIndexes = s.IntentIndexes, Title = s.Title, Highlights = s.Highlights, Narration = s.Narration, Pace = s.Pace }).ToList();
        ValidateScript(source, scenes);
        return scenes;
    }

    public static void ValidateScript(WritingPublication source, List<WritingTeachingScene> scenes)
    {
        if (scenes.Count is < 1 or > MaxScenes || scenes.Select(s => s.Id).Distinct().Count() != scenes.Count)
            throw new InvalidOperationException("教学需有1—12个不同场景，请重新编排");
        var paragraphs = source.Sections.SelectMany(s => s.Paragraphs).Where(p => !string.IsNullOrWhiteSpace(p.Text)).ToDictionary(p => p.Id);
        foreach (var scene in scenes) {
            if (scene.Pace is not ("normal" or "slow") || string.IsNullOrWhiteSpace(scene.Id) || scene.Id.Length > 60 || !scene.Id.All(c => char.IsAsciiLetterOrDigit(c) || c == '-') || string.IsNullOrWhiteSpace(scene.Title) || scene.Title.Length > 40
                || string.IsNullOrWhiteSpace(scene.Narration) || scene.Narration.Length > 180
                || scene.Highlights.Count is < 1 or > 3 || scene.Highlights.Any(h => string.IsNullOrWhiteSpace(h) || h.Length > 60))
                throw new InvalidOperationException("场景标题、讲解重点或旁白超出可读上限，请重新编排");
            var section = source.Sections.SingleOrDefault(s => s.Id == scene.SectionId);
            if (section == null || scene.ParagraphIds.Count == 0
                || scene.ParagraphIds.Any(id => id == null || !paragraphs.ContainsKey(id) || !section.Paragraphs.Any(p => p.Id == id))
                || scene.IntentIndexes.Any(i => i < 0 || i >= source.IntentPoints.Count))
                throw new InvalidOperationException("教学场景不能定位到来源正文或作者重点");
            if (scene.ParagraphIds.Any(id => source.OpenQuestions.Any(q => q.ParagraphId == id)))
                throw new InvalidOperationException("教学涉及尚未确定的内容，请先解决开放问题后再制作");
        }
        for (var index = 0; index < source.IntentPoints.Count; index++) {
            var coverage = source.IntentCoverage.SingleOrDefault(c => c.IntentIndex == index);
            if (coverage == null || !coverage.Confirmed || !scenes.Any(s => s.IntentIndexes.Contains(index)
                && s.ParagraphIds.Any(coverage.ParagraphIds.Contains)))
                throw new InvalidOperationException($"第{index + 1}项作者重点尚未进入教学编排");
        }
    }

    public static void SetTiming(WritingTeaching teaching, IReadOnlyList<double> audioDurations)
    {
        if (audioDurations.Count != teaching.Scenes.Count || audioDurations.Any(d => !double.IsFinite(d) || d <= 0 || d > 180))
            throw new InvalidOperationException("旁白时长无效，不能生成教学时间轴");
        var cursor = 0d;
        for (var i = 0; i < teaching.Scenes.Count; i++) {
            var scene = teaching.Scenes[i]; scene.Start = cursor;
            scene.Duration = Math.Ceiling(audioDurations[i] * FramesPerSecond) / FramesPerSecond;
            cursor += scene.Duration;
        }
        teaching.Duration = cursor;
    }

    public static string ArtifactFingerprint(WritingTeaching teaching) => WritingDeliveryPolicy.Hash(new {
        teaching.SourceFingerprint, teaching.Scenes, teaching.LandscapeSha256, teaching.PortraitSha256, teaching.Duration,
        teaching.ProfileId, teaching.ProfileRevision, teaching.VoiceId
    });

    public static bool Matches(WritingTeaching teaching, WritingPublication source) => teaching.Source.Version == source.Version
        && teaching.SourceFingerprint == SourceFingerprint(source);
}
