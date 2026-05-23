using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentSessionServiceScheduleDashboardTests
{
    [Fact]
    public void BuildScheduleDashboard_ShouldSummarizeCdsAgentCronAndKnowledgeGovernance()
    {
        var now = new DateTime(2026, 5, 19, 12, 0, 0, DateTimeKind.Utc);
        var workflow = new Workflow
        {
            Id = "workflow-1",
            Name = "CDS Agent 每日知识库巡检",
            Description = "Cron 工作流稳定跑并产出只读治理报告",
            Tags = new List<string> { "cds-agent", "knowledge", "readonly" },
            CreatedBy = "user-1",
            UpdatedAt = now,
            Nodes = new List<WorkflowNode>
            {
                new()
                {
                    NodeId = "n-cds-agent",
                    Name = "CdsAgentRun",
                    NodeType = CapsuleTypes.CdsAgent,
                    Config = new Dictionary<string, object?>
                    {
                        ["prompt"] = "使用 kb_list/kb_search/kb_read 只读巡检知识库，不做写入。"
                    }
                },
                new()
                {
                    NodeId = "n-notify",
                    Name = "Notify",
                    NodeType = CapsuleTypes.NotificationSender
                }
            }
        };
        var schedule = new WorkflowSchedule
        {
            Id = "schedule-1",
            WorkflowId = workflow.Id,
            WorkflowName = workflow.Name,
            Name = "每天 09:00 只读巡检",
            Mode = "cron",
            CronExpression = "0 9 * * *",
            Timezone = "Asia/Shanghai",
            IsEnabled = true,
            NextRunAt = now.AddHours(2),
            TriggerCount = 3,
            CreatedBy = "user-1",
            CreatedAt = now.AddDays(-2)
        };
        var runHandle = JsonSerializer.Serialize(new
        {
            kind = "cds-agent-workflow-run",
            sessionId = "session-1",
            traceId = "trace-1",
            workbenchPath = "/cds-agent?sessionId=session-1"
        });
        var execution = new WorkflowExecution
        {
            Id = "execution-1",
            WorkflowId = workflow.Id,
            WorkflowName = workflow.Name,
            TraceId = "workflow-trace-1",
            TriggerType = WorkflowTriggerTypes.Cron,
            TriggeredBy = "user-1",
            Status = WorkflowExecutionStatus.Completed,
            CreatedAt = now.AddHours(-1),
            DurationMs = 120000,
            NodeSnapshot = workflow.Nodes,
            NodeExecutions = new List<NodeExecution>
            {
                new()
                {
                    NodeId = "n-cds-agent",
                    NodeName = "CdsAgentRun",
                    NodeType = CapsuleTypes.CdsAgent,
                    Status = NodeExecutionStatus.Completed,
                    OutputArtifacts = new List<ExecutionArtifact>
                    {
                        new()
                        {
                            SlotId = "cds-agent-run",
                            Name = "CDS Agent 运行句柄",
                            MimeType = "application/json",
                            InlineContent = runHandle
                        }
                    }
                }
            }
        };

        var dashboard = InfraAgentSessionService.BuildScheduleDashboard(
            new[] { workflow },
            new[] { schedule },
            new[] { execution },
            14,
            now);

        dashboard.SchemaVersion.ShouldBe("cds-agent-schedule-dashboard/v1");
        dashboard.Summary.WorkflowCount.ShouldBe(1);
        dashboard.Summary.CdsAgentNodeCount.ShouldBe(1);
        dashboard.Summary.CronScheduleCount.ShouldBe(1);
        dashboard.Summary.EnabledCronScheduleCount.ShouldBe(1);
        dashboard.Summary.DueSoonScheduleCount.ShouldBe(1);
        dashboard.Summary.RecentExecutionCount.ShouldBe(1);
        dashboard.Summary.FailedRecentExecutionCount.ShouldBe(0);
        dashboard.Summary.KnowledgeReadonlyWorkflowCount.ShouldBe(1);
        dashboard.Workflows.Single().HasKnowledgeReadonlyTools.ShouldBeTrue();
        dashboard.Workflows.Single().HasNotifyNode.ShouldBeTrue();
        dashboard.Schedules.Single().State.ShouldBe("due-soon");
        dashboard.RecentExecutions.Single().CdsAgentSessionId.ShouldBe("session-1");
        dashboard.RecentExecutions.Single().WorkbenchPath.ShouldBe("/cds-agent?sessionId=session-1");
        dashboard.KnowledgeGovernance.ReadonlyTools.ShouldBe(new[] { "kb_list", "kb_search", "kb_read" });
        dashboard.KnowledgeGovernance.Boundary.ShouldContain("readonly-only");
    }
}
