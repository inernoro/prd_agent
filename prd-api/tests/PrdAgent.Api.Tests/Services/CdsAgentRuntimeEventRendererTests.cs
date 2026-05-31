using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class CdsAgentRuntimeEventRendererTests
{
    [Fact]
    public void Render_ShouldSummarizeRuntimeErrorRecoveryFields()
    {
        var evt = new InfraAgentEventView(
            "evt-1",
            "session-1",
            12,
            "trace-1",
            InfraAgentEventTypes.Error,
            """
            {
              "code": "provider_key_missing",
              "message": "ANTHROPIC_API_KEY is required",
              "retryable": false,
              "recoveryKind": "provider_config",
              "nextActions": [
                "select or create a MAP runtime profile with a valid provider apiKey",
                "verify the CDS Agent session request includes the intended runtime profile"
              ],
              "source": "sidecar-runtime-adapter",
              "runtimeAdapter": "claude-agent-sdk",
              "runtimeInstance": "sidecar-1"
            }
            """,
            DateTime.UtcNow);

        var rendered = CdsAgentRuntimeEventRenderer.Render(evt);

        rendered.ShouldContain("provider_key_missing");
        rendered.ShouldContain("recovery=provider_config");
        rendered.ShouldContain("retryable=no");
        rendered.ShouldContain("adapter=claude-agent-sdk");
        rendered.ShouldContain("instance=sidecar-1");
        rendered.ShouldContain("ANTHROPIC_API_KEY is required");
        rendered.ShouldContain("下一步: select or create a MAP runtime profile with a valid provider apiKey");
    }

    [Fact]
    public void Render_LiteStatus_SurfacesPreviewModeInWorkflowOutput()
    {
        var evt = new InfraAgentEventView(
            "evt-2", "session-2", 1, "trace-2",
            InfraAgentEventTypes.Status,
            "{\"status\":\"running\",\"mode\":\"lite\",\"degradeReason\":\"r1_profile_incompatible\"}",
            DateTime.UtcNow);

        var rendered = CdsAgentRuntimeEventRenderer.Render(evt);

        rendered.ShouldContain("Lite 预览");
        rendered.ShouldContain("只读");
    }

    [Fact]
    public void Render_OfficialStatus_ShowsOfficialSdk()
    {
        var evt = new InfraAgentEventView(
            "evt-3", "session-3", 1, "trace-3",
            InfraAgentEventTypes.Status,
            "{\"status\":\"running\",\"mode\":\"official\"}",
            DateTime.UtcNow);

        CdsAgentRuntimeEventRenderer.Render(evt).ShouldContain("官方 SDK");
    }

    [Fact]
    public void Render_StatusWithoutMode_ReturnsEmptyToAvoidNoise()
    {
        var evt = new InfraAgentEventView(
            "evt-4", "session-4", 1, "trace-4",
            InfraAgentEventTypes.Status,
            "{\"status\":\"stopping\",\"reason\":\"session_stop_requested\"}",
            DateTime.UtcNow);

        CdsAgentRuntimeEventRenderer.Render(evt).ShouldBe(string.Empty);
    }
}
