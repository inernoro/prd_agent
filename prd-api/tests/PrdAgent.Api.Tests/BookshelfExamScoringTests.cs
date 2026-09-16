using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 结业考成绩的落库判据。
///
/// 这组守卫盯的是两个都不会报错、只会静默给错结论的洞：
///   1. 「更好的那次」只比正确数，于是裸考满分的人读完整卷再考满分也永远不通关；
///   2. Passed 采信前端送上来的布尔值，于是 0 分也能标成通过。
///
/// 把 IsBetter 退回「只比 correct」，第三条会红；把 IsPassed 换成「返回前端给的值」，
/// 第五、六条会红。
/// </summary>
public class BookshelfExamScoringTests
{
    private static BookshelfExamResult Prev(int correct, int total, int readAtExam) => new()
    {
        Correct = correct,
        Total = total,
        Passed = BookshelfExamScoring.IsPassed(correct, total),
        ReadAtExam = readAtExam,
        TotalAtExam = 11,
    };

    [Fact(DisplayName = "库里没有记录时，任何一次成绩都要落库")]
    public void NoPrevious_AlwaysBetter()
    {
        BookshelfExamScoring.IsBetter(null, 0, 7, 0).ShouldBeTrue();
    }

    [Fact(DisplayName = "同一档里，分数更高的那次才盖掉旧的")]
    public void SameStance_HigherScoreWins()
    {
        var prev = Prev(5, 7, 11);
        BookshelfExamScoring.IsBetter(prev, 6, 7, 11).ShouldBeTrue();
        BookshelfExamScoring.IsBetter(prev, 5, 7, 11).ShouldBeFalse();
        BookshelfExamScoring.IsBetter(prev, 4, 7, 11).ShouldBeFalse();
    }

    [Fact(DisplayName = "裸考满分之后读完整卷再考满分，分数没涨也要落库（否则永远不通关）")]
    public void BlindFullScore_ThenReadAll_SameScore_StillUpgrades()
    {
        var blindFullScore = Prev(7, 7, 0);
        BookshelfExamScoring.CountsAsPassed(7, 7, 0).ShouldBeFalse(
            customMessage: "裸考不计入通关，这是这条用例成立的前提");

        BookshelfExamScoring.IsBetter(blindFullScore, 7, 7, 11).ShouldBeTrue();
    }

    [Fact(DisplayName = "已经通关的人再裸考一次，不会把记录降级回裸考")]
    public void PassedRecord_NotDowngradedByBlindRetake()
    {
        var passed = Prev(6, 7, 11);
        BookshelfExamScoring.IsBetter(passed, 7, 7, 0).ShouldBeFalse();
    }

    [Fact(DisplayName = "及格线是服务端自己算的，六成为界")]
    public void PassRate_IsSixTenths()
    {
        BookshelfExamScoring.IsPassed(4, 7).ShouldBeFalse(customMessage: "4/7 不到六成");
        BookshelfExamScoring.IsPassed(5, 7).ShouldBeTrue(customMessage: "5/7 过六成");
        BookshelfExamScoring.IsPassed(6, 10).ShouldBeTrue(customMessage: "恰好六成算过");
    }

    [Fact(DisplayName = "空卷与越界成绩一律不及格，不靠调用方先挡一道")]
    public void OutOfRange_NeverPasses()
    {
        BookshelfExamScoring.IsPassed(0, 0).ShouldBeFalse();
        BookshelfExamScoring.IsPassed(3, 0).ShouldBeFalse();
        BookshelfExamScoring.IsPassed(-1, 7).ShouldBeFalse();
        BookshelfExamScoring.IsPassed(9, 7).ShouldBeFalse();
    }
}
