using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class FeatureWorkflowCatalogTests
{
    [Fact]
    public void Default_feature_workflow_aligns_with_requirement_states_plus_delisted()
    {
        var def = ProductWorkflowDefaults.Feature();
        Assert.Equal(8, def.States.Count);
        Assert.Equal(RequirementWorkflowCatalog.New, def.States.First(s => s.IsInitial).Key);

        foreach (var key in RequirementWorkflowCatalog.StateLabels.Keys.Where(k => k != RequirementWorkflowCatalog.ToDefect))
        {
            var state = def.States.First(s => s.Key == key);
            Assert.Equal(RequirementWorkflowCatalog.StateLabels[key], state.Label);
        }

        var delisted = def.States.First(s => s.Key == FeatureWorkflowCatalog.Delisted);
        Assert.Equal("已下架", delisted.Label);
        Assert.Equal(FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Delisted], delisted.Description);
    }

    [Fact]
    public void Default_feature_workflow_delist_only_from_released()
    {
        var def = ProductWorkflowDefaults.Feature();
        Assert.Equal(FeatureWorkflowCatalog.ExpectedTransitionCount, def.Transitions.Count);

        var delist = def.Transitions.Single(t => t.ToState == FeatureWorkflowCatalog.Delisted);
        Assert.Equal(RequirementWorkflowCatalog.Released, delist.FromState);
        Assert.Equal("下架", delist.Label);

        Assert.DoesNotContain(def.Transitions, t =>
            t.ToState == FeatureWorkflowCatalog.Delisted && t.FromState != RequirementWorkflowCatalog.Released);
    }

    [Fact]
    public void Default_feature_workflow_delisted_can_reopen_to_planning_states()
    {
        var def = ProductWorkflowDefaults.Feature();
        var reopenTargets = def.Transitions
            .Where(t => t.FromState == FeatureWorkflowCatalog.Delisted)
            .Select(t => t.ToState)
            .ToHashSet();
        Assert.Contains(RequirementWorkflowCatalog.Planning, reopenTargets);
        Assert.Contains(RequirementWorkflowCatalog.New, reopenTargets);
    }
}
