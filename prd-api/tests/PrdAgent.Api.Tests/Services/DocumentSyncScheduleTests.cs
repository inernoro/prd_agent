using System;
using System.Collections.Generic;
using MongoDB.Bson.Serialization;
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
    public void 认领查询本身就要排除GitHub子文件()
    {
        // 取回之后再判不到期是不够的：子文件会先把 Limit 窗口占满，
        // 真正到期的普通订阅一条都取不到。这条断言盯的是**查询**而不是判据。
        var rendered = DocumentSyncSchedule
            .BuildRegularCandidateFilter(new DateTime(2026, 9, 14, 0, 0, 0, DateTimeKind.Utc))
            .Render(new MongoDB.Driver.RenderArgs<DocumentEntry>(
                BsonSerializer.SerializerRegistry.GetSerializer<DocumentEntry>(),
                BsonSerializer.SerializerRegistry))
            .ToString();

        Assert.Contains(DocumentSyncSchedule.GithubParentIdKey, rendered);
        // 必须是「排除」而不是「要求」。驱动对取反有几种等价渲染（$nor / $not / exists:false），
        // 这里认语义不认某一种写法，免得驱动升级改了渲染形态就假红。
        Assert.True(
            rendered.Contains("$nor", StringComparison.Ordinal)
                || rendered.Contains("$not", StringComparison.Ordinal)
                || rendered.Contains("$exists\" : false", StringComparison.Ordinal),
            $"认领查询必须排除子文件，实际渲染：{rendered}");
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
