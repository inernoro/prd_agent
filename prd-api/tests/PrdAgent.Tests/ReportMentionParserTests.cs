using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 周报评论 @ 提醒解析单测（<see cref="ReportMentionParser"/>）。
///
/// 这是服务端的唯一判据：前端传来的 mentionedUserIds 只作补充，最终以本解析器 + 团队成员集合为准。
/// 重点覆盖「张三 / 张三丰」这类长短名重叠场景——短名抢占长名会把提醒发错人。
/// </summary>
public class ReportMentionParserTests
{
    private static ReportMentionParser.MentionCandidate Candidate(string userId, params string[] names)
        => new() { UserId = userId, Names = names };

    [Fact]
    public void Extract_NullOrEmptyContent_ReturnsEmpty()
    {
        var candidates = new[] { Candidate("u1", "张三") };
        Assert.Empty(ReportMentionParser.Extract(null, candidates));
        Assert.Empty(ReportMentionParser.Extract("   ", candidates));
        Assert.Empty(ReportMentionParser.Extract("@张三", null));
    }

    [Fact]
    public void Extract_PlainMention_ReturnsUserId()
    {
        var ids = ReportMentionParser.Extract(
            "@杨锐聪 关注一下这个问题",
            new[] { Candidate("u-yang", "杨锐聪"), Candidate("u-yu", "余瑞鹏") });

        Assert.Equal(new[] { "u-yang" }, ids);
    }

    [Fact]
    public void Extract_NoAtPrefix_DoesNotMatch()
    {
        var ids = ReportMentionParser.Extract(
            "杨锐聪 已经处理完了",
            new[] { Candidate("u-yang", "杨锐聪") });

        Assert.Empty(ids);
    }

    [Fact]
    public void Extract_LongerNameWins_ShortNameDoesNotStealIt()
    {
        // 「@张三丰」不能被「张三」抢走：短名先命中会把提醒发给错的人
        var ids = ReportMentionParser.Extract(
            "@张三丰 请复核",
            new[] { Candidate("u-zs", "张三"), Candidate("u-zsf", "张三丰") });

        Assert.Equal(new[] { "u-zsf" }, ids);
    }

    [Fact]
    public void Extract_BothLongAndShortMentioned_ReturnsBoth()
    {
        var ids = ReportMentionParser.Extract(
            "@张三丰 和 @张三 都看一下",
            new[] { Candidate("u-zs", "张三"), Candidate("u-zsf", "张三丰") });

        Assert.Equal(2, ids.Count);
        Assert.Contains("u-zsf", ids);
        Assert.Contains("u-zs", ids);
    }

    [Fact]
    public void Extract_SamePersonMentionedTwice_Deduplicates()
    {
        var ids = ReportMentionParser.Extract(
            "@杨锐聪 请看，另外 @杨锐聪 补一句",
            new[] { Candidate("u-yang", "杨锐聪") });

        Assert.Equal(new[] { "u-yang" }, ids);
    }

    [Fact]
    public void Extract_MatchesAnyOfCandidateNames_ButReturnsUserIdOnce()
    {
        // 一个用户可能有显示名 + 用户名两个可被 @ 的名字
        var ids = ReportMentionParser.Extract(
            "@杨锐聪 和 @yangruicong 是同一个人",
            new[] { Candidate("u-yang", "杨锐聪", "yangruicong") });

        Assert.Equal(new[] { "u-yang" }, ids);
    }

    [Fact]
    public void Extract_IgnoresBlankNamesAndBlankUserIds()
    {
        var ids = ReportMentionParser.Extract(
            "@张三 在吗",
            new[] { Candidate("", "张三"), Candidate("u-ok", "张三") });

        Assert.Equal(new[] { "u-ok" }, ids);
    }
}
