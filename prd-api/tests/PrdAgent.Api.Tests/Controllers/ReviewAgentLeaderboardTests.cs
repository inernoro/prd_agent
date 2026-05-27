using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 排行榜「方案桶」聚合 + 「一次性通过率」公式（口径 Z）单元测试。
/// 模拟用户提出的张三 5 月度 6 方案场景。
/// </summary>
public class ReviewAgentLeaderboardTests
{
    private static ReviewAgentController.LeaderboardRow Row(
        string title, bool? passed, int rerun, string? appeal = null, string submitter = "u1")
        => new()
        {
            SubmitterId = submitter,
            SubmitterName = submitter == "u1" ? "张三" : "李四",
            Title = title,
            IsPassed = passed,
            RerunCount = rerun,
            AppealStatus = appeal,
        };

    [Fact]
    public void Bucket_单次通过且未重传_算一次过()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案A：互动营销", passed: true, rerun: 0),
        });

        var b = buckets.Single();
        b.SubmissionCount.ShouldBe(1);
        b.IsBucketPassed.ShouldBeTrue();
        b.IsFirstPass.ShouldBeTrue();
    }

    [Fact]
    public void Bucket_单次未通过_不算一次过_算桶级失败()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案B：积分体系", passed: false, rerun: 0),
        });

        var b = buckets.Single();
        b.IsBucketPassed.ShouldBeFalse();
        b.IsBucketFailed.ShouldBeTrue();
        b.IsFirstPass.ShouldBeFalse();
    }

    [Fact]
    public void Bucket_救活成功_RerunCount1_算桶级通过但非一次过()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案C：分销返利", passed: true, rerun: 1),
        });

        var b = buckets.Single();
        b.IsBucketPassed.ShouldBeTrue();
        b.IsFirstPass.ShouldBeFalse();    // RerunCount>0
    }

    [Fact]
    public void Bucket_救机会用尽仍未通过_桶级失败()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案D：会员等级", passed: false, rerun: 1),
        });

        var b = buckets.Single();
        b.IsBucketFailed.ShouldBeTrue();
        b.IsFirstPass.ShouldBeFalse();
    }

    [Fact]
    public void Bucket_用户新建同标题再过_2条submission_算桶级通过但非一次过()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案E：抽奖活动", passed: false, rerun: 0),
            Row("方案E：抽奖活动", passed: true, rerun: 0), // 用户新建同标题第二份
        });

        var b = buckets.Single(); // 按 title 去重，仍是 1 个桶
        b.SubmissionCount.ShouldBe(2);
        b.IsBucketPassed.ShouldBeTrue();
        b.IsFirstPass.ShouldBeFalse();    // submissionCount>1
    }

    [Fact]
    public void Bucket_F2语义_Error重跑通过_RerunCount0_算一次过()
    {
        // 关键：F-2 设计下 ErrorRetryCount 不污染 RerunCount
        // LLM 网关 Error 重跑通过的方案，RerunCount 仍为 0，应算"一次过"
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案F：渠道分润", passed: true, rerun: 0), // 系统故障重跑过，但 RerunCount=0
        });

        var b = buckets.Single();
        b.IsBucketPassed.ShouldBeTrue();
        b.IsFirstPass.ShouldBeTrue();    // ✓ F-2 关键断言
    }

    [Fact]
    public void Bucket_张三全月6方案_一次性通过率符合预期()
    {
        // 复现用户给的"张三 5 月度 6 方案"场景，验证全链路 Z 口径正确
        var rows = new[]
        {
            // A：1 sub 通过 → 一次过
            Row("方案A：互动营销", passed: true, rerun: 0),
            // B：1 sub 未通过放弃
            Row("方案B：积分体系", passed: false, rerun: 0),
            // C：1 sub 救活成功
            Row("方案C：分销返利", passed: true, rerun: 1),
            // D：1 sub 救失败
            Row("方案D：会员等级", passed: false, rerun: 1),
            // E：2 sub 同标题，第二个通过
            Row("方案E：抽奖活动", passed: false, rerun: 0),
            Row("方案E：抽奖活动", passed: true, rerun: 0),
            // F：1 sub Error 重跑通过，RerunCount 仍 0
            Row("方案F：渠道分润", passed: true, rerun: 0),
        };

        var buckets = ReviewAgentController.AggregateProposalBuckets(rows);

        buckets.Count.ShouldBe(6);  // 按 (submitter,title) 去重 → 6 个方案
        var firstPassCount = buckets.Count(b => b.IsFirstPass);
        var passedCount = buckets.Count(b => b.IsBucketPassed);

        // 一次过 = A + F = 2 / 6 ≈ 33.3%
        firstPassCount.ShouldBe(2);
        // 最终通过的方案桶 = A + C + E + F = 4 / 6 ≈ 66.7%
        passedCount.ShouldBe(4);

        ((double)firstPassCount / buckets.Count).ShouldBe(2d / 6d, 0.0001);
    }

    [Fact]
    public void Bucket_申诉成功的方案桶_不算通过也不算失败()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案 X", passed: false, rerun: 0, appeal: AppealStatuses.Approved),
        });

        var b = buckets.Single();
        b.IsBucketPassed.ShouldBeFalse();
        b.IsBucketFailed.ShouldBeFalse();
        b.IsBucketAppealApproved.ShouldBeTrue();
        b.IsFirstPass.ShouldBeFalse();    // 申诉成功不算一次过
    }

    [Fact]
    public void Bucket_跨用户同标题_分到不同桶()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(new[]
        {
            Row("方案A：互动营销", passed: true, rerun: 0, submitter: "u1"),
            Row("方案A：互动营销", passed: false, rerun: 0, submitter: "u2"),
        });

        buckets.Count.ShouldBe(2);
        buckets.Single(b => b.SubmitterId == "u1").IsFirstPass.ShouldBeTrue();
        buckets.Single(b => b.SubmitterId == "u2").IsFirstPass.ShouldBeFalse();
    }

    [Fact]
    public void Bucket_空输入_返回空列表()
    {
        var buckets = ReviewAgentController.AggregateProposalBuckets(Array.Empty<ReviewAgentController.LeaderboardRow>());
        buckets.ShouldBeEmpty();
    }
}
