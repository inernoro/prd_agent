using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", "Integration")]
public sealed class DeferredTaskAdmissionBodyTests
{
    [Theory]
    [InlineData("PrdAgent.Api.Controllers.GroupsController", "Create", false)]
    [InlineData("PrdAgent.Api.Controllers.Api.ReportAgentController", "CreateReport", false)]
    [InlineData("PrdAgent.Api.Controllers.Api.WebPageAskController", "AskStreamByShare", true)]
    public async Task JsonConsumedByModelBindingStillProducesTheOriginalTaskFingerprint(string controller, string action, bool visitor)
    {
        await using var db = new Database();
        var admission = new TaskAdmissionService(db.Data, new ConfigurationBuilder().Build());
        var http = HttpAction(controller, action, visitor);
        http.Request.ContentType = "application/json";
        var json = Encoding.UTF8.GetBytes("{\"question\":\"synthetic-question\",\"value\":2}");
        http.Request.Body = new NonSeekableBody(json);
        http.Request.ContentLength = json.Length;
        var admitted = 0;
        var middleware = new TaskAdmissionMiddleware(async current =>
        {
            // MVC的JSON模型绑定先消费正文；真实准入随后才在控制器付费分支发生。
            using var bound = await JsonDocument.ParseAsync(current.Request.Body);
            Assert.Equal("synthetic-question", bound.RootElement.GetProperty("question").GetString());
            var identity = visitor
                ? await admission.AdmitVerifiedIntegrationAsync(current, "synthetic-actor", "site-share:synthetic-share", default)
                : await admission.AdmitAuthenticatedPaidBranchAsync(current, default);
            var permit = await db.Permits.Find(x => x.Id == identity.PermitId).SingleAsync();
            Assert.Equal(TaskBusinessIntentFingerprint(), permit.RequestFingerprint);
            admitted++;
        });

        await middleware.InvokeAsync(http, admission);

        Assert.Equal(1, admitted);
        Assert.Equal(1, await db.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [Fact]
    public async Task ExistingModelReclassificationGetsItsExplicitCallerPermit()
    {
        await using var db = new Database();
        var admission = new TaskAdmissionService(db.Data, new ConfigurationBuilder().Build());
        var http = HttpAction("PrdAgent.Api.Controllers.Api.PlatformsController", "ReclassifyModels", false);
        http.Request.Headers.Remove("Idempotency-Key");
        var reached = false;
        await new TaskAdmissionMiddleware(async current =>
        {
            var identity = TaskAdmissionRequestState.Get(current).Identity;
            Assert.NotNull(identity);
            var permit = await db.Permits.Find(x => x.Id == identity.PermitId).SingleAsync();
            Assert.Equal([PrdAgent.Core.Models.AppCallerRegistry.Admin.Platforms.Reclassify], permit.AllowedAppCallerCodes);
            Assert.Equal(TaskExecutionOrigins.Interactive, permit.Origin);
            reached = true;
        }).InvokeAsync(http, admission);
        Assert.True(reached);
    }

    private static string TaskBusinessIntentFingerprint()
        => PrdAgent.Infrastructure.Security.TaskExecutionCoordinator.Fingerprint("POST{\"question\":\"synthetic-question\",\"value\":2}");

    private static DefaultHttpContext HttpAction(string controller, string action, bool visitor)
    {
        var type = typeof(PrdAgent.Api.Controllers.Api.ReportAgentController).Assembly.GetType(controller)!;
        var descriptor = new ControllerActionDescriptor { ControllerTypeInfo = type.GetTypeInfo(), ActionName = action,
            MethodInfo = type.GetMethods().First(x => x.Name == action) };
        var http = new DefaultHttpContext();
        http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(descriptor), action));
        http.Request.Method = "POST";
        http.Request.Path = "/synthetic/" + action;
        http.Request.Headers["Idempotency-Key"] = Guid.NewGuid().ToString("N");
        http.Response.Body = new MemoryStream();
        if (!visitor) http.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim(ClaimTypes.NameIdentifier, "synthetic-actor"), new Claim("authType", "jwt"),
            new Claim("jti", "synthetic-session")], "session"));
        return http;
    }

    private sealed class Database : IAsyncDisposable
    {
        private readonly MongoClient _client;
        public LlmGatewayDataContext Data { get; }
        public IMongoCollection<GatewayTaskPermitRecord> Permits => Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
        public Database()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? throw new InvalidOperationException("必须提供独占本地Mongo，禁止静默跳过。");
            var address = new MongoUrl(connection);
            Assert.Equal("127.0.0.1", address.Server.Host); Assert.Null(address.Username);
            BsonClassMapRegistration.RegisterConventionsOnly();
            _client = new MongoClient(connection);
            Data = new LlmGatewayDataContext(connection, "deferred_admission_" + Guid.NewGuid().ToString("N"));
        }
        public ValueTask DisposeAsync() => new(_client.DropDatabaseAsync(Data.DatabaseName));
    }

    private sealed class NonSeekableBody(byte[] bytes) : Stream
    {
        private readonly MemoryStream _inner = new(bytes);
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => _inner.ReadAsync(buffer, ct);
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) _inner.Dispose(); base.Dispose(disposing); }
    }
}
