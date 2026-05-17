using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.AgentRuntime;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using System.Text.Json;
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

    [Fact]
    public async Task SidecarRuntimeAdapter_ShouldPreserveOfficialProviderKeyError()
    {
        var content = """
        {
          "adapter": "claude-agent-sdk",
          "providerKeyMode": "runtime-profile-or-env",
          "nextActions": [
            "select or create a MAP runtime profile with a valid provider apiKey"
          ]
        }
        """;
        var router = new CapturingSidecarRouter(new SidecarEvent
        {
            Type = SidecarEventType.Error,
            ErrorCode = "provider_key_missing",
            Message = "ANTHROPIC_API_KEY is required",
            Content = content,
            SidecarName = "official-sidecar-1"
        });
        var adapter = new LegacySidecarRuntimeAdapter(router);

        var events = new List<InfraAgentRuntimeEvent>();
        await foreach (var ev in adapter.RunStreamAsync(
            new InfraAgentRuntimeRunRequest
            {
                RunId = "run-provider-key",
                RuntimeAdapter = "claude-agent-sdk"
            },
            CancellationToken.None))
        {
            events.Add(ev);
        }

        var error = events.Single();
        error.Type.ShouldBe(InfraAgentRuntimeEventType.Error);
        error.ErrorCode.ShouldBe("provider_key_missing");
        error.Message.ShouldBe("ANTHROPIC_API_KEY is required");
        error.Content.ShouldBe(content);
        error.RuntimeInstanceName.ShouldBe("official-sidecar-1");
        error.Source.ShouldBe("sidecar-runtime-adapter");

        using var doc = JsonDocument.Parse(error.Content!);
        doc.RootElement.GetProperty("adapter").GetString().ShouldBe("claude-agent-sdk");
        doc.RootElement.GetProperty("nextActions")[0].GetString().ShouldBe("select or create a MAP runtime profile with a valid provider apiKey");
    }

    [Fact]
    public void BuildRuntimeErrorStatus_ShouldClassifyProviderKeyMissingAsConfigIssue()
    {
        var status = InfraAgentSessionService.BuildRuntimeErrorStatus(
            "provider_key_missing",
            "ANTHROPIC_API_KEY is required",
            """
            {"nextActions":["select or create a MAP runtime profile with a valid provider apiKey"]}
            """);

        status.Retryable.ShouldBeFalse();
        status.RecoveryKind.ShouldBe("provider_config");
        status.SessionError.ShouldBe("Claude SDK sidecar 执行失败(provider_key_missing)：ANTHROPIC_API_KEY is required");
        status.NextActions.ShouldContain("select or create a MAP runtime profile with a valid provider apiKey");
    }

    [Fact]
    public void BuildRuntimeErrorStatus_ShouldClassifyNonRetryableWorkspaceConfigErrors()
    {
        var status = InfraAgentSessionService.BuildRuntimeErrorStatus(
            "workspace_prepare_failed",
            "remote branch not found",
            """
            {"workspaceErrorCode":"git_ref_not_found","nextActions":["verify gitRef exists on the target repository"]}
            """);

        status.Retryable.ShouldBeFalse();
        status.RecoveryKind.ShouldBe("workspace_config");
        status.NextActions.ShouldContain("verify gitRef exists on the target repository");
    }

    [Fact]
    public void BuildRuntimeErrorStatus_ShouldKeepSdkResultErrorsRetryable()
    {
        var status = InfraAgentSessionService.BuildRuntimeErrorStatus(
            "claude_agent_sdk_result_error",
            "error_during_execution",
            """{"sdkResult":{"subtype":"error_during_execution"}}""");

        status.Retryable.ShouldBeTrue();
        status.RecoveryKind.ShouldBe("sdk_result_error");
        status.NextActions.ShouldContain("查看 usage/done content.sdkResult 中的官方 SDK subtype/session 信息");
    }

    private sealed class CapturingSidecarRouter : IClaudeSidecarRouter
    {
        private readonly SidecarEvent? _event;

        public CapturingSidecarRouter(SidecarEvent? ev = null)
        {
            _event = ev;
        }

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
            yield return _event ?? new SidecarEvent { Type = SidecarEventType.Done, FinalText = "ok" };
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
                RuntimeTransport: "sidecar-runtime-adapter",
                DiscoveryMetrics: null));
    }
}
