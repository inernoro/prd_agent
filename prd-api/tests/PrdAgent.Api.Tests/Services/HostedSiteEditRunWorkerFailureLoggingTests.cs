using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using System.Text.Json;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// OpenDesign 远端失败时，用户文案说「原文已记入服务端日志」（PR #1611 Codex 评审）。
/// 远端原文挂在 InnerException 上；worker 的 InvalidOperationException 分支以前只把 ex.Message
/// 写进任务记录、不记日志，于是那句承诺是空的——原文随异常一起丢掉。
///
/// 这里走 worker 真实的 ProcessAsync（与 DesignArtifactLifecycleServiceTests 同一套装配），
/// 断言：任务记录里只有人话、没有远端原文；日志里有一条 Error，带着完整异常链。
/// </summary>
public sealed class HostedSiteEditRunWorkerFailureLoggingTests
{
    private const string RemoteDiagnostic = "POST /internal/workspace/commit returned 502 upstream=cds-node-7";
    private const string RemoteCode = "design_output_quality_rejected";

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RemoteFailure_UserSeesPlainMessage_AndRawDiagnosticIsLoggedWithExceptionChain()
    {
        await using var fixture = await RunMongoFixture.CreateAsync("worker_failure_log");
        var run = new DesignArtifactRun
        {
            Id = "remote-failure-log",
            UserId = "owner-user",
            Instruction = "生成说明网页",
            Title = "说明网页",
            Runtime = DesignArtifactRuntimes.OpenDesign,
        };
        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(run, Capability(), currentHtml: null);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        var eventStore = new InMemoryRunEventStore();
        var lifecycle = new DesignArtifactLifecycleService(fixture.Db, eventStore);
        var lifecycleAdapter = new WebPageDesignArtifactLifecycleAdapter(
            fixture.Db,
            lifecycle,
            Mock.Of<IDesignArtifactWorkspaceBroker>(),
            NullLogger<WebPageDesignArtifactLifecycleAdapter>.Instance);
        var services = new ServiceCollection();
        services.AddSingleton(fixture.Db);
        services.AddSingleton(Mock.Of<IHostedSiteService>());
        services.AddSingleton(Mock.Of<IHostedSiteRevisionService>());
        services.AddSingleton<IWebPageDesignArtifactLifecycleAdapter>(lifecycleAdapter);
        services.AddSingleton<IDesignArtifactLifecycleService>(lifecycle);
        services.AddSingleton(Mock.Of<IDesignKnowledgeSnapshotResolver>());
        services.AddSingleton(Mock.Of<IActivityActionRecorder>());
        services.AddSingleton<IDesignArtifactExecutor>(new RemoteFailureExecutor());
        using var provider = services.BuildServiceProvider();
        var logger = new RecordingLogger<HostedSiteEditRunWorker>();
        using var worker = new HostedSiteEditRunWorker(
            provider.GetRequiredService<IServiceScopeFactory>(),
            Mock.Of<IRunQueue>(),
            eventStore,
            logger);

        await worker.ProcessAsync(run.Id, CancellationToken.None);

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Error, persisted.Status);
        Assert.NotNull(persisted.Error);
        Assert.Contains("没有通过发布前的校验", persisted.Error, StringComparison.Ordinal);
        Assert.DoesNotContain(RemoteDiagnostic, persisted.Error, StringComparison.Ordinal);
        Assert.Equal(RemoteCode, persisted.LifecycleFailureCode);
        Assert.Equal(RemoteCode, persisted.RuntimeFailure?.Code);
        Assert.Equal(["css_generated_text"], persisted.RuntimeFailure?.IssueCodes);
        Assert.Equal(1, persisted.RuntimeFailure?.RepairAttempts);
        Assert.True(persisted.RuntimeFailure?.RepairBudgetExhausted);
        var terminal = persisted.LifecycleEvents[^1];
        Assert.Equal(DesignArtifactLifecycleEventTypes.Error, terminal.Type);
        Assert.Equal(["css_generated_text"], terminal.RuntimeFailure?.IssueCodes);
        var projected = (await eventStore.GetEventsAsync(
                RunKinds.DesignArtifact,
                run.Id,
                0,
                100,
                CancellationToken.None))
            .Last();
        Assert.Equal("error", projected.EventName);
        using var projectedPayload = JsonDocument.Parse(projected.PayloadJson);
        Assert.Equal(RemoteCode, projectedPayload.RootElement.GetProperty("code").GetString());
        Assert.Equal("css_generated_text",
            projectedPayload.RootElement.GetProperty("details").GetProperty("issueCodes")[0].GetString());
        Assert.Equal(1, projectedPayload.RootElement.GetProperty("details").GetProperty("repairAttempts").GetInt32());
        Assert.True(projectedPayload.RootElement.GetProperty("details").GetProperty("repairBudgetExhausted").GetBoolean());
        Assert.DoesNotContain(RemoteDiagnostic, projected.PayloadJson, StringComparison.Ordinal);

        var entry = Assert.Single(logger.Entries, e => e.Level == LogLevel.Error);
        Assert.Contains(run.Id, entry.Message, StringComparison.Ordinal);
        var failure = Assert.IsType<InvalidOperationException>(entry.Exception);
        var inner = Assert.IsType<OpenDesignRemoteDiagnosticException>(failure.InnerException);
        Assert.Equal(RemoteDiagnostic, inner.Diagnostic);
        Assert.Equal(RemoteCode, inner.RemoteCode);
    }

    private sealed class RemoteFailureExecutor : IDesignArtifactExecutor
    {
        public string Runtime => DesignArtifactRuntimes.OpenDesign;
        public bool Supports(string artifactType, string operation) => true;

        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
            DesignArtifactRun run,
            string? currentHtml,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            yield return new DesignArtifactExecutorChunk("thinking", "正在整理结构");
            throw OpenDesignFailureMessage.Failure(
                OpenDesignFailureStage.RemoteRun,
                RemoteDiagnostic,
                RemoteCode,
                new OpenDesignRemoteFailureDetails(["css_generated_text"], 1, true));
        }
    }

    private static DesignArtifactProviderCapability Capability() => new(
        DesignArtifactRuntimes.OpenDesign,
        "OpenDesign",
        DesignArtifactAdapterKinds.RemoteAgent,
        DesignArtifactExecutionOwners.CdsRemoteAgent,
        DesignArtifactIsolationModes.SessionContainer,
        [DesignArtifactTypes.WebPage],
        [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit],
        [DesignArtifactSourceSurfaces.WebHosting],
        Configured: true,
        Healthy: true,
        Enabled: true,
        Reason: null,
        ConnectionId: "cds-primary");

    private sealed record LogEntry(LogLevel Level, string Message, Exception? Exception);

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        private readonly List<LogEntry> _entries = [];

        public IReadOnlyList<LogEntry> Entries
        {
            get { lock (_entries) return _entries.ToList(); }
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            lock (_entries) _entries.Add(new LogEntry(logLevel, formatter(state, exception), exception));
        }
    }
}
