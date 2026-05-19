using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentSessionServiceGovernanceDashboardTests
{
    [Fact]
    public void BuildGovernanceDashboard_ShouldExposeP3_5IsolationGates()
    {
        var now = new DateTime(2026, 5, 19, 13, 0, 0, DateTimeKind.Utc);
        var userId = "user-1";
        var team = new ReportTeam
        {
            Id = "team-1",
            Name = "Agent Team",
            LeaderUserId = userId
        };
        var workflow = new Workflow
        {
            Id = "workflow-1",
            Name = "CDS Agent 只读巡检",
            CreatedBy = userId,
            OwnerUserId = userId,
            Nodes = new List<WorkflowNode>
            {
                new()
                {
                    NodeType = CapsuleTypes.CdsAgent
                }
            }
        };
        var ownedStore = new DocumentStore
        {
            Id = "store-owned",
            Name = "Owned KB",
            OwnerId = userId,
            IsPublic = false
        };
        var publicStore = new DocumentStore
        {
            Id = "store-public",
            Name = "Public KB",
            OwnerId = "other-user",
            IsPublic = true
        };
        var ownedProfile = new InfraAgentRuntimeProfile
        {
            Id = "profile-1",
            Name = "User Profile",
            CreatedByUserId = userId,
            IsDefault = false
        };
        var globalDefaultProfile = new InfraAgentRuntimeProfile
        {
            Id = "profile-2",
            Name = "Global Default",
            CreatedByUserId = "other-user",
            IsDefault = true
        };
        var writableSession = new InfraAgentSession
        {
            Id = "session-1",
            UserId = userId,
            ToolPolicy = InfraAgentToolPolicies.CodeWritableConfirm
        };
        var waitingApproval = new WorkflowExecution
        {
            Id = "execution-1",
            TriggeredBy = userId,
            Status = WorkflowExecutionStatus.WaitingApproval
        };

        var dashboard = InfraAgentSessionService.BuildGovernanceDashboard(
            userId,
            new[] { team },
            new[] { workflow },
            new[] { ownedStore, publicStore },
            new[] { ownedProfile, globalDefaultProfile },
            new[] { writableSession },
            new[] { waitingApproval },
            now);

        dashboard.SchemaVersion.ShouldBe("cds-agent-governance-dashboard/v1");
        dashboard.Subject.UserId.ShouldBe(userId);
        dashboard.Subject.TeamIds.ShouldBe(new[] { "team-1" });
        dashboard.Summary.OwnedWorkflowCount.ShouldBe(1);
        dashboard.Summary.OwnedKnowledgeBaseCount.ShouldBe(1);
        dashboard.Summary.PublicKnowledgeBaseCount.ShouldBe(1);
        dashboard.Summary.RuntimeProfileCount.ShouldBe(2);
        dashboard.Summary.OwnedRuntimeProfileCount.ShouldBe(1);
        dashboard.Summary.DefaultRuntimeProfileOwned.ShouldBeFalse();
        dashboard.Summary.WritablePolicySessionCount.ShouldBe(1);
        dashboard.Summary.WaitingApprovalExecutionCount.ShouldBe(1);
        dashboard.Gates.Single(x => x.Code == "GOV-KB-READONLY").Status.ShouldBe("pass");
        dashboard.Gates.Single(x => x.Code == "GOV-PROFILE-SCOPE").Status.ShouldBe("warn");
        dashboard.Scopes.Single(x => x.Area == "runtime-profile").State.ShouldBe("needs-enforcement");
        dashboard.NextActions.ShouldContain("Introduce team/user-scoped profile resolve before allowing organization-wide default routing.");
    }
}
