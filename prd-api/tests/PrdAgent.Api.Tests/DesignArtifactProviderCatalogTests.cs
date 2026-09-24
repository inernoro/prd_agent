using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
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
    public async Task OpenDesignExecutorReusesCommittedWorkspaceResultWithoutStartingAnotherSession()
    {
        var connections = new Mock<IInfraConnectionService>(MockBehavior.Strict);
        var sessions = new Mock<IInfraAgentSessionService>(MockBehavior.Strict);
        var workspaceBroker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        var verifiedResultFiles = new[]
        {
            new DesignWorkspaceFile(
                "index.html",
                Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("<!doctype html>recovered")),
                "verified-sha",
                25,
                "text/html; charset=utf-8"),
        };
        workspaceBroker.Setup(service => service.ReadResultAsync("run-result-ready", CancellationToken.None))
            .ReturnsAsync(new ParsedDesignWorkspaceResult("<!doctype html>recovered", verifiedResultFiles));
        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            workspaceBroker.Object,
            BuildConfiguration(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);
        var run = new DesignArtifactRun
        {
            Id = "run-result-ready",
            UserId = "user-1",
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Generate,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            RuntimeConnectionId = "connection-no-longer-required",
            WorkspaceResultAssetKey = "private/results/run-result-ready.json",
            Instruction = "生成页面",
        };
        var chunks = new List<DesignArtifactExecutorChunk>();

        await foreach (var chunk in executor.ExecuteAsync(run, currentHtml: null, CancellationToken.None))
            chunks.Add(chunk);

        var recovered = Assert.Single(chunks);
        Assert.Equal("delta", recovered.Type);
        Assert.Equal("<!doctype html>recovered", recovered.Content);
        Assert.Same(verifiedResultFiles, recovered.VerifiedFiles);
        workspaceBroker.Verify(service => service.ReadResultAsync("run-result-ready", CancellationToken.None), Times.Once);
        workspaceBroker.VerifyNoOtherCalls();
        connections.VerifyNoOtherCalls();
        sessions.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public async Task OpenDesignExecutorSendsVersionedTaskPackageAndStreamsCdsEvents(int pendingStarts)
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
        var verifiedResultFiles = new[]
        {
            new DesignWorkspaceFile("index.html", "", "verified-sha", 15, "text/html; charset=utf-8"),
            new DesignWorkspaceFile("manifest.json", "", "manifest-sha", 10, "application/json; charset=utf-8"),
        };
        workspaceBroker.Setup(service => service.ReadResultAsync("run-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ParsedDesignWorkspaceResult("<!doctype html>", verifiedResultFiles));
        var sessions = new Mock<IInfraAgentSessionService>();
        var startCalls = 0;
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
            .Returns<string, string, StartInfraAgentSessionRequest, CancellationToken>((_, _, request, _) =>
            {
                startRequest = request;
                startCalls++;
                if (startCalls <= pendingStarts)
                {
                    sessions.Verify(service => service.StopAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
                    sessions.Verify(service => service.SendMessageAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<SendInfraAgentMessageRequest>(), It.IsAny<CancellationToken>()), Times.Never);
                    throw new InfraAgentSessionException(InfraAgentSessionErrorCodes.SessionCreationPending, "创建中", 503);
                }
                return Task.FromResult<InfraAgentSessionView?>(remoteSession);
            });
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
                new InfraAgentEventView("event-3", remoteSession.Id, 3, "trace-1", InfraAgentEventTypes.Done, "{\"artifactRef\":\"map://design-artifact/run-1/result\",\"clientMessageId\":\"message-1\"}", DateTime.UtcNow, remoteSession.CdsSessionId),
            ]);
        sessions.Setup(service => service.ScheduleStopAsync(
                "user-1",
                remoteSession.Id,
                remoteSession.CdsSessionId!,
                "message-1",
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
        Assert.Equal(pendingStarts + 1, startCalls);
        sessions.Verify(service => service.CreateAsync("user-1", It.IsAny<CreateInfraAgentSessionRequest>(), It.IsAny<CancellationToken>()), Times.Once);
        sessions.Verify(service => service.SendMessageAsync("user-1", remoteSession.Id, It.IsAny<SendInfraAgentMessageRequest>(), It.IsAny<CancellationToken>()), Times.Once);
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
                Assert.Same(verifiedResultFiles, chunk.VerifiedFiles);
            });
        sessions.Verify(service => service.ScheduleStopAsync(
            "user-1",
            remoteSession.Id,
            remoteSession.CdsSessionId!,
            "message-1",
            CancellationToken.None), Times.Once);
        sessions.Verify(service => service.StopAsync(
            It.IsAny<string>(),
            It.IsAny<string>(),
            It.IsAny<CancellationToken>()), Times.Never);
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

        // 这两条断言原本要求这句话保持不透明，并把用户指向 CDS 会话日志——而 CDS 的 agent 会话
        // 是内存态，失败后随即销毁，点进去只会拿到 session_not_found；原因明明就在 LastError 里。
        // 改成断言真正被保护的性质：远端原因不丢、且这句话不再指向那个死胡同。
        // 2026-09-24（PR #1533 评审 4081291421）：远端原文不直接摆给用户，挂在异常链里进日志；
        // 用户文案说清「有诊断、在服务端日志里」并给下一步。
        Assert.DoesNotContain("remote diagnostic details", error.Message);
        Assert.Contains("remote diagnostic details", error.InnerException?.Message);
        Assert.Contains(OpenDesignFailureMessage.UnmappedReason, error.Message);
        Assert.DoesNotContain("会话日志", error.Message);
        Assert.Contains("下一步：", error.Message);
        sessions.Verify(service => service.GetAsync(
            "user-1",
            remoteSession.Id,
            It.IsAny<CancellationToken>()), Times.Once);
        sessions.Verify(service => service.StopAsync(
            "user-1",
            remoteSession.Id,
            CancellationToken.None), Times.Once);
    }

    /// <summary>
    /// 这条用例本来在保的是「finally 的重试确实生效」：登记第一次瞬时失败、第二次成功，
    /// 两次登记、不落到直接停止。那三条断言原样保留。
    ///
    /// 改掉的是它顺带断言的「不交付产物」——那不是被保护的性质，是抛出顺序的附带后果，
    /// 而且在这个场景里**清理明明重试成功了**，产物却还是被丢掉：模型已经跑完、钱已经花了，
    /// 用户拿到的是一次失败的 run（Codex P1，2026-09-16）。记账是我们这侧的账，
    /// 它不该有权处决一件已经完成的产物。
    /// </summary>
    [Fact]
    public async Task OpenDesignExecutorStillDeliversArtifactWhenCleanupLedgerWriteFailsOnce()
    {
        var connection = BuildConnection();
        var remoteSession = BuildSession();
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
        workspaceBroker.Setup(service => service.ReadResultAsync("run-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ParsedDesignWorkspaceResult("<!doctype html>", []));
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
            .ReturnsAsync([
                new InfraAgentEventView(
                    "event-done",
                    remoteSession.Id,
                    1,
                    "trace-1",
                    InfraAgentEventTypes.Done,
                    "{\"artifactRef\":\"map://design-artifact/run-1/result\",\"clientMessageId\":\"message-1\"}",
                    DateTime.UtcNow,
                    remoteSession.CdsSessionId),
            ]);
        sessions.SetupSequence(service => service.ScheduleStopAsync(
                "user-1",
                remoteSession.Id,
                remoteSession.CdsSessionId!,
                "message-1",
                CancellationToken.None))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                "transient cleanup failure",
                StatusCodes.Status502BadGateway))
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
            Runtime = DesignArtifactRuntimes.OpenDesign,
            RuntimeConnectionId = connection.Id,
            Instruction = "生成页面",
            Title = "页面",
        };
        var chunks = new List<DesignArtifactExecutorChunk>();
        await foreach (var chunk in executor.ExecuteAsync(run, currentHtml: null, CancellationToken.None))
        {
            chunks.Add(chunk);
        }

        // 产物必须交付：第一次登记瞬时失败不该把它带走
        Assert.Contains(chunks, chunk => chunk.Type == "delta");
        // 下面三条是这条用例原本就在保的：登记重试生效，两次登记，不落到直接停止
        sessions.Verify(service => service.ScheduleStopAsync(
            "user-1",
            remoteSession.Id,
            remoteSession.CdsSessionId!,
            "message-1",
            CancellationToken.None), Times.Exactly(2));
        sessions.Verify(service => service.StopAsync(
            It.IsAny<string>(),
            It.IsAny<string>(),
            It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task StartupObservationWaitsForCreatingViewButDoesNotRetryDefiniteFailure()
    {
        var session = BuildSession();
        var count = 0;
        var ready = await OpenDesignRemoteArtifactExecutor.WaitForSessionReadyAsync(_ =>
            Task.FromResult<InfraAgentSessionView?>(++count == 1
                ? session with { Status = InfraAgentSessionStatuses.Creating, CdsSessionId = null }
                : session), DateTime.UtcNow.AddSeconds(2), CancellationToken.None, TimeSpan.Zero);
        Assert.Equal(2, count);
        Assert.Same(session, ready);
        count = 0;
        var error = await Assert.ThrowsAsync<InfraAgentSessionException>(() =>
            OpenDesignRemoteArtifactExecutor.WaitForSessionReadyAsync(_ =>
            {
                count++;
                throw new InfraAgentSessionException(InfraAgentSessionErrorCodes.CdsRequestFailed, "确定失败", 503);
            }, DateTime.UtcNow.AddSeconds(2), CancellationToken.None, TimeSpan.Zero));
        Assert.Equal(1, count);
        Assert.Equal(InfraAgentSessionErrorCodes.CdsRequestFailed, error.ErrorCode);
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Stopped)]
    [InlineData(InfraAgentSessionStatuses.Stopping)]
    public async Task StartupObservationHonorsStoppedState(string status)
    {
        await Assert.ThrowsAsync<DesignArtifactExecutionCancelledException>(() =>
            OpenDesignRemoteArtifactExecutor.WaitForSessionReadyAsync(_ => Task.FromResult<InfraAgentSessionView?>(
                BuildSession() with { Status = status }), DateTime.UtcNow.AddSeconds(2), CancellationToken.None));
    }

    [Fact]
    public async Task StartupObservationKeepsExistingDeadlineAndCallerCancellation()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OpenDesignRemoteArtifactExecutor.WaitForSessionReadyAsync(async token =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return BuildSession();
            }, DateTime.UtcNow.AddMilliseconds(100), CancellationToken.None));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var calls = 0;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OpenDesignRemoteArtifactExecutor.WaitForSessionReadyAsync(_ =>
            {
                calls++;
                return Task.FromResult<InfraAgentSessionView?>(BuildSession());
            }, DateTime.UtcNow.AddSeconds(2), cancellation.Token));
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task StartupRetriesWithFreshSessionWhenNodeWasVerifying()
    {
        // 2026-09-23 预览环境实测：上一个设计会话结束后 CDS 节点做能力自检，新会话被拒，
        // 用户只看到「设计任务执行失败」。自检结束后换新会话就能起来。
        var first = BuildSession() with { Id = "session-a" };
        var second = BuildSession() with { Id = "session-b" };
        var started = new List<string>();
        var discarded = new List<string>();
        var replaced = new List<string>();
        var providerReads = 0;
        var ready = await OpenDesignRemoteArtifactExecutor.StartWithTransientRuntimeRetryAsync(
            first,
            (candidate, _) =>
            {
                started.Add(candidate.Id);
                if (candidate.Id == "session-a")
                    throw new InfraAgentSessionException(
                        InfraAgentSessionErrorCodes.CdsRequestFailed,
                        "OpenDesign capability verification is running on this CDS node",
                        502);
                return Task.FromResult(candidate);
            },
            _ => Task.FromResult<InfraAgentRuntimeProviderView?>(
                BuildProvider(verificationPending: ++providerReads == 1)),
            _ => Task.FromResult(second),
            failed => { discarded.Add(failed.Id); return Task.CompletedTask; },
            replacement => replaced.Add(replacement.Id),
            DateTime.UtcNow.AddSeconds(5),
            CancellationToken.None,
            pollDelay: TimeSpan.Zero);

        Assert.Same(second, ready);
        Assert.Equal(["session-a", "session-b"], started);
        Assert.Equal(["session-a"], discarded);
        Assert.Equal(["session-b"], replaced);
        Assert.Equal(2, providerReads);
    }

    [Fact]
    public async Task StartupDoesNotRetryWhenRuntimeIsReallyUnavailable()
    {
        var creates = 0;
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OpenDesignRemoteArtifactExecutor.StartWithTransientRuntimeRetryAsync(
                BuildSession(),
                (_, _) => throw new InfraAgentSessionException(
                    InfraAgentSessionErrorCodes.CdsRequestFailed, "docker unavailable", 502),
                _ => Task.FromResult<InfraAgentRuntimeProviderView?>(BuildProvider(healthy: false)),
                _ => { creates++; return Task.FromResult(BuildSession()); },
                _ => Task.CompletedTask,
                _ => { },
                DateTime.UtcNow.AddSeconds(5),
                CancellationToken.None,
                pollDelay: TimeSpan.Zero));
        Assert.Equal(0, creates);
        Assert.Contains("远端会话没能进入可用状态", error.Message);
        // 远端原文不进用户文案，挂在异常链里进日志（PR #1533 评审 4081291421）。
        Assert.DoesNotContain("docker unavailable", error.Message);
        Assert.Contains("docker unavailable", error.InnerException?.Message);
    }

    [Fact]
    public async Task StartupRetryIsBoundedAndExplainsTheVerifyingNode()
    {
        var starts = 0;
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OpenDesignRemoteArtifactExecutor.StartWithTransientRuntimeRetryAsync(
                BuildSession(),
                (_, _) =>
                {
                    starts++;
                    throw new InfraAgentSessionException(
                        InfraAgentSessionErrorCodes.CdsRequestFailed, "verification is running", 502);
                },
                _ => Task.FromResult<InfraAgentRuntimeProviderView?>(BuildProvider()),
                _ => Task.FromResult(BuildSession()),
                _ => Task.CompletedTask,
                _ => { },
                DateTime.UtcNow.AddSeconds(5),
                CancellationToken.None,
                maxAttempts: 3,
                pollDelay: TimeSpan.Zero));
        Assert.Equal(3, starts);
        Assert.Contains("正在做能力自检", error.Message);
    }

    [Fact]
    public async Task StartupRetryPassesThroughNonCdsFailures()
    {
        var reads = 0;
        await Assert.ThrowsAsync<DesignArtifactExecutionCancelledException>(() =>
            OpenDesignRemoteArtifactExecutor.StartWithTransientRuntimeRetryAsync(
                BuildSession(),
                (_, _) => throw new DesignArtifactExecutionCancelledException("stopped"),
                _ => { reads++; return Task.FromResult<InfraAgentRuntimeProviderView?>(BuildProvider()); },
                _ => Task.FromResult(BuildSession()),
                _ => Task.CompletedTask,
                _ => { },
                DateTime.UtcNow.AddSeconds(5),
                CancellationToken.None,
                pollDelay: TimeSpan.Zero));
        Assert.Equal(0, reads);
    }

    private static InfraAgentRuntimeProviderView BuildProvider(
        bool verificationPending = false,
        bool healthy = true) => new(
        InfraAgentRuntimes.OpenDesign,
        "OpenDesign",
        "cds-managed",
        "cds",
        "ready",
        true,
        [InfraAgentWorkloadKinds.DesignArtifact],
        [InfraAgentIsolationModes.SessionContainer],
        InfraAgentIsolationModes.SessionContainer,
        "cds-design-artifact-events-v1",
        Configured: true,
        Healthy: healthy,
        Selectable: healthy,
        IsolationOwnedBy: "cds",
        ResourcePolicyEnforcedPerSession: true,
        Reason: null,
        VerificationPending: verificationPending);

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

    /// <summary>
    /// 「这条路由在对面不存在」与「连不上」要分开说：前者要升级 CDS，后者要修连接。
    /// 压成同一句「请检查系统连接」，就是把人支去修一条健康的连接，而真正的版本/路由不匹配
    /// 反而看不见（Codex P2，2026-09-15）。判据取抛出点带出来的真实状态码，不匹配异常文案。
    /// </summary>
    [Fact]
    public async Task MissingRuntimeRouteIsReportedAsAVersionMismatchNotABrokenConnection()
    {
        using var cache = NewCache();
        var catalog = BuildOpenDesignCatalog(cache, new StubProbe(
            DesignArtifactRuntimes.OpenDesign,
            _ => throw new InfraAgentSessionException(
                "cds_request_failed",
                "CDS 请求失败：HTTP 404 CDS 远端请求失败",
                StatusCodes.Status502BadGateway,
                StatusCodes.Status404NotFound)));

        var capability = await catalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.False(capability!.Enabled);
        Assert.Contains("升级", capability.Reason);
        Assert.DoesNotContain("请检查系统连接", capability.Reason);
    }

    [Fact]
    public async Task TransportFailureStillTellsTheUserToCheckTheConnection()
    {
        using var cache = NewCache();
        var catalog = BuildOpenDesignCatalog(cache, new StubProbe(
            DesignArtifactRuntimes.OpenDesign,
            _ => throw new HttpRequestException("connection refused")));

        var capability = await catalog.FindAsync("user-1", DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.False(capability!.Enabled);
        Assert.Contains("请检查系统连接", capability.Reason);
    }

    [Fact]
    public void UpstreamStatusOtherThanNotFoundKeepsTheConnectionWording()
    {
        // 502 / 503 这类确实是「打不通对面」，不该被说成版本不匹配。
        var reason = DesignArtifactProviderCatalog.DescribeProbeFailure(
            new InfraAgentSessionException(
                "cds_request_failed",
                "CDS 请求失败：HTTP 503 CDS 远端请求失败",
                StatusCodes.Status502BadGateway,
                StatusCodes.Status503ServiceUnavailable));

        Assert.Contains("请检查系统连接", reason);
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
