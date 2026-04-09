using System.Reflection;
using PrdAgent.Api.Services.PrReviewPrism;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class PrReviewPrismServiceTests
{
    [Theory]
    [InlineData("https://github.com/owner/repo/pull/123", "owner", "repo", 123)]
    [InlineData("https://github.com/owner/repo/pull/123/", "owner", "repo", 123)]
    [InlineData("https://github.com/owner/repo/pull/123?foo=bar", "owner", "repo", 123)]
    [InlineData("http://github.com/OWNER/REPO/pull/999", "OWNER", "REPO", 999)]
    public void TryParsePullRequestUrl_ValidUrls_ShouldParse(
        string url,
        string expectedOwner,
        string expectedRepo,
        int expectedPrNumber)
    {
        var ok = GitHubPrReviewPrismService.TryParsePullRequestUrl(url, out var owner, out var repo, out var prNumber);

        Assert.True(ok);
        Assert.Equal(expectedOwner, owner);
        Assert.Equal(expectedRepo, repo);
        Assert.Equal(expectedPrNumber, prNumber);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("https://gitlab.com/owner/repo/pull/123")]
    [InlineData("https://github.com/owner/repo/issues/123")]
    [InlineData("https://github.com/owner/repo/pull/not-a-number")]
    [InlineData("https://github.com/owner/repo/pull/0")]
    public void TryParsePullRequestUrl_InvalidUrls_ShouldFail(string url)
    {
        var ok = GitHubPrReviewPrismService.TryParsePullRequestUrl(url, out var owner, out var repo, out var prNumber);

        Assert.False(ok);
        Assert.Null(owner);
        Assert.Null(repo);
        Assert.Equal(0, prNumber);
    }

    [Fact]
    public void DecisionCardParse_ShouldExtractStructuredFields()
    {
        const string body = """
            <!-- pr-review-prism-decision-card:begin -->
            ### B. 评审结论
            - 建议: `approve_with_guardrails`
            - 风险分: `67`
            - 置信度: `88`
            - 触发硬阻断: `yes`
            ### C. 阻断项（如有）
            - 缺少回滚验证
            ### D. 风险提示（Advisories）
            - 建议补齐告警阈值
            ### E. 架构师关注问题（最多 3 条）
            1. 这个字段是否需要幂等约束？
            2. 为什么这里不做重试策略？
            <!-- pr-review-prism-decision-card:end -->
            """;

        var comment = CreateIssueComment(body, "https://github.com/x/y/pull/1#issuecomment-1", new DateTime(2026, 4, 9, 10, 0, 0, DateTimeKind.Utc));
        var parsed = InvokeParseDecisionCard(comment);

        Assert.Equal("approve_with_guardrails", parsed.DecisionSuggestion);
        Assert.Equal(67, parsed.RiskScore);
        Assert.Equal(88, parsed.ConfidencePercent);
        Assert.True(parsed.BlockersTriggered);
        Assert.Single(parsed.Blockers);
        Assert.Equal("缺少回滚验证", parsed.Blockers[0]);
        Assert.Single(parsed.Advisories);
        Assert.Equal("建议补齐告警阈值", parsed.Advisories[0]);
        Assert.Equal(2, parsed.FocusQuestions.Count);
        Assert.Equal("这个字段是否需要幂等约束？", parsed.FocusQuestions[0]);
        Assert.Equal("为什么这里不做重试策略？", parsed.FocusQuestions[1]);
        Assert.Equal("https://github.com/x/y/pull/1#issuecomment-1", parsed.CommentUrl);
        Assert.Equal(new DateTime(2026, 4, 9, 10, 0, 0, DateTimeKind.Utc), parsed.UpdatedAt);
    }

    [Fact]
    public void DecisionCardParse_ShouldIgnoreNoneAndLimitFocusQuestionsToThree()
    {
        const string body = """
            <!-- pr-architect-decision-card:begin -->
            ### B. 评审结论
            - 建议: `request_changes`
            - 风险分: `40`
            - 置信度: `70`
            - 触发硬阻断: `false`
            ### C. 阻断项（如有）
            - None
            ### D. 风险提示（Advisories）
            - None
            ### E. 架构师关注问题（最多 3 条）
            1. Q1
            2. Q2
            3. Q3
            4. Q4
            <!-- pr-architect-decision-card:end -->
            """;

        var comment = CreateIssueComment(body, null, null);
        var parsed = InvokeParseDecisionCard(comment);

        Assert.Equal("request_changes", parsed.DecisionSuggestion);
        Assert.Equal(40, parsed.RiskScore);
        Assert.Equal(70, parsed.ConfidencePercent);
        Assert.False(parsed.BlockersTriggered);
        Assert.Empty(parsed.Blockers);
        Assert.Empty(parsed.Advisories);
        Assert.Equal(3, parsed.FocusQuestions.Count);
        Assert.Equal("Q1", parsed.FocusQuestions[0]);
        Assert.Equal("Q2", parsed.FocusQuestions[1]);
        Assert.Equal("Q3", parsed.FocusQuestions[2]);
    }

    private static DecisionCardDto InvokeParseDecisionCard(object issueComment)
    {
        var serviceType = typeof(GitHubPrReviewPrismService);
        var method = serviceType.GetMethod("ParseDecisionCard", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        var result = method!.Invoke(null, new[] { issueComment });
        Assert.NotNull(result);
        return Assert.IsType<DecisionCardDto>(result);
    }

    private static object CreateIssueComment(string body, string? htmlUrl, DateTime? updatedAt)
    {
        var serviceType = typeof(GitHubPrReviewPrismService);
        var commentType = serviceType.GetNestedType("IssueCommentDto", BindingFlags.NonPublic);
        Assert.NotNull(commentType);

        var instance = Activator.CreateInstance(commentType!);
        Assert.NotNull(instance);

        commentType!.GetProperty("Body")!.SetValue(instance, body);
        commentType.GetProperty("HtmlUrl")!.SetValue(instance, htmlUrl);
        commentType.GetProperty("UpdatedAt")!.SetValue(instance, updatedAt);
        return instance;
    }
}
