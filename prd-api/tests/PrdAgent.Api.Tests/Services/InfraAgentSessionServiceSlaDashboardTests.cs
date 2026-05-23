using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentSessionServiceSlaDashboardTests
{
    [Fact]
    public void BuildSlaDashboard_ShouldSummarizeTeamSlaAndUsage()
    {
        var now = new DateTime(2026, 5, 19, 10, 0, 0, DateTimeKind.Utc);
        var sessions = new[]
        {
            BuildSession("session-1", InfraAgentSessionStatuses.Stopped, now.AddMinutes(-30), now.AddMinutes(-20), null, null),
            BuildSession("session-2", InfraAgentSessionStatuses.Failed, now.AddMinutes(-15), now.AddMinutes(-5), "runtime timeout", "openai-agents-sdk"),
            BuildSession("session-3", InfraAgentSessionStatuses.Running, now.AddMinutes(-5), null, null, null),
        };
        var events = new[]
        {
            new InfraAgentEventView(
                "evt-1",
                "session-1",
                1,
                "trace-1",
                InfraAgentEventTypes.Done,
                JsonSerializer.Serialize(new { usage = new { input_tokens = 1200, output_tokens = 300 } }),
                now.AddMinutes(-20)),
            new InfraAgentEventView(
                "evt-2",
                "session-2",
                1,
                "trace-2",
                InfraAgentEventTypes.Error,
                """{"message":"runtime timeout after 900s"}""",
                now.AddMinutes(-5)),
            new InfraAgentEventView(
                "evt-3",
                "session-3",
                1,
                "trace-3",
                InfraAgentEventTypes.ToolCall,
                """{"tool":"kb_search"}""",
                now.AddMinutes(-3)),
        };

        var dashboard = InfraAgentSessionService.BuildSlaDashboard(sessions, events, 7, now.AddDays(-7), now);

        dashboard.SchemaVersion.ShouldBe("cds-agent-sla-dashboard/v1");
        dashboard.WindowDays.ShouldBe(7);
        dashboard.Summary.SessionCount.ShouldBe(3);
        dashboard.Summary.RunningCount.ShouldBe(1);
        dashboard.Summary.FailedCount.ShouldBe(1);
        dashboard.Summary.TimeoutCount.ShouldBe(1);
        dashboard.Summary.FailureRate.ShouldBe(1.0 / 3.0, 0.0001);
        dashboard.Summary.TimeoutRate.ShouldBe(1.0 / 3.0, 0.0001);
        dashboard.Summary.EventCount.ShouldBe(3);
        dashboard.Summary.ToolEventCount.ShouldBe(1);
        dashboard.Summary.ErrorEventCount.ShouldBe(1);
        dashboard.Summary.InputTokens.ShouldBe(1200);
        dashboard.Summary.OutputTokens.ShouldBe(300);
        dashboard.Summary.TotalTokens.ShouldBe(1500);
        dashboard.Summary.TokenUsageObserved.ShouldBeTrue();
        dashboard.Summary.EstimatedCostUsd.ShouldBeNull();
        dashboard.StatusCounts.Single(x => x.Status == InfraAgentSessionStatuses.Failed).Count.ShouldBe(1);
        dashboard.RuntimeBreakdown.ShouldContain(x => x.Runtime == InfraAgentRuntimes.ClaudeSdk && x.RuntimeAdapter == "claude-agent-sdk");
        dashboard.RuntimeBreakdown.Single(x => x.RuntimeAdapter == "openai-agents-sdk").TimeoutCount.ShouldBe(1);
        dashboard.Daily.Sum(x => x.SessionCount).ShouldBe(3);
    }

    private static InfraAgentSessionView BuildSession(
        string id,
        string status,
        DateTime startedAt,
        DateTime? stoppedAt,
        string? lastError,
        string? runtimeAdapter) => new(
            id,
            "user-1",
            "conn-1",
            "cds",
            "shared-service",
            $"cds-{id}",
            null,
            null,
            $"trace-{id}",
            InfraAgentRuntimes.ClaudeSdk,
            runtimeAdapter ?? "claude-agent-sdk",
            $"run-{id}",
            "claude-sonnet-4-5",
            "/workspace/prd_agent",
            "inernoro/prd_agent",
            "codex/cds-agent-workbench-ui",
            2,
            4096,
            900,
            InfraAgentRuntimeNetworkPolicies.Restricted,
            30,
            InfraAgentToolPolicies.ReadonlyAuto,
            null,
            "代码巡检",
            status,
            false,
            false,
            null,
            null,
            lastError,
            startedAt.AddMinutes(-2),
            stoppedAt ?? startedAt,
            startedAt,
            stoppedAt);
}
