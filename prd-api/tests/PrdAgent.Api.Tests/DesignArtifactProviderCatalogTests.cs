using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests;

public class DesignArtifactProviderCatalogTests
{
    [Fact]
    public async Task CatalogAcceptsAdditionalProviderWithoutChangingController()
    {
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource(), new ClosedDesignDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor("closed-design")],
            []);

        var capability = await catalog.FindAsync("user-1", "closed-design");

        Assert.NotNull(capability);
        Assert.True(capability.Enabled);
        Assert.Equal(DesignArtifactAdapterKinds.InProcess, capability.AdapterKind);
        Assert.Contains(DesignArtifactOperations.Edit, capability.Operations);
    }

    [Fact]
    public async Task RemoteProviderUsesCdsRuntimeFactAndKeepsPlannedRuntimeDisabled()
    {
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor(DesignArtifactRuntimes.OpenDesign)],
            [new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                new DesignArtifactProviderProbeResult(
                    Configured: false,
                    Healthy: false,
                    Enabled: false,
                    Reason: "OpenDesign daemon 与会话级容器分配器尚未部署"))]);

        var capability = await catalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.False(capability.Configured);
        Assert.False(capability.Healthy);
        Assert.False(capability.Enabled);
        Assert.Equal(DesignArtifactExecutionOwners.CdsRemoteAgent, capability.ExecutionOwner);
        Assert.Equal(DesignArtifactIsolationModes.SessionContainer, capability.IsolationMode);
        Assert.Contains("会话级容器", capability.Reason);
    }

    [Fact]
    public async Task RemoteProviderBecomesEnabledOnlyWhenCdsReportsSelectableContract()
    {
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor(DesignArtifactRuntimes.OpenDesign)],
            [new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                new DesignArtifactProviderProbeResult(
                    Configured: true,
                    Healthy: true,
                    Enabled: true,
                    Reason: null))]);

        var capability = await catalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.True(capability.Configured);
        Assert.True(capability.Healthy);
        Assert.True(capability.Enabled);
        Assert.Null(capability.Reason);
    }

    [Fact]
    public async Task OpenDesignProbeRequiresCdsSessionContainerResourceEnforcement()
    {
        var connection = BuildConnection();
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([connection]);
        var sessions = new Mock<IInfraAgentSessionService>();
        sessions.Setup(service => service.ListRuntimeProvidersAsync(
                "user-1",
                connection.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([BuildOpenDesignRuntime(resourcePolicyEnforcedPerSession: false)]);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        Assert.True(result.Configured);
        Assert.True(result.Healthy);
        Assert.False(result.Enabled);
        Assert.Contains("按会话强制", result.Reason);
    }

    [Fact]
    public async Task OpenDesignProbeEnablesOnlyMatchingCdsDesignArtifactContract()
    {
        var connection = BuildConnection();
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([connection]);
        var sessions = new Mock<IInfraAgentSessionService>();
        sessions.Setup(service => service.ListRuntimeProvidersAsync(
                "user-1",
                connection.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([BuildOpenDesignRuntime(resourcePolicyEnforcedPerSession: true)]);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        Assert.True(result.Configured);
        Assert.True(result.Healthy);
        Assert.True(result.Enabled);
        Assert.Null(result.Reason);
    }

    [Fact]
    public async Task OpenDesignExecutorSendsVersionedTaskPackageAndStreamsCdsEvents()
    {
        var connection = BuildConnection();
        var remoteSession = BuildSession();
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([connection]);
        CreateInfraAgentSessionRequest? createRequest = null;
        string? sentEnvelope = null;
        var sessions = new Mock<IInfraAgentSessionService>();
        sessions.Setup(service => service.CreateAsync(
                "user-1",
                It.IsAny<CreateInfraAgentSessionRequest>(),
                It.IsAny<CancellationToken>()))
            .Callback<string, CreateInfraAgentSessionRequest, CancellationToken>((_, request, _) => createRequest = request)
            .ReturnsAsync(remoteSession);
        sessions.Setup(service => service.StartAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<StartInfraAgentSessionRequest>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(remoteSession);
        sessions.Setup(service => service.SendMessageAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<SendInfraAgentMessageRequest>(),
                It.IsAny<CancellationToken>()))
            .Callback<string, string, SendInfraAgentMessageRequest, CancellationToken>((_, _, request, _) => sentEnvelope = request.Content)
            .ReturnsAsync(remoteSession);
        sessions.Setup(service => service.ListPersistedEventsAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<long>(),
                It.IsAny<int>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([
                new InfraAgentEventView("event-1", remoteSession.Id, 1, "trace-1", InfraAgentEventTypes.Thinking, "{\"text\":\"正在布局\"}", DateTime.UtcNow),
                new InfraAgentEventView("event-2", remoteSession.Id, 2, "trace-1", InfraAgentEventTypes.TextDelta, "{\"text\":\"<!doctype html>\"}", DateTime.UtcNow),
                new InfraAgentEventView("event-3", remoteSession.Id, 3, "trace-1", InfraAgentEventTypes.Done, "{\"finalText\":\"<!doctype html>\"}", DateTime.UtcNow),
            ]);
        sessions.Setup(service => service.StopAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(remoteSession);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);
        var run = new DesignArtifactRun
        {
            Id = "run-1",
            UserId = "user-1",
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Generate,
            SourceSurface = DesignArtifactSourceSurfaces.KnowledgeBase,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            Instruction = "做一个产品介绍页",
            KnowledgeReferences =
            [
                new DesignKnowledgeSnapshot
                {
                    EntryId = "entry-1",
                    Title = "产品资料",
                    Content = "核心价值是降低配置成本",
                    ContentHash = "hash-1",
                },
            ],
        };
        var chunks = new List<DesignArtifactExecutorChunk>();

        await foreach (var chunk in executor.ExecuteAsync(run, currentHtml: null, CancellationToken.None))
            chunks.Add(chunk);

        Assert.NotNull(createRequest);
        Assert.Equal(InfraAgentRuntimes.OpenDesign, createRequest.Runtime);
        Assert.Equal(InfraAgentWorkloadKinds.DesignArtifact, createRequest.WorkloadKind);
        Assert.Equal(InfraAgentIsolationModes.SessionContainer, createRequest.IsolationMode);
        Assert.Equal(InfraAgentToolPolicies.DenyAll, createRequest.ToolPolicy);
        Assert.NotNull(sentEnvelope);
        using var envelope = JsonDocument.Parse(sentEnvelope);
        Assert.Equal("map-design-artifact-v1", envelope.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal(
            "核心价值是降低配置成本",
            envelope.RootElement.GetProperty("knowledgeReferences")[0].GetProperty("content").GetString());
        Assert.Collection(
            chunks,
            chunk =>
            {
                Assert.Equal("thinking", chunk.Type);
                Assert.Equal("正在布局", chunk.Content);
            },
            chunk =>
            {
                Assert.Equal("delta", chunk.Type);
                Assert.Equal("<!doctype html>", chunk.Content);
            });
        sessions.Verify(service => service.StopAsync(
            "user-1",
            remoteSession.Id,
            CancellationToken.None), Times.Once);
    }

    private static InfraConnectionPublicView BuildConnection() => new(
        "connection-1",
        "cds",
        "CDS",
        "cds-1",
        "https://cds.test",
        "project-1",
        "/api/discovery",
        ["instance:read", "shared-service:deploy"],
        "active",
        DateTime.UtcNow.AddDays(-1),
        DateTime.UtcNow,
        DateTime.UtcNow,
        true,
        null,
        DateTime.UtcNow.AddYears(1));

    private static InfraAgentSessionView BuildSession() => new(
        Id: "session-1",
        UserId: "user-1",
        ConnectionId: "connection-1",
        Partner: "cds",
        CdsProjectId: "project-1",
        CdsSessionId: "cds-session-1",
        CdsWorkerId: "worker-1",
        CdsContainerName: "container-1",
        TraceId: "run-1",
        Runtime: InfraAgentRuntimes.OpenDesign,
        RuntimeAdapter: "design-daemon",
        CurrentRuntimeRunId: null,
        Model: null,
        WorkspaceRoot: null,
        GitRepository: null,
        GitRef: null,
        ResourceCpuCores: 2,
        ResourceMemoryMb: 4096,
        TimeoutSeconds: 900,
        NetworkPolicy: "restricted",
        AutoCleanupMinutes: 30,
        ToolPolicy: InfraAgentToolPolicies.DenyAll,
        HookProfileId: null,
        Title: "OpenDesign 网页生成",
        Status: InfraAgentSessionStatuses.Running,
        IsArchived: false,
        ManualTakeoverEnabled: false,
        ManualTakeoverAt: null,
        ManualTakeoverReason: null,
        LastError: null,
        CreatedAt: DateTime.UtcNow,
        UpdatedAt: DateTime.UtcNow,
        StartedAt: DateTime.UtcNow,
        StoppedAt: null,
        RuntimeProfileId: null,
        ModelBaseUrl: null,
        WorkloadKind: InfraAgentWorkloadKinds.DesignArtifact,
        IsolationMode: InfraAgentIsolationModes.SessionContainer);

    private static InfraAgentRuntimeProviderView BuildOpenDesignRuntime(
        bool resourcePolicyEnforcedPerSession) => new(
        DesignArtifactRuntimes.OpenDesign,
        "OpenDesign",
        "design-daemon",
        "cds-remote-agent",
        "available",
        true,
        [InfraAgentWorkloadKinds.DesignArtifact],
        [InfraAgentIsolationModes.SessionContainer],
        InfraAgentIsolationModes.SessionContainer,
        "cds-design-artifact-events-v1",
        true,
        true,
        true,
        "cds-remote-agent",
        resourcePolicyEnforcedPerSession,
        null);

    private sealed class ClosedDesignDefinitionSource : IDesignArtifactProviderDefinitionSource
    {
        public IEnumerable<DesignArtifactProviderDefinition> GetDefinitions()
        {
            yield return new DesignArtifactProviderDefinition(
                "closed-design",
                "ClosedDesign",
                DesignArtifactAdapterKinds.InProcess,
                DesignArtifactExecutionOwners.Map,
                DesignArtifactIsolationModes.Process,
                [DesignArtifactTypes.WebPage],
                [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit],
                [DesignArtifactSourceSurfaces.WebHosting]);
        }
    }

    private sealed class StubExecutor(string runtime) : IDesignArtifactExecutor
    {
        public string Runtime { get; } = runtime;

        public bool Supports(string artifactType, string operation) => true;

        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
            DesignArtifactRun run,
            string? currentHtml,
            [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            yield break;
        }
    }

    private sealed class StubProbe(
        string runtime,
        DesignArtifactProviderProbeResult result) : IDesignArtifactProviderProbe
    {
        public string Runtime { get; } = runtime;

        public Task<DesignArtifactProviderProbeResult> ProbeAsync(string userId, CancellationToken ct) =>
            Task.FromResult(result);
    }
}
