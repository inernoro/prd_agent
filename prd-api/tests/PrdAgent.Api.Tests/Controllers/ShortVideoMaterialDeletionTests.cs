using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Controllers;

[Trait("Category", "Integration")]
public sealed class ShortVideoMaterialDeletionTests : IAsyncLifetime
{
    private readonly ITestOutputHelper _output;
    public ShortVideoMaterialDeletionTests(ITestOutputHelper output) => _output = output;

    private const string Actor = "local-short-video-delete-owner";
    private MongoClient _client = null!;
    private IMongoDatabase _database = null!;
    private IMongoCollection<ShortVideoMaterialRun> _rows = null!;
    private WebApplication _app = null!;
    private HttpClient _http = null!;
    private readonly Mock<ITaskExecutionCoordinator> _coordinator = new(MockBehavior.Strict);

    public async Task InitializeAsync()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("须显式提供本轮本机 Mongo 地址");
        Assert.StartsWith("mongodb://127.0.0.1:", connection);
        BsonClassMapRegistration.Register();
        var settings = MongoClientSettings.FromConnectionString(connection);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
        _client = new MongoClient(settings);
        _database = _client.GetDatabase("short_video_delete_" + Guid.NewGuid().ToString("N"));
        await _database.RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
        _rows = _database.GetCollection<ShortVideoMaterialRun>("short_video_material_runs");
        _coordinator.Setup(x => x.RevokeAsync(It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(db, TaskLifecycleMongoDatabase.Wrap(_database, () => _coordinator.Object));

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.ConfigureKestrel(x => x.Listen(IPAddress.Loopback, 0));
        builder.Logging.ClearProviders();
        builder.Services.AddSingleton(db);
        builder.Services.AddSingleton(Mock.Of<IDocumentService>(MockBehavior.Strict));
        builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, FixtureIdentity>("fixture", _ => { });
        builder.Services.AddAuthorization();
        builder.Services.AddControllers().AddApplicationPart(typeof(ShortVideoMaterialController).Assembly)
            .ConfigureApplicationPartManager(x => x.FeatureProviders.Add(new OnlyMaterialController()));
        _app = builder.Build();
        _app.UseAuthentication();
        _app.UseAuthorization();
        _app.MapControllers();
        await _app.StartAsync();
        var address = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        _http = new HttpClient { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(10) };
        _http.DefaultRequestHeaders.Add("X-Fixture-Actor", Actor);
    }

    private static ShortVideoMaterialRun Run(string status, string? token = null, string user = Actor) => new()
    {
        UserId = user, Status = status, ProcessingToken = token, OwnerInstanceId = "local-delete-instance",
        TaskPermitId = "synthetic-no-outbound-grant-" + Guid.NewGuid().ToString("N"),
        VideoUrl = "https://example.invalid/not-a-real-task", Title = "本机删除保护合成记录",
    };

    private async Task<HttpResponseMessage> Delete(string id)
    {
        var response = await _http.DeleteAsync("/api/short-video-materials/runs/" + id);
        _output.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
        {
            method = "DELETE", path = "/api/short-video-materials/runs/" + id,
            status = (int)response.StatusCode, body = await response.Content.ReadAsStringAsync(),
        }));
        return response;
    }

    [Theory]
    [InlineData("queued")]
    [InlineData("done")]
    [InlineData("failed")]
    [InlineData("cancelled")]
    public async Task Delete_WhenNoProcessingToken_RemovesOnlyOwnRecordAndRevokesItsPermit(string status)
    {
        var run = Run(status);
        var other = Run(status, user: "another-local-fixture-actor");
        await _rows.InsertManyAsync(new[] { run, other });
        using var response = await Delete(run.Id);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, await _rows.CountDocumentsAsync(x => x.Id == run.Id));
        Assert.Equal(1, await _rows.CountDocumentsAsync(x => x.Id == other.Id));
        _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("running", null)]
    [InlineData("running", "active-processing")]
    [InlineData("queued", "active-processing")]
    [InlineData("done", "active-processing")]
    [InlineData("failed", "active-processing")]
    [InlineData("cancelled", "active-processing")]
    public async Task Delete_WhenWorkerMayStillBeActive_KeepsExactRecord(string status, string? token)
    {
        var run = Run(status, token);
        await _rows.InsertOneAsync(run);
        using var response = await Delete(run.Id);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("SHORT_VIDEO_RUN_ACTIVE", body);
        var actual = await _rows.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(run.ToBsonDocument(), actual.ToBsonDocument());
        _coordinator.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Delete_UnknownOrOtherActor_Returns404WithoutRevokingAnything()
    {
        var other = Run("done", user: "another-local-fixture-actor");
        await _rows.InsertOneAsync(other);
        using var missing = await Delete(Guid.NewGuid().ToString("N"));
        using var denied = await Delete(other.Id);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
        Assert.Equal(1, await _rows.CountDocumentsAsync(x => x.Id == other.Id));
        _coordinator.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Delete_Anonymous_Returns401AndKeepsRecord()
    {
        var run = Run("done");
        await _rows.InsertOneAsync(run);
        _http.DefaultRequestHeaders.Remove("X-Fixture-Actor");
        using var response = await Delete(run.Id);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(1, await _rows.CountDocumentsAsync(x => x.Id == run.Id));
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Delete_WhenClaimOrPermitChangesBetweenRevocationAndDelete_DoesNotDeleteNewIdentity(bool replacePermit)
    {
        var run = Run("queued");
        await _rows.InsertOneAsync(run);
        _coordinator.Setup(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None))
            .Returns(async () =>
            {
                var update = replacePermit
                    ? Builders<ShortVideoMaterialRun>.Update.Set(x => x.TaskPermitId, "new-synthetic-no-grant")
                    : Builders<ShortVideoMaterialRun>.Update.Set(x => x.Status, "running").Set(x => x.ProcessingToken, "new-processing");
                await _rows.UpdateOneAsync(x => x.Id == run.Id, update);
            });
        using var response = await Delete(run.Id);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var actual = await _rows.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(replacePermit ? "new-synthetic-no-grant" : run.TaskPermitId, actual.TaskPermitId);
        Assert.Equal(replacePermit ? "queued" : "running", actual.Status);
        Assert.Equal(replacePermit ? null : "new-processing", actual.ProcessingToken);
        _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        _coordinator.VerifyNoOtherCalls();
    }

    public async Task DisposeAsync()
    {
        _http?.Dispose();
        if (_app is not null) await _app.DisposeAsync();
        if (_database is not null) await _client.DropDatabaseAsync(_database.DatabaseNamespace.DatabaseName);
    }

    private sealed class OnlyMaterialController : IApplicationFeatureProvider<ControllerFeature>
    {
        public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature)
        {
            feature.Controllers.Clear();
            feature.Controllers.Add(typeof(ShortVideoMaterialController).GetTypeInfo());
        }
    }

    private sealed class FixtureIdentity(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var actor = Request.Headers["X-Fixture-Actor"].ToString();
            return Task.FromResult(string.IsNullOrEmpty(actor) ? AuthenticateResult.NoResult()
                : AuthenticateResult.Success(new AuthenticationTicket(
                    new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", actor) }, Scheme.Name)), Scheme.Name)));
        }
    }
}
