using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class RequirementWorkflowCatalogTests
{
    [Theory]
    [InlineData("待评审", "new")]
    [InlineData("已上线", "resolved")]
    [InlineData("已排期", "status_3")]
    public void MapImportedStatusLabel_maps_chinese_labels(string label, string expected)
    {
        Assert.Equal(expected, RequirementWorkflowCatalog.MapImportedStatusLabel(label));
    }

    [Theory]
    [InlineData("pending", "new")]
    [InlineData("reviewed", "planning")]
    [InlineData("done", "resolved")]
    [InlineData("state", "new")]
    public void NormalizeStateKey_migrates_legacy_keys(string legacy, string modern)
    {
        Assert.Equal(modern, RequirementWorkflowCatalog.NormalizeStateKey(legacy));
    }

    [Fact]
    public void NormalizeStateKey_prefers_workflow_definition_states()
    {
        var def = new ProductWorkflowDefinition
        {
            States = new()
            {
                new() { Key = "custom_a", Label = "自定义A", IsInitial = true },
                new() { Key = "custom_b", Label = "自定义B" },
            },
        };
        Assert.Equal("custom_b", RequirementWorkflowCatalog.NormalizeStateKey("custom_b", def));
        Assert.Equal("custom_a", RequirementWorkflowCatalog.NormalizeStateKey(null, def));
    }

    [Fact]
    public void Default_requirement_workflow_states_have_builtin_descriptions()
    {
        var def = ProductWorkflowDefaults.Requirement();
        foreach (var (key, expected) in RequirementWorkflowCatalog.StateDescriptions)
        {
            var state = def.States.First(s => s.Key == key);
            Assert.Equal(expected, state.Description);
        }
    }

    [Fact]
    public void Default_requirement_workflow_matches_builtin_state_count()
    {
        var def = ProductWorkflowDefaults.Requirement();
        Assert.Equal(8, def.States.Count);
        Assert.Contains(def.States, s => s.Key == RequirementWorkflowCatalog.ToDefect && s.Label == "转为缺陷");
        Assert.Equal("new", def.States.First(s => s.IsInitial).Key);
        Assert.Contains(def.Transitions, t => t.Key == "new-to-planning" && t.FromState == "new" && t.ToState == "planning");
        Assert.DoesNotContain(def.Transitions, t => t.FromState == t.ToState);
        var toDefect = def.Transitions.First(t => t.ToState == RequirementWorkflowCatalog.ToDefect);
        Assert.Equal(ProductEntityType.Defect, toDefect.LinkEntityType);
    }

    [Fact]
    public void Default_requirement_workflow_has_expected_transition_count()
    {
        var def = ProductWorkflowDefaults.Requirement();
        Assert.Equal(RequirementWorkflowCatalog.ExpectedTransitionCount, def.Transitions.Count);
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
    public void ResolveStateLabel_prefers_workflow_def_then_catalog()
    {
        var def = ProductWorkflowDefaults.Requirement();
        Assert.Equal("待评审", RequirementWorkflowCatalog.ResolveStateLabel("new", def));
        Assert.Equal("待规划", RequirementWorkflowCatalog.ResolveStateLabel("pending", def));
        Assert.Equal("待评审", RequirementWorkflowCatalog.ResolveStateLabel("new", null));
    }

    [Theory]
    [InlineData("planning", "到待规划")]
    [InlineData("resolved", "到已上线")]
    public void BuildTransitionActionLabel_returns_short_label(string toKey, string expected)
    {
        Assert.Equal(expected, RequirementWorkflowCatalog.BuildTransitionActionLabel(toKey));
    }
}
