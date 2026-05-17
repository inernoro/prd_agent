using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.AgentRuntime;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentSessionServiceRuntimeAdapterTests
{
    [Fact]
    public void ResolveSidecarRuntimeAdapter_ShouldPreferOfficialSdkByDefault()
    {
        var previous = Environment.GetEnvironmentVariable("INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER");
        try
        {
            Environment.SetEnvironmentVariable("INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER", null);

            InfraAgentRuntimeAdapterDefaults.ResolveSidecarRuntimeAdapter().ShouldBe("claude-agent-sdk");
        }
        finally
        {
            Environment.SetEnvironmentVariable("INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER", previous);
        }
    }

    [Fact]
    public void ResolveSidecarRuntimeAdapter_ShouldAllowExplicitLegacyOverride()
    {
        var previous = Environment.GetEnvironmentVariable("INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER");
        try
        {
            Environment.SetEnvironmentVariable("INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER", "legacy-sidecar");

            InfraAgentRuntimeAdapterDefaults.ResolveSidecarRuntimeAdapter().ShouldBe("legacy-sidecar");
        }
        finally
        {
            Environment.SetEnvironmentVariable("INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER", previous);
        }
    }

    [Fact]
    public async Task LegacySidecarRuntimeAdapter_ShouldForwardWorkspaceContext()
    {
        var router = new CapturingSidecarRouter();
        var adapter = new LegacySidecarRuntimeAdapter(router);
        var request = new InfraAgentRuntimeRunRequest
        {
            RunId = "run-1",
            MapSessionId = "session-1",
            TraceId = "trace-1",
            WorkspaceRoot = "/workspace/prd_agent",
            GitRepository = "inernoro/prd_agent",
            GitRef = "codex/cds-agent-workbench-ui",
            RuntimeAdapter = "claude-agent-sdk"
        };

        await foreach (var _ in adapter.RunStreamAsync(request, CancellationToken.None))
        {
        }

        router.LastRequest.ShouldNotBeNull();
        router.LastRequest.MapSessionId.ShouldBe("session-1");
        router.LastRequest.TraceId.ShouldBe("trace-1");
        router.LastRequest.WorkspaceRoot.ShouldBe("/workspace/prd_agent");
        router.LastRequest.GitRepository.ShouldBe("inernoro/prd_agent");
        router.LastRequest.GitRef.ShouldBe("codex/cds-agent-workbench-ui");
        router.LastRequest.RuntimeAdapter.ShouldBe("claude-agent-sdk");
    }

    private sealed class CapturingSidecarRouter : IClaudeSidecarRouter
    {
        public SidecarRunRequest? LastRequest { get; private set; }
        public bool IsConfigured => true;
        public int InstanceCount => 1;
        public int HealthyCount => 1;
        public IReadOnlyList<string> Blockers => Array.Empty<string>();
        public IReadOnlyList<string> NextActions => Array.Empty<string>();

        public async IAsyncEnumerable<SidecarEvent> RunStreamAsync(
            SidecarRunRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            LastRequest = request;
            await Task.Yield();
            yield return new SidecarEvent { Type = SidecarEventType.Done, FinalText = "ok" };
        }

        public Task<SidecarCancelResult> CancelRunAsync(string runId, CancellationToken ct) =>
            Task.FromResult(new SidecarCancelResult(true, "ok"));

        public Task<SidecarPoolDiagnostics> GetDiagnosticsAsync(CancellationToken ct) =>
            Task.FromResult(new SidecarPoolDiagnostics(
                IsConfigured: true,
                InstanceCount: 1,
                HealthyCount: 1,
                Instances: Array.Empty<SidecarInstanceDiagnostics>(),
                RegistryLastRefreshedAt: null,
                RegistryLastRefreshError: null,
                Blockers: Array.Empty<string>(),
                NextActions: Array.Empty<string>(),
                DesiredRuntimeAdapter: "claude-agent-sdk",
                RuntimeTransport: "legacy-sidecar-adapter",
                DiscoveryMetrics: null));
    }
}
