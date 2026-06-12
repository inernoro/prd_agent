using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class TapdRequirementWorkflowTests
{
    [Theory]
    [InlineData("待评审", "new")]
    [InlineData("已上线", "resolved")]
    [InlineData("已排期", "status_3")]
    public void MapTapdStatusLabel_maps_chinese_labels(string label, string expected)
    {
        Assert.Equal(expected, TapdRequirementWorkflow.MapTapdStatusLabel(label));
    }

    [Theory]
    [InlineData("pending", "new")]
    [InlineData("reviewed", "planning")]
    [InlineData("done", "resolved")]
    public void NormalizeStateKey_migrates_legacy_keys(string legacy, string modern)
    {
        Assert.Equal(modern, TapdRequirementWorkflow.NormalizeStateKey(legacy));
    }

    [Fact]
    public void Default_requirement_workflow_matches_tapd_state_count()
    {
        var def = ProductWorkflowDefaults.Requirement();
        Assert.Equal(7, def.States.Count);
        Assert.Equal("new", def.States.First(s => s.IsInitial).Key);
        Assert.Contains(def.Transitions, t => t.Key == "new-to-planning" && t.FromState == "new" && t.ToState == "planning");
        Assert.DoesNotContain(def.Transitions, t => t.FromState == t.ToState);
    }

    [Fact]
    public void Default_requirement_workflow_has_tapd_transition_count()
    {
        var def = ProductWorkflowDefaults.Requirement();
        Assert.Equal(TapdRequirementWorkflow.ExpectedTransitionCount, def.Transitions.Count);
    }

    [Fact]
    public void Transition_labels_use_short_action_format()
    {
        var def = ProductWorkflowDefaults.Requirement();
        var toPlanning = def.Transitions.First(t => t.Key == "new-to-planning");
        Assert.Equal("到待规划", toPlanning.Label);
        Assert.DoesNotContain("→", toPlanning.Label);
    }

    [Fact]
    public void ResolveStateLabel_prefers_workflow_def_then_tapd_table()
    {
        var def = ProductWorkflowDefaults.Requirement();
        Assert.Equal("待评审", TapdRequirementWorkflow.ResolveStateLabel("new", def));
        Assert.Equal("待规划", TapdRequirementWorkflow.ResolveStateLabel("pending", def));
        Assert.Equal("待评审", TapdRequirementWorkflow.ResolveStateLabel("new", null));
    }

    [Theory]
    [InlineData("planning", "到待规划")]
    [InlineData("resolved", "到已上线")]
    public void BuildTransitionActionLabel_returns_short_label(string toKey, string expected)
    {
        Assert.Equal(expected, TapdRequirementWorkflow.BuildTransitionActionLabel(toKey));
    }
}
