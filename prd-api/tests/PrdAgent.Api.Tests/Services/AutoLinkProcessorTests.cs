using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 自动补链处理器的纯函数测试。
/// BuildTitleToIdMap:标题撞名取最早创建(CreatedAt 最小,再按 Id 稳定破平),
/// 与 MentionService.ResyncDocumentMentionsAsync 的账本落点同口径。
/// </summary>
public class AutoLinkProcessorTests
{
    [Fact]
    public void BuildTitleToIdMap_DuplicateTitle_EarliestCreatedWins()
    {
        var map = AutoLinkProcessor.BuildTitleToIdMap(new[]
        {
            ("id-late", "双链设计", new DateTime(2026, 6, 2, 0, 0, 0, DateTimeKind.Utc)),
            ("id-early", "双链设计", new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc)),
            ("id-other", "另一篇", new DateTime(2026, 6, 3, 0, 0, 0, DateTimeKind.Utc)),
        });

        Assert.Equal("id-early", map["双链设计"]);
        Assert.Equal("id-other", map["另一篇"]);
    }

    [Fact]
    public void BuildTitleToIdMap_SameCreatedAt_TieBreakById()
    {
        var at = new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc);
        var map = AutoLinkProcessor.BuildTitleToIdMap(new[]
        {
            ("id-b", "同刻标题", at),
            ("id-a", "同刻标题", at),
        });

        Assert.Equal("id-a", map["同刻标题"]);
    }

    [Fact]
    public void BuildTitleToIdMap_Empty_ReturnsEmpty()
    {
        var map = AutoLinkProcessor.BuildTitleToIdMap(Array.Empty<(string, string, DateTime)>());
        Assert.Empty(map);
    }
}
