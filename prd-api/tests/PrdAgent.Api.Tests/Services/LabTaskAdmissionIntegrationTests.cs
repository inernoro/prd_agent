using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", "Integration")]
public sealed class LabTaskAdmissionIntegrationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DetachedReplyHasIndependentLeaseAfterHttpEndsAndStillHonorsRevocation(bool revoke)
    {
        await using var fixture = new Fixture();
        await fixture.SeedAsync();
        await fixture.InvokeAsync(true);
        var identity = await fixture.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            Assert.NotNull(identity?.Lease);
            var permit = await fixture.Permits.Find(x => x.Id == identity.PermitId).SingleAsync();
            Assert.Equal([AppCallerRegistry.Desktop.Chat.SendMessageChat], permit.AllowedAppCallerCodes);
            Assert.Equal("synthetic-actor", permit.ActorUserId);
            Assert.Equal(TaskExecutionLeaseStates.Completed, permit.Executions.Single(x => x.RunId == "").State);
            Assert.True(await fixture.Coordinator.ValidateAsync(identity.Lease, false, default));
            if (revoke) await fixture.Coordinator.RevokeAsync(identity.PermitId, identity.RunId, default);
            fixture.HttpFinished.TrySetResult();
            var outcome = await fixture.Finished.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(revoke ? "TASK_EXECUTION_LEASE_INVALID" : "allowed", outcome);
            Assert.True(fixture.UsedFreshScope);
            Assert.Equal(revoke ? 0 : 1, fixture.AuthorizedSends);
        }
        finally { fixture.HttpFinished.TrySetResult(); }
    }

    [Fact]
    public async Task PlainSimulatedMessageDoesNotAdmitOrSchedulePaidWork()
    {
        await using var fixture = new Fixture();
        await fixture.SeedAsync();
        await fixture.InvokeAsync(false);
        Assert.Equal(0, await fixture.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        Assert.False(fixture.Started.Task.IsCompleted);
        Assert.Equal(1, fixture.InsertedMessages);
    }

    [Fact]
    public async Task ReplayedPaidIntentDoesNotCreateAnotherSessionMessageOrBackgroundReply()
    {
        await using var fixture = new Fixture();
        await fixture.SeedAsync();
        var key = Guid.NewGuid().ToString("N");
        await fixture.InvokeAsync(true, key);
        await fixture.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var replay = await fixture.InvokeAsync(true, key);
        Assert.Equal("true", replay.Response.Headers["Idempotency-Replayed"].ToString());
        Assert.Equal(1, fixture.InsertedMessages);
        Assert.Equal(1, fixture.CreatedSessions);
        Assert.Equal(1, await fixture.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        fixture.HttpFinished.TrySetResult();
        Assert.Equal("allowed", await fixture.Finished.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("必须使用本任务独占本地Mongo。");
        private readonly string _name = "lab_admission_" + Guid.NewGuid().ToString("N");
        private readonly MongoClient _client;
        private readonly MongoDbContext _business;
        private readonly LlmGatewayDataContext _data;
        private readonly IConfiguration _configuration = new ConfigurationBuilder().Build();
        private readonly ServiceProvider _services;
        private readonly Mock<IChatService> _requestChat = new();
        private readonly Mock<IChatService> _backgroundChat = new();
        private readonly Mock<IMessageRepository> _messages = new();
        private readonly Mock<ISessionService> _sessions = new();
        public TaskExecutionCoordinator Coordinator { get; }
        public IMongoCollection<GatewayTaskPermitRecord> Permits => _data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
        public TaskCompletionSource<TaskExecutionIdentity?> Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource HttpFinished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<string> Finished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int InsertedMessages, CreatedSessions, AuthorizedSends;
        public bool UsedFreshScope;

        public Fixture()
        {
            var url = new MongoUrl(_connection);
            Assert.Equal("127.0.0.1", url.Server.Host); Assert.Null(url.Username);
            _client = new(_connection); _business = new(_connection, _name); _data = new(_connection, _name);
            Coordinator = new(_data);
            ConfigureChat(_requestChat, false); ConfigureChat(_backgroundChat, true);
            _messages.Setup(x => x.InsertManyAsync(It.IsAny<IEnumerable<Message>>()))
                .Callback(() => Interlocked.Increment(ref InsertedMessages)).Returns(Task.CompletedTask);
            _sessions.Setup(x => x.CreateAsync("document", "group")).Returns(() =>
            {
                Interlocked.Increment(ref CreatedSessions);
                return Task.FromResult(new Session { SessionId = Guid.NewGuid().ToString("N") });
            });
            _services = new ServiceCollection().AddSingleton(new TaskAdmissionService(_data, _configuration, executions: Coordinator))
                .AddSingleton<ITaskExecutionCoordinator>(Coordinator).AddScoped<IChatService>(_ => _backgroundChat.Object).BuildServiceProvider();
        }

        public Task SeedAsync() => _business.Groups.InsertOneAsync(new Group { GroupId = "group", PrdDocumentId = "document" });

        public async Task<DefaultHttpContext> InvokeAsync(bool paid, string? key = null)
        {
            var request = new SimulateMessageRequest { GroupId = "group", Content = "synthetic text", TriggerAiReply = paid };
            var http = new DefaultHttpContext { RequestServices = _services };
            http.User = new(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "synthetic-actor"), new Claim("authType", "jwt")], "session"));
            http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(new ControllerActionDescriptor
            {
                ControllerTypeInfo = typeof(LabController).GetTypeInfo(), ActionName = nameof(LabController.SimulateMessage),
                MethodInfo = typeof(LabController).GetMethod(nameof(LabController.SimulateMessage))!
            }), "lab"));
            http.Request.Method = "POST"; http.Request.Path = "/api/lab/simulate-message";
            http.Request.Headers["Idempotency-Key"] = key ?? Guid.NewGuid().ToString("N");
            http.Request.ContentType = "application/json";
            http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request)));
            http.Response.Body = new MemoryStream();
            var controller = new LabController(_business, _configuration, NullLogger<LabController>.Instance,
                _requestChat.Object, _messages.Object, Mock.Of<IGroupMessageStreamHub>(), _sessions.Object,
                Mock.Of<IGroupMessageSeqService>(), _services.GetRequiredService<IServiceScopeFactory>(),
                Mock.Of<IJwtService>(), Mock.Of<IAuthSessionService>()) { ControllerContext = new() { HttpContext = http } };
            await new TaskAdmissionMiddleware(async _ =>
            {
                using var bound = await JsonDocument.ParseAsync(http.Request.Body);
                Assert.IsType<OkObjectResult>(await controller.SimulateMessage(request));
            }).InvokeAsync(http, _services.GetRequiredService<TaskAdmissionService>());
            return http;
        }

        private void ConfigureChat(Mock<IChatService> chat, bool fresh)
            => chat.Setup(x => x.SendMessageAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<bool>(), It.IsAny<string?>(), It.IsAny<UserRole?>(), It.IsAny<CancellationToken>())).Returns(() => Stream(fresh));

        private async IAsyncEnumerable<ChatStreamEvent> Stream(bool fresh, [EnumeratorCancellation] CancellationToken ct = default)
        {
            UsedFreshScope = fresh;
            Started.TrySetResult(TaskExecutionContext.Current);
            await HttpFinished.Task.WaitAsync(TimeSpan.FromSeconds(10), ct);
            var outcome = "allowed";
            try
            {
                using var message = new HttpRequestMessage(HttpMethod.Post, "https://synthetic.invalid/no-send");
                await new TaskExecutionAuthorizer(_data, _configuration).AuthorizeOutboundAsync(message,
                    AppCallerRegistry.Desktop.Chat.SendMessageChat, new GatewayRequestContext { UserId = "synthetic-actor" }, default);
                Interlocked.Increment(ref AuthorizedSends);
            }
            catch (TaskExecutionAdmissionException ex) { outcome = ex.Code; }
            Finished.TrySetResult(outcome);
            yield return new ChatStreamEvent { Type = "done" };
        }

        public async ValueTask DisposeAsync()
        {
            HttpFinished.TrySetResult();
            if (Started.Task.IsCompleted) await Finished.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await _services.DisposeAsync();
            await _client.DropDatabaseAsync(_name);
        }
    }
}
