using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Core.Models;

public class WritingIntentCoverage
{
    public int IntentIndex { get; set; }
    public List<string> ParagraphIds { get; set; } = new();
    public string ConfirmedContentHash { get; set; } = "";
    public bool Confirmed { get; set; }
}

public class WritingTemplateDocument
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string StoreId { get; set; } = "";
    public WritingTemplate Template { get; set; } = null!;
    public string CreatedBy { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class WritingDerivedView
{
    public string Summary { get; set; } = "";
    public List<string> Conclusions { get; set; } = new();
    public string ScopeIn { get; set; } = "";
    public string ScopeOut { get; set; } = "";
    public List<WritingRole> Roles { get; set; } = new();
}

public static class WritingDeliveryPolicy
{
    public const string ReconcileRunKind = "template-writing-reconcile";
    // Confirmation belongs to meaning-bearing content, not saves, timestamps, playback or checkbox order.
    public static string Fingerprint(WritingDocumentState state) => Hash(new {
        state.Title, state.Summary, state.ManualInput, state.TemplateId, state.TemplateVersion, state.TemplateSnapshot,
        state.IntentPoints, state.Conclusions, state.ScopeIn, state.ScopeOut, state.Roles,
        Sources = state.Sources.Select(s => new { s.Id, s.EntryId, s.Hash, s.Status }),
        Sections = state.Sections.Select(s => new { s.Id, s.Title, s.Condition, s.Detail,
            Paragraphs = s.Paragraphs.Select(p => new { p.Id, p.Text, p.Status, p.Citations,
                Quotes = p.Quotes.OrderBy(x => x.Key).ToDictionary(x => x.Key, x => x.Value) }) })
    });

    public static string Hash(object value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        JsonSerializer.Serialize(value, WritingDocumentPolicy.JsonOptions)))).ToLowerInvariant();

    public static bool IsConfirmed(WritingDocumentState state, int index)
    {
        var coverage = state.IntentCoverage.Where(c => c.IntentIndex == index).Take(2).ToList();
        if (coverage.Count != 1) return false;
        var item = coverage[0];
        var ids = state.Sections.SelectMany(s => s.Paragraphs).Where(p => !string.IsNullOrWhiteSpace(p.Text)).Select(p => p.Id).ToHashSet();
        return item.ParagraphIds.Count > 0 && item.ParagraphIds.All(ids.Contains)
            && item.ConfirmedContentHash == CoverageFingerprint(state, item);
    }

    public static List<string> SubmissionProblems(WritingDocumentState state)
    {
        if (state.IntentCoverage.GroupBy(c => c.IntentIndex).Any(g => g.Count() > 1)) return new() { "必达点位置重复，请重新整理" };
        return Enumerable.Range(0, state.IntentPoints.Count).Where(i => !IsConfirmed(state, i))
            .Select(i => $"第{i + 1}项作者必达点尚未核对承载位置").ToList();
    }

    public static void ConfirmIntent(WritingDocumentState state, int index)
    {
        if (index < 0 || index >= state.IntentPoints.Count) throw new InvalidOperationException("作者必达点不存在");
        var coverage = state.IntentCoverage.SingleOrDefault(c => c.IntentIndex == index);
        var ids = state.Sections.SelectMany(s => s.Paragraphs).Where(p => !string.IsNullOrWhiteSpace(p.Text)).Select(p => p.Id).ToHashSet();
        if (coverage == null || coverage.ParagraphIds.Count == 0 || coverage.ParagraphIds.Any(id => !ids.Contains(id)))
            throw new InvalidOperationException("此必达点尚未定位到正文，请先整理或补充内容");
        coverage.ConfirmedContentHash = CoverageFingerprint(state, coverage);
    }

    private static string CoverageFingerprint(WritingDocumentState state, WritingIntentCoverage coverage) => Hash(new {
        Content = Fingerprint(state), coverage.IntentIndex, coverage.ParagraphIds
    });

    public static void Refresh(WritingDocumentState state)
    {
        state.ContentFingerprint = Fingerprint(state);
        foreach (var coverage in state.IntentCoverage) coverage.Confirmed = IsConfirmed(state, coverage.IntentIndex);
    }

    public static WritingTemplate CopyTemplate(WritingTemplate template) => JsonSerializer.Deserialize<WritingTemplate>(
        JsonSerializer.Serialize(template, WritingDocumentPolicy.JsonOptions), WritingDocumentPolicy.JsonOptions)!;

    public static void ApplyReconciliation(WritingDocumentState state, WritingDocumentState generated)
    {
        var ids = state.Sections.SelectMany(s => s.Paragraphs).Where(p => !string.IsNullOrWhiteSpace(p.Text)).Select(p => p.Id).ToHashSet();
        if (generated.IntentCoverage.Select(c => c.IntentIndex).Distinct().Count() != generated.IntentCoverage.Count
            || generated.IntentCoverage.Any(c => c.IntentIndex < 0 || c.IntentIndex >= state.IntentPoints.Count || c.ParagraphIds.Any(id => !ids.Contains(id))))
            throw new InvalidOperationException("重点位置不能定位到当前正文，请重试整理");
        if (generated.Roles.Any(r => !state.Sections.Any(s => s.Id == r.SectionId)
            || r.OrderedSectionIds.Any(id => !state.Sections.Any(s => s.Id == id))))
            throw new InvalidOperationException("角色行动不能定位到当前章节，请重试整理");
        state.PreviousDerivedView = JsonSerializer.Deserialize<WritingDerivedView>(JsonSerializer.Serialize(new WritingDerivedView {
            Summary = state.Summary, Conclusions = state.Conclusions, ScopeIn = state.ScopeIn, ScopeOut = state.ScopeOut, Roles = state.Roles
        }, WritingDocumentPolicy.JsonOptions), WritingDocumentPolicy.JsonOptions);
        state.Summary = generated.Summary; state.Conclusions = generated.Conclusions;
        state.ScopeIn = generated.ScopeIn; state.ScopeOut = generated.ScopeOut; state.Roles = generated.Roles;
        state.IntentCoverage = generated.IntentCoverage.Select(c => new WritingIntentCoverage {
            IntentIndex = c.IntentIndex, ParagraphIds = c.ParagraphIds.Distinct().ToList()
        }).ToList();
        state.DerivedContentStale = false;
        Refresh(state);
    }

    public static WritingTemplate ImportTemplate(string id, string name, string markdown)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 80 || markdown.Length > 50000)
            throw new InvalidOperationException("模版名称需为1—80字，文件不得超过5万字");
        var headings = new List<WritingHeading>();
        foreach (var line in markdown.Replace("\r\n", "\n").Split('\n')) {
            if (line.StartsWith("## ", StringComparison.Ordinal)) headings.Add(new WritingHeading(line[3..].Trim(), ""));
            else if (headings.Count > 0 && !line.StartsWith('#') && !string.IsNullOrWhiteSpace(line)) {
                var hint = line.Trim().Replace("<!--", "").Replace("-->", "").Trim();
                var last = headings[^1]; headings[^1] = last with { Hint = string.Join("\n", new[] { last.Hint, hint }.Where(x => !string.IsNullOrEmpty(x))) };
            }
        }
        if (headings.Count is < 1 or > 30 || headings.Any(h => string.IsNullOrWhiteSpace(h.Title) || h.Title.Length > 100 || h.Hint.Length > 4000)
            || headings.Select(h => h.Title).Distinct().Count() != headings.Count)
            throw new InvalidOperationException("请用Markdown二级标题（## 章节名）定义1—30个不同章节，每章提示不超过4000字");
        return new WritingTemplate(id, name.Trim(), "文档", "member", "组织上传的写作模版", headings, Hash(new { name, headings })[..12]);
    }
}
