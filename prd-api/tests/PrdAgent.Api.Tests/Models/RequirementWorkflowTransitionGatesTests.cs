using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class RequirementWorkflowTransitionGatesTests
{
    [Fact]
    public void ValidateApprovedGate_requires_initiation_linkage()
    {
        Assert.Equal("流转到已立项前，需关联已通过并取得立项号的立项单",
            RequirementWorkflowTransitionGates.ValidateApprovedGate(false, null, false));
        Assert.Null(RequirementWorkflowTransitionGates.ValidateApprovedGate(true, null, false));
        Assert.Null(RequirementWorkflowTransitionGates.ValidateApprovedGate(false, "init-1", true));
    }

    [Fact]
    public void ValidateScheduledGate_requires_version_ids()
    {
        Assert.Equal("流转到已排期前，需至少关联一个归属版本",
            RequirementWorkflowTransitionGates.ValidateScheduledGate(Array.Empty<string>()));
        Assert.Null(RequirementWorkflowTransitionGates.ValidateScheduledGate(new[] { "v1" }));
    }

    [Fact]
    public void ValidateReleasedGate_requires_completed_release()
    {
        Assert.Equal("流转到已上线前，需关联已完成上线的上线单",
            RequirementWorkflowTransitionGates.ValidateReleasedGate(false, null, false));
        Assert.Null(RequirementWorkflowTransitionGates.ValidateReleasedGate(true, null, false));
    }

    [Fact]
    public void Default_scheduled_transition_requires_version_ids_field()
    {
        var def = ProductWorkflowDefaults.Requirement();
        var toScheduled = def.Transitions.First(t => t.Key == "new-to-status_3");
        Assert.Contains(ProductWorkflowTransitionFieldKeys.VersionIds, toScheduled.RequiredFieldKeys ?? new List<string>());
    }
}
