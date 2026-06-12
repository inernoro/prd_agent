using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class FeatureWorkflowCatalogTests
{
    [Fact]
    public void Default_feature_workflow_uses_delisted_label_and_descriptions()
    {
        var def = ProductWorkflowDefaults.Feature();
        var delisted = def.States.First(s => s.Key == FeatureWorkflowCatalog.Delisted);
        Assert.Equal("已下架", delisted.Label);
        Assert.Equal(FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Delisted], delisted.Description);

        foreach (var (key, expected) in FeatureWorkflowCatalog.StateDescriptions)
        {
            var state = def.States.First(s => s.Key == key);
            Assert.Equal(expected, state.Description);
        }

        var delistTr = def.Transitions.First(t => t.Key == "delist");
        Assert.Equal("下架", delistTr.Label);
        Assert.Equal(FeatureWorkflowCatalog.Delisted, delistTr.ToState);
    }
}
