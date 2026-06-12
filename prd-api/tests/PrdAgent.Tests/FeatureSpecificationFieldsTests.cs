using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class FeatureSpecificationFieldsTests
{
    [Fact]
    public void Feature_ShouldExposeV26GovernanceFields()
    {
        var properties = typeof(Feature).GetProperties().Select(property => property.Name).ToHashSet();
        var required = new[]
        {
            nameof(Feature.ModuleName),
            nameof(Feature.FeatureType),
            nameof(Feature.MainRequirementId),
            nameof(Feature.PlannedVersionId),
            nameof(Feature.OfficialReleaseId),
            nameof(Feature.OwnerId),
            nameof(Feature.KeyRules),
            nameof(Feature.AcceptanceCriteria),
            nameof(Feature.Remark),
        };

        Assert.All(required, property => Assert.Contains(property, properties));
        Assert.Equal(
            new[] { "basic", "core", "value_added" },
            FeatureBusinessType.All);
    }
}
