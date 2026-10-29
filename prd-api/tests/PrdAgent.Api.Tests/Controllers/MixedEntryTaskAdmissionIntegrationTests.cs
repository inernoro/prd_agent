using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Api.Services.DefectAgent;
using PrdAgent.Api.Services.ReviewAgent;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Services.MarketplaceSkills;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>真实控制器与隔离Mongo；发送沿真实Http客户端/Authorizer，到本地计数handler结束，零厂商调用。</summary>
[Trait("Category", "Integration")]
public sealed class MixedEntryTaskAdmissionIntegrationTests
{
    [Theory]
    [InlineData("provided")]
    [InlineData("rule")]
    [InlineData("no-skill")]
    [InlineData("optional-ai-offline")]
    public async Task UploadRemainsUsableWhenGovernanceStorageIsOffline(string mode)
    {
        await using var fixture = await Fixture.CreateAsync(offline: true);
        var controller = fixture.Marketplace();
        using var zip = Zip(mode == "rule" ? "# 标题\n这段规则描述足够长" : mode == "no-skill" ? null : "# 只有标题");
        IActionResult? response = null;
        await fixture.InvokeAsync(controller, async () => response = await controller.Upload(zip.File, "业务技能", mode == "provided" ? "用户填写描述" : null,
            null, null, null, null, null, null, CancellationToken.None));
        response.ShouldBeOfType<OkObjectResult>();
        var saved = await fixture.Business.MarketplaceSkills.Find(FilterDefinition<MarketplaceSkill>.Empty).SingleAsync();
        saved.OwnerUserId.ShouldBe("actor");
        saved.Description.ShouldNotBeNullOrWhiteSpace();
        fixture.Transport.Requests.Count.ShouldBe(0);
        TaskExecutionContext.Current.ShouldBeNull();
    }

    [Fact]
    public async Task MissingRuleSummaryEntersOnlyRegisteredPaidScopeAndRealAuthorizer()
    {
        await using var fixture = await Fixture.CreateAsync();
        var controller = fixture.Marketplace();
        using var zip = Zip("# 只有标题");
        IActionResult? response = null;
        await fixture.InvokeAsync(controller, async () => response = await controller.Upload(zip.File, "业务技能", null, null, null, null, null, null, null, CancellationToken.None));
        response.ShouldBeOfType<OkObjectResult>();
        await fixture.AssertPaidAsync(AppCallerRegistry.MarketplaceSkill.Summary, nameof(MarketplaceSkillsController.Upload), null);
        (await fixture.Business.MarketplaceSkills.Find(FilterDefinition<MarketplaceSkill>.Empty).SingleAsync()).Description.ShouldBe("平台摘要");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DefectCacheAndAclReadDoNotDependOnGovernanceStorage(bool unauthorized)
    {
        await using var fixture = await Fixture.CreateAsync(offline: true);
        var share = new DefectShareLink { CreatedBy = unauthorized ? "someone-else" : "actor", AiScoreStatus = AiScoreStatusType.Completed,
            AiScores = [new DefectAiScoreItem { DefectId = "cached-defect", OverallScore = 8 }] };
        await fixture.Business.DefectShareLinks.InsertOneAsync(share);
        var controller = fixture.Defect();
        await fixture.InvokeAsync(controller, () => controller.StreamScores(share.Id, CancellationToken.None));
        var sse = fixture.Output(controller);
        sse.ShouldContain(unauthorized ? "event: error" : "event: done");
        if (unauthorized) sse.ShouldNotContain("cached-defect");
        fixture.Transport.Requests.Count.ShouldBe(0);
        (await fixture.Business.DefectShareLinks.Find(x => x.Id == share.Id).SingleAsync()).AiScoreStatus.ShouldBe(AiScoreStatusType.Completed);
    }

    [Theory]
    [InlineData(ReviewStatuses.Done)]
    [InlineData(ReviewStatuses.Error)]
    [InlineData(ReviewStatuses.Running)]
    [InlineData("unauthorized")]
    public async Task ReviewCacheErrorRunningAndAclReadDoNotDependOnGovernanceStorage(string status)
    {
        await using var fixture = await Fixture.CreateAsync(offline: true);
        var cached = new ReviewResult { Summary = "cached-review", TotalScore = 80 };
        await fixture.Business.ReviewResults.InsertOneAsync(cached);
        var submission = new ReviewSubmission { SubmitterId = status == "unauthorized" ? "someone-else" : "actor",
            Status = status == "unauthorized" ? ReviewStatuses.Done : status, ResultId = cached.Id, ErrorMessage = "已有失败结果" };
        await fixture.Business.ReviewSubmissions.InsertOneAsync(submission);
        var controller = fixture.Review();
        await fixture.InvokeAsync(controller, () => controller.StreamReviewResult(submission.Id, CancellationToken.None));
        var sse = fixture.Output(controller);
        sse.ShouldContain(status == ReviewStatuses.Done ? "event: done" : "event: error");
        if (status == "unauthorized") sse.ShouldNotContain("cached-review");
        fixture.Transport.Requests.Count.ShouldBe(0);
        (await fixture.Business.ReviewSubmissions.Find(x => x.Id == submission.Id).SingleAsync()).Status.ShouldBe(submission.Status);
    }

    [Theory]
    [InlineData("defect")]
    [InlineData("review")]
    public async Task PaidStreamAuthorizesBeforeSettingRunningState(string kind)
    {
        await using var fixture = await Fixture.CreateAsync();
        if (kind == "defect")
        {
            var share = new DefectShareLink { CreatedBy = "actor" };
            await fixture.Business.DefectShareLinks.InsertOneAsync(share);
            await fixture.Defect().StreamScores(share.Id, CancellationToken.None);
            (await fixture.Business.DefectShareLinks.Find(x => x.Id == share.Id).SingleAsync()).AiScoreStatus.ShouldBe(AiScoreStatusType.Completed);
            await fixture.AssertPaidAsync(AppCallerRegistry.DefectAgent.Scoring.Chat, nameof(DefectAgentController.StreamScores), share.Id);
        }
        else
        {
            var submission = new ReviewSubmission { SubmitterId = "actor", Title = "真实内容", ExtractedContent = "用户故事、方案和验收条件的实际文本" };
            await fixture.Business.ReviewSubmissions.InsertOneAsync(submission);
            await fixture.Business.ReviewDimensionConfigs.InsertOneAsync(new ReviewDimensionConfig { Key = "quality", Name = "质量", MaxScore = 100 });
            await fixture.Review().StreamReviewResult(submission.Id, CancellationToken.None);
            (await fixture.Business.ReviewSubmissions.Find(x => x.Id == submission.Id).SingleAsync()).Status.ShouldBe(ReviewStatuses.Done);
            await fixture.AssertPaidAsync(AppCallerRegistry.ReviewAgent.Review.Chat, nameof(ReviewAgentController.StreamReviewResult), submission.Id);
        }
    }

    [Theory]
    [InlineData("defect")]
    [InlineData("review")]
    public async Task UnavailableAdmissionCannotLeavePaidWorkMarkedRunning(string kind)
    {
        await using var fixture = await Fixture.CreateAsync(offline: true);
        if (kind == "defect")
        {
            var share = new DefectShareLink { CreatedBy = "actor" };
            await fixture.Business.DefectShareLinks.InsertOneAsync(share);
            (await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => fixture.Defect().StreamScores(share.Id, CancellationToken.None))).StatusCode.ShouldBe(503);
            (await fixture.Business.DefectShareLinks.Find(x => x.Id == share.Id).SingleAsync()).AiScoreStatus.ShouldBe(AiScoreStatusType.None);
        }
        else
        {
            var submission = new ReviewSubmission { SubmitterId = "actor", ExtractedContent = "内容" };
            await fixture.Business.ReviewSubmissions.InsertOneAsync(submission);
            (await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => fixture.Review().StreamReviewResult(submission.Id, CancellationToken.None))).StatusCode.ShouldBe(503);
            (await fixture.Business.ReviewSubmissions.Find(x => x.Id == submission.Id).SingleAsync()).Status.ShouldBe(ReviewStatuses.Queued);
        }
        fixture.Transport.Requests.Count.ShouldBe(0);
    }

    [Fact]
    public async Task ReviewEmptyContentValidationDoesNotDependOnGovernanceStorage()
    {
        await using var fixture = await Fixture.CreateAsync(offline: true);
        var submission = new ReviewSubmission { SubmitterId = "actor" };
        await fixture.Business.ReviewSubmissions.InsertOneAsync(submission);
        await fixture.Review().StreamReviewResult(submission.Id, CancellationToken.None);
        var persisted = await fixture.Business.ReviewSubmissions.Find(x => x.Id == submission.Id).SingleAsync();
        persisted.Status.ShouldBe(ReviewStatuses.Error); persisted.ErrorMessage.ShouldBe("文件内容为空");
        persisted.StartedAt.ShouldBeNull(); fixture.Transport.Requests.Count.ShouldBe(0);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal MongoDbContext Business { get; }
        internal CapturedTransport Transport { get; } = new();
        private readonly LlmGatewayDataContext _governance;
        private readonly MongoClient _mongo;
        private readonly IConfiguration _config;
        private readonly ServiceProvider _services;
        private readonly ILLMRequestContextAccessor _accessor = new LLMRequestContextAccessor();
        private readonly HttpLlmGatewayClient _gateway;
        private readonly Mock<IAssetStorage> _storage = new();
        private readonly Mock<IHttpClientFactory> _factory = new();
        private Fixture(string connection, bool offline)
        {
            _mongo = new(connection);
            Business = new(connection, "mixed_entry_business_" + Guid.NewGuid().ToString("N"));
            _governance = new(offline ? "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=150&connectTimeoutMS=150" : connection,
                "mixed_entry_governance_" + Guid.NewGuid().ToString("N"));
            _config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                { ["Deployment:Identity"] = "controller-test", ["LlmGateway:ServeBaseUrl"] = "http://gateway-fixture.invalid", ["LlmGwServe:ApiKey"] = "isolated-test-transport" }).Build();
            _services = new ServiceCollection().AddSingleton(new TaskAdmissionService(_governance, _config)).BuildServiceProvider();
            _factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(new HttpClient(Transport));
            _gateway = new(_factory.Object, _config, NullLogger<HttpLlmGatewayClient>.Instance, _accessor,
                taskAuthorizer: new TaskExecutionAuthorizer(_governance, _config));
            _storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>())).Returns<string>(key => "http://asset-fixture.invalid/" + key);
            _storage.Setup(x => x.UploadToKeyAsync(It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(), It.IsAny<CancellationToken>(), It.IsAny<string?>())).Returns(Task.CompletedTask);
        }
        internal static async Task<Fixture> CreateAsync(bool offline = false)
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? throw new InvalidOperationException("必须提供隔离本地Mongo，禁止静默跳过。");
            var address = new MongoUrl(connection);
            address.Server.Host.ShouldBe("127.0.0.1"); address.Username.ShouldBeNull();
            BsonClassMapRegistration.RegisterConventionsOnly();
            var fixture = new Fixture(connection, offline);
            await fixture.Business.Database.RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            await fixture.Business.Users.InsertOneAsync(new User { UserId = "actor", Username = "actor", DisplayName = "操作人" });
            return fixture;
        }
        internal MarketplaceSkillsController Marketplace() => Attach(new MarketplaceSkillsController(Business, _gateway, _accessor, _storage.Object,
            new SkillZipMetadataExtractor(), _config, _factory.Object, NullLogger<MarketplaceSkillsController>.Instance, new MemoryCache(new MemoryCacheOptions())), nameof(MarketplaceSkillsController.Upload));
        internal DefectAgentController Defect() => Attach(new DefectAgentController(Business, _gateway, NullLogger<DefectAgentController>.Instance,
            _storage.Object, Mock.Of<ICacheManager>(), null!, Mock.Of<IOpenPlatformService>(), _accessor, Mock.Of<IAgentApiKeyService>(), _config,
            _factory.Object, new DefectPolishService(_gateway, Business, NullLogger<DefectPolishService>.Instance), new AdminPushDispatchSignal()), nameof(DefectAgentController.StreamScores));
        internal ReviewAgentController Review() => Attach(new ReviewAgentController(Business, _gateway, NullLogger<ReviewAgentController>.Instance,
            new ReviewWebhookService(Business, _factory.Object, NullLogger<ReviewWebhookService>.Instance, _config, Mock.Of<ISafeOutboundUrlValidator>()), _storage.Object), nameof(ReviewAgentController.StreamReviewResult));
        private T Attach<T>(T controller, string action) where T : ControllerBase
        {
            var http = new DefaultHttpContext { RequestServices = _services, User = new ClaimsPrincipal(new ClaimsIdentity(new[]
                { new Claim(ClaimTypes.NameIdentifier, "actor"), new Claim("authType", "jwt"), new Claim("jti", "controller-session") }, "session")) };
            http.Response.Body = new MemoryStream();
            var descriptor = new ControllerActionDescriptor { ControllerTypeInfo = typeof(T).GetTypeInfo(), ActionName = action, MethodInfo = typeof(T).GetMethod(action)! };
            http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(descriptor), action));
            controller.ControllerContext = new ControllerContext { HttpContext = http };
            return controller;
        }
        internal string Output(ControllerBase controller) => Encoding.UTF8.GetString(((MemoryStream)controller.Response.Body).ToArray());
        internal Task InvokeAsync(ControllerBase controller, Func<Task> action)
            => new TaskAdmissionMiddleware(_ => action()).InvokeAsync(controller.HttpContext, _services.GetRequiredService<TaskAdmissionService>());
        internal async Task AssertPaidAsync(string caller, string action, string? run)
        {
            var request = Transport.Requests.Single();
            request.AppCallerCode.ShouldBe(caller);
            request.Context!.ExecutionOrigin.ShouldBe(TaskExecutionOrigins.Interactive);
            request.Context.UserId.ShouldBe("actor"); request.Context.TriggerActorUserId.ShouldBe("actor");
            var permit = await _governance.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
                .Find(x => x.Id == request.Context.TaskPermitId).SingleAsync();
            permit.AllowedAppCallerCodes.ShouldBe(new[] { caller });
            permit.SourceTask.ShouldEndWith("." + action);
            if (run is not null) permit.BoundRunIds.ShouldBe(new[] { run });
            TaskExecutionContext.Current.ShouldBeNull();
        }
        public async ValueTask DisposeAsync()
        {
            _services.Dispose();
            await _mongo.DropDatabaseAsync(Business.Database.DatabaseNamespace.DatabaseName);
            await _mongo.DropDatabaseAsync(_governance.DatabaseName);
        }
    }

    private sealed class CapturedTransport : HttpMessageHandler
    {
        internal List<GatewayRequest> Requests { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage message, CancellationToken ct)
        {
            var request = JsonSerializer.Deserialize<GatewayRequest>(await message.Content!.ReadAsStringAsync(ct))!;
            request.Context!.TaskPermitId.ShouldBe(message.Headers.GetValues("X-Gateway-Task-Permit").Single());
            Requests.Add(request);
            if (message.RequestUri!.AbsolutePath.EndsWith("/send"))
                return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new GatewayResponse { Success = true, StatusCode = 200, Content = "平台摘要" }), Encoding.UTF8, "application/json") };
            var text = request.AppCallerCode == AppCallerRegistry.DefectAgent.Scoring.Chat ? "[]"
                : "{\"dimensions\":[{\"key\":\"quality\",\"score\":70,\"comment\":\"具体评价\"}],\"summary\":\"评审已完成\"}";
            return new(HttpStatusCode.OK) { Content = new StringContent("data: " + JsonSerializer.Serialize(GatewayStreamChunk.Text(text)) + "\n\n", Encoding.UTF8, "text/event-stream") };
        }
    }
    private sealed record ZipInput(MemoryStream Stream, FormFile File) : IDisposable { public void Dispose() => Stream.Dispose(); }
    private static ZipInput Zip(string? skill)
    {
        var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, true))
        using (var writer = new StreamWriter(zip.CreateEntry(skill is null ? "README.md" : "SKILL.md").Open())) writer.Write(skill ?? "说明");
        stream.Position = 0;
        return new(stream, new FormFile(stream, 0, stream.Length, "file", "skill.zip"));
    }
}
