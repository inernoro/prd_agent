using System;
using System.Collections.Generic;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 订阅同步的到期判据（纯函数，无需 DB）。
///
/// 重点盯 GitHub 目录同步的**子文件**：它们的 SourceUrl 是列目录时拿到的 download_url，
/// 私有仓那串地址带着几分钟就过期的临时 token。若子文件还被当普通 URL 订阅每天单独拉一次，
/// 用户每天会收到一批假的同步失败。判据一旦被改回去，这里立刻变红。
/// </summary>
public class DocumentSyncScheduleTests
{
    private static DocumentEntry Child(Action<DocumentEntry>? tweak = null)
    {
        var entry = new DocumentEntry
        {
            SourceType = DocumentSourceType.Subscription,
            SourceUrl = "https://raw.githubusercontent.com/acme/site/main/doc/a.md?token=EXPIRES",
            SyncIntervalMinutes = 1440,
            LastSyncAt = DateTime.UtcNow.AddDays(-3),
            Metadata = new Dictionary<string, string>
            {
                ["github_parent_id"] = "parent-1",
                ["github_path"] = "doc/a.md",
            },
        };
        tweak?.Invoke(entry);
        return entry;
    }

    private static DocumentEntry Parent() => new()
    {
        SourceType = DocumentSourceType.GithubDirectory,
        SourceUrl = "https://github.com/acme/site/tree/main/doc",
        SyncIntervalMinutes = 1440,
        LastSyncAt = DateTime.UtcNow.AddDays(-3),
        Metadata = new Dictionary<string, string>
        {
            ["github_owner"] = "acme",
            ["github_repo"] = "site",
            ["github_path"] = "doc",
            ["github_branch"] = "main",
        },
    };

    [Fact]
    public void GitHub子文件不单独同步()
    {
        Assert.True(DocumentSyncSchedule.IsGithubChildEntry(Child()));
        Assert.False(DocumentSyncSchedule.IsDue(Child(), DateTime.UtcNow));
        // 就算被标成「同步中」也不认领——否则会卡在转圈上没人收
        Assert.False(DocumentSyncSchedule.IsDue(Child(e => e.SyncStatus = DocumentSyncStatus.Syncing), DateTime.UtcNow));
        Assert.Null(DocumentSyncSchedule.GetNextSyncAt(Child()));
    }

    [Fact]
    public void 父目录条目照常按天到期()
    {
        Assert.False(DocumentSyncSchedule.IsGithubChildEntry(Parent()));
        Assert.True(DocumentSyncSchedule.IsDue(Parent(), DateTime.UtcNow));
    }

    [Fact]
    public void 普通URL订阅不受影响()
    {
        var entry = new DocumentEntry
        {
            SourceType = DocumentSourceType.Subscription,
            SourceUrl = "https://example.com/feed.xml",
            SyncIntervalMinutes = 60,
            LastSyncAt = DateTime.UtcNow.AddHours(-2),
        };

        Assert.False(DocumentSyncSchedule.IsGithubChildEntry(entry));
        Assert.True(DocumentSyncSchedule.IsDue(entry, DateTime.UtcNow));
        Assert.NotNull(DocumentSyncSchedule.GetNextSyncAt(entry));
    }

    [Fact]
    public void 暂停仍然优先()
    {
        Assert.False(DocumentSyncSchedule.IsDue(Parent2Paused(), DateTime.UtcNow));

        static DocumentEntry Parent2Paused()
        {
            var entry = Parent();
            entry.IsPaused = true;
            return entry;
        }
    }
}
