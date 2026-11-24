using MongoDB.Bson;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

public class GatewayModelAliasConfigurationTests
{
    [Theory]
    [InlineData("fixed", "image-2-all", false)]
    [InlineData("stable", "image-2-all", true)]
    [InlineData("stable", "image-quality", false)]
    [InlineData("stable", "*", false)]
    [InlineData("stable", "", false)]
    [InlineData("unknown", "image-2-all", false)]
    public void AliasConfigurationPreservesFixedAndExactIdentity(string kind, string alias, bool valid)
        => Assert.Equal(valid, LogicalModelAliasPolicy.Validate(kind, "image-quality", [alias]) is null);

    [Fact]
    public void DisabledCanonicalStillReservesVersionName()
        => Assert.True(LogicalModelAliasPolicy.Conflicts(new BsonDocument
        { { "PublicId", "gpt-image-2" }, { "Enabled", false } }, ["GPT-IMAGE-2"]));

    [Fact]
    public void AliasAndMigratedPoolNamesShareCanonicalNamespace()
    {
        var other = new BsonDocument { { "PublicId", "image-quality" },
            { "Aliases", new BsonArray { "image-2-all" } }, { "MigratedFromPoolIds", new BsonArray { "legacy-pool" } } };
        Assert.True(LogicalModelAliasPolicy.Conflicts(other, ["image-2-all"]));
        Assert.True(LogicalModelAliasPolicy.Conflicts(other, ["legacy-pool"]));
        Assert.False(LogicalModelAliasPolicy.Conflicts(other, ["new-model"]));
    }
}
