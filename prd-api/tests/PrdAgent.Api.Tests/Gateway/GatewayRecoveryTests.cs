using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Tests.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

// 真正的本机 HTTP 上游：先读取付费请求，再延迟、拒绝、截断或断开。
// 不访问供应商，不标 Integration/Manual，随默认 CI 永久运行。
public class GatewayRecoveryTests
{
    [Theory]
    [InlineData("send", 429)]
    [InlineData("raw", 429)]
    [InlineData("stream", 429)]
    [InlineData("raw", 401)]
    [InlineData("raw", 403)]
    [InlineData("raw", 404)]
    public async Task ExplicitRejection_RecoversAndPreservesRequestedProtocol(string entry, int status)
    {
        await using var upstream = await Upstream.StartAsync(status);
        var log = new CapturingLogWriter();
        var result = await InvokeAsync(entry, upstream, log);

        Assert.True(result.Success, result.Error);
        Assert.Equal(new[] { "model-a", "model-b" }, upstream.Models);
        Assert.All(upstream.Bodies, body =>
        {
            Assert.Equal("required", body["tool_choice"]!.GetValue<string>());
            Assert.Equal("lookup", body["tools"]![0]!["function"]!["name"]!.GetValue<string>());
        });
        Assert.NotNull(log.Done);
        Assert.Equal("succeeded", log.Done!.Status);
        var attempts = log.Done.ProviderAttempts!.Where(a => a.Stage == "send").ToArray();
        Assert.Equal(2, attempts.Length);
        Assert.Equal(status, attempts[0].StatusCode);
        Assert.Equal("platform-a", attempts[0].PlatformId);
        Assert.Equal("platform-b", attempts[1].PlatformId);
        Assert.Equal("model-b", log.Done.Model);
    }

    [Theory]
    [InlineData("send", 408)]
    [InlineData("raw", 409)]
    [InlineData("raw", 500)]
    [InlineData("raw", 502)]
    [InlineData("send", 503)]
    [InlineData("raw", 504)]
    [InlineData("stream", 503)]
    public async Task AmbiguousHttpFailure_DoesNotResubmitPaidGeneration(string entry, int status)
    {
        await using var upstream = await Upstream.StartAsync(status);
        var log = new CapturingLogWriter();
        var result = await InvokeAsync(entry, upstream, log);

        Assert.False(result.Success);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", result.Error);
        Assert.Equal(new[] { "model-a" }, upstream.Models);
        var attempt = Assert.Single(log.Done!.ProviderAttempts!, a => a.Stage == "send");
        Assert.Equal(status, attempt.StatusCode);
        Assert.Contains("outcome_unknown", attempt.Reason);
    }

    [Theory]
    [InlineData("send")]
    [InlineData("raw")]
    [InlineData("stream")]
    public async Task AcceptedThenDisconnected_DoesNotCallBackup(string entry)
    {
        await using var upstream = await Upstream.StartAsync(200, "abort");
        var log = new CapturingLogWriter();
        var result = await InvokeAsync(entry, upstream, log);
        Assert.False(result.Success);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", result.Error);
        Assert.Equal(new[] { "model-a" }, upstream.Models);
        var attempt = Assert.Single(log.Done!.ProviderAttempts!, a => a.Stage == "send");
        Assert.True(attempt.ReachedProvider);
        Assert.Contains("outcome_unknown", attempt.Reason);
    }

    [Theory]
    [InlineData("send")]
    [InlineData("raw")]
    [InlineData("stream")]
    public async Task ConnectionRefused_ConfirmedNotSent_CanUseLegalBackup(string entry)
    {
        await using var upstream = await Upstream.StartAsync(200);
        using var refused = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        refused.Bind(new IPEndPoint(IPAddress.Loopback, 0)); // 占住端口但不监听，确定拒绝连接。
        var address = $"http://127.0.0.1:{((IPEndPoint)refused.LocalEndPoint!).Port}";
        var log = new CapturingLogWriter();
        var result = await InvokeAsync(entry, upstream, log, primaryUrl: address);
        Assert.True(result.Success, result.Error);
        Assert.Equal(new[] { "model-b" }, upstream.Models);
        var attempts = log.Done!.ProviderAttempts!.Where(a => a.Stage == "send").ToArray();
        Assert.Equal(2, attempts.Length);
        Assert.False(attempts[0].ReachedProvider);
        Assert.Contains("not_sent", attempts[0].Reason);
    }

    [Theory]
    [InlineData("send", "pinned")]
    [InlineData("raw", "pinned")]
    [InlineData("stream", "pinned")]
    [InlineData("raw", "offering")]
    [InlineData("send", "probe")]
    [InlineData("stream", "probe")]
    public async Task LockedRoute_FailsAccuratelyWithoutFallback(string entry, string policy)
    {
        await using var upstream = await Upstream.StartAsync(429);
        var log = new CapturingLogWriter();
        var result = await InvokeAsync(entry, upstream, log, policy: policy);
        Assert.False(result.Success);
        Assert.Equal(new[] { "model-a" }, upstream.Models);
    }

    [Theory]
    [InlineData("send", "same-provider")]
    [InlineData("raw", "same-provider")]
    [InlineData("stream", "same-provider")]
    [InlineData("raw", "different-logical-model")]
    [InlineData("send", "different-logical-model")]
    [InlineData("stream", "different-logical-model")]
    public async Task IneligibleBackup_IsNeverCalled(string entry, string policy)
    {
        await using var upstream = await Upstream.StartAsync(429);
        var result = await InvokeAsync(entry, upstream, new CapturingLogWriter(), policy: policy);
        Assert.False(result.Success);
        Assert.Equal(new[] { "model-a" }, upstream.Models);
    }

    [Theory]
    [InlineData("send", "stall")]
    [InlineData("raw", "stall")]
    [InlineData("stream", "stall")]
    [InlineData("stream", "headers-stall")]
    [InlineData("stream", "partial-stall")]
    [InlineData("stream", "error-body-stall")]
    public async Task AcceptedButNoCompletion_UsesOneDeadlineAndNeverReplays(string entry, string fault)
    {
        await using var upstream = await Upstream.StartAsync(200, fault);
        var log = new CapturingLogWriter();
        var watch = Stopwatch.StartNew();
        var result = await InvokeAsync(entry, upstream, log, timeout: 1).WaitAsync(TimeSpan.FromSeconds(4));
        Assert.InRange(watch.Elapsed.TotalSeconds, 0.7, 3.5);
        Assert.False(result.Success);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", result.Error);
        Assert.Equal(new[] { "model-a" }, upstream.Models);
        Assert.Equal("failed", log.Done!.Status);
        Assert.Single(log.Done.ProviderAttempts!, a => a.Stage == "send");
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("partial")]
    public async Task StreamEofWithoutTerminalEvidence_IsFailureAndPreservesPartialOutput(string fault)
    {
        await using var upstream = await Upstream.StartAsync(200, fault);
        var log = new CapturingLogWriter();
        var result = await InvokeAsync("stream", upstream, log);
        Assert.False(result.Success);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", result.Error);
        Assert.Equal(fault == "partial" ? "partial" : "", result.Text);
        Assert.Equal(new[] { "model-a" }, upstream.Models);
        Assert.Equal("failed", log.Done!.Status);
        Assert.Equal(result.Text, log.Done.AnswerText);
    }

    [Fact]
    public async Task ConcurrentRejections_HaveBoundedSequentialAttempts()
    {
        await using var upstream = await Upstream.StartAsync(429);
        var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ =>
            InvokeAsync("raw", upstream, new CapturingLogWriter())));
        Assert.All(results, result => Assert.True(result.Success, result.Error));
        Assert.Equal(12, upstream.Models.Count(model => model == "model-a"));
        Assert.Equal(12, upstream.Models.Count(model => model == "model-b"));
    }

    [Theory]
    [InlineData("send")]
    [InlineData("raw")]
    [InlineData("stream")]
    public async Task SlowRejectionAndSlowBackup_DoNotRestartTotalDeadline(string entry)
    {
        await using var upstream = await Upstream.StartAsync(429, "slow-rejection");
        var watch = Stopwatch.StartNew();
        var result = await InvokeAsync(entry, upstream, new CapturingLogWriter(), timeout: 1)
            .WaitAsync(TimeSpan.FromSeconds(4));
        Assert.False(result.Success);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", result.Error);
        Assert.Equal(new[] { "model-a", "model-b" }, upstream.Models);
        Assert.InRange(watch.Elapsed.TotalSeconds, 0.7, 1.5);
    }

    [Fact]
    public async Task EmptyRoleHeartbeats_CannotBypassFirstOutputDeadline()
    {
        await using var upstream = await Upstream.StartAsync(200, "role-heartbeats");
        var watch = Stopwatch.StartNew();
        var result = await InvokeAsync("stream", upstream, new CapturingLogWriter(), timeout: 3, firstByteTimeout: 1)
            .WaitAsync(TimeSpan.FromSeconds(4));
        Assert.False(result.Success);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", result.Error);
        Assert.Equal("", result.Text);
        Assert.InRange(watch.Elapsed.TotalSeconds, 0.7, 2);
        Assert.Equal(new[] { "model-a" }, upstream.Models);
    }

    [Fact]
    public async Task RecoveryAndUnknownOutcome_AreQueryableThroughRealMongoLogWriter()
    {
        await using var database = await RunMongoFixture.CreateAsync("gateway_recovery_audit");
        var storage = Mock.Of<IAssetStorage>();
        var factory = new LocalHttpFactory();
        var background = new LlmRequestLogBackground(database.Db,
            NullLogger<LlmRequestLogBackground>.Instance, storage, factory, Mock.Of<ISafeOutboundUrlValidator>());
        var settings = new Mock<IAppSettingsService>();
        settings.Setup(x => x.GetSettingsAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new AppSettings());
        var writer = new LlmRequestLogWriter(database.Db, NullLogger<LlmRequestLogWriter>.Instance,
            background, settings.Object, storage, new ConfigurationBuilder().Build());
        await using (var rejected = await Upstream.StartAsync(429))
            Assert.True((await InvokeAsync("raw", rejected, writer)).Success);
        await using (var disconnected = await Upstream.StartAsync(200, "abort"))
            Assert.False((await InvokeAsync("raw", disconnected, writer)).Success);

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        List<LlmRequestLog> records;
        do
        {
            records = await database.Db.LlmRequestLogs.Find(_ => true).ToListAsync(deadline.Token);
            if (records.Count == 2 && records.All(r => r.EndedAt.HasValue)) break;
            await Task.Delay(20, deadline.Token);
        } while (true);
        var success = Assert.Single(records, r => r.Status == "succeeded");
        Assert.Equal(2, success.ProviderAttempts!.Count(a => a.Stage == "send"));
        Assert.Contains("next_candidate", success.ProviderAttempts.First(a => a.Stage == "send").Reason);
        var failure = Assert.Single(records, r => r.Status == "failed");
        Assert.Contains("outcome_unknown", Assert.Single(failure.ProviderAttempts!, a => a.Stage == "send").Reason);
        Assert.Equal("model-a", failure.Model);
    }

    [Theory]
    [InlineData("pinned", false)]
    [InlineData("offering", false)]
    [InlineData("allowed", true)]
    public async Task LocalConcurrencyRejection_RespectsLocksAndRetainsUnsentAttempt(string policy, bool recover)
    {
        await using var database = await RunMongoFixture.CreateAsync("gateway_recovery_concurrency");
        var data = new LlmGatewayDataContext(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? "mongodb://127.0.0.1:27017", database.Db.Database.DatabaseNamespace.DatabaseName);
        var coordinator = new GatewayProviderConcurrencyCoordinator(data,
            NullLogger<GatewayProviderConcurrencyCoordinator>.Instance);
        var admission = await coordinator.AcquireAsync(GatewayTenantDefaults.InternalTenantId, new ModelResolutionResult
        {
            ActualPlatformId = "platform-a", ActualModel = "model-a", PlatformMaxConcurrency = 1,
        }, 3, default);
        Assert.True(admission.Allowed);
        await using var held = admission.Lease!;
        await using var upstream = await Upstream.StartAsync(200);
        var log = new CapturingLogWriter();
        var result = await InvokeAsync("raw", upstream, log, policy: policy, coordinator: coordinator);
        Assert.Equal(recover, result.Success);
        Assert.Equal(recover ? new[] { "model-b" } : Array.Empty<string>(), upstream.Models);
        Assert.NotNull(log.Done);
        var attempts = log.Done!.ProviderAttempts!.Where(a => a.Stage == "send").ToArray();
        Assert.Equal(recover ? 2 : 1, attempts.Length);
        Assert.False(attempts[0].ReachedProvider);
        Assert.Contains("not_sent", attempts[0].Reason);
    }

    private static async Task<(bool Success, string? Error, string Text)> InvokeAsync(
        string entry, Upstream upstream, ILlmRequestLogWriter log,
        string? primaryUrl = null, string? policy = null, int timeout = 3,
        GatewayProviderConcurrencyCoordinator? coordinator = null, int firstByteTimeout = 30)
    {
        ModelResolutionResult Route(string id, string url) => new()
        {
            Success = true, ResolutionType = "LogicalModel",
            LogicalModelId = id == "b" && policy == "different-logical-model" ? "unrelated-model" : "logical-chat",
            LogicalModelPublicId = "stable-chat", OfferingId = $"offering-{id}",
            ActualModel = $"model-{id}", ActualPlatformId = id == "b" && policy == "same-provider" ? "platform-a" : $"platform-{id}",
            ActualPlatformName = $"Provider {id}", PlatformType = "openai", Protocol = "openai",
            ApiUrl = url, ApiKey = "fixture-key",
            PlatformMaxConcurrency = coordinator is null ? null : 1,
        };
        var primary = Route("a", primaryUrl ?? upstream.Url);
        primary.RetryCandidates = [Route("b", upstream.Url)];
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(primary);
        var gateway = new LlmGateway(resolver.Object, new LocalHttpFactory(), new TestLogger<LlmGateway>(), log,
            concurrencyCoordinator: coordinator, configuration: new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { ["LlmGateway:FirstByteTimeoutSeconds"] = firstByteTimeout.ToString() }).Build());
        var body = new JsonObject
        {
            ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "fixture" }),
            ["tool_choice"] = "required",
            ["tools"] = new JsonArray(new JsonObject { ["type"] = "function",
                ["function"] = new JsonObject { ["name"] = "lookup", ["parameters"] = new JsonObject { ["type"] = "object" } } }),
        };
        var context = new GatewayRequestContext { IsHealthProbe = policy == "probe" };
        if (entry == "raw")
        {
            var response = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
            {
                AppCallerCode = "prd-agent-web.lab::chat", ModelType = "chat", RequestBody = body,
                EndpointPath = "/v1/chat/completions", TimeoutSeconds = timeout,
                ExpectedModel = "stable-chat", PinnedPlatformId = policy == "pinned" ? "platform-a" : null,
                RequiredOfferingId = policy == "offering" ? "offering-a" : null, Context = context,
                CanonicalImageRequest = coordinator is null ? null : new GatewayCanonicalImageRequest { Prompt = "fixture" },
            }, primary.ToGatewayResolution());
            return (response.Success, response.ErrorCode, response.Content ?? "");
        }
        var request = new GatewayRequest
        {
            AppCallerCode = "prd-agent-web.lab::chat", ModelType = "chat", RequestBody = body,
            ExpectedModel = "stable-chat", TimeoutSeconds = timeout,
            PinnedPlatformId = policy == "pinned" ? "platform-a" : null, Context = context,
        };
        if (entry == "send")
        {
            var response = await gateway.SendAsync(request);
            return (response.Success, response.ErrorCode, response.Content ?? "");
        }
        var chunks = new List<GatewayStreamChunk>();
        await foreach (var chunk in gateway.StreamAsync(request)) chunks.Add(chunk);
        return (chunks.Any(c => c.Type == GatewayChunkType.Done),
            chunks.FirstOrDefault(c => c.Type == GatewayChunkType.Error)?.ErrorCode,
            string.Concat(chunks.Where(c => c.Type == GatewayChunkType.Text).Select(c => c.Content)));
    }

    private sealed class LocalHttpFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new SocketsHttpHandler
        {
            UseProxy = false, AllowAutoRedirect = false,
        });
    }

    private sealed class Upstream(WebApplication app, int status, string? fault) : IAsyncDisposable
    {
        public string Url => app.Urls.Single();
        public ConcurrentQueue<string> Models { get; } = new();
        public ConcurrentQueue<JsonObject> Bodies { get; } = new();

        public static async Task<Upstream> StartAsync(int status, string? fault = null)
        {
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();
            var app = builder.Build();
            var upstream = new Upstream(app, status, fault);
            app.Run(upstream.HandleAsync);
            await app.StartAsync();
            return upstream;
        }

        private async Task HandleAsync(HttpContext http)
        {
            var body = (await JsonNode.ParseAsync(http.Request.Body))!.AsObject();
            var model = body["model"]!.GetValue<string>();
            Models.Enqueue(model);
            Bodies.Enqueue(body);
            var primary = model == "model-a";
            if (primary && fault == "slow-rejection") await Task.Delay(600, http.RequestAborted);
            if (!primary && fault == "slow-rejection")
            {
                await Task.Delay(Timeout.Infinite, http.RequestAborted);
                return;
            }
            if (primary && fault == "abort") { http.Abort(); return; }
            if (primary && fault == "error-body-stall")
            {
                http.Response.StatusCode = 429;
                await http.Response.StartAsync();
                await Task.Delay(Timeout.Infinite, http.RequestAborted);
                return;
            }
            if (primary && status != 200)
            {
                http.Response.StatusCode = status;
                http.Response.Headers.RetryAfter = "60";
                await http.Response.WriteAsync("{\"error\":{\"message\":\"fixture rejection\"}}");
                return;
            }
            var stream = body["stream"]?.GetValue<bool>() == true;
            http.Response.ContentType = stream ? "text/event-stream" : "application/json";
            if (primary && fault == "stall")
            {
                await Task.Delay(Timeout.Infinite, http.RequestAborted);
                return;
            }
            await http.Response.StartAsync();
            if (primary && fault == "headers-stall")
            {
                await Task.Delay(Timeout.Infinite, http.RequestAborted);
                return;
            }
            if (primary && fault == "empty") return;
            if (primary && fault == "role-heartbeats")
            {
                while (!http.RequestAborted.IsCancellationRequested)
                {
                    await http.Response.WriteAsync("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n");
                    await http.Response.Body.FlushAsync();
                    await Task.Delay(50, http.RequestAborted);
                }
                return;
            }
            if (stream)
            {
                await http.Response.WriteAsync("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n");
                await http.Response.Body.FlushAsync();
                if (primary && fault == "partial-stall")
                {
                    await Task.Delay(Timeout.Infinite, http.RequestAborted);
                    return;
                }
                if (primary && fault == "partial") return;
                await http.Response.WriteAsync("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n");
            }
            else await http.Response.WriteAsync(body.ContainsKey("prompt")
                ? "{\"data\":[{\"url\":\"https://fixture.invalid/image.png\"}]}"
                : "{\"choices\":[{\"message\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}");
        }

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }
}
