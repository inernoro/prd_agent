using System.Text.Json;
using PrdAgent.Api.Controllers.Api;
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
    public void Parse_RejectsAdditionalDataApartFromTheTerminator()
    {
        Assert.Throws<JsonException>(() => DesignArtifactsController.ParseBriefReply(Reply + "\n{}\n<<<END>>>"));
    }
}
