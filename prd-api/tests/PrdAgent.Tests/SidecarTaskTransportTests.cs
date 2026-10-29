using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services.AgentRuntime;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;
using Xunit;

namespace PrdAgent.Tests;

public sealed class SidecarTaskTransportTests
{
    [Fact]
    public async Task NormalTask_DispatchesIssuerPreparedCredentialsAndPreservesModelToolsAndTrace()
    {
        var original = new SidecarRunRequest
        {
            SubjectUserId = "task-owner", RunId = "runtime-trace", Model = "selected-model",
            AppCallerCode = "chat-agent::conversation", TraceId = "trace-1", MapSessionId = "session-1",
            Tools = new() { new() { Name = "read_document", InputSchema = JsonSerializer.SerializeToElement(new { type = "object" }) } },
            BuiltinTools = Array.Empty<string>(), Profile = "old-provider-profile",
            BaseUrl = "https://provider.invalid", ApiKey = "old-long-key",
        };
        var prepared = new SidecarRunRequest
        {
            SubjectUserId = original.SubjectUserId, RunId = original.RunId, Model = original.Model,
            AppCallerCode = original.AppCallerCode, TraceId = original.TraceId, MapSessionId = original.MapSessionId,
            Tools = original.Tools, BuiltinTools = original.BuiltinTools,
            BaseUrl = "https://gateway.invalid", ApiKey = "gwrg_finite-task-grant", Protocol = "anthropic",
        };
        var issuer = new TestIssuer(request =>
        {
            Assert.Same(original, request);
            Assert.Equal("trusted-task-root", TaskExecutionContext.Current?.RunId);
            return prepared;
        });
        var transport = new RecordingHandler();
        var router = Router(transport, issuer);
        using var scope = TaskExecutionContext.Enter(new TaskExecutionIdentity("trusted-permit", "trusted-task-root"));

        var events = new List<SidecarEvent>();
        await foreach (var ev in router.RunStreamAsync(original, CancellationToken.None)) events.Add(ev);

        Assert.Equal(SidecarEventType.Done, Assert.Single(events).Type);
        Assert.Equal(1, transport.Sends);
        using var body = JsonDocument.Parse(transport.Body!);
        var json = body.RootElement;
        Assert.Equal(original.RunId, json.GetProperty("runId").GetString());
        Assert.Equal(original.Model, json.GetProperty("model").GetString());
        Assert.Equal(original.AppCallerCode, json.GetProperty("appCallerCode").GetString());
        Assert.Equal(original.TraceId, json.GetProperty("traceId").GetString());
        Assert.Equal("https://gateway.invalid", json.GetProperty("baseUrl").GetString());
        Assert.Equal("gwrg_finite-task-grant", json.GetProperty("apiKey").GetString());
        Assert.False(json.TryGetProperty("profile", out _));
        Assert.False(json.TryGetProperty("subjectUserId", out _));
        Assert.Empty(json.GetProperty("builtinTools").EnumerateArray());
        Assert.Equal("read_document", json.GetProperty("tools")[0].GetProperty("name").GetString());
        Assert.Equal(1, issuer.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MissingOrRejectedAdmission_StopsBeforeSidecarNetwork(bool configuredIssuer)
    {
        var issuer = new TestIssuer(_ => throw new TaskExecutionAdmissionException("TASK_EXECUTION_EXPIRED", "本次任务已过期，请重新发起操作。", 403));
        var transport = new RecordingHandler();
        var router = Router(transport, configuredIssuer ? issuer : null);
        var events = new List<SidecarEvent>();
        await foreach (var ev in router.RunStreamAsync(new SidecarRunRequest { RunId = "fake-run", ApiKey = "long-key" }, CancellationToken.None))
            events.Add(ev);
        var error = Assert.Single(events);
        Assert.Equal(SidecarEventType.Error, error.Type);
        Assert.Equal(configuredIssuer ? "TASK_EXECUTION_EXPIRED" : "TASK_EXECUTION_NOT_ADMITTED", error.ErrorCode);
        Assert.Equal(0, transport.Sends);
    }

    [Fact]
    public async Task InfraAdapter_PassesBusinessSubjectToPlatformWithoutGrantingExecution()
    {
        var request = new InfraAgentRuntimeRunRequest
        { RunId = "infra-runtime", UserId = "infra-owner", Model = "selected-infra-model", AppCallerCode = "infra-agent::runtime.chat" };
        SidecarRunRequest? captured = null;
        var router = new TestRouter(r => captured = r);
        await foreach (var _ in new SidecarRuntimeAdapter(router).RunStreamAsync(request, CancellationToken.None)) { }
        Assert.NotNull(captured);
        Assert.Equal(request.UserId, captured!.SubjectUserId);
        Assert.Equal(request.Model, captured.Model);
        Assert.Equal(request.AppCallerCode, captured.AppCallerCode);
        Assert.Null(TaskExecutionContext.Current);
    }

    [Fact]
    public void SidecarSubject_CannotBeReadOrWrittenThroughJson()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var json = JsonSerializer.Serialize(new SidecarRunRequest { SubjectUserId = "owner" }, options);
        Assert.DoesNotContain("subjectUserId", json);
        Assert.Null(JsonSerializer.Deserialize<SidecarRunRequest>("{\"subjectUserId\":\"spoofed\"}", options)!.SubjectUserId);
    }

    private static async IAsyncEnumerable<SidecarEvent> EmptyEvents()
    {
        await Task.CompletedTask;
        yield break;
    }

    private static ClaudeSidecarRouter Router(RecordingHandler transport, ITaskScopedRuntimeGrantIssuer? issuer)
    {
        var factory = new TestFactory(transport);
        var options = new StaticOptions(new ClaudeSidecarOptions { Enabled = true, CallbackBaseUrl = "https://callback.invalid" });
        return new ClaudeSidecarRouter(factory, options, new InstanceStateRegistry(), new TestRegistry(),
            new ConfigurationBuilder().Build(), new HttpContextAccessor(), NullLogger<ClaudeSidecarRouter>.Instance, issuer);
    }

    private sealed class TestIssuer(Func<SidecarRunRequest, SidecarRunRequest> prepare) : ITaskScopedRuntimeGrantIssuer
    {
        public int Calls { get; private set; }
        public Task<SidecarRunRequest> PrepareAsync(SidecarRunRequest request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(prepare(request));
        }
    }

    private sealed class TestRouter(Action<SidecarRunRequest> capture) : IClaudeSidecarRouter
    {
        public bool IsConfigured => true;
        public int InstanceCount => 1;
        public int HealthyCount => 1;
        public IReadOnlyList<string> Blockers => Array.Empty<string>();
        public IReadOnlyList<string> NextActions => Array.Empty<string>();
        public IAsyncEnumerable<SidecarEvent> RunStreamAsync(SidecarRunRequest request, CancellationToken ct)
        { capture(request); return EmptyEvents(); }
        public Task<SidecarCancelResult> CancelRunAsync(string runId, CancellationToken ct) => throw new NotImplementedException();
        public Task<SidecarPoolDiagnostics> GetDiagnosticsAsync(CancellationToken ct) => throw new NotImplementedException();
    }

    private sealed class TestFactory(RecordingHandler transport) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name)
        {
            Assert.Equal(ClaudeSidecarRouter.HttpClientName, name);
            return new HttpClient(transport, disposeHandler: false);
        }
    }

    private sealed class StaticOptions(ClaudeSidecarOptions options) : IOptionsMonitor<ClaudeSidecarOptions>
    {
        public ClaudeSidecarOptions CurrentValue => options;
        public ClaudeSidecarOptions Get(string? name) => options;
        public IDisposable? OnChange(Action<ClaudeSidecarOptions, string?> listener) => null;
    }

    private sealed class TestRegistry : IDynamicSidecarRegistry
    {
        public IReadOnlyList<DynamicSidecarInstance> GetCurrent() => new[]
        { new DynamicSidecarInstance { Name = "unit-sidecar", BaseUrl = "https://sidecar.invalid", Token = "sidecar-token" } };
        public Task RefreshAsync(CancellationToken ct) => Task.CompletedTask;
        public DateTime? LastRefreshedAt => null;
        public string? LastRefreshError => null;
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public int Sends { get; private set; }
        public string? Body { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sends++;
            Body = await request.Content!.ReadAsStringAsync(ct);
            return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent("event: done\ndata: {\"final_text\":\"ok\"}\n\n", Encoding.UTF8, "text/event-stream") };
        }
    }
}
