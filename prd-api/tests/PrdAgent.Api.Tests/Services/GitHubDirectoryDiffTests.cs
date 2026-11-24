using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 目录同步结果的失败契约（Codex review P1）。
///
/// 旧实现里单个文件拉取失败只打一行日志，调用方照样 AddedCount++、worker 照样标 idle：
/// 私有仓撞限流时会「少几篇文档 + 一个绿色的成功状态」。这是形状 10 的又一例，
/// 所以失败必须留在 diff 里并能说出缺了什么。
/// </summary>
public class GitHubDirectoryDiffTests
{
    [Fact]
    public void 没有失败时不触发失败分支()
    {
        var diff = new GitHubDirectoryDiff { AddedCount = 3 };

        Assert.False(diff.HasFailures);
        Assert.True(diff.HasChanges);
    }

    [Fact]
    public void 有文件失败就必须可见()
    {
        var diff = new GitHubDirectoryDiff
        {
            AddedCount = 2,
            FailedCount = 2,
            FailedPaths = { "doc/a.md", "doc/b.md" },
        };

        Assert.True(diff.HasFailures);

        var message = diff.BuildFailureMessage();
        Assert.Contains("2 篇", message);
        Assert.Contains("doc/a.md", message);
        Assert.Contains("重试同步", message);
    }

    [Fact]
    public void 失败样本多于三个时给出总数()
    {
        var diff = new GitHubDirectoryDiff { FailedCount = 5 };
        diff.FailedPaths.AddRange(new[] { "doc/1.md", "doc/2.md", "doc/3.md", "doc/4.md", "doc/5.md" });

        Assert.Contains("等 5 个文件", diff.BuildFailureMessage());
    }

    [Fact]
    public void 清单被截断也要让父条目标红()
    {
        // 上一轮加了 ListingIncomplete 却没人读它：worker 只看 HasFailures，于是清掉 SyncError、
        // 推进 LastSyncAt，把「跳过了删除」演成一次成功（形状 2：建了一半 + 形状 10：静默降级）。
        var diff = new GitHubDirectoryDiff { AddedCount = 3, ListingIncomplete = true };

        Assert.False(diff.HasFailures);
        Assert.True(diff.NeedsAttention);

        var message = diff.BuildFailureMessage();
        Assert.Contains("上限", message);
        Assert.Contains("没有处理删除", message);
        Assert.Contains("拆细", message);
    }

    [Fact]
    public void 两种来路同时出现时都要说到()
    {
        var diff = new GitHubDirectoryDiff
        {
            FailedCount = 1,
            FailedPaths = { "doc/a.md" },
            ListingIncomplete = true,
        };

        var message = diff.BuildFailureMessage();
        Assert.Contains("doc/a.md", message);
        Assert.Contains("重试同步", message);
        Assert.Contains("上限", message);
    }

    [Fact]
    public void 两样都没有才算这一轮做完了()
    {
        var diff = new GitHubDirectoryDiff { AddedCount = 5 };

        Assert.False(diff.NeedsAttention);
    }
}
