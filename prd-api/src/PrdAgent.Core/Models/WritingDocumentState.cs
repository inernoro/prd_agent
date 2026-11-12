using System.Text.Json;

namespace PrdAgent.Core.Models;

public class WritingDocumentState
{
    public int SchemaVersion { get; set; } = 1;
    public long Revision { get; set; } = 1;
    public string Stage { get; set; } = "select";
    public string TemplateId { get; set; } = "prd";
    public string TemplateVersion { get; set; } = "1.0";
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public string ManualInput { get; set; } = "";
    public string AuthorId { get; set; } = "";
    public string AuthorName { get; set; } = "";
    public string ReviewerId { get; set; } = "";
    public string ReviewerName { get; set; } = "";
    public string ScopeIn { get; set; } = "";
    public string ScopeOut { get; set; } = "";
    public List<string> Conclusions { get; set; } = new();
    public List<string> IntentPoints { get; set; } = new();
    public List<WritingSource> Sources { get; set; } = new();
    public List<WritingSection> Sections { get; set; } = new();
    public List<WritingQuestion> Questions { get; set; } = new();
    public List<WritingRole> Roles { get; set; } = new();
    public List<WritingChapter> Chapters { get; set; } = new();
    public List<WritingCaption> Captions { get; set; } = new();
    public string? VideoEntryId { get; set; }
    public string? ActiveRunId { get; set; }
    public string ActiveExecutionId { get; set; } = "";
    public string? Failure { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public WritingPublication? Published { get; set; }
}

public class WritingSource
{
    public string Id { get; set; } = "";
    public string EntryId { get; set; } = "";
    public string Title { get; set; } = "";
    public string Content { get; set; } = "";
    public string Hash { get; set; } = "";
    public string? ReviewedHash { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string Status { get; set; } = "read";
}
public class WritingSection
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public List<WritingParagraph> Paragraphs { get; set; } = new();
    public string Condition { get; set; } = "";
    public WritingSectionDetail? Detail { get; set; }
    public bool MetadataConfirmed { get; set; }
}
public class WritingSectionDetail
{
    public string Label { get; set; } = "";
    public List<List<string>> Rows { get; set; } = new();
}
public class WritingAnswerChoice
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Text { get; set; } = "";
}
public class WritingQuestionEvidence
{
    public string SourceId { get; set; } = "";
    public string Quote { get; set; } = "";
    public string Location { get; set; } = "";
}
public class WritingParagraph
{
    public string Id { get; set; } = "";
    public string Text { get; set; } = "";
    public string Status { get; set; } = "auth";
    public List<string> Citations { get; set; } = new();
    public Dictionary<string, string> Quotes { get; set; } = new();
    public bool Confirmed { get; set; }
}
public class WritingQuestion
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "ask";
    public string ParagraphId { get; set; } = "";
    public string SectionTitle { get; set; } = "";
    public string Title { get; set; } = "";
    public string Why { get; set; } = "";
    public List<string> Citations { get; set; } = new();
    public List<string> Options { get; set; } = new();
    public List<WritingAnswerChoice> Choices { get; set; } = new();
    public List<WritingQuestionEvidence> Evidence { get; set; } = new();
    public string Status { get; set; } = "pending";
    public string Answer { get; set; } = "";
}
public class WritingRole
{
    public string Label { get; set; } = "";
    public string Action { get; set; } = "";
    public string Condition { get; set; } = "";
    public string SectionId { get; set; } = "";
    public List<string> OrderedSectionIds { get; set; } = new();
}
public class WritingChapter
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public double Start { get; set; }
    public List<WritingTutorialStep> Steps { get; set; } = new();
}
public class WritingCaption
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Text { get; set; } = "";
    public double At { get; set; }
}
public class WritingTutorialStep
{
    public string Id { get; set; } = "";
    public string Text { get; set; } = "";
    public string Condition { get; set; } = "";
    public double At { get; set; }
}
public class WritingPublication
{
    public int Version { get; set; }
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public string TemplateId { get; set; } = "";
    public string TemplateVersion { get; set; } = "";
    public string AuthorName { get; set; } = "";
    public string ReviewerName { get; set; } = "";
    public string ReviewerId { get; set; } = "";
    public DateTime PublishedAt { get; set; }
    public List<string> Conclusions { get; set; } = new();
    public string ScopeIn { get; set; } = "";
    public string ScopeOut { get; set; } = "";
    public List<WritingSection> Sections { get; set; } = new();
    public List<WritingSource> Sources { get; set; } = new();
    public List<WritingQuestion> OpenQuestions { get; set; } = new();
    public List<WritingRole> Roles { get; set; } = new();
    public List<WritingChapter> Chapters { get; set; } = new();
    public List<WritingCaption> Captions { get; set; } = new();
    public string? VideoEntryId { get; set; }
}

public static class WritingDocumentPolicy
{
    public const string RunKind = "template-writing";
    public static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    public static List<string> SubmissionProblems(WritingDocumentState state)
    {
        var problems = new List<string>();
        if (string.IsNullOrWhiteSpace(state.Title)) problems.Add("请填写标题");
        if (state.Sections.Count == 0 || !state.Sections.SelectMany(s => s.Paragraphs).Any(p => !string.IsNullOrWhiteSpace(p.Text))) problems.Add("请填写正文");
        if (state.Questions.Any(q => q.Status == "pending") || state.Sections.SelectMany(s => s.Paragraphs).Any(p => p.Status is "ask" or "conf")) problems.Add("还有未处理的确认事项");
        var sourceIds = state.Sources.Where(s => s.Status == "read").Select(s => s.Id).ToHashSet();
        if (state.Sections.SelectMany(s => s.Paragraphs).Any(p => p.Citations.Any(c => !sourceIds.Contains(c)))) problems.Add("存在失效的引用");
        if (state.Sections.SelectMany(s => s.Paragraphs).Any(p => p.Status is "auth" or "src" && !p.Confirmed)) problems.Add("还有正文段落未过目，请核对引用、数字与适用条件");
        if (state.Sections.Any(s => (!string.IsNullOrWhiteSpace(s.Condition) || s.Detail?.Rows.Count > 0) && !s.MetadataConfirmed))
            problems.Add("还有小节条件与细节未过目，请逐项核对");
        if (string.IsNullOrWhiteSpace(state.ReviewerId)) problems.Add("请设置审核人");
        return problems;
    }
    public static void Answer(WritingDocumentState state, string questionId, string answer, bool open)
    {
        var q = state.Questions.SingleOrDefault(q => q.Id == questionId) ?? throw new InvalidOperationException("确认事项不存在");
        if (string.IsNullOrWhiteSpace(answer)) throw new InvalidOperationException("请填写回答或开放问题");
        q.Answer = answer.Trim(); q.Status = open ? "open" : "answered";
        var p = state.Sections.SelectMany(s => s.Paragraphs).FirstOrDefault(p => p.Id == q.ParagraphId);
        if (p != null) { p.Text = open ? $"待确认：{q.Title}。{q.Answer}" : q.Answer; p.Status = "auth"; p.Citations.Clear(); p.Quotes.Clear(); p.Confirmed = false; }
        // 回答改变后的角色行动与摘要必须重新过目，不能让旧结论继续冒充已确认结果。
        state.Conclusions.Clear(); state.Roles.Clear(); state.Summary = "";
        state.ScopeIn = ""; state.ScopeOut = ""; state.Chapters.Clear(); state.Captions.Clear();
        state.Stage = "confirm";
    }
    public static void ValidateGenerated(WritingDocumentState state)
    {
        var sources = state.Sources.Where(s => s.Status == "read").Select(s => s.Id).ToHashSet();
        var paragraphs = state.Sections.SelectMany(s => s.Paragraphs).ToList();
        if (paragraphs.Count == 0 || paragraphs.Count > 300) throw new InvalidOperationException("生成内容为空或超过段落上限，请重试");
        if (paragraphs.Select(p => p.Id).Distinct().Count() != paragraphs.Count) throw new InvalidOperationException("生成的段落编号重复，请重试");
        foreach (var p in paragraphs)
        {
            if (p.Citations.Any(c => !sources.Contains(c))) throw new InvalidOperationException("生成内容包含无法定位的引用，请重试");
            if (p.Status is not ("src" or "auth" or "ask" or "conf")) p.Status = "auth";
            if (p.Status == "src" && p.Citations.Count == 0) p.Status = "auth";
            if (p.Status == "src") foreach (var citation in p.Citations) {
                if (!p.Quotes.TryGetValue(citation, out var quote) || string.IsNullOrWhiteSpace(quote)
                    || !state.Sources.Single(s => s.Id == citation).Content.Contains(quote, StringComparison.Ordinal))
                    throw new InvalidOperationException("引用片段不能在原文中定位，请重试");
            }
            // 有来源标记仅表示可定位，仍需作者逐段核实语义、数字与适用条件。
            p.Confirmed = false;
        }
        if (state.Questions.Any(q => !paragraphs.Any(p => p.Id == q.ParagraphId))) throw new InvalidOperationException("确认事项未关联正文段落，请重试");
        if (paragraphs.Any(p => p.Status is "ask" or "conf" && !state.Questions.Any(q => q.ParagraphId == p.Id))) throw new InvalidOperationException("缺失或冲突段落没有对应确认事项，请重试");
        if (state.Questions.Select(q => q.Id).Distinct().Count() != state.Questions.Count) throw new InvalidOperationException("确认事项编号重复，请重试");
        foreach (var section in state.Sections) section.MetadataConfirmed = false;
        foreach (var question in state.Questions) {
            if (question.Citations.Any(id => !sources.Contains(id))) throw new InvalidOperationException("确认事项引用了未读取的资料");
            foreach (var evidence in question.Evidence)
                if (!sources.Contains(evidence.SourceId) || string.IsNullOrWhiteSpace(evidence.Quote)
                    || !state.Sources.Single(s => s.Id == evidence.SourceId).Content.Contains(evidence.Quote, StringComparison.Ordinal))
                    throw new InvalidOperationException("问题原文片段无法定位到所选资料，请重试");
        }
        foreach (var q in state.Questions) { q.Status = "pending"; q.Answer = ""; }
    }
    public static string Markdown(WritingDocumentState state)
    {
        static string Cell(string value) => System.Net.WebUtility.HtmlEncode(value)
            .Replace("|", "\\|").Replace("\r\n", "\n").Replace("\n", "<br>");
        var parts = state.Sections.Select(section => {
            var content = new List<string> { $"## {section.Title}", string.Join("\n\n", section.Paragraphs.Select(p => p.Text)) };
            if (!string.IsNullOrWhiteSpace(section.Condition))
                content.Add("> 条件：" + section.Condition.Replace("\n", "\n> "));
            if (section.Detail is { Rows.Count: > 0 } detail) {
                content.Add($"### {detail.Label}");
                var columns = detail.Rows.Max(row => row.Count);
                var headers = Enumerable.Range(0, columns).Select(i => i < 3 ? new[] { "字段", "要求", "说明" }[i] : $"内容 {i + 1}");
                content.Add("| " + string.Join(" | ", headers) + " |\n| " + string.Join(" | ", Enumerable.Repeat("---", columns)) + " |\n"
                    + string.Join("\n", detail.Rows.Select(row => "| " + string.Join(" | ", Enumerable.Range(0, columns).Select(i => i < row.Count ? Cell(row[i]) : "")) + " |")));
            }
            return string.Join("\n\n", content);
        }).ToList();
        var open = state.Questions.Where(q => q.Status == "open").ToList();
        if (open.Count > 0) parts.Add("## 待确认事项\n\n" + string.Join("\n", open.Select(q => $"- {q.Title}：{q.Answer}")));
        return $"# {state.Title}\n\n{state.Summary}\n\n" + string.Join("\n\n", parts);
    }
    public static WritingPublication Snapshot(WritingDocumentState state, string reviewerId, string reviewerName)
    {
        var publication = new WritingPublication {
            Version = (state.Published?.Version ?? 0) + 1, Title = state.Title, Summary = state.Summary,
            TemplateId = state.TemplateId, TemplateVersion = state.TemplateVersion, AuthorName = state.AuthorName,
            ReviewerId = reviewerId, ReviewerName = reviewerName, PublishedAt = DateTime.UtcNow,
            Conclusions = state.Conclusions, ScopeIn = state.ScopeIn, ScopeOut = state.ScopeOut,
            Sources = state.Sources, Sections = state.Sections, Roles = state.Roles, Chapters = state.Chapters, Captions = state.Captions,
            VideoEntryId = state.VideoEntryId, OpenQuestions = state.Questions.Where(q => q.Status == "open").ToList()
        };
        return JsonSerializer.Deserialize<WritingPublication>(JsonSerializer.Serialize(publication, JsonOptions), JsonOptions)!;
    }
}

public class WritingPublicationRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string EntryId { get; set; } = "";
    public string StoreId { get; set; } = "";
    public WritingPublication Publication { get; set; } = new();
}
