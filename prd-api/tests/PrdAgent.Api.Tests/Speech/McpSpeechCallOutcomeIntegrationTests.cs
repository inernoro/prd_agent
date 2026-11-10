using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Speech;

/// <summary>本地随机测试库验证异步产物结果，不依赖智能体调用任务查询工具。</summary>
[Trait("Category", "Integration")]
[Collection("Speech environment isolation")]
public sealed class McpSpeechCallOutcomeIntegrationTests : IAsyncLifetime
{
    private const string MongoConnection = "mongodb://127.0.0.1:27088/?serverSelectionTimeoutMS=5000";
    private readonly string databaseName = $"map_speech_test_{Guid.NewGuid():N}";
    private readonly string? previousProject = Environment.GetEnvironmentVariable("CDS_PROJECT_ID");
    private readonly MongoDbContext db;
    private readonly McpConsoleController controller;

    public McpSpeechCallOutcomeIntegrationTests()
    {
        Environment.SetEnvironmentVariable("CDS_PROJECT_ID", null);
        db = new MongoDbContext(MongoConnection, databaseName);
        var keys = new Mock<IAgentApiKeyService>();
        keys.Setup(x => x.ListByOwnerAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<AgentApiKey>());
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(x => x.GetEffectivePermissionsAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((IReadOnlyList<string>)Array.Empty<string>());
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner-a"), new Claim("isRoot", "1") }, "test")),
        };
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("map.test");
        controller = new McpConsoleController(db, keys.Object, permissions.Object,
            new McpUsageService(db, NullLogger<McpUsageService>.Instance))
        {
            ControllerContext = new ControllerContext { HttpContext = context },
        };
    }

    public async Task InitializeAsync() => await db.SpeechRuns.CountDocumentsAsync(FilterDefinition<SpeechRun>.Empty);
    public async Task DisposeAsync()
    {
        await new MongoClient(MongoConnection).DropDatabaseAsync(databaseName);
        Environment.SetEnvironmentVariable("CDS_PROJECT_ID", previousProject);
    }

    private async Task<McpCallLog> AddSpeechCallAsync(string status, string owner = "owner-a")
    {
        var run = new SpeechRun { OwnerUserId = owner, Environment = "SpeechTest", Status = status };
        await db.SpeechRuns.InsertOneAsync(run);
        var log = new McpCallLog
        {
            OwnerUserId = owner, KeyId = "speech-client", ToolName = "map_speech_generate", Capability = "speech",
            Status = "success", HttpStatus = 200, ArtifactKind = "audio-run", ArtifactId = run.Id,
            ArtifactStatus = SpeechRunStatus.Queued, ArtifactTitle = "语音任务", DeploymentSlug = null,
        };
        await db.McpCallLogs.InsertOneAsync(log);
        return log;
    }

    private static JsonElement Data(IActionResult result)
    {
        var response = Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.True(response.Success);
        return JsonSerializer.SerializeToElement(response.Data);
    }

    private async Task<JsonElement> CallsAsync(string? status = null, int skip = 0, int limit = 50)
        => Data(await controller.Calls(null, null, status, skip, limit, default));

    [Fact]
    public async Task CallsAndOverviewReadCurrentRunStateWithoutClientPolling()
    {
        var log = await AddSpeechCallAsync(SpeechRunStatus.Queued);
        var queued = Assert.Single((await CallsAsync()).GetProperty("items").EnumerateArray());
        Assert.Equal(SpeechRunStatus.Queued, queued.GetProperty("artifact").GetProperty("status").GetString());
        await db.SpeechRuns.UpdateOneAsync(x => x.Id == log.ArtifactId,
            Builders<SpeechRun>.Update.Set(x => x.Status, SpeechRunStatus.Failed).Set(x => x.ErrorMessage, "上游拒绝了音色参数"));
        var failed = Assert.Single((await CallsAsync()).GetProperty("items").EnumerateArray());
        Assert.Equal(SpeechRunStatus.Failed, failed.GetProperty("artifact").GetProperty("status").GetString());
        Assert.Equal("上游拒绝了音色参数", failed.GetProperty("errorMessage").GetString());
        var recent = Assert.Single(Data(await controller.Overview(default)).GetProperty("recentCalls").EnumerateArray());
        Assert.Equal(SpeechRunStatus.Failed, recent.GetProperty("artifact").GetProperty("status").GetString());
        // 富化只影响展示，不把异步失败改写成当初的HTTP提交失败。
        var persisted = await db.McpCallLogs.Find(x => x.Id == log.Id).SingleAsync();
        Assert.Equal("success", persisted.Status);
        Assert.Equal(200, persisted.HttpStatus);
    }

    [Fact]
    public async Task OutcomeFiltersCountBeforePaginationAndOnlyCompletedAudioIsSuccessful()
    {
        var queued = await AddSpeechCallAsync(SpeechRunStatus.Queued);
        var completed = await AddSpeechCallAsync(SpeechRunStatus.Completed);
        var failed = await AddSpeechCallAsync(SpeechRunStatus.Failed);
        var unknown = await AddSpeechCallAsync(SpeechRunStatus.Unknown);
        var ordinary = new McpCallLog { OwnerUserId = "owner-a", KeyId = "client", ToolName = "map_read", Status = "success" };
        await db.McpCallLogs.InsertOneAsync(ordinary);
        var errors = await CallsAsync("error");
        Assert.Equal(2, errors.GetProperty("total").GetInt64());
        Assert.Equal(new[] { failed.Id, unknown.Id }.OrderBy(x => x),
            errors.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetString()!).OrderBy(x => x));
        var errorPage = await CallsAsync("error", skip: 1, limit: 1);
        Assert.Equal(2, errorPage.GetProperty("total").GetInt64());
        Assert.Single(errorPage.GetProperty("items").EnumerateArray());
        var successes = await CallsAsync("success");
        Assert.Equal(2, successes.GetProperty("total").GetInt64());
        Assert.Equal(new[] { completed.Id, ordinary.Id }.OrderBy(x => x),
            successes.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetString()!).OrderBy(x => x));
        Assert.DoesNotContain(successes.GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetString() == queued.Id);
    }

    [Fact]
    public async Task ForeignOwnedArtifactCannotEnrichOrChangeTheOwnersFilteredResults()
    {
        var owned = await AddSpeechCallAsync(SpeechRunStatus.Completed);
        var foreign = await AddSpeechCallAsync(SpeechRunStatus.Failed, "owner-b");
        await db.SpeechRuns.UpdateOneAsync(x => x.Id == foreign.ArtifactId,
            Builders<SpeechRun>.Update.Set(x => x.ErrorMessage, "另一位用户的私密错误"));
        var foreignReference = new McpCallLog
        {
            OwnerUserId = "owner-a", KeyId = "speech-client", ToolName = "map_speech_generate", Capability = "speech",
            Status = "success", HttpStatus = 200, ArtifactKind = "audio-run", ArtifactId = foreign.ArtifactId,
            ArtifactStatus = SpeechRunStatus.Queued,
        };
        await db.McpCallLogs.InsertOneAsync(foreignReference);
        var all = await CallsAsync();
        Assert.Equal(2, all.GetProperty("total").GetInt64());
        var foreignDto = Assert.Single(all.GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetString() == foreignReference.Id);
        Assert.Equal(SpeechRunStatus.Queued, foreignDto.GetProperty("artifact").GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, foreignDto.GetProperty("errorMessage").ValueKind);
        Assert.Equal(0, (await CallsAsync("error")).GetProperty("total").GetInt64());
        var successful = Assert.Single((await CallsAsync("success")).GetProperty("items").EnumerateArray());
        Assert.Equal(owned.Id, successful.GetProperty("id").GetString());
    }
}
