using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class DefectWorkflowCatalogTests
{
    [Fact]
    public void Default_defect_workflow_aligns_with_requirement_states_plus_to_requirement()
    {
        var def = ProductWorkflowDefaults.Defect();
        Assert.Equal(8, def.States.Count);
        Assert.Equal(RequirementWorkflowCatalog.New, def.States.First(s => s.IsInitial).Key);

        foreach (var key in RequirementWorkflowCatalog.StateLabels.Keys.Where(k => k != RequirementWorkflowCatalog.ToDefect))
        {
            var state = def.States.First(s => s.Key == key);
            Assert.Equal(RequirementWorkflowCatalog.StateLabels[key], state.Label);
        }

        var toReq = def.States.First(s => s.Key == DefectWorkflowCatalog.ToRequirement);
        Assert.Equal(ProductDefectLinkageCatalog.NonProductDefect, toReq.Label);
    }

    [Fact]
    public void Default_defect_workflow_has_expected_transition_count_and_link()
    {
        var def = ProductWorkflowDefaults.Defect();
        Assert.Equal(DefectWorkflowCatalog.ExpectedTransitionCount, def.Transitions.Count);

        var toReq = def.Transitions.First(t => t.ToState == DefectWorkflowCatalog.ToRequirement);
        Assert.Equal(ProductEntityType.Requirement, toReq.LinkEntityType);
        Assert.Equal("转需求", toReq.Label);
    }

    [Theory]
    [InlineData("submitted", "new")]
    [InlineData("assigned", "planning")]
    [InlineData("processing", "developing")]
    public void NormalizeStateKey_migrates_legacy_defect_statuses(string legacy, string modern)
    {
        Assert.Equal(modern, DefectWorkflowCatalog.NormalizeStateKey(legacy));
    }
}
