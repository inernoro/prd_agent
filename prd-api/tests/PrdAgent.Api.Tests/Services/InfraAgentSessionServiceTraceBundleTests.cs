using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentSessionServiceTraceBundleTests
{
    [Fact]
    public void BuildTraceBundle_ShouldSummarizeEventsAndArtifacts()
    {
        var now = DateTime.UtcNow;
        var session = BuildSession(now);
        var messages = new[]
        {
            new InfraAgentMessageView("msg-1", "session-1", "user", "巡检当前仓库", "completed", now)
        };
        var events = new[]
        {
            new InfraAgentEventView("evt-1", "session-1", 1, "trace-1", InfraAgentEventTypes.Status, """{"status":"running","reason":"start"}""", now),
            new InfraAgentEventView(
                "evt-2",
                "session-1",
                2,
                "trace-1",
                InfraAgentEventTypes.ToolResult,
                JsonSerializer.Serialize(new
                {
                    resultSummary = JsonSerializer.Serialize(new
                    {
                        diff = "diff --git a/a.txt b/a.txt",
                        path = "a.txt"
                    })
                }),
                now.AddSeconds(1)),
        };

        var bundle = InfraAgentSessionService.BuildTraceBundle(session, messages, events, "line-1\nline-2");

        bundle.SchemaVersion.ShouldBe("cds-agent-trace-bundle/v1");
        bundle.Metrics.MessageCount.ShouldBe(1);
        bundle.Metrics.EventCount.ShouldBe(2);
        bundle.Metrics.LastEventSeq.ShouldBe(2);
        bundle.Metrics.LogLineCount.ShouldBe(2);
        bundle.EventTypeCounts[InfraAgentEventTypes.ToolResult].ShouldBe(1);
        bundle.Events[0].Payload.GetProperty("status").GetString().ShouldBe("running");
        bundle.Artifacts.ShouldContain(x => x.Kind == "diff" && x.Summary == "a.txt");
        bundle.Artifacts.ShouldContain(x => x.Id == "runtime-logs" && x.Kind == "log");
        bundle.Replay.WorkbenchPath.ShouldBe("/cds-agent?sessionId=session-1");
        bundle.Replay.EventsCursor.ShouldBe(2);
    }

    private static InfraAgentSessionView BuildSession(DateTime now) => new(
        "session-1",
        "user-1",
        "conn-1",
        "cds",
        "shared-service",
        "cds-session-1",
        null,
        null,
        "trace-1",
        InfraAgentRuntimes.ClaudeSdk,
        "claude-agent-sdk",
        "run-1",
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
        InfraAgentSessionStatuses.Running,
        false,
        false,
        null,
        null,
        null,
        now.AddMinutes(-1),
        now,
        now.AddMinutes(-1),
        null);
}
