using System.Text.Json;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class QuickCreationBriefReplyTests
{
    private const string Reply = "这支宣传片要讲哪个产品？\n\n<<<BRIEF>>>\n"
        + """{"kind":"video","quickReplies":["新产品发布","团队招募"],"startRequested":false}""";

    [Theory]
    [InlineData("")]
    [InlineData("\n<<<END>>>\n")]
    public void Parse_PreservesBriefAndChoicesWhenModelAddsTerminator(string suffix)
    {
        var (text, brief) = DesignArtifactsController.ParseBriefReply(Reply + suffix);

        Assert.Equal("这支宣传片要讲哪个产品？", text);
        Assert.Equal("video", brief.Kind);
        Assert.Equal(new[] { "新产品发布", "团队招募" }, brief.QuickReplies);
        Assert.False(brief.StartRequested);
    }

    [Fact]
    public void FreezeBriefUserRequests_UsesOnlyVerbatimUserRequestsInOrder()
    {
        QuickCreationBriefMessage[] messages =
        [
            new("selection", "user", "只展示第二部分\n保留标题原文"),
            new("reply", "agent", "助手的理解回复"),
            new("constraint", "user", "不要出现联系方式"),
            new("confirmation", "user", "可以开始了。"),
        ];

        Assert.Equal("只展示第二部分\n保留标题原文\n\n不要出现联系方式",
            DesignArtifactsController.FreezeBriefUserRequests(messages));
        Assert.Empty(DesignArtifactsController.FreezeBriefUserRequests([]));
    }

    [Fact]
    public void Parse_RejectsAdditionalDataApartFromTheTerminator()
    {
        Assert.Throws<JsonException>(() => DesignArtifactsController.ParseBriefReply(Reply + "\n{}\n<<<END>>>"));
    }
}
