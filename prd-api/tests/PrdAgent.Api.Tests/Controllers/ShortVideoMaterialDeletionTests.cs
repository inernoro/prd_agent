using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
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
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.Security;
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
        builder.Services.AddScoped<ShortVideoMaterialProcessor>();
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

    private async Task<HttpResponseMessage> Cancel(string id)
    {
        var response = await _http.PostAsync("/api/short-video-materials/runs/" + id + "/cancel", null);
        _output.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
        {
            method = "POST", path = "/api/short-video-materials/runs/" + id + "/cancel",
            status = (int)response.StatusCode, body = await response.Content.ReadAsStringAsync(),
        }));
        return response;
    }

    [Fact]
    public async Task Cancel_QueuedWithoutProcessingIdentity_BecomesCancelledAndRevokesOnlyOwnPermit()
    {
        var run = Run("queued");
        var other = Run("queued", user: "another-local-fixture-actor");
        await _rows.InsertManyAsync(new[] { run, other });
        using var response = await Cancel(run.Id);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var raw = await _database.GetCollection<BsonDocument>("short_video_material_runs")
            .Find(new BsonDocument("_id", run.Id)).SingleAsync();
        Assert.Equal("cancelled", raw["Status"].AsString);
        Assert.True(raw["CancelRequested"].AsBoolean);
        Assert.True(raw["ProcessingToken"].IsBsonNull);
        Assert.Equal("queued", (await _rows.Find(x => x.Id == other.Id).SingleAsync()).Status);
        _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Exactly(2));
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("current-processing")]
    public async Task Cancel_Running_RequestsCancellationButRetainsProcessingIdentityUntilAcknowledged(string? token)
    {
        var run = Run("running", token);
        await _rows.InsertOneAsync(run);
        using var response = await Cancel(run.Id);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var raw = await _database.GetCollection<BsonDocument>("short_video_material_runs")
            .Find(new BsonDocument("_id", run.Id)).SingleAsync();
        Assert.True(raw["CancelRequested"].AsBoolean);
        Assert.Equal("running", raw["Status"].AsString);
        Assert.Equal(token is null ? BsonNull.Value : new BsonString(token), raw["ProcessingToken"]);
        using var deletion = await Delete(run.Id);
        Assert.Equal(HttpStatusCode.Conflict, deletion.StatusCode);
        _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("done")]
    [InlineData("failed")]
    [InlineData("cancelled")]
    public async Task Cancel_Terminal_IsIdempotentAndDoesNotRewriteRecord(string status)
    {
        var run = Run(status);
        await _rows.InsertOneAsync(run);
        using var response = await Cancel(run.Id);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(run.ToBsonDocument(), (await _rows.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument());
        _coordinator.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Cancel_MissingOrOtherActor_DoesNotRevealOrMutateRecord()
    {
        var run = Run("running", "other-processing", "another-local-fixture-actor");
        await _rows.InsertOneAsync(run);
        using var denied = await Cancel(run.Id);
        using var missing = await Cancel(Guid.NewGuid().ToString("N"));
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal(run.ToBsonDocument(), (await _rows.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument());
        _coordinator.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Cancel_Anonymous_DoesNotMutateRecord()
    {
        var run = Run("queued");
        await _rows.InsertOneAsync(run);
        _http.DefaultRequestHeaders.Remove("X-Fixture-Actor");
        using var response = await Cancel(run.Id);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("queued", (await _rows.Find(x => x.Id == run.Id).SingleAsync()).Status);
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancel_WhenProcessingOrPermitChangesDuringRevocation_DoesNotCancelNewIdentity(bool replacePermit)
    {
        var run = Run("running", "old-processing");
        await _rows.InsertOneAsync(run);
        _coordinator.Setup(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None))
            .Returns(async () =>
            {
                await _rows.UpdateOneAsync(x => x.Id == run.Id,
                    replacePermit ? Builders<ShortVideoMaterialRun>.Update.Set(x => x.TaskPermitId, "new-permit")
                        : Builders<ShortVideoMaterialRun>.Update.Set(x => x.ProcessingToken, "new-processing").Set(x => x.OwnerInstanceId, "new-owner"));
            });
        using var response = await Cancel(run.Id);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var raw = await _database.GetCollection<BsonDocument>("short_video_material_runs")
            .Find(new BsonDocument("_id", run.Id)).SingleAsync();
        Assert.False(raw.GetValue("CancelRequested", false).AsBoolean);
        Assert.Equal(replacePermit ? "new-permit" : run.TaskPermitId, raw["TaskPermitId"].AsString);
        Assert.Equal(replacePermit ? "old-processing" : "new-processing", raw["ProcessingToken"].AsString);
        _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancel_DuringActualWorkerDownload_StopsBeforeAssetsOrTranscriptionAndAcknowledgesCancellation(bool transientLookupFailure)
    {
        using var handler = new WaitingLocalHandler();
        var fault = new LocalReadFault { Ready = () => handler.Started.Task.IsCompleted };
        var db = _app.Services.GetRequiredService<MongoDbContext>();
        if (transientLookupFailure)
            typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(db, LocalReadFaultProxy.Wrap(db.Database, fault));
        var validator = new Mock<ISafeOutboundUrlValidator>(MockBehavior.Strict);
        validator.Setup(x => x.EnsureSafeHttpUrlAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((string url, string _, CancellationToken _) => new Uri(url));
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IConfiguration>(_app.Configuration);
        services.AddSingleton(_app.Services.GetRequiredService<MongoDbContext>());
        services.AddSingleton(_app.Services.GetRequiredService<IDocumentService>());
        services.AddSingleton(validator.Object);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        services.AddSingleton(storage.Object);
        services.AddHttpClient("SafeOutbound").ConfigurePrimaryHttpMessageHandler(() => handler);
        services.AddScoped(sp => new ShortVideoMaterialProcessor(sp.GetRequiredService<MongoDbContext>(),
            sp.GetRequiredService<IDocumentService>(), sp.GetRequiredService<IConfiguration>(), sp,
            NullLogger<ShortVideoMaterialProcessor>.Instance));
        await using var provider = services.BuildServiceProvider();
        var run = Run("queued");
        run.OwnerInstanceId = InstanceIdentity.Get(_app.Configuration);
        run.VideoUrl = "https://local-fixture.invalid/video.mp4";
        run.InputSourceText = "本机取消测试，不是真实视频任务";
        await _rows.InsertOneAsync(run);
        var worker = new ShortVideoMaterialWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ShortVideoMaterialWorker>.Instance);
        var work = (Task)typeof(ShortVideoMaterialWorker).GetMethod("ProcessNextRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, null)!;
        try
        {
            await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (transientLookupFailure)
            {
                await fault.Injected.Task.WaitAsync(TimeSpan.FromSeconds(5));
                await Task.Delay(250);
                Assert.False(work.IsCompleted);
                Assert.False(handler.AuthorityCancellationObserved);
            }
            using var response = await Cancel(run.Id);
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
            await work.WaitAsync(TimeSpan.FromSeconds(6));
            var actual = await _rows.Find(x => x.Id == run.Id).SingleAsync();
            Assert.Equal("cancelled", actual.Status);
            Assert.Null(actual.ProcessingToken);
            Assert.True(handler.AuthorityCancellationObserved);
            Assert.Equal(0, await _database.GetCollection<Attachment>("attachments").CountDocumentsAsync(FilterDefinition<Attachment>.Empty));
            Assert.Equal(0, await _database.GetCollection<DocumentEntry>("document_entries").CountDocumentsAsync(FilterDefinition<DocumentEntry>.Empty));
            storage.VerifyNoOtherCalls();
            // 请求和后台终态写回都经过现有许可包装器，各自幂等撤销同一原许可。
            _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Exactly(2));
            _coordinator.VerifyNoOtherCalls();
        }
        finally
        {
            handler.Abort.Cancel();
            await work.WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    public sealed class LocalReadFault
    {
        public Func<bool> Ready = () => false;
        public readonly TaskCompletionSource Injected = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Fired;
    }

    public class LocalReadFaultProxy : DispatchProxy
    {
        private object _inner = null!;
        private LocalReadFault _fault = null!;
        public static T Wrap<T>(T inner, LocalReadFault fault) where T : class
        {
            var proxy = Create<T, LocalReadFaultProxy>();
            ((LocalReadFaultProxy)(object)proxy)._inner = inner;
            ((LocalReadFaultProxy)(object)proxy)._fault = fault;
            return proxy;
        }
        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method!.Name == "FindAsync" && _fault.Ready() && Interlocked.CompareExchange(ref _fault.Fired, 1, 0) == 0)
            {
                _fault.Injected.TrySetResult();
                throw new TimeoutException("本机只注入一次身份查询超时，未取消任务");
            }
            try
            {
                var result = method.Invoke(_inner, args);
                return result is IMongoCollection<ShortVideoMaterialRun> rows ? Wrap(rows, _fault) : result;
            }
            catch (TargetInvocationException ex) when (ex.InnerException is not null)
            { ExceptionDispatchInfo.Capture(ex.InnerException).Throw(); throw; }
        }
    }

    private sealed class WaitingLocalHandler : HttpMessageHandler
    {
        public readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly CancellationTokenSource Abort = new();
        public bool AuthorityCancellationObserved { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Started.TrySetResult();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, Abort.Token);
            try { await Task.Delay(Timeout.Infinite, linked.Token); }
            finally { AuthorityCancellationObserved = ct.IsCancellationRequested; }
            throw new InvalidOperationException("本机测试不可发送真实 HTTP 请求");
        }
    }

    [Fact]
    public async Task Cancel_LegacyQueuedRecordWithoutFlag_AndRepeatedRunningRequestRemainSupported()
    {
        var queued = Run("queued");
        var running = Run("running", "current-processing");
        await _rows.InsertManyAsync(new[] { queued, running });
        await _database.GetCollection<BsonDocument>("short_video_material_runs").UpdateOneAsync(
            new BsonDocument("_id", queued.Id), new BsonDocument("$unset", new BsonDocument("CancelRequested", "")));
        using var legacy = await Cancel(queued.Id);
        using var first = await Cancel(running.Id);
        var before = (await _rows.Find(x => x.Id == running.Id).SingleAsync()).ToBsonDocument();
        using var repeated = await Cancel(running.Id);
        Assert.Equal(HttpStatusCode.OK, legacy.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, repeated.StatusCode);
        Assert.Equal(before, (await _rows.Find(x => x.Id == running.Id).SingleAsync()).ToBsonDocument());
        _coordinator.Verify(x => x.RevokeAsync(queued.TaskPermitId!, queued.Id, CancellationToken.None), Times.Exactly(2));
        _coordinator.Verify(x => x.RevokeAsync(running.TaskPermitId!, running.Id, CancellationToken.None), Times.Once);
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancel_QueuedCancellationAlreadyPersisted_RepeatedRequestIsAcceptedWithoutRewritingIdentity(bool duringRevocation)
    {
        var run = Run("queued");
        run.CancelRequested = !duringRevocation;
        await _rows.InsertOneAsync(run);
        var before = (await _rows.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument();
        before["CancelRequested"] = true;
        if (duringRevocation)
            _coordinator.Setup(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None))
                .Returns(async () => await _rows.UpdateOneAsync(x => x.Id == run.Id,
                    Builders<ShortVideoMaterialRun>.Update.Set(x => x.CancelRequested, true)));

        using var repeated = await Cancel(run.Id);

        Assert.Equal(HttpStatusCode.Accepted, repeated.StatusCode);
        Assert.Equal(before, (await _rows.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument());
        if (duringRevocation)
            _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        _coordinator.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Recovery_AcknowledgesRequestedCancellationWithoutRewritingOtherOwners()
    {
        var cancelled = Run("running", "current-processing");
        cancelled.CancelRequested = true;
        cancelled.OwnerInstanceId = InstanceIdentity.Get(_app.Configuration);
        var failed = Run("running", "another-processing");
        failed.OwnerInstanceId = cancelled.OwnerInstanceId;
        var other = Run("running", "other-processing");
        other.OwnerInstanceId = "another-owner";
        var pending = Run("queued");
        pending.CancelRequested = true;
        pending.OwnerInstanceId = cancelled.OwnerInstanceId;
        await _rows.InsertManyAsync(new[] { cancelled, failed, other, pending });
        var worker = new ShortVideoMaterialWorker(_app.Services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ShortVideoMaterialWorker>.Instance);
        await (Task)typeof(ShortVideoMaterialWorker).GetMethod("RecoverRunningRunsAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, null)!;
        await (Task)typeof(ShortVideoMaterialWorker).GetMethod("ProcessNextRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, null)!;
        Assert.Equal("cancelled", (await _rows.Find(x => x.Id == cancelled.Id).SingleAsync()).Status);
        Assert.Null((await _rows.Find(x => x.Id == cancelled.Id).SingleAsync()).ProcessingToken);
        Assert.Equal("failed", (await _rows.Find(x => x.Id == failed.Id).SingleAsync()).Status);
        Assert.Equal(other.ToBsonDocument(), (await _rows.Find(x => x.Id == other.Id).SingleAsync()).ToBsonDocument());
        Assert.Equal("cancelled", (await _rows.Find(x => x.Id == pending.Id).SingleAsync()).Status);
        _coordinator.Verify(x => x.RevokeAsync(cancelled.TaskPermitId!, cancelled.Id, CancellationToken.None), Times.Once);
        _coordinator.Verify(x => x.RevokeAsync(pending.TaskPermitId!, pending.Id, CancellationToken.None), Times.Once);
        _coordinator.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Cancel_BetweenWorkerClaimAndLeaseAcquisition_AcknowledgesOriginalProcessingIdentity()
    {
        var run = Run("queued");
        run.OwnerInstanceId = InstanceIdentity.Get(_app.Configuration);
        await _rows.InsertOneAsync(run);
        _coordinator.Setup(x => x.AcquireAsync(run.TaskPermitId!, run.Id, CancellationToken.None))
            .Returns(async () =>
            {
                using var response = await Cancel(run.Id);
                Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
                throw new TaskExecutionAdmissionException("TASK_EXECUTION_UNAVAILABLE", "本机模拟原执行许可已被撤销", 409);
            });
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(_app.Configuration);
        services.AddSingleton(_app.Services.GetRequiredService<MongoDbContext>());
        services.AddScoped(sp => new ShortVideoMaterialProcessor(sp.GetRequiredService<MongoDbContext>(),
            _app.Services.GetRequiredService<IDocumentService>(), sp.GetRequiredService<IConfiguration>(), sp,
            NullLogger<ShortVideoMaterialProcessor>.Instance, _coordinator.Object));
        await using var provider = services.BuildServiceProvider();
        using var worker = new ShortVideoMaterialWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ShortVideoMaterialWorker>.Instance);
        await (Task)typeof(ShortVideoMaterialWorker).GetMethod("ProcessNextRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, null)!;
        var actual = await _rows.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal("cancelled", actual.Status);
        Assert.Null(actual.ProcessingToken);
        _coordinator.Verify(x => x.AcquireAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Exactly(2));
        _coordinator.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancel_QueuedClaimFinishesDuringPermitRevocation_AcknowledgesSameTaskInsteadOfLeavingFailed(bool observedRunning)
    {
        var run = Run("queued");
        run.OwnerInstanceId = InstanceIdentity.Get(_app.Configuration);
        await _rows.InsertOneAsync(run);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var revoked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _coordinator.Setup(x => x.AcquireAsync(run.TaskPermitId!, run.Id, CancellationToken.None))
            .Returns(async () =>
            {
                entered.TrySetResult();
                if (observedRunning) await revoked.Task.WaitAsync(TimeSpan.FromSeconds(5));
                throw new TaskExecutionAdmissionException("TASK_EXECUTION_UNAVAILABLE", "本机模拟取消已撤销许可", 409);
            });
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(_app.Configuration);
        services.AddSingleton(_app.Services.GetRequiredService<MongoDbContext>());
        services.AddScoped(sp => new ShortVideoMaterialProcessor(sp.GetRequiredService<MongoDbContext>(),
            _app.Services.GetRequiredService<IDocumentService>(), sp.GetRequiredService<IConfiguration>(), sp,
            NullLogger<ShortVideoMaterialProcessor>.Instance, _coordinator.Object));
        await using var provider = services.BuildServiceProvider();
        using var worker = new ShortVideoMaterialWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ShortVideoMaterialWorker>.Instance);
        Task? claimed = null;
        Task Process() => (Task)typeof(ShortVideoMaterialWorker)
            .GetMethod("ProcessNextRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(worker, null)!;
        var revocations = 0;
        _coordinator.Setup(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None)).Returns(async () =>
        {
            if (++revocations == 1)
            {
                revoked.TrySetResult();
                await (claimed ?? Process());
            }
        });
        if (observedRunning)
        {
            claimed = Process();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        }
        using var response = await Cancel(run.Id);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var actual = await _rows.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal("cancelled", actual.Status);
        Assert.True(actual.CancelRequested);
        Assert.Null(actual.ProcessingToken);
        _coordinator.Verify(x => x.AcquireAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Once);
        _coordinator.Verify(x => x.RevokeAsync(run.TaskPermitId!, run.Id, CancellationToken.None), Times.Exactly(2));
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
