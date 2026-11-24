using MongoDB.Bson;
using PrdAgent.LlmGw.Logs;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class LogAppCallerNamesTests
{
    [Fact]
    public void SnapshotPreservesNameAndSkipsCodePlaceholders()
    {
        var log = new BsonDocument
        {
            { "AppCallerCode", "example.summary" },
            { "AppCallerCodeDisplayName", " EXAMPLE.SUMMARY " },
            { "AppCallerTitle", "请求时的标题" },
        };

        Assert.Equal("请求时的标题", LogAppCallerNames.Snapshot(log));
        log["AppCallerCodeDisplayName"] = "历史显示名";
        Assert.Equal("历史显示名", LogAppCallerNames.Snapshot(log));
    }

    [Fact]
    public void RegisteredNameMatchesTheRequestTypeAndTeam()
    {
        var log = new BsonDocument
        {
            { "AppCallerCode", "example.summary" },
            { "RequestType", "CHAT" },
            { "TeamId", "team-a" },
        };
        var callers = new[]
        {
            Caller("chat", "team-b", "其他团队名称"),
            Caller("vision", "team-a", "图像摘要"),
            Caller("chat", "team-a", "文字摘要"),
        };

        Assert.Equal("文字摘要", LogAppCallerNames.RegisteredName(log, callers));
        log["RequestType"] = "embedding";
        Assert.Null(LogAppCallerNames.RegisteredName(log, callers));
    }

    [Fact]
    public void LegacyLogUsesOnlyAnUnambiguousRegisteredName()
    {
        var log = new BsonDocument("AppCallerCode", "example.summary");
        var chat = Caller("chat", "team-a", "文字摘要");
        var vision = Caller("vision", "team-a", "图像摘要");
        var placeholder = Caller("vision", "team-a", "example.summary");

        Assert.Equal("文字摘要", LogAppCallerNames.RegisteredName(log, [chat]));
        Assert.Null(LogAppCallerNames.RegisteredName(log, [chat, vision]));
        Assert.Null(LogAppCallerNames.RegisteredName(log, [chat, placeholder]));
        Assert.Null(LogAppCallerNames.RegisteredName(log, [placeholder]));
    }

    private static BsonDocument Caller(string type, string teamId, string title) => new()
    {
        { "AppCallerCode", "EXAMPLE.SUMMARY" },
        { "RequestType", type },
        { "TeamId", teamId },
        { "Title", title },
    };
}
