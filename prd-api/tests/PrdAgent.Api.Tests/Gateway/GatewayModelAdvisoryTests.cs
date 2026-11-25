using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Services;
using PrdAgent.GatewayTransport;
using PrdAgent.LlmGatewayHost;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayModelAdvisoryTests
{
    private const string Caller = "future-pilot.extract::chat";
    private const string Model = "future-v12-pro-2099-01-01";
    private const string Replacement = "future-v13-pro-2099-02-01";
    private const string Default = "future-chat-default";
    private const string Provider = "official-provider";
    private const string NoticeUrl = "https://docs.example.org/retirements";

    [Fact]
    public async Task ReadOnlyEndpointReturnsAnnouncedRetirementAndAuthorizedSameTierAlternatives()
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.ResolveModelMetadataAsync(Caller, "chat", "fixed-model", null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution { Success = true, LogicalModelPublicId = "fixed-model", ActualModel = Model, ActualPlatformId = Provider });
        gateway.Setup(x => x.ResolveModelMetadataAsync(Caller, "chat", null, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution { Success = true, LogicalModelPublicId = Default, ActualModel = Replacement, ActualPlatformId = Provider });
        gateway.Setup(x => x.GetAvailablePoolsAsync(Caller, "chat", It.IsAny<CancellationToken>()))
            .ReturnsAsync([
                Pool("fixed-model", Model),
                Pool("tiny-model", "future-v13-mini-2099-02-01"),
                Pool("broken-model", "future-v14-pro-2099-03-01", health: "Unavailable"),
                Pool(Default, Replacement, isDefault: true),
            ]);
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.AddConfiguration(NoticeConfiguration());
        builder.Services.AddSingleton(gateway.Object);
        builder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
        builder.Services.AddSingleton<GatewayCancellationRegistry>();
        GatewayAuthorizedTaskFixture.Register(builder.Services, null);
        await using var app = builder.Build();
        app.MapGatewayServingEndpoints(new(), "advisory-test-key", "advisory-tests");
        await app.StartAsync();

        using var http = app.GetTestClient();
        const string path = ModelLifecycleAdvisory.Path + "?modelType=chat&expectedModel=fixed-model";
        using var unauthorized = await http.GetAsync(path);
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
        http.DefaultRequestHeaders.Add("X-Gateway-Key", "advisory-test-key");
        http.DefaultRequestHeaders.Add("X-Gateway-App-Caller", Caller);
        http.DefaultRequestHeaders.Add("X-Gateway-Source", "map");
        using var response = await http.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = Assert.IsType<ModelLifecycleAdvisory>(await response.Content.ReadFromJsonAsync<ModelLifecycleAdvisory>());
        Assert.Equal("announced", result.Status);
        Assert.Equal(Model, result.ActualModel);
        Assert.Equal(DateTimeOffset.Parse("2099-04-30T06:00:00Z", System.Globalization.CultureInfo.InvariantCulture), result.Notice!.RetirementAt);
        Assert.Equal(Default, result.DefaultPublicId);
        Assert.True(result.DefaultAvailable);
        Assert.Equal(Replacement, Assert.Single(result.Recommendations).ActualModel);
        gateway.Verify(x => x.ResolveModelMetadataAsync(Caller, "chat", "fixed-model", null, null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task MissingOrUnavailableDefaultRemainsUnresolvedAndDoesNotRecommendAnArbitraryReplacement()
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.ResolveModelMetadataAsync(Caller, "chat", null, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution { Success = false });
        gateway.Setup(x => x.GetAvailablePoolsAsync(Caller, "chat", It.IsAny<CancellationToken>()))
            .ReturnsAsync([Pool(Default, Model, isDefault: true, health: "Unavailable"), Pool("other", Replacement)]);
        var result = await GatewayModelAdvisory.ReadAsync(gateway.Object, NoticeConfiguration(), Caller, "chat", null, default);

        Assert.Equal("unresolved", result.Status);
        Assert.Equal(Default, result.DefaultPublicId);
        Assert.False(result.DefaultAvailable);
        Assert.Null(result.Notice);
        Assert.Empty(result.Recommendations);
    }

    [Fact]
    public void IncorrectOrConflictingAnnouncementStaysUnknownAndTimeZoneChangesDoNotDuplicateReminders()
    {
        var at = new DateTimeOffset(2099, 4, 30, 14, 0, 0, TimeSpan.FromHours(8));
        var notice = new ModelRetirementNotice(Provider, Model, at, NoticeUrl);

        Assert.Null(ModelLifecycleAdvisory.MatchNotice([notice], "another-provider", Model));
        Assert.Null(ModelLifecycleAdvisory.MatchNotice([notice], Provider, "future-v12-pro"));
        Assert.Null(ModelLifecycleAdvisory.MatchNotice([notice with { Source = "http://docs.example.org" }], Provider, Model));
        Assert.Null(ModelLifecycleAdvisory.MatchNotice([notice, notice with { RetirementAt = at.AddDays(1) }], Provider, Model));
        Assert.Equal(notice, ModelLifecycleAdvisory.MatchNotice([notice, notice], Provider, Model));
        Assert.Equal(TapdModelAdvisoryWorker.DedupKey(notice),
            TapdModelAdvisoryWorker.DedupKey(notice with { RetirementAt = at.ToUniversalTime() }));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("fixed-model")]
    public async Task TapdDraftKeepsExplicitSelectionAndUsesExistingFormFallbackWhenNoModelCanRun(string? fixedModel)
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.StreamAsync(It.Is<GatewayRequest>(request => request.ExpectedModel == fixedModel),
            It.IsAny<CancellationToken>())).Returns(Unavailable());
        var service = new TapdBugAgentService(gateway.Object, Mock.Of<IHttpClientFactory>(),
            NullLogger<TapdBugAgentService>.Instance, new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { [TapdBugAgentService.ModelPublicIdKey] = fixedModel }).Build());
        var events = new List<(string Name, System.Text.Json.JsonElement Value)>();
        await service.StreamPreviewAsync(new TapdBugPreviewRequest { NaturalText = "提交按钮无法点击" }, (name, value) =>
        {
            events.Add((name, System.Text.Json.JsonSerializer.SerializeToElement(value)));
            return Task.CompletedTask;
        }, default);
        Assert.Contains(events, item => item.Name == "stage" && item.Value.GetProperty("stage").GetString() == "fallback");
        Assert.Contains(events, item => item.Name == "draft");
        Assert.DoesNotContain(events, item => item.Name == "model");
        gateway.Verify(x => x.StreamAsync(It.Is<GatewayRequest>(request => request.ExpectedModel == fixedModel),
            It.IsAny<CancellationToken>()), Times.Once);

        static async IAsyncEnumerable<GatewayStreamChunk> Unavailable()
        {
            await Task.CompletedTask;
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Error, Error = "MODEL_ROUTE_UNAVAILABLE" };
        }
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task DailyCheckRecordsGatewayFailureAndKeepsConfirmedNotificationDeduplicated()
    {
        var connection = Environment.GetEnvironmentVariable("LLMGW_TRACE_TEST_MONGO")
            ?? throw new InvalidOperationException("需要隔离的本地 Mongo 测试连接");
        var databaseName = "test_tapd_advisory_" + Guid.NewGuid().ToString("N");
        var database = new MongoDbContext(connection, databaseName);
        using var factory = new AdvisoryHttpFixture();
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://gateway.test",
            ["LlmGwServe:ApiKey"] = "gateway-test-key",
            ["TapdBugAgent:ModelPublicId"] = "fixed-model",
            ["TapdBugAgent:ModelAdvisory:NotifyUserIds:0"] = "configured-owner",
        }).Build();
        using var services = new ServiceCollection()
            .AddSingleton(database).AddSingleton<IConfiguration>(config)
            .AddSingleton<AdminPushDispatchSignal>().AddLogging()
            .AddSingleton(new HttpLlmGatewayClient(factory, config, NullLogger<HttpLlmGatewayClient>.Instance))
            .AddScoped<AdminNotificationEventService>().BuildServiceProvider();
        try
        {
            await database.Users.InsertOneAsync(new User
            {
                UserId = "configured-owner", Status = UserStatus.Active, UserType = UserType.Human,
            });
            var worker = new TapdModelAdvisoryWorker(services.GetRequiredService<IServiceScopeFactory>(), config,
                NullLogger<TapdModelAdvisoryWorker>.Instance);
            var states = database.Database.GetCollection<BsonDocument>(TapdModelAdvisoryWorker.StateCollection);
            factory.Result = new ModelLifecycleAdvisory("announced", DateTimeOffset.UtcNow, "fixed-model", Model,
                Default, true, new ModelRetirementNotice(Provider, Model, DateTimeOffset.UtcNow.AddDays(7), NoticeUrl), []);
            await worker.CheckDueAsync(default);
            await worker.CheckDueAsync(default);
            Assert.Equal(1, factory.Calls);
            var notification = await database.AdminNotifications.Find(_ => true).SingleAsync();
            Assert.Equal("configured-owner", notification.TargetUserId);
            Assert.Contains(NoticeUrl, notification.Message);
            Assert.True(await TapdModelAdvisoryWorker.IsCheckHealthyAsync(database, DateTime.UtcNow, false, default));

            await states.UpdateOneAsync(_ => true, Builders<BsonDocument>.Update.Set("NextCheckAt", DateTime.UnixEpoch));
            await worker.CheckDueAsync(default);
            Assert.Equal(2, factory.Calls);
            Assert.Equal(1, await database.AdminNotifications.CountDocumentsAsync(_ => true));

            await states.UpdateOneAsync(_ => true, Builders<BsonDocument>.Update.Set("NextCheckAt", DateTime.UnixEpoch));
            factory.Result = null;
            await worker.CheckDueAsync(default);
            var persisted = await states.Find(_ => true).SingleAsync();
            Assert.Equal("unknown", persisted["Status"].AsString);
            Assert.Equal(Model, persisted["ActualModel"].AsString);
            Assert.False(await TapdModelAdvisoryWorker.IsCheckHealthyAsync(database, DateTime.UtcNow, false, default));
            Assert.Equal(1, await database.AdminNotifications.CountDocumentsAsync(_ => true));
        }
        finally
        {
            await new MongoClient(connection).DropDatabaseAsync(databaseName);
        }
    }

    private sealed class AdvisoryHttpFixture : HttpMessageHandler, IHttpClientFactory
    {
        public ModelLifecycleAdvisory? Result { get; set; }
        public int Calls { get; private set; }

        public HttpClient CreateClient(string name) => new(new MapModelEgressHandler(name, new Uri("http://gateway.test"))
        {
            InnerHandler = this,
        }, disposeHandler: false);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal(ModelLifecycleAdvisory.Path, request.RequestUri!.AbsolutePath);
            Assert.Contains("expectedModel=fixed-model", request.RequestUri.Query);
            return Task.FromResult(Result is null ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(Result, options: new System.Text.Json.JsonSerializerOptions()) });
        }
    }

    private static IConfiguration NoticeConfiguration() => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["LlmGateway:ModelAdvisories:Notices:0:ModelId"] = Model,
        ["LlmGateway:ModelAdvisories:Notices:0:ProviderId"] = Provider,
        ["LlmGateway:ModelAdvisories:Notices:0:RetirementAt"] = "2099-04-30T14:00:00+08:00",
        ["LlmGateway:ModelAdvisories:Notices:0:Source"] = NoticeUrl,
    }).Build();

    private static AvailableModelPool Pool(string id, string model, bool isDefault = false, string health = "Healthy")
        => new()
        {
            Code = id, IsDefault = isDefault, Capabilities = ["chat", "json_mode"],
            Models = [new PoolModelInfo { HealthStatus = health, ActualModelId = model, ActualPlatformId = Provider }],
        };
}
