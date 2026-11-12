using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WritingDocumentPolicyTests
{
    [Fact]
    public void Templates_PreserveUploadedIdentity_AndNeverIncludeExamples()
    {
        Assert.Equal(7, WritingTemplateRegistry.All.Count);
        Assert.Equal(6, WritingTemplateRegistry.Find("prd")!.Headings.Count);
        Assert.Equal("结论", WritingTemplateRegistry.Find("minutes")!.Headings[0].Title);
        Assert.Null(WritingTemplateRegistry.Find("summary"));
    }

    [Fact]
    public void MarkdownPreservesReviewedConditionsAndDetailCells()
    {
        var state = Draft();
        state.Sections[0].Condition = "仅限本部门，离岗后不能补办。";
        state.Sections[0].Detail = new() { Label = "清单字段", Rows = new() { new() { "负责人", "必填", "唯一负责人" }, new() { "风险", "选填", "a|b\n不可省略" } } };
        var markdown = WritingDocumentPolicy.Markdown(state);
        Assert.Contains("仅限本部门，离岗后不能补办。", markdown);
        Assert.Contains("清单字段", markdown);
        Assert.Contains("| 负责人 | 必填 | 唯一负责人 |", markdown);
        Assert.Contains("a\\|b<br>不可省略", markdown);
    }

    [Fact]
    public void MissingTitle_BlocksSubmission_ButLongTitleDoesNot()
    {
        var state = Draft();
        state.Title = "";
        Assert.Contains(WritingDocumentPolicy.SubmissionProblems(state), p => p.Contains("标题"));
        state.Title = new string('文', 40);
        Assert.Empty(WritingDocumentPolicy.SubmissionProblems(state));
    }

    [Fact]
    public void Answer_IsAuthorDeclaration_AndOpenQuestionRemainsVisible()
    {
        var state = Draft();
        state.Questions.Add(new() { Id = "q1", ParagraphId = "p1", Title = "谁负责？" });
        WritingDocumentPolicy.Answer(state, "q1", "暂未确定", true);
        Assert.Equal("open", state.Questions[0].Status);
        Assert.Contains("暂未确定", WritingDocumentPolicy.Markdown(state));
        Assert.Equal("auth", state.Sections[0].Paragraphs[0].Status);
        Assert.False(state.Sections[0].Paragraphs[0].Confirmed);
    }

    [Fact]
    public void AnswerInvalidatesOldSummaryScopeAndTeaching()
    {
        var state = Draft();
        state.Summary = "所有租户可执行"; state.ScopeIn = "所有租户";
        state.Chapters.Add(new() { Title = "在正式租户执行" });
        state.Questions.Add(new() { Id = "q1", ParagraphId = "p1", Title = "适用范围？" });
        WritingDocumentPolicy.Answer(state, "q1", "仅测试租户", false);
        Assert.Empty(state.Summary); Assert.Empty(state.ScopeIn); Assert.Empty(state.Chapters);
    }

    [Fact]
    public void LocatedQuoteDoesNotBypassHumanSemanticReview()
    {
        var state = Draft();
        state.Sources.Add(new() { Id = "S1", Status = "read", Content = "仅测试租户可执行" });
        var p = state.Sections[0].Paragraphs[0];
        p.Status = "src"; p.Text = "所有租户可执行"; p.Citations.Add("S1"); p.Quotes["S1"] = "仅测试租户可执行";
        WritingDocumentPolicy.ValidateGenerated(state);
        Assert.Contains(WritingDocumentPolicy.SubmissionProblems(state), message => message.Contains("条件"));
    }

    [Fact]
    public void UnresolvedQuestion_AndUnreviewedAuthorContent_BlockSubmission()
    {
        var state = Draft();
        state.Questions.Add(new() { Id = "q1", Title = "负责人？" });
        state.Sections[0].Paragraphs[0].Status = "auth";
        state.Sections[0].Paragraphs[0].Confirmed = false;
        Assert.Equal(2, WritingDocumentPolicy.SubmissionProblems(state).Count);
    }

    [Fact]
    public void InvalidCitationCannotBecomeSourceSupported()
    {
        var state = Draft();
        state.Sections[0].Paragraphs[0].Status = "src";
        state.Sections[0].Paragraphs[0].Citations = new() { "S999" };
        Assert.Throws<InvalidOperationException>(() => WritingDocumentPolicy.ValidateGenerated(state));
    }

    [Fact]
    public void PublishedSnapshot_DoesNotChangeWhenDraftChanges()
    {
        var state = Draft();
        state.Published = WritingDocumentPolicy.Snapshot(state, "reviewer", "审阅人");
        state.Sections[0].Paragraphs[0].Text = "后来修改的草稿";
        Assert.Equal("仅限测试租户，正式租户禁止执行。", state.Published.Sections[0].Paragraphs[0].Text);
        Assert.Equal(1, state.Published.Version);
    }

    [Fact]
    public void ModelCannotMarkAnUnansweredQuestionAsAnswered()
    {
        var state = Draft();
        state.Sections[0].Paragraphs[0].Status = "ask";
        state.Questions.Add(new() { Id = "q1", ParagraphId = "p1", Status = "answered", Answer = "模型猜测" });
        WritingDocumentPolicy.ValidateGenerated(state);
        Assert.Equal("pending", state.Questions[0].Status);
        Assert.Equal("", state.Questions[0].Answer);
        Assert.NotEmpty(WritingDocumentPolicy.SubmissionProblems(state));
    }

    [Fact]
    public void MissingQuestionForConflictParagraph_IsRejected()
    {
        var state = Draft();
        state.Sections[0].Paragraphs[0].Status = "conf";
        Assert.Throws<InvalidOperationException>(() => WritingDocumentPolicy.ValidateGenerated(state));
    }

    [Fact]
    public void RemovedSourceCannotPassSubmissionWithStaleCitation()
    {
        var state = Draft();
        state.Sections[0].Paragraphs[0].Citations.Add("S1");
        Assert.Contains(WritingDocumentPolicy.SubmissionProblems(state), p => p.Contains("引用"));
    }

    [Theory]
    [InlineData("正式租户允许执行。", false)]
    [InlineData("仅限测试租户，正式租户禁止执行。", true)]
    public void SourceQuoteMustExistVerbatimInTheSourceSnapshot(string quote, bool valid)
    {
        var state = Draft();
        state.Sources.Add(new() { Id = "S1", Status = "read", Content = "条件：仅限测试租户，正式租户禁止执行。" });
        var paragraph = state.Sections[0].Paragraphs[0];
        paragraph.Status = "src";
        paragraph.Citations.Add("S1");
        paragraph.Quotes["S1"] = quote;
        if (valid) WritingDocumentPolicy.ValidateGenerated(state);
        else Assert.Throws<InvalidOperationException>(() => WritingDocumentPolicy.ValidateGenerated(state));
    }

    private static WritingDocumentState Draft() => new()
    {
        Title = "测试方案", TemplateId = "prd", AuthorId = "author", ReviewerId = "reviewer",
        Sections = new() { new() { Id = "s1", Title = "需求范围", Paragraphs = new() {
            new() { Id = "p1", Status = "auth", Confirmed = true, Text = "仅限测试租户，正式租户禁止执行。" }
        } } }
    };
}
