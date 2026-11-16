using System.Text.Json;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WritingDeliveryPolicyTests
{
    private static WritingDocumentState Draft() => new()
    {
        Title = "执行交接", ReviewerId = "reviewer", IntentPoints = new() { "仅测试租户；每批少于100条，失败后停止" },
        Sections = new() { new WritingSection { Id = "s1", Title = "条件", Paragraphs = new() {
            new WritingParagraph { Id = "p1", Text = "仅测试租户；每批少于100条，失败后停止", Status = "auth", Confirmed = true }
        } } }
    };

    [Fact]
    public void PublicationFreezesAuthorIntentInsteadOfDroppingItAfterDraftConfirmation()
    {
        var draft = Draft();
        var published = WritingDocumentPolicy.Snapshot(draft, "reviewer", "审核人");
        draft.IntentPoints[0] = "下一版的重点";
        var json = JsonSerializer.SerializeToElement(published, WritingDocumentPolicy.JsonOptions);
        Assert.True(json.TryGetProperty("intentPoints", out var intent), "作者确认的必达点必须进入发布快照");
        Assert.Equal("仅测试租户；每批少于100条，失败后停止", intent[0].GetString());
    }

    [Fact]
    public void AnAuthorPointWithoutAConfirmedLocationCannotBeSilentlyPublished()
    {
        var draft = Draft();
        Assert.Contains(WritingDocumentPolicy.SubmissionProblems(draft), problem => problem.Contains("必达"));
    }

    [Fact]
    public void ImportedTemplateIsPartOfTheFrozenDocumentNotALookupIntoChangingGlobalRegistry()
    {
        var draft = JsonSerializer.Deserialize<WritingDocumentState>("""
            {"templateId":"custom-organization","templateVersion":"2.0","templateSnapshot":{
              "id":"custom-organization","name":"交接模版","type":"规范","role":"member","useWhen":"交接",
              "version":"2.0","headings":[{"title":"停止条件","hint":"明确不能继续的情况"}]}}
            """, WritingDocumentPolicy.JsonOptions)!;
        var published = WritingDocumentPolicy.Snapshot(draft, "reviewer", "审核人");
        var json = JsonSerializer.SerializeToElement(published, WritingDocumentPolicy.JsonOptions);
        Assert.True(json.TryGetProperty("templateSnapshot", out var template), "发布版必须冻结所用组织模版");
        Assert.Equal("停止条件", template.GetProperty("headings")[0].GetProperty("title").GetString());
    }

    [Fact]
    public void ConfirmationCannotBeMovedToADifferentParagraphWithoutReview()
    {
        var draft = Draft();
        draft.Sections[0].Paragraphs.Add(new WritingParagraph { Id = "p2", Text = "其他说明", Status = "auth", Confirmed = true });
        draft.IntentCoverage.Add(new WritingIntentCoverage { IntentIndex = 0, ParagraphIds = new() { "p1" } });
        WritingDeliveryPolicy.ConfirmIntent(draft, 0);
        Assert.Empty(WritingDocumentPolicy.SubmissionProblems(draft));
        draft.IntentCoverage[0].ParagraphIds = new() { "p2" };
        Assert.Contains(WritingDocumentPolicy.SubmissionProblems(draft), p => p.Contains("必达"));
    }

    [Fact]
    public void SavesAndParagraphCheckboxesDoNotInvalidateMeaningButAChangedConditionDoes()
    {
        var draft = Draft();
        draft.IntentCoverage.Add(new WritingIntentCoverage { IntentIndex = 0, ParagraphIds = new() { "p1" } });
        WritingDeliveryPolicy.ConfirmIntent(draft, 0);
        var content = WritingDeliveryPolicy.Fingerprint(draft);
        draft.Revision++; draft.UpdatedAt = DateTime.UtcNow.AddHours(2);
        Assert.Equal(content, WritingDeliveryPolicy.Fingerprint(draft));
        Assert.True(WritingDeliveryPolicy.IsConfirmed(draft, 0));
        draft.Sections[0].Condition = "正式租户也可执行";
        Assert.False(WritingDeliveryPolicy.IsConfirmed(draft, 0));
    }

    [Fact]
    public void OrganizationMarkdownKeepsChapterOrderAndWritingHints()
    {
        var template = WritingDeliveryPolicy.ImportTemplate("org-1", "交接模版", "## 执行条件\n<!-- 提示：写清范围和批准人 -->\n## 异常处理\n禁止重试的条件");
        Assert.Equal(new[] { "执行条件", "异常处理" }, template.Headings.Select(h => h.Title));
        Assert.Contains("写清范围和批准人", template.Headings[0].Hint);
        Assert.DoesNotContain("<!--", template.Headings[0].Hint);
        Assert.Throws<InvalidOperationException>(() => WritingDeliveryPolicy.ImportTemplate("x", "无章节", "只有普通正文"));
    }
    [Fact]
    public void AnswerKeepsPreviousDerivedTextForComparisonAndRequiresReconciliation()
    {
        var state = Draft();
        state.Summary = "旧摘要";
        state.Roles.Add(new WritingRole { Label = "执行人", Action = "先备份" });
        state.Questions.Add(new WritingQuestion { Id = "q1", ParagraphId = "p1", Title = "失败后如何处理" });
        WritingDocumentPolicy.Answer(state, "q1", "失败后立即停止，不得重复提交", false);
        Assert.Equal("旧摘要", state.Summary);
        Assert.Single(state.Roles);
        Assert.Contains(WritingDocumentPolicy.SubmissionProblems(state), problem => problem.Contains("重新整理"));
    }

    [Fact]
    public void EmptyParagraphCannotCarryAnAuthorPoint()
    {
        var state = Draft();
        state.Sections[0].Paragraphs[0].Text = " ";
        state.IntentCoverage.Add(new WritingIntentCoverage { IntentIndex = 0, ParagraphIds = new() { "p1" } });
        Assert.Throws<InvalidOperationException>(() => WritingDeliveryPolicy.ConfirmIntent(state, 0));
    }
    [Fact]
    public void ReconciliationChangesDerivedViewWithoutRewritingAuthorBodyOrPublishedVersion()
    {
        var state = Draft();
        state.Summary = "旧摘要"; state.DerivedContentStale = true;
        state.Published = WritingDocumentPolicy.Snapshot(state, "reviewer", "审核人");
        var body = JsonSerializer.Serialize(state.Sections);
        var publication = JsonSerializer.Serialize(state.Published);
        var generated = new WritingDocumentState { Summary = "失败立即停止，禁止重复提交", ScopeOut = "正式租户",
            Sections = new() { new WritingSection { Id = "evil", Title = "模型擅改正文" } },
            IntentCoverage = new() { new WritingIntentCoverage { IntentIndex = 0, ParagraphIds = new() { "p1" }, Confirmed = true, ConfirmedContentHash = "forged" } } };
        WritingDeliveryPolicy.ApplyReconciliation(state, generated);
        Assert.Equal(body, JsonSerializer.Serialize(state.Sections));
        Assert.Equal(publication, JsonSerializer.Serialize(state.Published));
        Assert.Equal("旧摘要", state.PreviousDerivedView!.Summary);
        Assert.Equal(generated.Summary, state.Summary);
        Assert.False(state.DerivedContentStale);
        Assert.False(WritingDeliveryPolicy.IsConfirmed(state, 0));
        Assert.True(state.Sections[0].Paragraphs[0].Confirmed);
    }

    [Fact]
    public void ReconciliationCannotAttachSuggestionsToAnUnknownParagraph()
    {
        var state = Draft(); state.Summary = "旧摘要"; state.DerivedContentStale = true;
        var generated = new WritingDocumentState { Summary = "无效整理", IntentCoverage = new() {
            new WritingIntentCoverage { IntentIndex = 0, ParagraphIds = new() { "missing" } }
        } };
        Assert.Throws<InvalidOperationException>(() => WritingDeliveryPolicy.ApplyReconciliation(state, generated));
        Assert.Equal("旧摘要", state.Summary);
        Assert.True(state.DerivedContentStale);
    }
}
