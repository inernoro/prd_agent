using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>真实建群控制器、后台建议服务和模型业务链；只用独立 Mongo，发送端为本地替身。</summary>
public sealed class GroupNameTaskAdmissionTests : IAsyncLifetime
{
    private const string Caller = AppCallerRegistry.Desktop.GroupName.SuggestIntent;
    private LlmGatewayDataContext _data = null!;
    private MongoDbContext _business = null!;
    private IConfiguration _configuration = null!;
    private string _database = "";
    private IMongoCollection<GatewayTaskPermitRecord> Permits =>
        _data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);

    public Task InitializeAsync()
    {
        var connection = Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION") ?? "";
        var address = new MongoUrl(connection);
        Assert.Single(address.Servers);
        Assert.Equal("127.0.0.1", address.Server.Host);
        Assert.Equal(27389, address.Server.Port);
        Assert.Null(address.Username);
        _database = "phase1_group_name_" + Guid.NewGuid().ToString("N");
        _data = new(connection, _database);
        _business = new(connection, _database);
        _configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["Deployment:Identity"] = "synthetic-group-deployment" }).Build();
        return Task.CompletedTask;
    }

    [DesignScopeMongoTheory]
    [InlineData("手工群名", "test-prd")]
    [InlineData(null, null)]
    public async Task ManualNameOrNoDocument_CreatesGroupWithoutGovernanceLookup(string? name, string? document)
    {
        var offline = Offline();
        var admission = new TaskAdmissionService(offline, _configuration);
        var fixture = new GroupFixture(_business, _data, _configuration);
        var http = AuthenticatedCreate();
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        http.RequestServices = services;
        var controller = fixture.Controller(http);
        IActionResult? result = null;
        await new TaskAdmissionMiddleware(async _ =>
        {
            Assert.Null(TaskExecutionContext.Current);
            result = await controller.Create(new CreateGroupRequest { GroupName = name, PrdDocumentId = document });
        }).InvokeAsync(http, admission);
        Assert.IsType<CreatedAtActionResult>(result);
        fixture.Gateway.VerifyNoOtherCalls();
        fixture.Groups.Verify(item => item.GetByIdAsync(It.IsAny<string>()), Times.Never);
        Assert.Empty(fixture.ControllerLog.Messages);
        Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task GovernanceUnavailable_KeepsCreatedGroup_AndDoesNotEnqueueNameSuggestion()
    {
        var admission = new TaskAdmissionService(Offline(), _configuration);
        var fixture = new GroupFixture(_business, _data, _configuration);
        var http = AuthenticatedCreate();
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        http.RequestServices = services;
        IActionResult? result = null;
        await new TaskAdmissionMiddleware(async _ =>
        {
            result = await fixture.Controller(http).Create(new CreateGroupRequest { PrdDocumentId = "test-prd" });
        }).InvokeAsync(http, admission);
        Assert.IsType<CreatedAtActionResult>(result);
        fixture.Groups.Verify(item => item.CreateAsync("actor", "test-prd", It.IsAny<string>(),
            It.IsAny<string?>(), It.IsAny<int?>(), It.IsAny<int?>()), Times.Once);
        fixture.Groups.Verify(item => item.GetByIdAsync(It.IsAny<string>()), Times.Never);
        fixture.Gateway.VerifyNoOtherCalls();
        Assert.Contains(fixture.ControllerLog.Messages, message => message.Contains("TASK_EXECUTION_UNAVAILABLE", StringComparison.Ordinal)
            && message.Contains("群组已创建", StringComparison.Ordinal));
        Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoTheory]
    [InlineData("Bearer", null, TaskExecutionOrigins.Interactive)]
    [InlineData("ApiKey", "agent-apikey", TaskExecutionOrigins.Agent)]
    public async Task RealCreateAndBackgroundChain_RestoresSamePermit_BindsGroupAndPreservesTrustedOrigin(
        string scheme, string? auth, string origin)
    {
        var admission = new TaskAdmissionService(_data, _configuration);
        var fixture = new GroupFixture(_business, _data, _configuration);
        var http = AuthenticatedCreate(scheme, auth);
        http.Request.Headers["X-Gateway-Execution-Origin"] = origin == TaskExecutionOrigins.Agent ? "interactive" : "agent";
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        http.RequestServices = services;
        IActionResult? result = null;
        await new TaskAdmissionMiddleware(async _ =>
        {
            Assert.Null(TaskExecutionContext.Current);
            result = await fixture.Controller(http).Create(new CreateGroupRequest { PrdDocumentId = "test-prd" });
        }).InvokeAsync(http, admission);
        Assert.IsType<CreatedAtActionResult>(result);
        Assert.Null(TaskExecutionContext.Current);
        var captured = await fixture.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var permit = await Permits.Find(FilterDefinition<GatewayTaskPermitRecord>.Empty).SingleAsync();
        Assert.Equal(permit.Id, captured!.PermitId);
        Assert.Equal(fixture.Group.GroupId, captured.RunId);
        Assert.Equal([Caller], permit.AllowedAppCallerCodes);
        Assert.Equal(1, permit.MaxCalls);
        Assert.Equal(origin, permit.Origin);
        using (TaskExecutionContext.Enter(new(Guid.NewGuid().ToString("N"), "unrelated-request")))
        {
            fixture.ReleaseRead.TrySetResult();
            await fixture.Updated.Task.WaitAsync(TimeSpan.FromSeconds(10));
        }
        var paid = Assert.Single(fixture.AuthorizedRequests);
        Assert.Equal(permit.Id, paid.TaskPermitId);
        Assert.Equal(fixture.Group.GroupId, paid.RunId);
        Assert.Equal("actor", paid.UserId);
        Assert.Equal("actor", paid.TriggerActorUserId);
        Assert.Equal(origin, paid.ExecutionOrigin);
        Assert.Equal(1, fixture.PaidSends);
        Assert.Equal("测试群名建议", fixture.Group.GroupName);
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal([fixture.Group.GroupId], unchanged.BoundRunIds);
        Assert.Equal(0, unchanged.CallCount); // MAP 准备不计费，本地上游替身不调用 serving。
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task PermitExpiresAfterEnqueue_RealAuthorizerPreventsPaidSendAndNameUpdate()
    {
        var admission = new TaskAdmissionService(_data, _configuration);
        var fixture = new GroupFixture(_business, _data, _configuration);
        var http = AuthenticatedCreate();
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        http.RequestServices = services;
        IActionResult? result = null;
        await new TaskAdmissionMiddleware(async _ =>
        {
            result = await fixture.Controller(http).Create(new CreateGroupRequest { PrdDocumentId = "test-prd" });
        }).InvokeAsync(http, admission);
        Assert.IsType<CreatedAtActionResult>(result);
        var captured = await fixture.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Permits.UpdateOneAsync(item => item.Id == captured!.PermitId,
            Builders<GatewayTaskPermitRecord>.Update.Set(item => item.ExpiresAt, DateTime.UtcNow.AddSeconds(-1)));
        fixture.ReleaseRead.TrySetResult();
        var diagnosis = await fixture.ServiceLog.Diagnosed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("TASK_EXECUTION_LEASE_INVALID", diagnosis, StringComparison.Ordinal);
        Assert.Equal(0, fixture.PaidSends);
        Assert.Empty(fixture.AuthorizedRequests);
        fixture.Groups.Verify(item => item.UpdateGroupNameAsync(It.IsAny<string>(), It.IsAny<string>()), Times.Never);
        var unchanged = await Permits.Find(item => item.Id == captured!.PermitId).SingleAsync();
        Assert.Equal([fixture.Group.GroupId], unchanged.BoundRunIds);
        Assert.Equal(0, unchanged.CallCount);
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task ServiceWithoutPermit_NeverBorrowsUserOrMintsAuthority()
    {
        var fixture = new GroupFixture(_business, _data, _configuration);
        using var execution = TaskExecutionContext.Enter(null);
        fixture.Service.EnqueueGroupNameSuggestion(fixture.Group.GroupId, null, "test-prd");
        var diagnosis = await fixture.ServiceLog.Diagnosed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("缺少任务执行许可", diagnosis, StringComparison.Ordinal);
        fixture.Groups.Verify(item => item.GetByIdAsync(It.IsAny<string>()), Times.Never);
        fixture.Gateway.VerifyNoOtherCalls();
        Assert.Equal(0, fixture.PaidSends);
        Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    public async Task DisposeAsync() => await _data.Database.Client.DropDatabaseAsync(_database);

    private static LlmGatewayDataContext Offline() => new(
        "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200", "phase1_offline");

    private static DefaultHttpContext AuthenticatedCreate(string scheme = "Bearer", string? auth = null)
    {
        var http = new DefaultHttpContext();
        http.Request.Headers["Idempotency-Key"] = Guid.NewGuid().ToString("N");
        http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(
            new ControllerActionDescriptor
            {
                ControllerTypeInfo = typeof(GroupsController).GetTypeInfo(),
                ActionName = nameof(GroupsController.Create),
            }), "real-groups-create"));
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, "actor") };
        if (auth is not null) claims.Add(new("authType", auth));
        http.User = new ClaimsPrincipal(new ClaimsIdentity(claims, scheme));
        return http;
    }

    private sealed class GroupFixture
    {
        public Group Group { get; } = new() { GroupId = "actual-group", OwnerId = "actor", GroupName = "产品需求文档" };
        public Mock<IGroupService> Groups { get; } = new(MockBehavior.Strict);
        public Mock<ILlmGateway> Gateway { get; } = new(MockBehavior.Strict);
        public TaskCompletionSource<TaskExecutionIdentity?> ReadStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleaseRead { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Updated { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public RecordingLogger<GroupsController> ControllerLog { get; } = new();
        public RecordingLogger<GroupNameSuggestionService> ServiceLog { get; } = new();
        public ConcurrentQueue<GatewayRequestContext> AuthorizedRequests { get; } = new();
        public GroupNameSuggestionService Service { get; }
        public int PaidSends;
        private readonly Mock<IDocumentService> _documents = new(MockBehavior.Strict);
        private readonly Mock<IUserService> _users = new(MockBehavior.Strict);
        private readonly Mock<IGroupBotService> _bots = new(MockBehavior.Strict);
        private readonly MongoDbContext _business;
        private readonly IConfiguration _configuration;

        public GroupFixture(MongoDbContext business, LlmGatewayDataContext data, IConfiguration configuration)
        {
            _business = business;
            _configuration = configuration;
            Groups.Setup(item => item.CreateAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
                    It.IsAny<string?>(), It.IsAny<int?>(), It.IsAny<int?>()))
                .Returns((string owner, string document, string? name, string? title, int? tokens, int? chars) =>
                {
                    Group.OwnerId = owner; Group.PrdDocumentId = document; Group.GroupName = name ?? "新建群组";
                    return Task.FromResult(Group);
                });
            Groups.Setup(item => item.GetMembersAsync(Group.GroupId)).ReturnsAsync([]);
            Groups.Setup(item => item.GetByIdAsync(Group.GroupId)).Returns(async () =>
            {
                ReadStarted.TrySetResult(TaskExecutionContext.Current);
                await ReleaseRead.Task;
                return Group;
            });
            Groups.Setup(item => item.UpdateGroupNameAsync(Group.GroupId, It.IsAny<string>()))
                .Returns((string _, string name) =>
                {
                    Group.GroupName = name;
                    Updated.TrySetResult();
                    return Task.CompletedTask;
                });
            _users.Setup(item => item.GetByIdAsync("actor")).ReturnsAsync(new User { UserId = "actor" });
            _documents.Setup(item => item.GetByIdAsync("test-prd")).ReturnsAsync(new ParsedPrd
            {
                Id = "test-prd", Title = "产品需求文档", RawContent = "# 测试产品\n提供需求协作能力。", CharCount = 20,
            });
            _bots.Setup(item => item.EnsureDefaultRoleBotsInGroupAsync(Group.GroupId)).ReturnsAsync(Array.Empty<User>());
            var context = new LLMRequestContextAccessor();
            Gateway.Setup(item => item.CreateClient(Caller, "intent", 4096, 0.2, false, null, null, null))
                .Returns(new GatewayLLMClient(Gateway.Object, Caller, "intent", contextAccessor: context));
            Gateway.Setup(item => item.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
                .Returns((GatewayRequest request, CancellationToken ct) => SendLocallyAsync(request, data, configuration, ct));
            var modelDomain = new ModelDomainService(business, Mock.Of<IHttpClientFactory>(), configuration,
                Mock.Of<ILlmRequestLogWriter>(), context, Gateway.Object, NullLogger<ClaudeClient>.Instance);
            Service = new GroupNameSuggestionService(Groups.Object, _documents.Object, modelDomain, ServiceLog, new TaskExecutionCoordinator(data));
        }

        public GroupsController Controller(HttpContext http) => new(Groups.Object, _bots.Object, _documents.Object,
            _users.Object, null!, null!, null!, ControllerLog, _business, null!, _configuration, Service, null!, null!)
        { ControllerContext = new ControllerContext { HttpContext = http } };

        private async IAsyncEnumerable<GatewayStreamChunk> SendLocallyAsync(GatewayRequest request,
            LlmGatewayDataContext data, IConfiguration configuration, [EnumeratorCancellation] CancellationToken ct)
        {
            using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
            await new TaskExecutionAuthorizer(data, configuration).AuthorizeOutboundAsync(message,
                request.AppCallerCode, request.Context, ct);
            AuthorizedRequests.Enqueue(request.Context!);
            Interlocked.Increment(ref PaidSends);
            yield return GatewayStreamChunk.Text("测试群名建议");
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Done };
        }
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public ConcurrentQueue<string> Messages { get; } = new();
        public TaskCompletionSource<string> Diagnosed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (logLevel < LogLevel.Warning) return;
            var message = formatter(state, exception);
            Messages.Enqueue(message);
            Diagnosed.TrySetResult(message);
        }
    }
}
