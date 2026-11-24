using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Middleware;

// Only fabricated credentials and strict in-memory Mongo/cache mocks. No account, login or database calls.
public sealed class AuthUserCredentialLoggingTests
{
    private const string FakePassword = "fake-password-for-log-boundary-only";
    private const string FakeToken = "fake-access-token-for-log-boundary-only";

    [Theory]
    [InlineData("/api/v1/auth")]
    [InlineData("/api/v1/auth/")]
    [InlineData("/api/v1/auth/login")]
    [InlineData("/api/v1/auth/register")]
    [InlineData("/api/v1/auth/refresh")]
    [InlineData("/api/v1/auth/reset-password")]
    [InlineData("/api/v1/auth/change-password")]
    [InlineData("/api/v1/auth/miduo-planet/login")]
    [InlineData("/API/V1/AUTH/LOGIN")]
    [InlineData("/api/users")]
    [InlineData("/api/users/")]
    [InlineData("/api/users/bulk")]
    [InlineData("/api/users/fake-user/password")]
    [InlineData("/api/users/fake-user/force-expire")]
    [InlineData("/API/USERS/fake-user/password")]
    [InlineData("/api/chat-agent")]
    [InlineData("/api/chat-agent/sessions/fake-session/messages")]
    [InlineData("/API/CHAT-AGENT/sessions/fake-session/stream")]
    [InlineData("/api/agent-tools")]
    [InlineData("/api/agent-tools/invoke")]
    [InlineData("/API/AGENT-TOOLS/approvals/fake-run/fake-approval/wait")]
    public void AuthAndUserFamiliesExcludeBodies(string path)
        => Assert.True(RequestLogRedactionProbe.CarriesCredential(path));

    [Theory]
    [InlineData("/api/users-history")]
    [InlineData("/api/usersettings")]
    [InlineData("/api/v1/authorizations")]
    [InlineData("/api/v1/auth-health")]
    [InlineData("/api/authz/users/fake-user/authz")]
    [InlineData("/api/document-store/stores")]
    [InlineData("/api/chat-agent-health")]
    [InlineData("/api/chat-agents")]
    [InlineData("/api/agent-tools-console")]
    [InlineData("/api/agent-toolsmith")]
    public void AdjacentRoutesKeepTheirExistingDiagnostics(string path)
        => Assert.False(RequestLogRedactionProbe.CarriesCredential(path));

    [Theory]
    [InlineData("/api/v1/auth/login", 200, false)]
    [InlineData("/api/v1/auth/login", 401, false)]
    [InlineData("/api/v1/auth/reset-password", 200, false)]
    [InlineData("/api/users", 200, false)]
    [InlineData("/api/users/bulk", 400, false)]
    [InlineData("/api/users/fake-user/password", 200, false)]
    [InlineData("/api/v1/auth/login", 200, true)]
    public async Task BodiesStayOnTransportButNeverReachFinalSharedLog(string path, int statusCode, bool stream)
    {
        var fixture = new LogFixture();
        var context = NewContext(path, stream);
        var requestBody = JsonSerializer.Serialize(new { username = "fake-user", password = FakePassword });
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(requestBody));
        context.Request.ContentLength = context.Request.Body.Length;
        var output = (MemoryStream)context.Response.Body;
        var responseBody = JsonSerializer.Serialize(new { success = statusCode < 400, data = new { accessToken = FakeToken } });
        var middleware = new RequestResponseLoggingMiddleware(async ctx =>
        {
            Assert.Equal(requestBody, await new StreamReader(ctx.Request.Body, leaveOpen: true).ReadToEndAsync());
            ctx.Response.StatusCode = statusCode;
            ctx.Response.ContentType = stream ? "text/event-stream" : "application/json";
            await ctx.Response.WriteAsync(responseBody);
        }, NullLogger<RequestResponseLoggingMiddleware>.Instance, fixture.Db, fixture.Cache.Object);

        await middleware.InvokeAsync(context);

        Assert.Equal(responseBody, Encoding.UTF8.GetString(output.ToArray()));
        var log = Assert.Single(fixture.Completed);
        Assert.Null(log.RequestBody);
        Assert.Null(log.ResponseBody);
        Assert.DoesNotContain(FakePassword, JsonSerializer.Serialize(log));
        Assert.DoesNotContain(FakeToken, JsonSerializer.Serialize(log));
        AssertMetadata(context, log, path, statusCode, stream);
    }

    [Theory]
    [InlineData("/api/v1/auth/login")]
    [InlineData("/api/users")]
    [InlineData("/api/chat-agent/sessions/fake-session/messages")]
    [InlineData("/api/agent-tools/invoke")]
    public async Task DelayedPreinsertAlsoExcludesRequestCredentials(string path)
    {
        var fixture = new LogFixture();
        var context = NewContext(path, false);
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { password = FakePassword })));
        context.Request.ContentLength = context.Request.Body.Length;
        await new RequestResponseLoggingMiddleware(async ctx =>
        {
            var running = await fixture.Running.Task.WaitAsync(TimeSpan.FromSeconds(8));
            Assert.Equal("running", running.Status);
            Assert.Null(running.RequestBody);
            Assert.Null(running.ResponseBody);
            Assert.DoesNotContain(FakePassword, JsonSerializer.Serialize(running));
            Assert.Equal(path, running.Path);
            Assert.Equal("fake-session", running.SessionId);
            Assert.Equal(ctx.Items["RequestId"], running.RequestId);
            await ctx.Response.WriteAsync(JsonSerializer.Serialize(new { accessToken = FakeToken }));
        }, NullLogger<RequestResponseLoggingMiddleware>.Instance, fixture.Db, fixture.Cache.Object).InvokeAsync(context);
        Assert.Null(Assert.Single(fixture.Completed).ResponseBody);
    }

    [Theory]
    [InlineData("/api/chat-agent/sessions/fake-session/messages", "POST")]
    [InlineData("/api/chat-agent/sessions/fake-session/messages", "GET")]
    [InlineData("/api/agent-tools/invoke", "POST")]
    public async Task SelectedKnowledgeRouteBodiesDoNotReachSharedLogs(string path, string method)
    {
        const string privateText = "fabricated-private-knowledge-text-for-log-boundary-only";
        var fixture = new LogFixture();
        var context = NewContext(path, false);
        context.Request.Method = method;
        var requestBody = method == "GET" ? string.Empty : JsonSerializer.Serialize(new { content = privateText });
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(requestBody));
        context.Request.ContentLength = context.Request.Body.Length;
        var output = (MemoryStream)context.Response.Body;
        var responseBody = path == "/api/agent-tools/invoke"
            ? JsonSerializer.Serialize(new { success = true, content = JsonSerializer.Serialize(new { content = privateText, snippet = privateText }) })
            : JsonSerializer.Serialize(new { success = true, data = new { items = new[] { new { content = privateText } } } });
        await new RequestResponseLoggingMiddleware(async ctx =>
        {
            Assert.Equal(requestBody, await new StreamReader(ctx.Request.Body, leaveOpen: true).ReadToEndAsync());
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync(responseBody);
        }, NullLogger<RequestResponseLoggingMiddleware>.Instance, fixture.Db, fixture.Cache.Object).InvokeAsync(context);
        Assert.Equal(responseBody, Encoding.UTF8.GetString(output.ToArray()));
        var log = Assert.Single(fixture.Completed);
        Assert.Null(log.RequestBody);
        Assert.Null(log.ResponseBody);
        Assert.DoesNotContain(privateText, JsonSerializer.Serialize(log));
        AssertMetadata(context, log, path, 200, false);
    }

    [Fact]
    public async Task NeighborStillCapturesOrdinaryRequestAndResponseBodies()
    {
        const string path = "/api/users-history";
        var fixture = new LogFixture();
        var context = NewContext(path, false);
        const string requestBody = "{\"page\":2}";
        const string responseBody = "{\"success\":true,\"data\":{\"total\":3}}";
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(requestBody));
        context.Request.ContentLength = context.Request.Body.Length;
        await new RequestResponseLoggingMiddleware(ctx => ctx.Response.WriteAsync(responseBody),
            NullLogger<RequestResponseLoggingMiddleware>.Instance, fixture.Db, fixture.Cache.Object).InvokeAsync(context);
        var log = Assert.Single(fixture.Completed);
        Assert.Equal(requestBody, log.RequestBody);
        Assert.Equal(responseBody, log.ResponseBody);
        AssertMetadata(context, log, path, 200, false);
    }

    private static DefaultHttpContext NewContext(string path, bool stream)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("synthetic.invalid");
        context.Request.Method = "POST";
        context.Request.ContentType = "application/json";
        context.Request.Protocol = "HTTP/1.1";
        context.Request.Headers["X-Client"] = "admin";
        context.Request.QueryString = new QueryString("?page=2");
        context.Request.RouteValues["groupId"] = "fake-group";
        context.Request.RouteValues["sessionId"] = "fake-session";
        context.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("sub", "fake-user-id"), new Claim("displayName", "Fake User")
        }, "fake-test"));
        if (stream) context.Request.Headers.Accept = "text/event-stream";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static void AssertMetadata(HttpContext context, ApiRequestLog log, string path, int statusCode, bool stream)
    {
        Assert.Equal(path, log.Path);
        Assert.Equal(context.Request.Method, log.Method);
        Assert.Equal("?page=2", log.Query);
        Assert.Equal(statusCode, log.StatusCode);
        Assert.Equal(statusCode < 400 ? "completed" : "failed", log.Status);
        Assert.Equal("fake-user-id", log.UserId);
        Assert.Equal("fake-group", log.GroupId);
        Assert.Equal("fake-session", log.SessionId);
        Assert.Equal(context.Items["RequestId"], log.RequestId);
        Assert.False(string.IsNullOrWhiteSpace(log.Id));
        Assert.True(log.DurationMs >= 0);
        Assert.NotNull(log.EndedAt);
        Assert.Equal(stream, log.IsEventStream);
        Assert.Equal("inbound", log.Direction);
    }

    private sealed class LogFixture
    {
        public MongoDbContext Db { get; }
        public Mock<ICacheManager> Cache { get; } = new(MockBehavior.Strict);
        public List<ApiRequestLog> Completed { get; } = [];
        public TaskCompletionSource<ApiRequestLog> Running { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public LogFixture()
        {
            var logs = new Mock<IMongoCollection<ApiRequestLog>>(MockBehavior.Strict);
            logs.Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
                .Callback<ApiRequestLog, InsertOneOptions, CancellationToken>((log, _, _) => Running.TrySetResult(log))
                .Returns(Task.CompletedTask);
            logs.Setup(x => x.ReplaceOneAsync(It.IsAny<FilterDefinition<ApiRequestLog>>(), It.IsAny<ApiRequestLog>(),
                    It.IsAny<ReplaceOptions>(), It.IsAny<CancellationToken>()))
                .Callback<FilterDefinition<ApiRequestLog>, ApiRequestLog, ReplaceOptions, CancellationToken>((_, log, _, _) => Completed.Add(log))
                .ReturnsAsync(new ReplaceOneResult.Acknowledged(1, 1, null));
            var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
            database.Setup(x => x.GetCollection<ApiRequestLog>("apirequestlogs", null)).Returns(logs.Object);
            Db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
            typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(Db, database.Object);
        }
    }
}
