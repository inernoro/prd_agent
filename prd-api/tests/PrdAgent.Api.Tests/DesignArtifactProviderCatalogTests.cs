using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
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
        using var cache = NewCache();
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource(), new ClosedDesignDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor("closed-design")],
            [],
            cache);

        var capability = await catalog.FindAsync("user-1", "closed-design");

        Assert.NotNull(capability);
        Assert.True(capability.Enabled);
        Assert.Equal(DesignArtifactAdapterKinds.InProcess, capability.AdapterKind);
        Assert.Contains(DesignArtifactOperations.Edit, capability.Operations);
    }

    [Fact]
    public async Task RemoteProviderUsesCdsRuntimeFactAndKeepsPlannedRuntimeDisabled()
    {
        using var cache = NewCache();
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor(DesignArtifactRuntimes.OpenDesign)],
            [new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                new DesignArtifactProviderProbeResult(
                    Configured: false,
                    Healthy: false,
                    Enabled: false,
                    Reason: "OpenDesign daemon 与会话级容器分配器尚未部署"))],
            cache);

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
        using var cache = NewCache();
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor(DesignArtifactRuntimes.OpenDesign)],
            [new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                new DesignArtifactProviderProbeResult(
                    Configured: true,
                    Healthy: true,
                    Enabled: true,
                    Reason: null))],
            cache);

        var capability = await catalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.True(capability.Configured);
        Assert.True(capability.Healthy);
        Assert.True(capability.Enabled);
        Assert.Null(capability.Reason);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task RemoteProviderUsesRecentPositiveFactAcrossCatalogScopesWhenProbeFails(bool timesOut)
    {
        using var cache = NewCache();
        var firstCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                EnabledProbeResult()));
        var first = await firstCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);
        Exception failure = timesOut
            ? new OperationCanceledException("probe timed out")
            : new InvalidOperationException("probe transport failed");
        var nextCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                _ => Task.FromException<DesignArtifactProviderProbeResult>(failure)));

        var fallback = await nextCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(first);
        Assert.True(first.Enabled);
        Assert.NotNull(fallback);
        Assert.True(fallback.Enabled);
        Assert.True(fallback.Configured);
        Assert.True(fallback.Healthy);
    }

    [Fact]
    public async Task RemoteProviderValidDisabledFactInvalidatesRecentPositiveSnapshot()
    {
        using var cache = NewCache();
        var firstCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(DesignArtifactRuntimes.OpenDesign, EnabledProbeResult()));
        await firstCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);
        var disabledCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                new DesignArtifactProviderProbeResult(
                    Configured: true,
                    Healthy: false,
                    Enabled: false,
                    Reason: "CDS 正在维护")));

        var disabled = await disabledCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);
        var failingCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                _ => Task.FromException<DesignArtifactProviderProbeResult>(new InvalidOperationException("probe failed"))));
        var afterFailure = await failingCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(disabled);
        Assert.False(disabled.Enabled);
        Assert.Equal("CDS 正在维护", disabled.Reason);
        Assert.NotNull(afterFailure);
        Assert.False(afterFailure.Enabled);
        Assert.Contains("暂时无法读取", afterFailure.Reason);
    }

    [Fact]
    public async Task RemoteProviderDoesNotUseExpiredPositiveSnapshot()
    {
        using var cache = NewCache();
        var cacheDuration = TimeSpan.FromMilliseconds(20);
        var firstCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(DesignArtifactRuntimes.OpenDesign, EnabledProbeResult()),
            cacheDuration);
        await firstCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);
        await Task.Delay(80);
        var failingCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                _ => Task.FromException<DesignArtifactProviderProbeResult>(new InvalidOperationException("probe failed"))),
            cacheDuration);

        var capability = await failingCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.False(capability.Enabled);
        Assert.Contains("暂时无法读取", capability.Reason);
    }

    [Fact]
    public async Task RemoteProviderDoesNotSharePositiveSnapshotAcrossUsers()
    {
        using var cache = NewCache();
        var firstCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(DesignArtifactRuntimes.OpenDesign, EnabledProbeResult()));
        await firstCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);
        var failingCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                _ => Task.FromException<DesignArtifactProviderProbeResult>(new InvalidOperationException("probe failed"))));

        var capability = await failingCatalog.FindAsync("user-2", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.False(capability.Enabled);
        Assert.Contains("暂时无法读取", capability.Reason);
    }

    [Fact]
    public async Task RemoteProviderDoesNotMaskCallerCancellationWithPositiveSnapshot()
    {
        using var cache = NewCache();
        var firstCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(DesignArtifactRuntimes.OpenDesign, EnabledProbeResult()));
        await firstCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var cancelledCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                ct => Task.FromCanceled<DesignArtifactProviderProbeResult>(ct)));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            cancelledCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign, cancellation.Token));
    }

    [Fact]
    public async Task ConnectionScopedProviderFactIsNeverReusedWithoutCurrentConnectionProof()
    {
        using var cache = NewCache();
        var firstCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                EnabledProbeResult() with { ConnectionId = "connection-a" }));
        var first = await firstCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);
        Assert.True(first!.Enabled);
        Assert.Equal("connection-a", first.ConnectionId);

        var failingCatalog = BuildOpenDesignCatalog(
            cache,
            new StubProbe(
                DesignArtifactRuntimes.OpenDesign,
                _ => Task.FromException<DesignArtifactProviderProbeResult>(new InvalidOperationException("probe failed"))));
        var afterFailure = await failingCatalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.False(afterFailure!.Enabled);
        Assert.Null(afterFailure.ConnectionId);
    }

    [Fact]
    public void InternalConnectionIdIsNotSerializedToCapabilityClients()
    {
        var capability = new DesignArtifactProviderCapability(
            DesignArtifactRuntimes.OpenDesign,
            "OpenDesign",
            DesignArtifactAdapterKinds.RemoteAgent,
            DesignArtifactExecutionOwners.CdsRemoteAgent,
            DesignArtifactIsolationModes.SessionContainer,
            [DesignArtifactTypes.WebPage],
            [DesignArtifactOperations.Generate],
            [DesignArtifactSourceSurfaces.WebHosting],
            Configured: true,
            Healthy: true,
            Enabled: true,
            Reason: null,
            ConnectionId: "internal-connection-id");

        var json = JsonSerializer.Serialize(capability);

        Assert.DoesNotContain("internal-connection-id", json, StringComparison.Ordinal);
        Assert.DoesNotContain("ConnectionId", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OpenDesignProbeFailsClosedForDuplicateConnectionsToSameTarget()
    {
        var first = BuildConnection(id: "connection-1");
        var duplicate = BuildConnection(id: "connection-2");
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([first, duplicate]);
        var sessions = new Mock<IInfraAgentSessionService>(MockBehavior.Strict);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            Mock.Of<IDesignArtifactWorkspaceBroker>(),
            BuildConfiguration(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        Assert.False(result.Enabled);
        Assert.Null(result.ConnectionId);
        Assert.Contains("多个可用的 CDS 连接", result.Reason);
        sessions.VerifyNoOtherCalls();
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
            Mock.Of<IDesignArtifactWorkspaceBroker>(),
            BuildConfiguration(),
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
            Mock.Of<IDesignArtifactWorkspaceBroker>(),
            BuildConfiguration(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        Assert.True(result.Configured);
        Assert.True(result.Healthy);
        Assert.True(result.Enabled);
        Assert.Null(result.Reason);
    }

    [Fact]
    public async Task OpenDesignProbeWaitsForCdsCapabilityVerification()
    {
        var connection = BuildConnection();
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([connection]);
        var sessions = new Mock<IInfraAgentSessionService>();
        sessions.SetupSequence(service => service.ListRuntimeProvidersAsync(
                "user-1",
                connection.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([BuildPendingOpenDesignRuntime()])
            .ReturnsAsync([BuildOpenDesignRuntime(resourcePolicyEnforcedPerSession: true)]);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            Mock.Of<IDesignArtifactWorkspaceBroker>(),
            BuildConfiguration(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        Assert.True(result.Enabled);
        sessions.Verify(service => service.ListRuntimeProvidersAsync(
            "user-1",
            connection.Id,
            It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    [Fact]
    public async Task OpenDesignProbeFailsClosedForMultipleTargetsUntilConnectionIsConfigured()
    {
        var first = BuildConnection();
        var second = BuildConnection(
            id: "connection-2",
            partnerId: "cds-2",
            baseUrl: "https://cds-2.test",
            projectId: "project-2");
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([first, second]);
        var sessions = new Mock<IInfraAgentSessionService>(MockBehavior.Strict);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            Mock.Of<IDesignArtifactWorkspaceBroker>(),
            BuildConfiguration(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        Assert.False(result.Enabled);
        Assert.Null(result.ConnectionId);
        Assert.Contains("多个可用的 CDS", result.Reason);
        sessions.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task OpenDesignProbeUsesConfiguredConnectionAndReturnsItsFrozenIdentity()
    {
        var first = BuildConnection();
        var second = BuildConnection(
            id: "connection-2",
            partnerId: "cds-2",
            baseUrl: "https://cds-2.test",
            projectId: "project-2");
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([first, second]);
        var sessions = new Mock<IInfraAgentSessionService>();
        sessions.Setup(service => service.ListRuntimeProvidersAsync(
                "user-1",
                second.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([BuildOpenDesignRuntime(resourcePolicyEnforcedPerSession: true)]);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            Mock.Of<IDesignArtifactWorkspaceBroker>(),
            BuildConfiguration(second.Id),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        Assert.True(result.Enabled);
        Assert.Equal(second.Id, result.ConnectionId);
        sessions.Verify(service => service.ListRuntimeProvidersAsync(
            "user-1",
            second.Id,
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task OpenDesignExecutorSendsVersionedTaskPackageAndStreamsCdsEvents()
    {
        var connection = BuildConnection();
        var remoteSession = BuildSession();
        var connections = new Mock<IInfraConnectionService>();
        var newerDifferentTarget = BuildConnection(
            id: "connection-2",
            partnerId: "cds-2",
            baseUrl: "https://cds-2.test",
            projectId: "project-2",
            updatedAt: DateTime.UtcNow.AddMinutes(1));
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([connection, newerDifferentTarget]);
        CreateInfraAgentSessionRequest? createRequest = null;
        StartInfraAgentSessionRequest? startRequest = null;
        string? sentEnvelope = null;
        var workspaceBroker = new Mock<IDesignArtifactWorkspaceBroker>();
        workspaceBroker.Setup(service => service.PrepareAsync(
                It.IsAny<DesignArtifactRun>(),
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new PreparedDesignArtifactWorkspace(
                "https://map.test/input",
                "input-sha",
                "https://map.test/result",
                "transfer-token",
                "https://map.test/llm/v1",
                "model-token",
                "map-managed",
                "base-revision",
                1_048_576,
                6_291_456,
                ["index.html", "manifest.json", "assets/**"]));
        workspaceBroker.Setup(service => service.ReadResultHtmlAsync("run-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync("<!doctype html>");
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
            .Callback<string, string, StartInfraAgentSessionRequest, CancellationToken>((_, _, request, _) => startRequest = request)
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
                new InfraAgentEventView("event-2", remoteSession.Id, 2, "trace-1", InfraAgentEventTypes.TextDelta, "{\"text\":\"正在生成页面文件\"}", DateTime.UtcNow),
                new InfraAgentEventView("event-3", remoteSession.Id, 3, "trace-1", InfraAgentEventTypes.Done, "{\"artifactRef\":\"map://design-artifact/run-1/result\"}", DateTime.UtcNow),
            ]);
        sessions.Setup(service => service.StopAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(remoteSession);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            workspaceBroker.Object,
            BuildConfiguration(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);
        var run = new DesignArtifactRun
        {
            Id = "run-1",
            UserId = "user-1",
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Generate,
            SourceSurface = DesignArtifactSourceSurfaces.KnowledgeBase,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            RuntimeConnectionId = connection.Id,
            Instruction = "做一个产品介绍页",
            Title = "产品介绍页",
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
        Assert.Equal(connection.Id, createRequest.ConnectionId);
        Assert.Equal(InfraAgentRuntimes.OpenDesign, createRequest.Runtime);
        Assert.Equal(InfraAgentWorkloadKinds.DesignArtifact, createRequest.WorkloadKind);
        Assert.Equal(InfraAgentIsolationModes.SessionContainer, createRequest.IsolationMode);
        Assert.Equal(InfraAgentToolPolicies.DenyAll, createRequest.ToolPolicy);
        Assert.NotNull(startRequest?.ManagedLaunch);
        Assert.Equal("https://map.test/llm/v1", startRequest.ManagedLaunch.ModelBaseUrl);
        Assert.Equal("https://map.test/input", startRequest.ManagedLaunch.WorkspaceTransfer.InputPackageUrl);
        Assert.Equal("transfer-token", startRequest.ManagedLaunch.WorkspaceTransfer.TransferToken);
        Assert.NotNull(sentEnvelope);
        using var envelope = JsonDocument.Parse(sentEnvelope);
        Assert.Equal("map-design-artifact-command-v2", envelope.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal("cds-design-artifact-events-v1", envelope.RootElement.GetProperty("runtimeProtocol").GetString());
        Assert.Equal(
            ["schemaVersion", "runtimeProtocol", "runId", "workspaceTask", "command"],
            envelope.RootElement.EnumerateObject().Select(property => property.Name).ToArray());
        Assert.Equal("run-1", envelope.RootElement.GetProperty("runId").GetString());
        Assert.Equal("/workspace/brief/task.json", envelope.RootElement.GetProperty("workspaceTask").GetString());
        Assert.Contains("/workspace/index.html exists", envelope.RootElement.GetProperty("command").GetString());
        Assert.False(envelope.RootElement.TryGetProperty("knowledgeReferences", out _));
        Assert.False(envelope.RootElement.TryGetProperty("workspace", out _));
        Assert.False(envelope.RootElement.TryGetProperty("responseContract", out _));
        Assert.False(envelope.RootElement.TryGetProperty("systemInstruction", out _));
        Assert.False(envelope.RootElement.TryGetProperty("task", out _));
        Assert.DoesNotContain("做一个产品介绍页", sentEnvelope);
        Assert.DoesNotContain("产品介绍页", sentEnvelope);
        Assert.DoesNotContain("entry-1", sentEnvelope);
        Assert.DoesNotContain("hash-1", sentEnvelope);
        Assert.DoesNotContain("核心价值是降低配置成本", sentEnvelope);
        Assert.Collection(
            chunks,
            chunk =>
            {
                Assert.Equal("thinking", chunk.Type);
                Assert.Equal("正在布局", chunk.Content);
            },
            chunk =>
            {
                Assert.Equal("thinking", chunk.Type);
                Assert.Equal("正在生成页面文件", chunk.Content);
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

    [Fact]
    public async Task OpenDesignExecutorStopsWhenCdsSessionFailsBeforeErrorEventIsPersisted()
    {
        var connection = BuildConnection();
        var remoteSession = BuildSession();
        var failedSession = remoteSession with
        {
            Status = InfraAgentSessionStatuses.Failed,
            LastError = "remote diagnostic details",
        };
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(service => service.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync([connection]);
        var workspaceBroker = new Mock<IDesignArtifactWorkspaceBroker>();
        workspaceBroker.Setup(service => service.PrepareAsync(
                It.IsAny<DesignArtifactRun>(),
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new PreparedDesignArtifactWorkspace(
                "https://map.test/input",
                "input-sha",
                "https://map.test/result",
                "transfer-token",
                "https://map.test/llm/v1",
                "model-token",
                "map-managed",
                "base-revision",
                1_048_576,
                6_291_456,
                ["index.html", "manifest.json", "assets/**"]));
        var sessions = new Mock<IInfraAgentSessionService>();
        sessions.Setup(service => service.CreateAsync(
                "user-1",
                It.IsAny<CreateInfraAgentSessionRequest>(),
                It.IsAny<CancellationToken>()))
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
            .ReturnsAsync(remoteSession);
        sessions.Setup(service => service.ListPersistedEventsAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<long>(),
                It.IsAny<int>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        sessions.Setup(service => service.GetAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(failedSession);
        sessions.Setup(service => service.StopAsync(
                "user-1",
                remoteSession.Id,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(failedSession);
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            workspaceBroker.Object,
            BuildConfiguration(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);
        var run = new DesignArtifactRun
        {
            Id = "run-1",
            UserId = "user-1",
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Generate,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            RuntimeConnectionId = connection.Id,
            Instruction = "生成页面",
            Title = "页面",
        };

        var error = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await foreach (var _ in executor.ExecuteAsync(run, currentHtml: null, CancellationToken.None))
            {
            }
        });

        Assert.Equal("OpenDesign 远程执行失败，请在 CDS 会话日志中查看原因后重试", error.Message);
        Assert.DoesNotContain("remote diagnostic details", error.Message);
        sessions.Verify(service => service.GetAsync(
            "user-1",
            remoteSession.Id,
            It.IsAny<CancellationToken>()), Times.Once);
        sessions.Verify(service => service.StopAsync(
            "user-1",
            remoteSession.Id,
            CancellationToken.None), Times.Once);
    }

    private static InfraConnectionPublicView BuildConnection(
        string id = "connection-1",
        string partnerId = "cds-1",
        string baseUrl = "https://cds.test",
        string projectId = "project-1",
        DateTime? updatedAt = null) => new(
        id,
        "cds",
        "CDS",
        partnerId,
        baseUrl,
        projectId,
        "/api/discovery",
        ["instance:read", "shared-service:deploy"],
        "active",
        DateTime.UtcNow.AddDays(-1),
        updatedAt ?? DateTime.UtcNow,
        DateTime.UtcNow,
        true,
        null,
        DateTime.UtcNow.AddYears(1));

    private static IConfiguration BuildConfiguration(string? connectionId = null)
    {
        var values = new Dictionary<string, string?>();
        if (!string.IsNullOrWhiteSpace(connectionId))
            values["DesignArtifactRuntime:CdsConnectionId"] = connectionId;
        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private static MemoryCache NewCache() => new(new MemoryCacheOptions());

    private static DesignArtifactProviderCatalog BuildOpenDesignCatalog(
        IMemoryCache cache,
        IDesignArtifactProviderProbe probe,
        TimeSpan? positiveCapabilityCacheDuration = null) => new(
            [new BuiltInDesignArtifactProviderDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor(DesignArtifactRuntimes.OpenDesign)],
            [probe],
            cache,
            positiveCapabilityCacheDuration ?? TimeSpan.FromSeconds(60));

    private static DesignArtifactProviderProbeResult EnabledProbeResult() => new(
        Configured: true,
        Healthy: true,
        Enabled: true,
        Reason: null);

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

    private static InfraAgentRuntimeProviderView BuildPendingOpenDesignRuntime() => new(
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
        false,
        false,
        false,
        "cds-remote-agent",
        false,
        "OpenDesign capability verification is running on this CDS node",
        VerificationPending: true);

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

    private sealed class StubProbe : IDesignArtifactProviderProbe
    {
        private readonly Func<CancellationToken, Task<DesignArtifactProviderProbeResult>> _probe;

        public StubProbe(string runtime, DesignArtifactProviderProbeResult result)
            : this(runtime, _ => Task.FromResult(result))
        {
        }

        public StubProbe(
            string runtime,
            Func<CancellationToken, Task<DesignArtifactProviderProbeResult>> probe)
        {
            Runtime = runtime;
            _probe = probe;
        }

        public string Runtime { get; }

        public Task<DesignArtifactProviderProbeResult> ProbeAsync(string userId, CancellationToken ct) =>
            _probe(ct);
    }
}
