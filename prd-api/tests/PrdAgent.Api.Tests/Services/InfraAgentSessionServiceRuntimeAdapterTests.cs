using PrdAgent.Core.Interfaces;
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
}
