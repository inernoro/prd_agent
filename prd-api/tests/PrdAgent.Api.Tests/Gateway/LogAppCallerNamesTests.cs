using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;
using PrdAgent.LlmGatewayHost;
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

    [Theory]
    [InlineData(true, "llmgw-console", "Quickstart 用途推导")]
    [InlineData(null, "llmgw-console", "Quickstart 用途推导")]
    [InlineData(false, "llmgw-console", null)]
    [InlineData(null, "external", null)]
    public void CodePlaceholderUsesDefaultTitleOnlyForTheOwnedSystemRegistration(
        bool? systemManaged, string sourceSystem, string? expected)
    {
        const string code = "llmgw-console.intent-draft::chat";
        var log = new BsonDocument { { "AppCallerCode", code }, { "TeamId", "system-team" }, { "RequestType", "chat" } };
        var caller = new BsonDocument(log) { { "Title", code }, { "SourceSystem", sourceSystem } };
        if (systemManaged.HasValue) caller["SystemManaged"] = systemManaged.Value;

        Assert.Equal(expected, LogAppCallerNames.RegisteredName(log, [caller]));
        caller["Title"] = "已登记的用途名";
        Assert.Equal("已登记的用途名", LogAppCallerNames.RegisteredName(log, [caller]));
    }

    [Fact, Trait("Category", "Integration")]
    public async Task ObservingRequestsWithoutAMeaningfulTitlePreservesTheRegisteredName()
    {
        var connection = Environment.GetEnvironmentVariable("LLMGW_TRACE_TEST_MONGO")
            ?? throw new InvalidOperationException("显式指定隔离 Mongo：LLMGW_TRACE_TEST_MONGO");
        var dbName = "app_caller_names_" + Guid.NewGuid().ToString("N");
        var data = new LlmGatewayDataContext(connection, dbName);
        using var services = new ServiceCollection().AddSingleton(data).BuildServiceProvider();
        var observe = typeof(GatewayHttpEndpoints).GetMethod("RecordDiscoveredAppCallerAsync", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(observe);
        var callers = data.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers");
        const string code = "example.summary::chat";
        try
        {
            await callers.InsertOneAsync(new GatewayAppCallerRecord
            {
                TenantId = "tenant-a", TeamId = "team-a", AppCallerCode = code, RequestType = "chat", Title = "文字摘要",
            });
            foreach (var title in new[] { null, code.ToUpperInvariant() })
            {
                var ingress = new GatewayIngressRequest
                {
                    RequestId = Guid.NewGuid().ToString("N"), IngressProtocol = "gw-native", RequestType = "chat",
                    AppCallerCode = code, AppCallerTitle = title, Context = new GatewayRequestContext { TenantId = "tenant-a", TeamId = "team-a" },
                };
                Assert.True(await (Task<bool>)observe!.Invoke(null, [services, ingress, CancellationToken.None])!);
                Assert.Equal("文字摘要", (await callers.Find(_ => true).SingleAsync()).Title);
            }
        }
        finally
        {
            await data.Database.Client.DropDatabaseAsync(dbName);
        }
    }

    private static BsonDocument Caller(string type, string teamId, string title) => new()
    {
        { "AppCallerCode", "EXAMPLE.SUMMARY" },
        { "RequestType", type },
        { "TeamId", teamId },
        { "Title", title },
    };
}
