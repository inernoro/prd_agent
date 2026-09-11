using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests;

// Only synthetic requests, in-memory streams and strict Mongo/cache mocks; no application host.
public sealed class HostedSitePreviewLoggingTests
{
    private const string Secret = "synthetic-preview-secret-not-a-real-ticket";

    [Theory]
    [InlineData("/api/hosted-site-preview-files/", false)]
    [InlineData("/API/HOSTED-SITE-PREVIEW-FILES/", false)]
    [InlineData("/api/hosted-site-preview-%66iles/", false)]
    [InlineData("/api/hosted-site-preview-access", false)]
    [InlineData("/api/hosted-site-preview-files/", true)]
    public async Task SensitiveRequestsKeepTransportButNotLogCredentials(string prefix, bool stream)
    {
        var path = prefix.EndsWith('/') ? prefix + Secret + "/index.html" : prefix;
        var context = NewContext(path);
        var requestJson = JsonSerializer.Serialize(new { ticket = Secret });
        context.Request.Method = "POST";
        context.Request.ContentType = "application/json";
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(requestJson));
        context.Request.ContentLength = context.Request.Body.Length;
        context.Request.QueryString = new QueryString("?ticket=" + Secret);
        context.Request.Headers["X-Client"] = "desktop";
        context.Request.Headers["X-Client-Id"] = "synthetic-client";
        if (stream) context.Request.Headers.Accept = "text/event-stream";
        var output = (MemoryStream)context.Response.Body;
        var responseJson = JsonSerializer.Serialize(new { success = false, error = new { code = Secret } });
        var fixture = new LogFixture();
        var logger = new RecordingLogger<RequestResponseLoggingMiddleware>();
        var middleware = new RequestResponseLoggingMiddleware(async ctx =>
        {
            Assert.Equal(path, ctx.Request.Path.Value);
            Assert.Equal("?ticket=" + Secret, ctx.Request.QueryString.Value);
            Assert.Equal(requestJson, await new StreamReader(ctx.Request.Body, leaveOpen: true).ReadToEndAsync());
            ctx.Response.StatusCode = 400;
            ctx.Response.ContentType = stream ? "text/event-stream" : "application/json";
            await ctx.Response.WriteAsync(responseJson);
        }, logger, fixture.Db, fixture.Cache.Object);

        await middleware.InvokeAsync(context);

        Assert.Equal(responseJson, Encoding.UTF8.GetString(output.ToArray()));
        var persisted = Assert.Single(fixture.Logs);
        Assert.DoesNotContain(Secret, JsonSerializer.Serialize(persisted));
        Assert.Null(persisted.RequestBody);
        Assert.Null(persisted.ResponseBody);
        Assert.Contains("[redacted]", persisted.AbsoluteUrl);
        Assert.DoesNotContain(Secret, string.Join('\n', logger.Messages));
        var presence = Assert.Single(fixture.Presence);
        Assert.DoesNotContain(Secret, JsonSerializer.Serialize(presence));
    }

    [Fact]
    public async Task SimilarButDifferentRoutePreservesDiagnostics()
    {
        var context = NewContext("/api/hosted-site-preview-files-history");
        context.Request.QueryString = new QueryString("?page=2");
        var fixture = new LogFixture();
        var logger = new RecordingLogger<RequestResponseLoggingMiddleware>();
        await new RequestResponseLoggingMiddleware(ctx => ctx.Response.WriteAsync("ordinary-response"),
            logger, fixture.Db, fixture.Cache.Object).InvokeAsync(context);
        var log = Assert.Single(fixture.Logs);
        Assert.Equal(context.Request.Path.Value, log.Path);
        Assert.Equal("?page=2", log.Query);
        Assert.Equal("ordinary-response", log.ResponseBody);
    }

    [Fact]
    public async Task InFlightLogIsRedactedBeforeRequestFinishes()
    {
        var context = NewContext("/api/hosted-site-preview-files/" + Secret + "/index.html");
        context.Request.QueryString = new QueryString("?ticket=" + Secret);
        var fixture = new LogFixture();
        var logger = new RecordingLogger<RequestResponseLoggingMiddleware>();
        await new RequestResponseLoggingMiddleware(async ctx =>
        {
            var running = await fixture.RunningLog.Task.WaitAsync(TimeSpan.FromSeconds(8));
            Assert.Equal("running", running.Status);
            Assert.DoesNotContain(Secret, JsonSerializer.Serialize(running));
            await ctx.Response.WriteAsync("synthetic-file");
        }, logger, fixture.Db, fixture.Cache.Object).InvokeAsync(context);
        Assert.Single(fixture.Logs);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PreviewExceptionsDoNotExposeAccessCredential(bool canceled)
    {
        var context = NewContext("/api/hosted-site-preview-files/" + Secret + "/index.html");
        if (canceled) context.RequestAborted = new CancellationToken(true);
        var logger = new RecordingLogger<ExceptionMiddleware>();
        await new ExceptionMiddleware(_ => throw (canceled
            ? new OperationCanceledException(Secret)
            : new InvalidOperationException(Secret)), logger).InvokeAsync(context);
        Assert.DoesNotContain(Secret, string.Join('\n', logger.Messages));
        Assert.DoesNotContain(Secret, Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray()));
    }

    private static DefaultHttpContext NewContext(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = new PathString(path);
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("synthetic.invalid");
        context.Request.Method = "GET";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private sealed class LogFixture
    {
        public MongoDbContext Db { get; }
        public Mock<ICacheManager> Cache { get; } = new(MockBehavior.Strict);
        public List<ApiRequestLog> Logs { get; } = [];
        public List<DesktopPresenceEntry> Presence { get; } = [];
        public TaskCompletionSource<ApiRequestLog> RunningLog { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public LogFixture()
        {
            var collection = new Mock<IMongoCollection<ApiRequestLog>>(MockBehavior.Strict);
            collection.Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(),
                    It.IsAny<CancellationToken>()))
                .Callback<ApiRequestLog, InsertOneOptions, CancellationToken>((log, _, _) => RunningLog.TrySetResult(log))
                .Returns(Task.CompletedTask);
            collection.Setup(x => x.ReplaceOneAsync(It.IsAny<FilterDefinition<ApiRequestLog>>(),
                    It.IsAny<ApiRequestLog>(), It.IsAny<ReplaceOptions>(), It.IsAny<CancellationToken>()))
                .Callback<FilterDefinition<ApiRequestLog>, ApiRequestLog, ReplaceOptions, CancellationToken>(
                    (_, log, _, _) => Logs.Add(log))
                .ReturnsAsync(new ReplaceOneResult.Acknowledged(1, 1, null));
            var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
            database.Setup(x => x.GetCollection<ApiRequestLog>("apirequestlogs", null)).Returns(collection.Object);
            // Do not construct MongoClient: the middleware only sees our strict in-memory collection.
            Db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
            typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(Db, database.Object);
            Cache.Setup(x => x.GetAsync<DesktopPresenceEntry>(It.IsAny<string>())).ReturnsAsync((DesktopPresenceEntry?)null);
            Cache.Setup(x => x.SetAsync(It.IsAny<string>(), It.IsAny<DesktopPresenceEntry>(), It.IsAny<TimeSpan?>()))
                .Callback<string, DesktopPresenceEntry, TimeSpan?>((_, entry, _) => Presence.Add(entry))
                .Returns(Task.CompletedTask);
        }
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception) + exception);
    }
}
